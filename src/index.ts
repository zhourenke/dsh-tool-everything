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

// The host's own declarations are the contract for everything below. Importing
// them instead of mirroring the shapes locally is what lets `tsc` catch host
// drift; a local structural copy stays green while the host changes underneath
// (PLUGIN_RELEASE_GUIDE.md 「类型定义原则」). `ToolRunContext` carries the agent
// augmentation (`session.header.cwd`) through dsh-tools' own type graph, which
// is the same accessor the host's glob/grep tools read.
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type {
  ToolCallView,
  ToolDefinition,
  ToolResult,
  ToolResultView,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools'


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

/**
 * Warning shown when a content: search was auto-restricted to immediate
 * children. It deliberately names no internal mechanism — the restriction is
 * applied through es's `-parent` option when the path came from the path
 * parameter and through Everything's `parent:` function when it was written
 * inline, and a message that says "via the parent: function" is wrong for the
 * first case. What the caller needs is the effect and the remedy.
 *
 * It does name the offending scope. isBroadPath accepts exactly four shapes —
 * a drive root, `<drive>:\Users` or one level under it, `<drive>:\Documents and
 * Settings` likewise, or the current user home — which is far narrower than "a
 * drive root or the Users tree" suggests: a workspace living at
 * `C:\Users\<user>\<project>` is not restricted at all. A caller that cannot
 * tell which value tripped the guard cannot judge whether a retry with a
 * similar path would be narrowed as well.
 * @param path - the scope as the caller wrote it, or undefined when unavailable.
 * @returns the warning text to attach to the result.
 */
function contentSearchRestrictedWarning(path: string | undefined): string {
  const scope = path === undefined || path === '' ? 'the original path' : `the path "${path}"`
  return (
    'Content search was restricted to immediate children only (one level, no recursion into ' +
    `subdirectories): ${scope} is treated as too broad — a drive root, <drive>:\\Users or one ` +
    'level under it, <drive>:\\Documents and Settings likewise, or the current user home. A ' +
    'recursive content scan across such a scope would freeze the Everything engine. Provide a ' +
    'narrower path, such as path: "C:\\Specific\\Folder", to search recursively.'
  )
}

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

// The subprocess seam's request/handle/outcome vocabulary is imported from
// `@deepseek-ai/dsh-subprocess` rather than mirrored locally, so a host-side
// field change fails `tsc` instead of failing at runtime. The host's
// `SubprocessSpawnSpec` is exactly the request this plugin sends: argv, cwd,
// per-stream stdio retention budgets, a terminate grace period, the
// caller-owned abort signal, and optional extra environment entries merged onto
// the seam's scrubbed parent base — the last of which carries a quoted
// `-path` / `-parent` value past cmd's tokenizer without a quote character ever
// appearing in the command string.

/**
 * Execution context handed to a tool's `execute`. The host's `ToolRunContext` is
 * the contract; the session cwd it carries at `agent.session.header.cwd` is the
 * same value the subprocess seam defaults to, and the same accessor the host's
 * own glob/grep tools read.
 */
type ToolExecContext = ToolRunContext

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
  /** The host's own `ToolDefinition`, so a tool shape that drifts fails `tsc`. */
  tools: { register(definition: ToolDefinition): unknown }
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

/**
 * Detect scopes that are too broad for content searches. Exactly four shapes
 * qualify — a drive root, `<drive>:\Users` or one level under it,
 * `<drive>:\Documents and Settings` likewise, or the current user home — so a
 * deep path such as `C:\Users\<user>\<project>` is NOT broad and must stay
 * recursive. Keep this list and contentSearchRestrictedWarning in step: the
 * warning enumerates the same four shapes to the caller.
 */
function isBroadPath(path: string): boolean {
  if (!path) return false
  // Strip trailing slashes AND wildcard suffixes before checking.
  // The model may write path:C:\* which is semantically the same as path:C:\
  let n = path.replace(/[\\/]+$/, '')
  n = n.replace(/(?:\\[*?])+$/, '')
  // Drive root: C:\, D:\
  if (/^[A-Za-z]:\\?$/.test(n)) return true
  // C:\Users itself, or exactly one level under it (C:\Users\AnyUser) --
  // one level only, never the whole subtree
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

/**
 * Sort fields accepted by `-sort <field>-<direction>`, exactly as the tool
 * schema documents them.
 *
 * This is a whitelist rather than a passthrough because the value is
 * interpolated into a `cmd /c` command string: a `&`, `|` or `>` in a
 * free-form value would be read by cmd as an operator instead of as part of
 * the argument (measured: a sort value of `name & echo X` makes cmd run two
 * commands). Any further field es accepts has to be added here deliberately.
 */
const SORT_FIELDS = [
  'name',
  'path',
  'size',
  'extension',
  'date-created',
  'date-modified',
  'date-accessed',
] as const

/**
 * The DIR attribute letters Everything works with — the same vocabulary
 * `-attribs` reports back through `formatAttributes`. Kept in one place so the
 * `/a` whitelist, the model-facing parameter copy and the error message cannot
 * drift apart.
 *
 * Measured as honoured `/a` filters: R, A and D. The other ten follow from the
 * `-attribs` vocabulary rather than from a direct filter measurement (the probe
 * that would have covered them ran into the Everything hang recorded in
 * DEVELOPMENT.md).
 */
const ATTRIBUTE_LETTERS = 'RHSDAVNTLCOIE'

/**
 * Everything's `/a` attribute filter: those letters, each optionally prefixed
 * with `-` to exclude it (`R`, `R-H`, `RHS`).
 *
 * The LETTERS are checked, not merely the character shape. Measured against the
 * real es, `/aZ` returns exactly the same result set as no filter at all
 * (17807 for `*.md`, identical both ways) — an unknown letter is silently
 * ignored — while `/aD` narrows that same query to 4 entries. A shape-only
 * whitelist such as `[A-Za-z+-]` therefore let a guessed letter (`X` for
 * "executable", say) produce an unfiltered result set that looks entirely
 * normal, which is the worst failure mode this tool has: a plausible wrong
 * answer. es itself rejects non-letters (`/aZZ9` -> `Error 4: Unknown
 * attribute: 9`, exit 4), but those characters never reach it because this
 * regex refuses them first.
 */
const ATTRIBUTE_FILTER = new RegExp(`^(?:[+-]?[${ATTRIBUTE_LETTERS}]){1,32}$`, 'i')

/** The letters above, space separated, for the model-facing error message. */
const ATTRIBUTE_LETTER_LIST = ATTRIBUTE_LETTERS.split('').join(' ')

/** Validate `sort_by` against the fields es sorts by, lower-casing it. */
function parseSortField(raw: unknown): string {
  const value = String(raw).trim().toLowerCase()
  if (!(SORT_FIELDS as readonly string[]).includes(value)) {
    throw new Error(`sort_by must be one of: ${SORT_FIELDS.join(', ')}`)
  }
  return value
}

/** Validate `attributes` against Everything's `/a` filter syntax. */
function parseAttributeFilter(raw: unknown): string {
  const value = String(raw).trim()
  if (!ATTRIBUTE_FILTER.test(value)) {
    throw new Error(
      `attributes must be one of the DIR letters ${ATTRIBUTE_LETTER_LIST}, ` +
        'optionally prefixed with "-" or "+" to exclude or require one ' +
        `(for example "R", "R-H" or "RHS"); got "${value}"`,
    )
  }
  return value
}

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
  /** @internal The scope that tripped isBroadPath, as the caller wrote it (warning text). */
  _contentSearchRestrictedPath?: string
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

  // Both of these land in the command string, so they are narrowed to a known
  // vocabulary before they ever get there (see SORT_FIELDS).
  const sortBy = args.sort_by === undefined ? undefined : parseSortField(args.sort_by)
  const attributes =
    args.attributes === undefined ? undefined : parseAttributeFilter(args.attributes)

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
    sortBy,
    sortDesc: Boolean(args.sort_desc),
    path: args.path !== undefined ? String(args.path) : undefined,
    attributes,
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
 * one OR search (not a pipe), `Windows11 25H2.iso` stays one multi-word query
 * (cmd splits on spaces, but es merges its positional arguments back into the
 * search text), and `100%CD%` stays `100%CD%` instead of being expanded by
 * cmd's `%NAME%` substitution — measured: `cmd /c "echo ^%CD^%"` prints the
 * literal `%CD%`, while the same line without carets prints the working
 * directory. Quotes are NEVER used: es passes them through to Everything,
 * where `"..."` means a literal search and silently returns zero results.
 */
function escapeForCmd(arg: string): string {
  return arg.replace(/[ &|<>^()"%]/g, (ch) => `^${ch}`)
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
 * The `path` argument is always passed as es's `-path` option (or `-parent`
 * for a broad content search), never folded into the query as Everything's
 * `path:` function prefix. Two independent reasons, both measured against
 * es 1.1.0.37:
 *
 * 1. A caret-escaped space still splits the argument. `path:C:\Program^ Files`
 *    reaches es as TWO argv elements, `path:C:\Program` and `Files`, so the
 *    function is handed a truncated path and the search returns nothing —
 *    silently. An earlier revision of this plugin relied on es merging those
 *    back together; it does not.
 * 2. Under -r the fold-in cannot work at all, because es compiles the entire
 *    search string as one regular expression and `path:C:\dir` becomes literal
 *    regex text no filename matches. Measured: `-r "path:<dir> .*"` returns 0
 *    while `-path <dir> -r ".*"` returns the directory's contents.
 *
 * The option route avoids both, but its value may contain spaces and so needs
 * quotes — and a quote inside this command string is escaped by spawn and then
 * torn apart by cmd (an in-string -path value of C:\Program Files reaches es
 * as two argv elements, the first carrying a stray quote). The value therefore
 * travels through PATH_ARG_ENV, whose contents include the quotes, leaving the
 * command string itself quote-free.
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

  // Resolve the directory scope through es options; see buildEsCommand for why
  // the path: function prefix is never used for the path parameter.
  let query = input.query
  let env: Record<string, string> | undefined

  /** Scope the search through an option, handing the value over by environment. */
  const scopeByOption = (option: '-path' | '-parent', value: string): void => {
    env = { ...(env ?? {}), [PATH_ARG_ENV]: `"${value}"` }
    esArgs.push(option, `%${PATH_ARG_ENV}%`)
  }

  if (input.path !== undefined) {
    if (isContentSearch(query) && isBroadPath(input.path)) {
      // -parent is non-recursive, matching the parent: function it replaces.
      scopeByOption('-parent', restrictToImmediateDir(input.path))
      input._contentSearchRestricted = true
      input._contentSearchRestrictedPath = input.path
    } else {
      scopeByOption('-path', input.path)
    }
  } else {
    // Check the query string itself for an inline path: function — this is the
    // caller's own search text, which Everything parses, and it is left as
    // written. Only the path parameter is lifted into the -path option, so an
    // inline value containing spaces stays ambiguous (Everything splits it too).
    // Under -r it is left alone entirely: the caller wrote a regular
    // expression, and "path:" inside one is literal text by regex semantics.
    // Either way it cannot scope a content search, so the guard below applies.
    const inlinePath = input.regex ? undefined : extractInlinePath(query)
    if (inlinePath) {
      if (isBroadPath(inlinePath) && isContentSearch(query)) {
        query = query.replace(
          /\bpath:(\S+?)(?:\s|$)/i,
          (_, p: string) => `parent:${restrictToImmediateDir(p)} `,
        )
        input._contentSearchRestricted = true
        input._contentSearchRestrictedPath = inlinePath
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
  // Zero, negative and non-finite values have no place on the log scale; they
  // are printed as whole bytes so the unit index can never run off the list (a
  // value of 1 PB or more would otherwise index past TB and print "undefined"
  // as its unit).
  if (!Number.isFinite(bytes) || bytes <= 0) return `${bytes} B`
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const size = bytes / 1024 ** i
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/**
 * Convert a Windows FILETIME (100-ns intervals since 1601-01-01 UTC) to an
 * ISO-8601 date string, or undefined when the value is not a usable timestamp.
 *
 * Rejecting instead of formatting matters in both directions: zero is the
 * Windows API's "unset" value and would render as 1601-01-01, a date no caller
 * asked for, and a value outside `Date`'s range makes `toISOString()` throw a
 * RangeError — which fails the whole tool call rather than dropping one
 * metadata field.
 */
function formatFiletime(filetime: unknown): string | undefined {
  if (typeof filetime !== 'number' || !Number.isFinite(filetime) || filetime <= 0) return undefined
  // FILETIME epoch: January 1, 1601 (UTC)
  // Unix epoch: January 1, 1970 (UTC)
  // Difference: 11644473600 seconds
  const UNIX_EPOCH_DIFF = 11644473600
  const unixSeconds = Math.floor(filetime / 10_000_000) - UNIX_EPOCH_DIFF
  const date = new Date(unixSeconds * 1000)
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
}

/**
 * Convert a Windows attribute bitmask (es -attribs outputs a NUMBER) into a
 * DIR-style letter string matching Everything's /a filter syntax
 * (e.g. 32 → 'A' for Archive, 6 → 'HS' for Hidden+System). Non-numeric
 * values pass through as-is; zero attributes render as '-'.
 *
 * The letters below are exactly ATTRIBUTE_LETTERS — the filter whitelist and
 * this map have to stay the same vocabulary, and a test asserts it.
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
): Promise<{ stdout: string; noMatches: boolean }> {
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

  let outcome: SubprocessOutcome
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

  // Acquire the COMPLETE raw stdout, never a silently-partial stream. A truncated
  // capture means the seam could not retain complete stdout within the requested
  // budget; the byte check below additionally guards a seam that never enforces
  // that budget at all — one that hands back everything has no loss to flag.
  // Same two-step shape as the host's own `completeStdout` in
  // dsh-tool-fs-search, so both discovery tools fail alike.
  if (stdout.lossy) {
    throw new EverythingError(
      `${toolName} produced more raw output than the subprocess seam retained within the ${rawOutputMaxBytes}-byte cap; narrow the query and retry`,
      'ES_RAW_OUTPUT_OVERFLOW',
    )
  }

  const text = stdout.text ?? ''
  const inlineBytes = Buffer.byteLength(text, 'utf8')
  if (inlineBytes > rawOutputMaxBytes) {
    throw new EverythingError(
      `${toolName} produced ${inlineBytes} bytes of raw output, over the ${rawOutputMaxBytes}-byte cap; narrow the query and retry`,
      'ES_RAW_OUTPUT_OVERFLOW',
    )
  }

  // An empty JSON array means no matches
  const noMatches = text === '[]' || text.trim() === ''

  return { stdout: text, noMatches }
}

// ---------------------------------------------------------------------------
// Tool presentation (host presentCall/presentResult views)
// ---------------------------------------------------------------------------

/**
 * Byte budget for the replayed presentation metadata. That projection is
 * persisted with the session log, so an exhaustive search
 * (`max_results: 100000`) must not write every discovered path into it. The host
 * bounds its own glob/grep metadata the same way (`capMetaBytes` in
 * dsh-tool-fs-search) and marks the result truncated when it drops anything, so
 * a UI never presents a capped list as complete.
 */
const PRESENTATION_META_MAX_BYTES = 16 * 1024

/**
 * Bound a path list to a UTF-8 byte budget.
 *
 * Each path is measured *as JSON serializes it*, not as the raw string: a
 * Windows path is full of backslashes and every one of them becomes `\\` in the
 * log, so a naive `byteLength(path)` undercounts by roughly the path length —
 * enough to blow the budget it is supposed to enforce. The trailing `+ 1` is
 * the separating comma; charging one for the last element too keeps the
 * estimate one byte conservative rather than one short.
 * @param paths - the paths, in result order.
 * @param maxBytes - the serialized-meta byte budget.
 * @returns the retained prefix, plus whether anything was dropped.
 */
function capPathsForMeta(paths: string[], maxBytes: number): { paths: string[]; truncated: boolean } {
  const kept: string[] = []
  let bytes = 2 // the enclosing brackets
  for (const path of paths) {
    const cost = Buffer.byteLength(JSON.stringify(path), 'utf8') + 1
    if (bytes + cost > maxBytes) break
    bytes += cost
    kept.push(path)
  }
  return { paths: kept, truncated: kept.length < paths.length }
}

/**
 * Tool-call card showing what the model searched for. A pending search has no
 * paths yet, so it stays the host's generic call view carrying `kind: 'search'`
 * (the host documents exactly this for its own search tools).
 */
function everythingSearchPresentCall(args: Record<string, unknown>): ToolCallView | undefined {
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
 * Completed-result card: the host's `SearchPathsResultView` — the same
 * `card: 'search'` / `shape: 'paths'` view its own glob tool returns, so a
 * capable UI renders this as a native search card. Falls back to the generic
 * card for an error or a missing metadata projection.
 */
function everythingSearchPresentResult(
  _args: Record<string, unknown>,
  result: ToolResult,
): ToolResultView | undefined {
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
      'everything_search — whole-disk file search on Windows via Everything (es.exe); NOT scoped to the ' +
      'workspace. Filename and metadata queries are served from its index; content: queries read file ' +
      'contents, which is why content: needs a narrow scope (below). Syntax: wildcards (* ?), boolean logic ' +
      '(| !), <a|b> grouping, quoted phrases, and the functions size:, dm:, dc:, da:, ext:, path:, attributes:, ' +
      'content:. Output is a numbered list of [i] path [metadata]; metadata is attached only for the fields ' +
      'you request via include_* (size, modified, created, accessed, ext, attributes). "Found N" is the TRUE ' +
      'match count, obtained by a separate count pass — NOT the number of rows listed; "(showing first M)" ' +
      'means max_results (default 50, max 100000) capped the list. Prefer glob/grep for workspace-scoped path ' +
      'and content search; use this tool for paths outside the workspace, disk-wide sweeps, and metadata ' +
      'queries.\n\n' +
      '⚠️ content: REQUIRES a scope — the path parameter, or an inline path: in the query. With neither, the ' +
      'call is rejected outright and no search runs at all, so retrying it unchanged cannot help.\n' +
      '⚠️ content: a scope is too wide only if it is a drive root (C:\\), C:\\Users or exactly one level under ' +
      'it, C:\\Documents and Settings likewise, or exactly your home directory. Such a scope is silently ' +
      'narrowed to immediate children — one level, NOT recursive — and the result carries a warning; pass a ' +
      'deeper path to search recursively. Any deeper path, including your workspace, recurses normally.',
  })

  const tool = defineTool({
    name: 'everything_search',
    description:
      'Search files on Windows using the Everything search engine (via es.exe), across the whole disk ' +
      'rather than the workspace alone. Supports the full Everything search syntax including wildcards ' +
      '(*, ?), boolean operators (| !), <a|b> grouping, and the functions size:, dm:, dc:, da:, ext:, ' +
      'path:, attributes:, content:. Returns a numbered list of paths, each carrying the metadata you ' +
      'request via include_*. Results are capped at max_results (default 50, max 100000).',
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
          'DIR-style attribute filter. Allowed letters: ' + ATTRIBUTE_LETTER_LIST + '. ' +
          'The common ones are R (read-only), H (hidden), S (system), D (directory), ' +
          'A (archive). ' +
          'Prefix with - to exclude: "R-H" means read-only AND not hidden. ' +
          'Combine: "RHS" means read-only, hidden, and system. ' +
          'Anything else is rejected, because es silently ignores an unknown letter ' +
          'and would return unfiltered results.',
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
    // A pure read of the Everything index, with no shared mutable state, so the
    // host may run several of these calls in one parallel group. Left absent the
    // tool registry classifies every tool as `exclusive` (dsh-tools:
    // `if (!tool?.isConcurrencySafe) return { kind: 'exclusive' }`), which would
    // serialize concurrent searches for no reason.
    isConcurrencySafe: () => true,
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
      // Both projections read `value` through the type the schema above infers,
      // so a renamed or retyped output field fails `tsc` here instead of
      // silently printing nothing (a local annotation would keep compiling).
      render: (_args, value) => {
        if (value.total === 0 && !value.warning) {
          return [{ type: 'text' as const, text: 'No files found' }]
        }
        let header = ''
        if (value.total > 0) {
          header = `Found ${value.total} result${value.total === 1 ? '' : 's'} for "${value.query}"${value.truncated ? ` (showing first ${value.results.length})` : ''}`
        }
        if (value.warning) {
          header = `${header}\n\n⚠️ ${value.warning}`
        }
        if (value.total === 0) {
          return [{ type: 'text' as const, text: header || 'No files found' }]
        }
        const lines = value.results.map((r, i) => {
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
        // This projection is persisted with the session log, so bound it the way
        // the host bounds its own glob metadata. `truncated` has to reflect the
        // dropped paths, or a UI would present a capped list as the complete
        // result set.
        const capped = capPathsForMeta(
          value.results.map((r) => String(r.path ?? '(unknown)')),
          PRESENTATION_META_MAX_BYTES,
        )
        return {
          total: value.total,
          truncated: value.truncated || capped.truncated,
          query: value.query,
          results: capped.paths,
        }
      },
    },
    async execute(args, exec) {
      const input = parseEverythingArgs(args)
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
            ? { warning: contentSearchRestrictedWarning(input._contentSearchRestrictedPath) }
            : {}),
        }
      }

      const entries = parseEsOutput(run.stdout)
      const results = entries.map((entry) => {
        // A timestamp es cannot supply is dropped rather than rendered as a
        // bogus 1601 date, see formatFiletime.
        const dateModified = formatFiletime(entry.date_modified)
        const dateCreated = formatFiletime(entry.date_created)
        const dateAccessed = formatFiletime(entry.date_accessed)
        return {
          path: entry.filename ?? entry.path ?? '(unknown)',
          ...(entry.size !== null && entry.size !== undefined ? { size: entry.size } : {}),
          ...(dateModified !== undefined ? { date_modified: dateModified } : {}),
          ...(dateCreated !== undefined ? { date_created: dateCreated } : {}),
          ...(dateAccessed !== undefined ? { date_accessed: dateAccessed } : {}),
          // es reports "extension":null for a directory, "" for an extensionless
          // file, and the extension otherwise (measured against the real es with
          // `-json -ext`). The declared output schema types this field as a
          // string, so letting a null through makes the harness reject the WHOLE
          // result -- every row, not just the offending one. Emit it only when it
          // really is a string; a directory is recognisable by its trailing "\".
          ...(typeof entry.extension === 'string' ? { extension: entry.extension } : {}),
          // formatAttributes always returns a string (even for null), so this one
          // cannot leak a non-string into the schema.
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
          ? { warning: contentSearchRestrictedWarning(input._contentSearchRestrictedPath) }
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

/** Plugin configuration fields and their defaults. */
const configSchema = z.object({
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  graceMs: z.number().default(DEFAULT_GRACE_MS),
  stderrMaxBytes: z.number().default(DEFAULT_STDERR_MAX_BYTES),
  rawOutputMaxBytes: z.number().default(DEFAULT_RAW_OUTPUT_MAX_BYTES),
})

/**
 * Plugin configuration schema.
 *
 * The `as unknown as ReturnType<typeof z.any>` widening keeps this exported
 * declaration portable, and the three forms were measured rather than guessed:
 *
 * - Exporting the schema as-is (`const Config = configSchema`) is the form to
 *   try first. It compiles while this package and the host resolve the SAME
 *   schemastery copy (measured after pinning `~3.18.4`, the line every DSH
 *   0.1.7-rc.2 package declares), and it goes red the moment the two copies
 *   split (`TS2883: The inferred type of 'Config' cannot be named without a
 *   reference to 'Schema'`) — which is a signal to re-decide, not a bug.
 * - Annotating it directly fails either way: `Schema`'s `data` parameter is
 *   contravariant, so `Schema<ObjectS<…>>` is not assignable to
 *   `Schema<unknown, unknown, 'plain'>` (`TS2322`).
 * - Widening through the double assertion always compiles, at the cost of not
 *   checking the export at all.
 *
 * The assertion is kept because the split is something the host can cause on
 * its own schedule (a DSH upgrade to a new schemastery line), and the emitted
 * declaration then stays portable instead of turning a dependency bump into a
 * build break. PLUGIN_RELEASE_GUIDE.md 「DSH 升级后的复核」 greps for exactly
 * this expression, so do not delete it as a redundant cast.
 * @see PLUGIN_RELEASE_GUIDE.md 「类型定义原则」
 */
const Config = configSchema as unknown as ReturnType<typeof z.any>

/**
 * Register the `everything_search` tool.
 */
function apply(ctx: HostContext, config: EverythingConfig): void {
  applyEverythingTool(ctx, config)
}

// Only the cordis contract is exported: the host loads `apply`, `Config`,
// `inject` and `name`, and the constants below stay private to the bundle.
export { apply, Config, inject, name }