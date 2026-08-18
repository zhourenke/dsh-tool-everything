/**
 * @deepseek-ai/dsh-tool-everything
 *
 * A model-facing Everything search tool powered by the `es` command-line client
 * (es.exe). Provides blazing-fast file search on Windows via the Everything
 * search engine, supporting the full Everything search syntax (wildcards, regex,
 * size:, dm:, etc.).
 *
 * @module @deepseek-ai/dsh-tool-everything
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max results to return. */
const DEFAULT_MAX_RESULTS = 50

/** Maximum allowed max_results (safety cap). */
const ABSOLUTE_MAX_RESULTS = 100000

/** Default cooperative tool-call timeout budget in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30000

/** Default terminate grace period for the `es` process (ms). */
const DEFAULT_GRACE_MS = 3000

/** Default cap in bytes on the retained stderr tail. */
const DEFAULT_STDERR_MAX_BYTES = 64 * 1024

/** Default cap in bytes on the raw stdout the tool will parse. */
const DEFAULT_RAW_OUTPUT_MAX_BYTES = 2e7

// ---------------------------------------------------------------------------
// Error vocabulary
// ---------------------------------------------------------------------------

/** Error codes for `everything_search` failures. */
type EverythingErrorCode =
  | 'ES_NOT_FOUND'
  | 'ES_FAILED'
  | 'ES_RAW_OUTPUT_OVERFLOW'
  | 'ES_ABORTED'
  | 'ES_TIMEOUT'

/** Typed search failure extending HarnessError. */
class EverythingError extends HarnessError {
  declare code: EverythingErrorCode

  constructor(message: string, code: EverythingErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// es output column flags
// ---------------------------------------------------------------------------

/** Column flags mapped to `es` command-line arguments. */
const COLUMN_FLAGS: Record<string, string> = {
  path: '-path-column',
  size: '-size',
  date_created: '-dc',
  date_modified: '-dm',
  date_accessed: '-da',
  extension: '-ext',
  attributes: '-attribs',
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
 * Escape a single argument for use in a Windows cmd /c command string.
 *
 * Two distinct rules, verified against cmd's actual parsing of es.exe:
 * - `mode: 'query'` (the Everything search text): every shell-special
 *   character — including SPACE — is escaped with caret (^), cmd's escape
 *   character. Caret-escaping spaces is the only reliable way to keep a
 *   multi-word Everything query (`*.pdf | *.txt`) intact, because cmd splits
 *   arguments on unescaped spaces. Quotes are never used for the query: es
 *   passes them through to Everything, where `"..."` means a literal search,
 *   silently producing zero results.
 * - `mode: 'option'` (the value of an option like `-path`): the value is
 *   wrapped in double quotes, which protects spaces and any `& | < >` inside
 *   it. es strips the quotes from option values (verified: `-path "C:\Program
 *   Files\MacType"` works), so the quoted path is received correctly.
 */
function escapeForCmd(arg: string, mode: 'query' | 'option'): string {
  if (mode === 'option') {
    return `"${arg}"`
  }
  return arg.replace(/[ &|<>^()"]/g, (ch) => `^${ch}`)
}

/**
 * Build the argv array for the `es` command. On Windows, the command is
 * wrapped in `cmd /c chcp 65001 > nul & es` so the console code page is
 * switched to UTF-8 (65001) before es runs, ensuring that filenames with
 * non-ASCII characters are output as UTF-8 rather than the system's ANSI
 * code page (e.g. GB2312 on Chinese Windows).
 */
function buildEsCommand(input: EverythingInput): string[] {
  const esArgs: string[] = ['-json']

  // Limit results
  esArgs.push('-n', String(input.maxResults))

  // Search options
  if (input.regex) esArgs.push('-r')
  if (input.matchCase) esArgs.push('-i')
  if (input.matchWholeWord) esArgs.push('-w')
  if (input.matchPath) esArgs.push('-p')

  // File/folder filters
  if (input.fileOnly) esArgs.push('/a-d')
  if (input.folderOnly) esArgs.push('/ad')

  // Path filter
  if (input.path !== undefined) {
    esArgs.push('-path', escapeForCmd(input.path, 'option'))
  }

  // Attributes filter
  if (input.attributes !== undefined) {
    esArgs.push(`/a${input.attributes}`)
  }

  // Sort
  if (input.sortBy !== undefined) {
    const direction = input.sortDesc ? '-descending' : '-ascending'
    esArgs.push('-sort', `${input.sortBy}-${direction}`)
  }

  // Columns (display options)
  for (const col of input.columns) {
    const flag = COLUMN_FLAGS[col]
    if (flag !== undefined) esArgs.push(flag)
  }

  // The query is the last argument; it may contain cmd special characters
  // (e.g. > in size:>1gb, | in *.pdf|*.txt, spaces in multi-word queries),
  // so every one of them must be caret-escaped. Quotes would be passed to
  // Everything as a literal-search marker and return zero results.
  esArgs.push(escapeForCmd(input.query, 'query'))

  // Build a single cmd /c command string that:
  // 1. Changes the console code page to UTF-8 (65001)
  // 2. Redirects chcp's own banner to nul
  // 3. Runs es with all the arguments
  const cmdLine = `chcp 65001>nul & es ${esArgs.join(' ')}`
  return ['cmd', '/c', cmdLine]
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
 * Format a single result entry into a human-readable string.
 */
function formatEntry(entry: EsResultEntry, input: EverythingInput): string {
  const parts: string[] = []

  // File path
  const filepath = entry.filename ?? entry.path ?? '(unknown)'
  parts.push(filepath)

  // Metadata
  const meta: string[] = []

  if (entry.size !== null && entry.size !== undefined) {
    meta.push(formatSize(entry.size))
  }

  if (entry.date_modified !== null && entry.date_modified !== undefined) {
    meta.push(`modified: ${formatFiletime(entry.date_modified)}`)
  }

  if (entry.date_created !== null && entry.date_created !== undefined) {
    meta.push(`created: ${formatFiletime(entry.date_created)}`)
  }

  if (entry.date_accessed !== null && entry.date_accessed !== undefined) {
    meta.push(`accessed: ${formatFiletime(entry.date_accessed)}`)
  }

  if (entry.extension !== undefined) {
    meta.push(`ext: ${entry.extension}`)
  }

  if (entry.attributes !== undefined) {
    meta.push(`attrib: ${entry.attributes}`)
  }

  if (meta.length > 0) {
    parts.push(`  [${meta.join(', ')}]`)
  }

  return parts.join('\n')
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
 * Parse the `es -json` stdout into an array of result entries.
 */
function parseEsOutput(stdout: string): EsResultEntry[] {
  try {
    const parsed = JSON.parse(stdout)
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
  ctx: Record<string, unknown>,
  exec: { signal: AbortSignal; agent?: { session?: { header?: { cwd?: string } } } },
  toolName: string,
  argv: string[],
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

  const subprocess = (ctx as { subprocess?: { spawn: Function } }).subprocess
  if (subprocess === undefined) {
    throw new EverythingError(
      `${toolName} requires the subprocess service, which is not available`,
      'ES_FAILED',
    )
  }

  const workdir = exec.agent?.session?.header?.cwd ?? process.cwd()
  let handle: { done: Promise<unknown>; collected: { stdout?: { readFrom: Function }; stderr?: { readFrom: Function } } }

  try {
    handle = subprocess.spawn({
      argv,
      cwd: workdir,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: rawOutputMaxBytes },
        stderr: { maxBytes: stderrMaxBytes },
      },
      graceMs,
      signal: exec.signal,
    }) as typeof handle
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

  let outcome: { signal: string | null; exitCode: number | null }
  try {
    outcome = (await handle.done) as typeof outcome
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
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Format the complete result list into a model-facing text block.
 */
function formatResults(entries: EsResultEntry[], input: EverythingInput): string {
  if (entries.length === 0) {
    return 'No files found'
  }

  const lines: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const header = `[${i + 1}]`
    const entry = formatEntry(entries[i], input)
    lines.push(`${header} ${entry}`)
  }

  return lines.join('\n\n')
}

// ---------------------------------------------------------------------------
// Meta types
// ---------------------------------------------------------------------------

interface EverythingSearchMeta {
  total: number
  truncated: boolean
  query: string
  results: string[]
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

function applyEverythingTool(ctx: Record<string, unknown>, config: Record<string, unknown>): void {
  const timeoutMs = Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const graceMs = Number(config.graceMs ?? DEFAULT_GRACE_MS)
  const stderrMaxBytes = Number(config.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES)
  const rawOutputMaxBytes = Number(config.rawOutputMaxBytes ?? DEFAULT_RAW_OUTPUT_MAX_BYTES)

  // Register system prompt guidance
  const systemPrompt = (ctx as { systemPrompt?: { section: Function } }).systemPrompt
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: 'tool:everything_search',
      order: 106,
      text:
        'Use the everything_search tool — not glob or grep — for blazing-fast file search on Windows. ' +
        'It queries the Everything search engine (via es.exe) and supports the full Everything search syntax: ' +
        'wildcards (*, ?), boolean operators (|, !, <...>), content: (file content), size: (file size), ' +
        'dm: (date modified), dc: (date created), da: (date accessed), ext: (extension), ' +
        'path: (path), and more. Results are returned as a numbered list with file paths and optional metadata.',
    })
  }

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
      render: (_args: Record<string, unknown>, value: Record<string, unknown>) => {
        const v = value as {
          total: number
          truncated: boolean
          query: string
          results: Array<Record<string, unknown>>
        }
        if (v.total === 0) {
          return [{ type: 'text' as const, text: 'No files found' }]
        }
        const header = `Found ${v.total} result${v.total === 1 ? '' : 's'} for "${v.query}"${v.truncated ? ` (showing first ${v.results.length})` : ''}`
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
      presentationMeta: (_args: Record<string, unknown>, value: Record<string, unknown>) => {
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
        } as EverythingSearchMeta
      },
    },
    async execute(
      args: Record<string, unknown>,
      exec: { signal: AbortSignal; agent?: { session?: { header?: { cwd?: string } } } },
    ) {
      const input = parseEverythingArgs(args)
      const argv = buildEsCommand(input)

      const run = await runEs(
        ctx,
        exec,
        'everything_search',
        argv,
        rawOutputMaxBytes,
        graceMs,
        stderrMaxBytes,
      )

      if (run.noMatches) {
        return { total: 0, truncated: false, query: input.query, results: [] }
      }

      const entries = parseEsOutput(run.stdout)
      const results = entries.map((entry) => {
        const result: Record<string, unknown> = {
          path: entry.filename ?? entry.path ?? '(unknown)',
        }
        if (entry.size !== null && entry.size !== undefined) result.size = entry.size
        if (entry.date_modified !== null && entry.date_modified !== undefined) {
          result.date_modified = formatFiletime(entry.date_modified)
        }
        if (entry.date_created !== null && entry.date_created !== undefined) {
          result.date_created = formatFiletime(entry.date_created)
        }
        if (entry.date_accessed !== null && entry.date_accessed !== undefined) {
          result.date_accessed = formatFiletime(entry.date_accessed)
        }
        if (entry.extension !== undefined) result.extension = entry.extension
        if (entry.attributes !== undefined) result.attributes = entry.attributes
        return result
      })

      const truncated = results.length > input.maxResults
      const capped = results.slice(0, input.maxResults)

      return {
        total: results.length,
        truncated,
        query: input.query,
        results: capped,
      }
    },
  })

  // Register the tool
  const tools = (ctx as { tools?: { register: Function } }).tools
  if (tools !== undefined) {
    tools.register(tool)
  }
}

// ---------------------------------------------------------------------------
// Plugin exports
// ---------------------------------------------------------------------------

/** Cordis plugin name used by loader diagnostics. */
const name = 'tool-everything'

/** Services required by the tool. */
const inject = ['tools', 'subprocess']

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
async function apply(ctx: Record<string, unknown>, config: Record<string, unknown>): Promise<void> {
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