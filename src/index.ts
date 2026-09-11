/**
 * @zhourenke/dsh-tool-everything
 *
 * A model-facing Everything search tool powered by the `es` command-line client
 * (es.exe). Provides blazing-fast file search on Windows via the Everything
 * search engine, supporting the full Everything search syntax (wildcards, regex,
 * size:, dm:, etc.).
 *
 * @module @zhourenke/dsh-tool-everything
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max results to return. */
const DEFAULT_MAX_RESULTS = 50

/** Maximum allowed max_results (safety cap). */
const ABSOLUTE_MAX_RESULTS = 100000

/** Default cooperative tool-call timeout budget in milliseconds. */
const DEFAULT_TIMEOUT_MS = 1200000

/** Default terminate grace period for the `es` process (ms). */
const DEFAULT_GRACE_MS = 3000

/** Default cap in bytes on the retained stderr tail. */
const DEFAULT_STDERR_MAX_BYTES = 64 * 1024

/** Default cap in bytes on the raw stdout the tool will parse. */
const DEFAULT_RAW_OUTPUT_MAX_BYTES = 2e7

/** Warning shown when a content: search was auto-restricted to immediate children. */
const CONTENT_SEARCH_RESTRICTED_WARNING =
  'Content search was restricted to immediate files only (no recursion into subdirectories) ' +
  'via the parent: function, to prevent the Everything engine from freezing: the original path ' +
  'was too broad (drive root or Users tree). Provide a narrow path such as path:C:\\Specific\\Folder ' +
  'for recursive content searches.'

// ---------------------------------------------------------------------------
// System-prompt section placement
// ---------------------------------------------------------------------------
//
// dsh-system-prompt owns a registry of section orders (SECTION_ORDERS in
// @deepseek-ai/dsh-system-prompt) and every TOOL_* entry lives in the
// 1000-2900 band, ordered by tool family: TOOL_BASH 1000, TOOL_PWSH 1010,
// TOOL_READ 1100 ... TOOL_GLOB 1400, TOOL_GREP 1500, TOOL_JOBS 1600 ...
//
// The registry has no entry for a third-party Everything tool and plugins
// cannot add one, so this section derives its order from the closest relative
// instead of carrying a bare literal. everything_search is a
// filesystem-discovery tool, so it anchors to TOOL_GREP and takes the 10-slot
// immediately after it -- the same shape the registry itself uses for the
// sibling pair TOOL_BASH (1000) / TOOL_PWSH (1010).
//
// Reading the anchor through getSectionOrder() rather than copying "1500" as a
// literal means a DSH reshuffle of the registry carries this section along
// instead of silently leaving it behind.

/** Registry name this section is ordered relative to. */
const SECTION_ORDER_ANCHOR = 'TOOL_GREP'

/** Offset from the anchor: lands inside the anchor's own 100-block. */
const SECTION_ORDER_OFFSET = 10

/**
 * Order used when the anchor is unavailable. getSectionOrder() returns
 * `undefined` for a name DSH no longer registers, and section() rejects a
 * non-finite order with a TypeError -- which would take the whole plugin down
 * at startup -- so the fallback must always be a finite number inside the tool
 * band (TOOL_GREP 1500 + 10 at the time of writing).
 */
const SECTION_ORDER_FALLBACK = 1510

// ---------------------------------------------------------------------------
// Error vocabulary
// ---------------------------------------------------------------------------

/** Error codes for `everything_search` failures. */
type EverythingErrorCode =
  | 'ES_NOT_FOUND'
  | 'ES_FAILED'
  | 'ES_RAW_OUTPUT_OVERFLOW'
  | 'ES_ABORTED'

/** Typed search failure extending HarnessError. */
class EverythingError extends HarnessError {
  declare code: EverythingErrorCode

  constructor(message: string, code: EverythingErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Host service contracts
// ---------------------------------------------------------------------------
//
// Structural descriptions of the host surface this plugin consumes. They are
// declared locally (rather than as `Record<string, unknown>` plus casts, or as
// `any`) so every call site is actually checked: a misspelled service name, a
// misspelled method, or a wrong argument shape fails at typecheck instead of at
// runtime inside the DSH loader.
//
// All three services are hard dependencies listed in `inject`, so none is
// modelled as optional. Optional capabilities would use `ctx.get(name)` and be
// declared `| undefined` here.

/** One collected output stream returned by the subprocess seam. */
interface CollectedStream {
  text?: string
  lossy?: boolean
}

/** Terminal facts of one finished process. */
interface ProcessOutcome {
  signal: string | null
  exitCode: number | null
}

/**
 * Spawn request accepted by `ctx.subprocess.spawn()`. Only the fields this
 * plugin sets are declared; the seam accepts more.
 */
interface SubprocessSpawnSpec {
  argv: string[]
  cwd: string
  stdio: {
    stdin: 'ignore'
    stdout: { maxBytes: number }
    stderr: { maxBytes: number }
  }
  graceMs: number
  signal: AbortSignal
  /**
   * Extra environment entries for the child, merged onto the implementation's
   * scrubbed parent base. Used to carry a quoted `-path` / `-parent` value past
   * cmd's tokenizer without putting a quote character in the command string.
   */
  env?: Record<string, string>
}

/** Live handle for one spawned process. */
interface SubprocessHandle {
  done: Promise<ProcessOutcome>
  collected: {
    stdout?: { readFrom(offset: number): CollectedStream }
    stderr?: { readFrom(offset: number): CollectedStream }
  }
}

/** One system-prompt section request. */
interface PromptSection {
  name: string
  order: number
  text: string
}

/**
 * Execution context handed to a tool's `execute`. The session cwd is read from
 * `agent.session.header.cwd`, matching the subprocess seam's own default.
 */
interface ToolExecContext {
  signal: AbortSignal
  agent?: { session?: { header?: { cwd?: string } } }
}

/** Plugin configuration after schemastery defaulting (fields stay optional so the coalescing below is honest). */
interface EverythingConfig {
  timeoutMs?: number
  graceMs?: number
  stderrMaxBytes?: number
  rawOutputMaxBytes?: number
}

/** The host services this plugin consumes. */
interface HostContext {
  systemPrompt: {
    section(section: PromptSection): unknown
    /** Central placement of a registered section, or undefined for an unknown name. */
    getSectionOrder(name: string): number | undefined
  }
  tools: { register(definition: { name: string }): unknown }
  subprocess: { spawn(spec: SubprocessSpawnSpec): SubprocessHandle }
}

/**
 * Resolve this plugin's prompt-section order from the host registry, falling
 * back to a finite tool-band value if the anchor entry is gone.
 */
function resolveSectionOrder(ctx: HostContext): number {
  const anchor = ctx.systemPrompt.getSectionOrder(SECTION_ORDER_ANCHOR)
  return typeof anchor === 'number' && Number.isFinite(anchor)
    ? anchor + SECTION_ORDER_OFFSET
    : SECTION_ORDER_FALLBACK
}

// ---------------------------------------------------------------------------
// es output column flags
// ---------------------------------------------------------------------------

/**
 * Column flags mapped to `es` command-line arguments.
 * `path` uses -full-path-and-name (NOT -path-column): -path-column replaces
 * the filename with its parent directory, while -full-path-and-name keeps
 * the full path AND the filename in the `filename` JSON field.
 */
const COLUMN_FLAGS: Record<string, string> = {
  path: '-full-path-and-name',
  size: '-size',
  date_created: '-dc',
  date_modified: '-dm',
  date_accessed: '-da',
  extension: '-ext',
  attributes: '-attribs',
}

// ---------------------------------------------------------------------------
// Content search safety
// ---------------------------------------------------------------------------

/** Check whether the query contains a content: search. */
function isContentSearch(query: string): boolean {
  return /\bcontent:/i.test(query)
}

/** Detect paths that are too broad for content searches (drive roots, Users tree). */
function isBroadPath(path: string): boolean {
  if (!path) return false
  // Strip trailing slashes AND wildcard suffixes before checking.
  // The model may write path:C:\* which is semantically the same as path:C:\
  let n = path.replace(/[\\/]+$/, '')
  n = n.replace(/(?:\\[*?])+$/, '')
  // Drive root: C:\, D:\
  if (/^[A-Za-z]:\\?$/.test(n)) return true
  // Entire Users tree: C:\Users, C:\Users\AnyUser
  if (/^[A-Za-z]:\\Users(\\[^\\]+)?$/i.test(n)) return true
  // Legacy profile container
  if (/^[A-Za-z]:\\Documents and Settings(\\[^\\]+)?$/i.test(n)) return true
  // Current user home
  const userHome =
    typeof process !== 'undefined'
      ? process.env.USERPROFILE || process.env.HOME
      : undefined
  if (userHome && n.toLowerCase() === userHome.toLowerCase()) return true
  return false
}

/** Clean a path for use with Everything's `parent:` function (immediate children). */
function restrictToImmediateDir(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

/** Extract a `path:` value from the query string when inlined by the model. */
function extractInlinePath(query: string): string | undefined {
  const m = query.match(/\bpath:(\S+?)(?:\s|$)/i)
  return m ? m[1] : undefined
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Validated input for the `es` command. */
interface EverythingInput {
  query: string
  maxResults: number
  regex: boolean
  matchCase: boolean
  matchWholeWord: boolean
  matchPath: boolean
  fileOnly: boolean
  folderOnly: boolean
  sortBy?: string
  sortDesc: boolean
  path?: string
  attributes?: string
  columns: string[]
  /** @internal Set by buildEsCommand when content search was auto-restricted. */
  _contentSearchRestricted?: boolean
  /** @internal Set by buildEsCommand when content search requires an explicit path. */
  _contentSearchRejected?: boolean
}

function parseEverythingArgs(args: Record<string, unknown>): EverythingInput {
  const query = String(args.query ?? '').trim()
  if (query.length === 0) {
    throw new Error('query must be a non-empty string')
  }

  const maxResults = Math.min(
    Math.max(1, Number(args.max_results ?? DEFAULT_MAX_RESULTS)),
    ABSOLUTE_MAX_RESULTS,
  )

  if (args.path !== undefined && String(args.path).trim().length === 0) {
    throw new Error('path must be a non-empty string when given')
  }

  // Collect requested columns
  const columns: string[] = []
  if (args.include_path) columns.push('path')
  if (args.include_size) columns.push('size')
  if (args.include_date_created) columns.push('date_created')
  if (args.include_date_modified) columns.push('date_modified')
  if (args.include_date_accessed) columns.push('date_accessed')
  if (args.include_extension) columns.push('extension')
  if (args.include_attributes) columns.push('attributes')

  return {
    query,
    maxResults,
    regex: Boolean(args.regex),
    matchCase: Boolean(args.match_case),
    matchWholeWord: Boolean(args.match_whole_word),
    matchPath: Boolean(args.match_path),
    fileOnly: Boolean(args.file_only),
    folderOnly: Boolean(args.folder_only),
    sortBy: args.sort_by !== undefined ? String(args.sort_by) : undefined,
    sortDesc: Boolean(args.sort_desc),
    path: args.path !== undefined ? String(args.path) : undefined,
    attributes: args.attributes !== undefined ? String(args.attributes) : undefined,
    columns,
  }
}

// ---------------------------------------------------------------------------
// es command builder
// ---------------------------------------------------------------------------

/**
 * Escape the Everything query for embedding in a single `cmd /c` command
 * string. Every shell-special character — including SPACE — is escaped with
 * caret (^), cmd's escape character, so the query is passed to es literally:
 * `size:>1gb` stays `size:>1gb` (not a redirection), `*.pdf | *.txt` stays
 * one OR search (not a pipe), and `Windows11 25H2.iso` stays one multi-word
 * query (cmd splits on spaces, but es merges its positional arguments back
 * into the search text). Quotes are NEVER used: es passes them through to
 * Everything, where `"..."` means a literal search and silently returns zero
 * results.
 */
function escapeForCmd(arg: string): string {
  return arg.replace(/[ &|<>^()"]/g, (ch) => `^${ch}`)
}

/**
 * Environment variable that carries a `-path` / `-parent` value to the command
 * string. The value is stored *including* its surrounding double quotes, so the
 * command string can reference it as a bare `%NAME%` and never contain a quote
 * character of its own. That matters because Node's spawn escapes a quote inside
 * the command string as `\"`, and cmd then tears the argument apart — measured:
 * an in-string `-path "C:\Program Files"` reaches es as `"C:\Program` plus
 * `Files"`, while the same value delivered through the environment arrives as
 * the single argv element `C:\Program Files`.
 */
const PATH_ARG_ENV = 'EVERYTHING_TOOL_PATH_ARG'

/** One prepared es invocation: the argv to spawn plus any environment it needs. */
interface EsInvocation {
  argv: string[]
  env?: Record<string, string>
}

/**
 * Build the argv array for the spawn call: a single
 * `["cmd", "/c", "chcp 65001>nul & es ..."]` command string. The console
 * code page is switched to UTF-8 (65001) before es runs because es outputs
 * filenames in the system ANSI code page (e.g. GB2312 on Chinese Windows),
 * which the harness subprocess decodes as UTF-8 and garbles. es exposes no
 * UTF-8 option for console output (-utf8-bom applies only to -export-* files),
 * so the code-page switch and therefore cmd itself are both required.
 *
 * The command is ONE joined string, not separate argv elements: cmd /c
 * strips the outer quotes Node adds, leaving the caret escapes to take
 * effect. Separate argv elements fail because Node auto-quotes
 * space-containing elements and cmd then keeps those quotes (a quote inside
 * the search text becomes a literal Everything search marker).
 *
 * Outside regex mode the `path` argument is folded into the query as
 * Everything's `path:` function prefix (`path:C:\Program^ Files\MacType *.ini`)
 * rather than the `-path` option: a `-path` value containing spaces needs
 * quotes, and Node's `\"` escaping of those quotes breaks cmd. The `path:`
 * function handles space-containing paths correctly after caret-escaping.
 *
 * In regex mode that fold-in does NOT work and the search silently returns
 * nothing: es compiles the entire search string as one regular expression, so
 * `path:C:\dir` stops being a function and becomes literal regex text that no
 * filename matches. Verified: `-r path:<dir> .*` returns 0 while
 * `-path <dir> -r .*` returns the directory's contents. Regex mode therefore
 * switches to the `-path` / `-parent` options, whose values travel through
 * PATH_ARG_ENV so a space-containing path still arrives as one argv element.
 *
 * es also parses its option list strictly left to right and is greedy about
 * the search-mode switches: -r (regex) and -i/-w/-p (case/whole-word/
 * match-path) must be the LAST options, immediately before the query. Any
 * option that follows them (e.g. -size, -n, -sort) is consumed as part of
 * the search text and silently returns zero results — verified empirically:
 * `-size -n 5 -r query` works, `-r -size query` does not.
 */
function buildEsCommand(input: EverythingInput): EsInvocation {
  const esArgs: string[] = ['-json']

  // 1. Display columns first (never after the search switches).
  for (const col of input.columns) {
    const flag = COLUMN_FLAGS[col]
    if (flag !== undefined) esArgs.push(flag)
  }

  // 2. Result-count limit.
  esArgs.push('-n', String(input.maxResults))

  // 3. File/folder type and attribute filters (shared with the count query).
  pushMatchFilters(esArgs, input)

  // 4. Sort.
  if (input.sortBy !== undefined) {
    const direction = input.sortDesc ? 'descending' : 'ascending'
    esArgs.push('-sort', `${input.sortBy}-${direction}`)
  }

  // 5. Search switches and directory scope, then the query itself.
  const { query, env } = resolveQueryScope(input, esArgs)
  esArgs.push(escapeForCmd(query))

  return makeInvocation(esArgs, env)
}

/**
 * Build the `es -get-result-count` invocation for the same search. Everything's
 * `-get-result-count` reports the true number of matches without listing them,
 * which is the only way to know a capped listing was capped: es is invoked with
 * `-n <maxResults>` for the listing, so its output can never exceed that number
 * and a "more results exist" test on the returned array alone can never fire.
 *
 * Columns, `-n` and the sort are omitted — they cannot change the count.
 */
function buildEsCountCommand(input: EverythingInput): EsInvocation {
  const esArgs: string[] = ['-get-result-count']

  pushMatchFilters(esArgs, input)

  const { query, env } = resolveQueryScope(input, esArgs)
  esArgs.push(escapeForCmd(query))

  return makeInvocation(esArgs, env)
}

/** Filters restricting which entries match: file/folder type and attributes. */
function pushMatchFilters(esArgs: string[], input: EverythingInput): void {
  if (input.fileOnly) esArgs.push('/a-d')
  if (input.folderOnly) esArgs.push('/ad')
  if (input.attributes !== undefined) esArgs.push(`/a${input.attributes}`)
}

/**
 * Append the search-mode switches, the directory scope and the query text.
 *
 * Order is load-bearing: es parses its options strictly left to right and the
 * search-mode switches (-i/-w/-p/-r) are greedy, so they must come last, with
 * the greedy `-r` immediately before the query. Any option after them is
 * swallowed into the search text — verified empirically: `-size -n 5 -r query`
 * works, `-r -size query` does not.
 */
function resolveQueryScope(
  input: EverythingInput,
  esArgs: string[],
): { query: string; env?: Record<string, string> } {
  // Non-greedy search switches, in any order among themselves.
  if (input.matchCase) esArgs.push('-i')
  if (input.matchWholeWord) esArgs.push('-w')
  if (input.matchPath) esArgs.push('-p')

  // Resolve the directory scope. Under -r this becomes a real option (applied
  // outside the expression) rather than a path:/parent: prefix, because inside
  // a regex those function names are literal text.
  let query = input.query
  let env: Record<string, string> | undefined

  /** Scope the search through an option, handing the value over by environment. */
  const scopeByOption = (option: '-path' | '-parent', value: string): void => {
    env = { ...(env ?? {}), [PATH_ARG_ENV]: `"${value}"` }
    esArgs.push(option, `%${PATH_ARG_ENV}%`)
  }

  if (input.path !== undefined) {
    const broadContent = isContentSearch(query) && isBroadPath(input.path)
    if (input.regex) {
      if (broadContent) {
        // -parent is non-recursive, matching what the parent: function did.
        scopeByOption('-parent', restrictToImmediateDir(input.path))
        input._contentSearchRestricted = true
      } else {
        scopeByOption('-path', input.path)
      }
    } else if (broadContent) {
      query = `parent:${restrictToImmediateDir(input.path)} ${query}`
      input._contentSearchRestricted = true
    } else {
      query = `path:${input.path} ${query}`
    }
  } else {
    // Check the query string itself for an inline path: function. Under -r it
    // is deliberately left alone: the caller wrote a regular expression, and
    // "path:" inside one is literal text by regex semantics. That also means it
    // cannot scope a content search, so the guard below still applies.
    const inlinePath = input.regex ? undefined : extractInlinePath(query)
    if (inlinePath) {
      if (isBroadPath(inlinePath) && isContentSearch(query)) {
        query = query.replace(
          /\bpath:(\S+?)(?:\s|$)/i,
          (_, p: string) => `parent:${restrictToImmediateDir(p)} `,
        )
        input._contentSearchRestricted = true
      }
      // inline path present and not broad → pass through normally
    } else if (isContentSearch(query)) {
      // No path at all — content search would scan every file on every
      // drive through system iFilters, freezing Everything.  Reject with
      // a clear error so the model learns to supply a path parameter.
      input._contentSearchRejected = true
    }
  }

  // -r is greedy: it MUST be the final option, right before the query.
  if (input.regex) esArgs.push('-r')

  return env === undefined ? { query } : { query, env }
}

/**
 * Wrap the finished es argument list in the single `cmd /c` command string:
 * the console code page is switched to UTF-8 (65001) first because es writes
 * filenames in the system ANSI code page (e.g. GB2312 on Chinese Windows),
 * which the harness subprocess decodes as UTF-8 and garbles, and chcp's banner
 * is redirected to nul.
 */
function makeInvocation(esArgs: string[], env?: Record<string, string>): EsInvocation {
  const cmdLine = `chcp 65001>nul & es ${esArgs.join(' ')}`
  return env === undefined ? { argv: ['cmd', '/c', cmdLine] } : { argv: ['cmd', '/c', cmdLine], env }
}

/**
 * Ask Everything for the exact match count of an already-validated search.
 *
 * Returns undefined when the count cannot be read, so a listing that already
 * succeeded is never failed by the follow-up query; the caller degrades to
 * reporting that more results may exist.
 */
async function countMatches(
  ctx: HostContext,
  exec: ToolExecContext,
  input: EverythingInput,
  rawOutputMaxBytes: number,
  graceMs: number,
  stderrMaxBytes: number,
): Promise<number | undefined> {
  try {
    const run = await runEs(
      ctx,
      exec,
      'everything_search',
      buildEsCountCommand(input),
      rawOutputMaxBytes,
      graceMs,
      stderrMaxBytes,
    )
    if (run.noMatches) return 0
    const count = Number.parseInt(run.stdout.trim(), 10)
    return Number.isSafeInteger(count) && count >= 0 ? count : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

/** One result entry from `es -json`. */
interface EsResultEntry {
  filename?: string
  path?: string
  size?: number | null
  date_created?: number | null
  date_modified?: number | null
  date_accessed?: number | null
  extension?: string
  attributes?: string
}

/**
 * Format a file size in bytes to a human-readable string.
 */
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const size = bytes / Math.pow(1024, i)
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/**
 * Convert a Windows FILETIME (100-ns intervals since 1601-01-01 UTC) to an
 * ISO-8601 date string.
 */
function formatFiletime(filetime: number): string {
  // FILETIME epoch: January 1, 1601 (UTC)
  // Unix epoch: January 1, 1970 (UTC)
  // Difference: 11644473600 seconds
  const UNIX_EPOCH_DIFF = 11644473600
  const unixSeconds = Math.floor(filetime / 10_000_000) - UNIX_EPOCH_DIFF
  const date = new Date(unixSeconds * 1000)
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
}

/**
 * Convert a Windows attribute bitmask (es -attribs outputs a NUMBER) into a
 * DIR-style letter string matching Everything's /a filter syntax
 * (e.g. 32 → 'A' for Archive, 6 → 'HS' for Hidden+System). Non-numeric
 * values pass through as-is; zero attributes render as '-'.
 */
function formatAttributes(attr: unknown): string {
  if (typeof attr !== 'number') {
    return attr === undefined || attr === null ? '' : String(attr)
  }
  const map: Array<[number, string]> = [
    [0x1, 'R'], [0x2, 'H'], [0x4, 'S'], [0x10, 'D'], [0x20, 'A'],
    [0x40, 'V'], [0x80, 'N'], [0x100, 'T'], [0x400, 'L'], [0x800, 'C'],
    [0x1000, 'O'], [0x2000, 'I'], [0x4000, 'E'],
  ]
  let out = ''
  for (const [bit, ch] of map) if ((attr & bit) !== 0) out += ch
  return out || '-'
}

/**
 * Parse the `es -json` stdout into an array of result entries.
 *
 * es wraps its JSON array in an EXTRA array level — `[[{...}]]` instead of
 * `[{...}]` — when a display column flag (e.g. -size) is combined with -r
 * (regex mode). This unwraps exactly one level when the outer array holds a
 * single inner array; a flat array passes through unchanged.
 */
function parseEsOutput(stdout: string): EsResultEntry[] {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (Array.isArray(parsed) && parsed.length === 1 && Array.isArray(parsed[0])) {
      return parsed[0] as EsResultEntry[]
    }
    if (!Array.isArray(parsed)) {
      throw new EverythingError(
        'es produced unexpected output format (expected JSON array)',
        'ES_FAILED',
      )
    }
    return parsed as EsResultEntry[]
  } catch (error) {
    if (error instanceof EverythingError) throw error
    throw new EverythingError(
      `es produced invalid JSON output: ${(error as Error).message}`,
      'ES_FAILED',
      { cause: error },
    )
  }
}

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

/**
 * Run the `es` command with the given argv and return its complete stdout.
 */
async function runEs(
  ctx: HostContext,
  exec: ToolExecContext,
  toolName: string,
  invocation: EsInvocation,
  rawOutputMaxBytes: number,
  graceMs: number,
  stderrMaxBytes: number,
): Promise<{ stdout: string; noMatches: boolean; workdir: string }> {
  if (exec.signal.aborted) {
    throw new EverythingError(
      `${toolName} was aborted before completion (tool timeout or caller cancellation)`,
      'ES_ABORTED',
    )
  }

  const workdir = exec.agent?.session?.header?.cwd ?? process.cwd()
  let handle: SubprocessHandle

  try {
    handle = ctx.subprocess.spawn({
      argv: invocation.argv,
      cwd: workdir,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: rawOutputMaxBytes },
        stderr: { maxBytes: stderrMaxBytes },
      },
      graceMs,
      signal: exec.signal,
      ...(invocation.env === undefined ? {} : { env: invocation.env }),
    })
  } catch (error) {
    if (exec.signal.aborted) {
      throw new EverythingError(
        `${toolName} was aborted before completion (tool timeout or caller cancellation)`,
        'ES_ABORTED',
      )
    }
    const message = (error as Error).message ?? String(error)
    if (
      message.includes('ENOENT') ||
      message.includes('not found') ||
      message.includes('cannot find')
    ) {
      throw new EverythingError(
        `${toolName}: the "cmd" or "es" command was not found on PATH. Please ensure Everything (voidtools) and its CLI client (es.exe) are installed and accessible.`,
        'ES_NOT_FOUND',
        { cause: error as Error },
      )
    }
    throw new EverythingError(
      `${toolName} could not start the es command: ${message}`,
      'ES_FAILED',
      { cause: error as Error },
    )
  }

  let outcome: ProcessOutcome
  try {
    outcome = await handle.done
  } catch (error) {
    throw new EverythingError(
      `${toolName} could not start the es command: ${(error as Error).message}`,
      'ES_FAILED',
      { cause: error as Error },
    )
  }

  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)

  if (stdout === undefined || stderr === undefined) {
    throw new EverythingError(
      `${toolName} search command produced no collected output streams`,
      'ES_FAILED',
    )
  }

  if (exec.signal.aborted) {
    throw new EverythingError(
      `${toolName} was aborted before completion (tool timeout or caller cancellation)`,
      'ES_ABORTED',
    )
  }

  if (outcome.signal !== null || outcome.exitCode === null) {
    throw new EverythingError(
      `${toolName} search command was killed by signal ${outcome.signal ?? '(unknown)'}`,
      'ES_FAILED',
    )
  }

  // Es returns 0 on success, non-zero on failure
  if (outcome.exitCode !== 0) {
    const stderrText = stderr.text ?? ''
    const truncated = stderr.lossy ?? false
    const excerpt = stderrText.trim()
    const detail = excerpt.length > 0
      ? truncated
        ? `${excerpt} [stderr truncated]`
        : excerpt
      : ''
    throw new EverythingError(
      `${toolName} search failed (exit ${outcome.exitCode})${detail.length > 0 ? `: ${detail}` : ''}`,
      'ES_FAILED',
    )
  }

  // Check stdout size
  if (stdout.lossy) {
    throw new EverythingError(
      `${toolName} produced more raw output than the subprocess seam retained within the ${rawOutputMaxBytes}-byte cap; narrow the query and retry`,
      'ES_RAW_OUTPUT_OVERFLOW',
    )
  }

  // An empty JSON array means no matches
  const text = stdout.text ?? ''
  const noMatches = text === '[]' || text.trim() === ''

  return { stdout: text, noMatches, workdir }
}

// ---------------------------------------------------------------------------
// Tool presentation (modern presentCall/presentResult pattern)
// ---------------------------------------------------------------------------

/**
 * Tool-call card showing what the model searched for.
 * Returns a generic search card.
 */
function everythingSearchPresentCall(args: Record<string, unknown>): {
  card: 'generic'
  title: string
  kind: 'search'
  rawInput: string
} {
  const query = String(args.query ?? '')
  const where = args.path !== undefined ? ` in ${String(args.path)}` : ''
  return {
    card: 'generic',
    title: `Everything search: ${query}${where}`,
    kind: 'search',
    rawInput: query,
  }
}

/**
 * Completed-result card showing the discovered paths in a structured search card.
 * Falls back to generic when the result is an error or has no meta.
 */
function everythingSearchPresentResult(
  _args: Record<string, unknown>,
  result: any,
): undefined | {
  card: 'search'
  shape: 'paths'
  title: string
  paths: string[]
  truncated: boolean
  total: number
} {
  if (result.isError) return undefined
  const meta = result.meta as { total: number; truncated: boolean; query: string; results: string[] } | undefined
  if (meta === undefined) return undefined
  return {
    card: 'search',
    shape: 'paths',
    title: `Found ${meta.total} result${meta.total === 1 ? '' : 's'} for "${meta.query}"`,
    paths: meta.results,
    truncated: meta.truncated,
    total: meta.total,
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

function applyEverythingTool(ctx: HostContext, config: EverythingConfig): void {
  const timeoutMs = Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const graceMs = Number(config.graceMs ?? DEFAULT_GRACE_MS)
  const stderrMaxBytes = Number(config.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES)
  const rawOutputMaxBytes = Number(config.rawOutputMaxBytes ?? DEFAULT_RAW_OUTPUT_MAX_BYTES)

  // Register system prompt guidance — inject guarantees systemPrompt is available.
  // The order keeps this section inside the host's TOOL_* band (1000-2900)
  // rather than the deployment-policy band, see SECTION_ORDER_ANCHOR.
  ctx.systemPrompt.section({
    name: 'tool:everything_search',
    order: resolveSectionOrder(ctx),
    text:
      'everything_search: Windows file search via Everything engine (es.exe). Supports full Everything syntax — ' +
      'wildcards (* ?), boolean operators (| ! <...>), functions (content:, size:, dm:, dc:, da:, ext:, path:). ' +
      'Returns numbered results with optional metadata.\n\n' +
      '⚠️ content: requires a path parameter. Without one the search freezes Everything (scans every file ' +
      'via system iFilters) and the plugin rejects it with an error. Broad paths (drive root, Users tree, ' +
      'user home) auto-restrict to immediate children only — use a narrower path for recursive content search.',
  })

  const tool = defineTool({
    name: 'everything_search',
    description:
      'Search files on Windows using the Everything search engine (via es.exe). ' +
      'Supports the full Everything search syntax including wildcards (*, ?), ' +
      'size:, dm:, dc:, ext:, path:, content: and other search functions. ' +
      'Returns results as a numbered list with file paths and optional metadata (size, dates). ' +
      'Results are capped at max_results (default 50, max 100000).',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description:
          'Everything search query. Supports Everything search syntax: ' +
          'wildcards (*.txt, *report*), content: (content:text), ' +
          'size: (size:>1mb), dm: (dm:2024-01-01), dc:, da:, ext:, ' +
          'path:, boolean operators (| !), and quoted terms. ' +
          'Examples: "*.pdf dm:today", "report size:>500kb", "content:hello ext:txt"',
      },
      max_results: {
        type: 'number',
        description:
          'Maximum number of results to return (1–100000, default 50). ' +
          'Use 100000 for exhaustive searches, but prefer narrow queries for speed.',
      },
      path: {
        type: 'string',
        description:
          'Restrict search to files and folders under this directory. ' +
          'Example: "C:\\Projects" or "D:\\Documents".',
      },
      regex: {
        type: 'boolean',
        description:
          'Enable regular expression search mode. The query will be treated as a regex pattern.',
      },
      match_case: {
        type: 'boolean',
        description: 'Enable case-sensitive matching. Default is case-insensitive.',
      },
      match_whole_word: {
        type: 'boolean',
        description: 'Match whole words only, not substrings.',
      },
      match_path: {
        type: 'boolean',
        description: 'Match the full file path instead of just the filename.',
      },
      file_only: {
        type: 'boolean',
        description: 'Only search for files (exclude folders).',
      },
      folder_only: {
        type: 'boolean',
        description: 'Only search for folders (exclude files).',
      },
      sort_by: {
        type: 'string',
        description:
          'Sort results by this field. Options: name, path, size, extension, ' +
          'date-created, date-modified, date-accessed. Default is relevance/name order.',
      },
      sort_desc: {
        type: 'boolean',
        description: 'Sort in descending order when sort_by is set.',
      },
      attributes: {
        type: 'string',
        description:
          'DIR-style attribute filter. Examples: "R" (read-only), "H" (hidden), ' +
          '"S" (system), "D" (directory), "A" (archive). ' +
          'Prefix with - to exclude: "R-H" means read-only AND not hidden. ' +
          'Combine: "RHS" means read-only, hidden, and system.',
      },
      include_size: {
        type: 'boolean',
        description: 'Include file size in results.',
      },
      include_date_modified: {
        type: 'boolean',
        description: 'Include last modified date in results.',
      },
      include_date_created: {
        type: 'boolean',
        description: 'Include creation date in results.',
      },
      include_date_accessed: {
        type: 'boolean',
        description: 'Include last accessed date in results.',
      },
      include_path: {
        type: 'boolean',
        description: 'Include the full directory path for each result.',
      },
      include_extension: {
        type: 'boolean',
        description: 'Include file extension in results.',
      },
      include_attributes: {
        type: 'boolean',
        description: 'Include file attributes (R, H, S, A, etc.) in results.',
      },
    },
    timeoutMs,
    presentCall: everythingSearchPresentCall,
    presentResult: everythingSearchPresentResult,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: {
            type: 'integer',
            required: true,
          },
          truncated: {
            type: 'boolean',
            required: true,
          },
          query: {
            type: 'string',
            required: true,
          },
          warning: {
            type: 'string',
          },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                size: { type: 'integer' },
                date_modified: { type: 'string' },
                date_created: { type: 'string' },
                date_accessed: { type: 'string' },
                extension: { type: 'string' },
                attributes: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as {
          total: number
          truncated: boolean
          query: string
          results: Array<Record<string, unknown>>
          warning?: string
        }
        if (v.total === 0 && !v.warning) {
          return [{ type: 'text' as const, text: 'No files found' }]
        }
        let header = ''
        if (v.total > 0) {
          header = `Found ${v.total} result${v.total === 1 ? '' : 's'} for "${v.query}"${v.truncated ? ` (showing first ${v.results.length})` : ''}`
        }
        if (v.warning) {
          header = `${header}\n\n⚠️ ${v.warning}`
        }
        if (v.total === 0) {
          return [{ type: 'text' as const, text: header || 'No files found' }]
        }
        const lines = v.results.map((r, i) => {
          const filepath = String(r.path ?? '(unknown)')
          const meta: string[] = []
          if (r.size !== undefined && r.size !== null) meta.push(formatSize(Number(r.size)))
          if (r.date_modified !== undefined && r.date_modified !== null) meta.push(`modified: ${r.date_modified}`)
          if (r.date_created !== undefined && r.date_created !== null) meta.push(`created: ${r.date_created}`)
          if (r.date_accessed !== undefined && r.date_accessed !== null) meta.push(`accessed: ${r.date_accessed}`)
          if (r.extension !== undefined && r.extension !== null) meta.push(`ext: ${r.extension}`)
          if (r.attributes !== undefined && r.attributes !== null) meta.push(`attrib: ${r.attributes}`)
          const suffix = meta.length > 0 ? ` [${meta.join(', ')}]` : ''
          return `[${i + 1}] ${filepath}${suffix}`
        })
        return [{ type: 'text' as const, text: `${header}\n\n${lines.join('\n')}` }]
      },
      presentationMeta: (_args, value) => {
        const v = value as {
          total: number
          truncated: boolean
          query: string
          results: Array<Record<string, unknown>>
        }
        return {
          total: v.total,
          truncated: v.truncated,
          query: v.query,
          results: v.results.map((r) => String(r.path ?? '(unknown)')),
        }
      },
    },
    async execute(args, exec) {
      const input = parseEverythingArgs(args)
      input._contentSearchRestricted = false
      input._contentSearchRejected = false
      const invocation = buildEsCommand(input)

      // Reject content: searches with no path — attempting them would
      // freeze Everything while it reads every file on every drive.
      if (input._contentSearchRejected) {
        throw new EverythingError(
          'Content search requires an explicit path to prevent the Everything engine from freezing. ' +
          'Use the path parameter to narrow the scope (e.g. path: "C:\\Specific\\Folder") ' +
          'or add path:C:\\Specific\\Folder to your query.',
          'ES_FAILED',
        )
      }

      const run = await runEs(
        ctx,
        exec,
        'everything_search',
        invocation,
        rawOutputMaxBytes,
        graceMs,
        stderrMaxBytes,
      )

      if (run.noMatches) {
        return {
          total: 0,
          truncated: false,
          query: input.query,
          results: [],
          ...(input._contentSearchRestricted
            ? { warning: CONTENT_SEARCH_RESTRICTED_WARNING }
            : {}),
        }
      }

      const entries = parseEsOutput(run.stdout)
      const results = entries.map((entry) => {
        return {
          path: entry.filename ?? entry.path ?? '(unknown)',
          ...(entry.size !== null && entry.size !== undefined ? { size: entry.size } : {}),
          ...(entry.date_modified !== null && entry.date_modified !== undefined
            ? { date_modified: formatFiletime(entry.date_modified) }
            : {}),
          ...(entry.date_created !== null && entry.date_created !== undefined
            ? { date_created: formatFiletime(entry.date_created) }
            : {}),
          ...(entry.date_accessed !== null && entry.date_accessed !== undefined
            ? { date_accessed: formatFiletime(entry.date_accessed) }
            : {}),
          ...(entry.extension !== undefined ? { extension: entry.extension } : {}),
          ...(entry.attributes !== undefined ? { attributes: formatAttributes(entry.attributes) } : {}),
        }
      })

      // A listing that filled the limit may be hiding further matches: es was
      // invoked with -n maxResults, so the returned array can never reveal it
      // (es caps its output exactly, making results.length > maxResults
      // unreachable). Ask for the exact count only in that case — a listing
      // shorter than the limit is already its own total.
      let total = results.length
      let truncated = false
      if (results.length >= input.maxResults) {
        const exact = await countMatches(ctx, exec, input, rawOutputMaxBytes, graceMs, stderrMaxBytes)
        if (exact === undefined) {
          // The listing is still valid, but it is full and the true total is
          // unknown, so report that more may exist rather than assert a false
          // total from the capped slice.
          truncated = true
        } else {
          total = exact
          truncated = exact > results.length
        }
      }

      return {
        total,
        truncated,
        query: input.query,
        results,
        ...(input._contentSearchRestricted
          ? { warning: CONTENT_SEARCH_RESTRICTED_WARNING }
          : {}),
      }
    },
  })

  // Register the tool — inject guarantees tools is available
  ctx.tools.register(tool)
}

// ---------------------------------------------------------------------------
// Plugin exports
// ---------------------------------------------------------------------------

/** Cordis plugin name used by loader diagnostics. */
const name = 'tool-everything'

/** Services required by the tool. */
const inject = ['tools', 'subprocess', 'systemPrompt']

/** Plugin configuration schema. */
const Config = z.object({
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  graceMs: z.number().default(DEFAULT_GRACE_MS),
  stderrMaxBytes: z.number().default(DEFAULT_STDERR_MAX_BYTES),
  rawOutputMaxBytes: z.number().default(DEFAULT_RAW_OUTPUT_MAX_BYTES),
})

/**
 * Register the `everything_search` tool.
 */
async function apply(ctx: HostContext, config: EverythingConfig): Promise<void> {
  applyEverythingTool(ctx, config)
}

export { apply, Config, inject, name }
export {
  EverythingError,
  DEFAULT_MAX_RESULTS,
  ABSOLUTE_MAX_RESULTS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_GRACE_MS,
  DEFAULT_STDERR_MAX_BYTES,
  DEFAULT_RAW_OUTPUT_MAX_BYTES,
}