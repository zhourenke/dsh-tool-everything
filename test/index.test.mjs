/**
 * Host-half product evaluation for @zhourenke/dsh-tool-everything.
 *
 * This imports the SHIPPED artifact (`../lib/index.js`), never `src/`: a stale
 * or broken build must fail here rather than inside the DSH loader at startup.
 * `pnpm test` chains `pnpm run build` first for that reason.
 *
 * `es` itself is not required: the subprocess seam is mocked, so the suite
 * exercises argument building, the content-search safety guard, es stdout
 * parsing, and the presentation surface deterministically.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config, inject, name } from '../lib/index.js'

/** The host's own prompt-section registry, mirrored for the ordering tests. */
const HOST_SECTION_ORDERS = { TOOL_GLOB: 1400, TOOL_GREP: 1500, TOOL_JOBS: 1600 }

/** Minimal in-memory stand-in for the host services this plugin injects. */
function createHarness(options = {}) {
  const spawnCalls = []
  const tools = []
  const sections = []
  const warnings = []
  const orders = options.orders ?? HOST_SECTION_ORDERS
  const respond =
    options.respond ??
    (() => ({
      done: Promise.resolve({ signal: null, exitCode: 0 }),
      collected: {
        stdout: { readFrom: () => ({ text: '[]', lossy: false }) },
        stderr: { readFrom: () => ({ text: '', lossy: false }) },
      },
    }))

  const ctx = {
    systemPrompt: {
      section: (section) => {
        // Mirrors dsh-system-prompt's own validation, so a non-finite order
        // fails here exactly as it would take the plugin down at DSH startup.
        if (!Number.isFinite(section.order)) {
          throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
        }
        sections.push(section)
      },
      getSectionOrder: (sectionName) => orders[sectionName],
    },
    tools: { register: (tool) => tools.push(tool) },
    subprocess: {
      spawn: (spec) => {
        spawnCalls.push(spec)
        return respond(spec)
      },
    },
    logger: { warn: (message) => warnings.push(message) },
  }
  return { ctx, tools, sections, spawnCalls, warnings }
}

/** Apply the plugin to a fresh harness and return the registered tool. */
async function loadTool(harness, config = {}) {
  await apply(harness.ctx, new Config(config))
  assert.equal(harness.tools.length, 1, 'apply must register exactly one tool')
  return harness.tools[0]
}

/** A tool-execution context carrying a live, unaborted signal. */
function execContext() {
  return { signal: new AbortController().signal }
}

/** A spawn responder that reports one successful run with the given stdout. */
function succeedWith(stdout) {
  return () => ({
    done: Promise.resolve({ signal: null, exitCode: 0 }),
    collected: {
      stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', lossy: false }) },
    },
  })
}

/**
 * A responder that answers the listing and the follow-up `-get-result-count`
 * query with different output, the way the two real es invocations differ.
 */
function listingThenCount(listingStdout, countStdout) {
  return (spec) =>
    spec.argv[2].includes('-get-result-count')
      ? succeedWith(countStdout)()
      : succeedWith(listingStdout)()
}

/**
 * A responder whose listing succeeds immediately while the follow-up count
 * never finishes on its own: it settles only when the seam aborts it, which is
 * what the real subprocess seam does when the caller's signal fires (the
 * plugin's count deadline aborts that same signal). Models a wedged `es`.
 *
 * The settled outcome matches the seam's declared vocabulary
 * (`SubprocessOutcome`: `exitCode` null when a signal killed the process), and
 * the behaviour is not invented: `dsh-subprocess` documents that "the spec's
 * abort signal" starts termination of the provider's managed range, and a live
 * observation backs it — when the host aborted five wedged calls on
 * 2026-09-28, not one `es` process survived.
 */
function listingThenHangingCount(listingStdout) {
  return (spec) => {
    if (!spec.argv[2].includes('-get-result-count')) return succeedWith(listingStdout)()
    return hangingUntilAborted(spec.signal)
  }
}

/**
 * The seam's side of a killed process: settle when the spec's signal aborts —
 * and settle AT ONCE when it is already aborted, because `abort()` on an
 * aborted signal fires no further event. A mock that only listens would deadlock
 * on the cancel-during-spawn case, which the real seam handles by terminating
 * the managed range it just created.
 */
function hangingUntilAborted(signal) {
  return {
    done: new Promise((resolve) => {
      const settle = () => resolve({ signal: 'SIGTERM', exitCode: null })
      if (signal.aborted) {
        settle()
        return
      }
      signal.addEventListener('abort', settle, { once: true })
    }),
    collected: {
      stdout: { readFrom: () => ({ text: '', lossy: false }) },
      stderr: { readFrom: () => ({ text: '', lossy: false }) },
    },
  }
}

/** The `cmd /c` command string of the first spawn (or of `index`, 0-based). */
function commandLine(harness, index = 0) {
  assert.ok(harness.spawnCalls.length > index, `expected at least ${index + 1} spawn call(s)`)
  const argv = harness.spawnCalls[index].argv
  assert.equal(argv[0], 'cmd')
  assert.equal(argv[1], '/c')
  return argv[2]
}

// ---------------------------------------------------------------------------
// Cordis plugin contract (host-half load path)
// ---------------------------------------------------------------------------

test('the shipped artifact exposes the cordis plugin contract', () => {
  assert.equal(typeof apply, 'function')
  assert.equal(name, 'tool-everything')
  assert.deepEqual(inject, ['tools', 'subprocess', 'systemPrompt'])
})

test('the configuration schema defaults every cap', () => {
  assert.deepEqual(new Config({}), {
    timeoutMs: 1200000,
    countTimeoutMs: 5000,
    graceMs: 3000,
    stderrMaxBytes: 65536,
    rawOutputMaxBytes: 20000000,
  })
})

test('apply registers the tool and its system-prompt section', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  assert.equal(tool.name, 'everything_search')

  assert.equal(harness.sections.length, 1)
  assert.equal(harness.sections[0].name, 'tool:everything_search')
  assert.ok(
    Number.isFinite(harness.sections[0].order),
    'section order must be finite or dsh-system-prompt rejects it',
  )
})

// ---------------------------------------------------------------------------
// System-prompt section placement
// ---------------------------------------------------------------------------

test('the guidance section is placed inside the host tool band', async () => {
  const harness = createHarness()
  await loadTool(harness)
  const { order } = harness.sections[0]

  assert.equal(order, 1510, 'TOOL_GREP 1500 plus the 10-slot offset')
  assert.ok(order >= 1000 && order < 3000, 'TOOL_* sections occupy 1000-2900')
  assert.ok(order > HOST_SECTION_ORDERS.TOOL_GLOB, 'must follow the discovery family')
  assert.ok(order < HOST_SECTION_ORDERS.TOOL_JOBS, 'must precede the jobs family')
})

test('the section order follows the host registry when DSH reshuffles it', async () => {
  const harness = createHarness({ orders: { TOOL_GREP: 2500 } })
  await loadTool(harness)

  assert.equal(
    harness.sections[0].order,
    2510,
    'the anchor is read at runtime, never copied as a literal',
  )
})

test('a missing anchor falls back to a finite tool-band order instead of throwing', async () => {
  const harness = createHarness({ orders: {} })
  await loadTool(harness)

  const { order } = harness.sections[0]
  assert.ok(Number.isFinite(order), 'undefined + offset would be NaN and section() would throw')
  assert.equal(order, 1510)
})

// ---------------------------------------------------------------------------
// The content: safety guard — the plugin's most consequential behaviour
// ---------------------------------------------------------------------------

test('a content: search with no path is rejected before es is spawned', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  await assert.rejects(
    () => tool.execute({ query: 'content:hello' }, execContext()),
    (error) => error.code === 'ES_FAILED',
  )
  assert.equal(harness.spawnCalls.length, 0, 'a rejected search must never spawn es')
})

test('a present-but-empty path is rejected before es is spawned', async () => {
  // The contract is "absent means no restriction", so sending "" (or whitespace)
  // is a caller bug, not a request for a whole-disk search. Both shapes must be
  // rejected by the same guard, and neither may reach es.
  const harness = createHarness()
  const tool = await loadTool(harness)

  for (const badPath of ['', '   ']) {
    await assert.rejects(
      () => tool.execute({ query: '*playwright*', path: badPath }, execContext()),
      /path must be a non-empty string when given/,
    )
  }
  assert.equal(harness.spawnCalls.length, 0, 'a rejected search must never spawn es')
})

test('an empty query is rejected before es is spawned', async () => {
  // Only these two shapes reach the tool: the host's validator already rejects a
  // missing or non-string query with its own message.
  const harness = createHarness()
  const tool = await loadTool(harness)

  for (const badQuery of ['', '   ']) {
    await assert.rejects(
      () => tool.execute({ query: badQuery }, execContext()),
      /query must be a non-empty string/,
    )
  }
  assert.equal(harness.spawnCalls.length, 0, 'a rejected search must never spawn es')
})

test('a content: search on a drive root is restricted to immediate children', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: 'content:hello', path: 'C:\\' }, execContext())
  const line = commandLine(harness)

  assert.match(line, /-parent %EVERYTHING_TOOL_PATH_ARG%/, 'broad content search must use -parent')
  assert.doesNotMatch(line, /-path /, 'a broad content search must not be scoped recursively')
  assert.equal(harness.spawnCalls[0].env.EVERYTHING_TOOL_PATH_ARG, '"C:"')
  assert.equal(typeof result.warning, 'string')
  assert.ok(result.warning.length > 0)
  // The warning must name the scope as the caller wrote it (with its trailing
  // slash), not the value the guard derived after stripping it.
  assert.ok(
    result.warning.includes('the path "C:\\"'),
    `the warning must name the offending scope, got: ${result.warning}`,
  )
})

test('the restriction warning names no internal mechanism', async () => {
  // The restriction is applied through es's -parent option when the path came
  // from the path parameter, but through Everything's parent: function when it
  // was written inline — so a message naming either one is wrong for the other.
  const harness = createHarness()
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: 'content:hello', path: 'C:\\' }, execContext())

  assert.doesNotMatch(result.warning, /parent:/, 'the warning must not name a mechanism that varies by branch')
  assert.match(result.warning, /immediate children/)
  assert.match(result.warning, /narrower path/)
})

test('a content: search on the Users tree is restricted too', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  await tool.execute({ query: 'content:hello', path: 'C:\\Users' }, execContext())

  assert.match(commandLine(harness), /-parent %EVERYTHING_TOOL_PATH_ARG%/)
  assert.equal(harness.spawnCalls[0].env.EVERYTHING_TOOL_PATH_ARG, '"C:\\Users"')
})

test('a content: search on a narrow path stays recursive and adds no warning', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  const result = await tool.execute(
    { query: 'content:hello', path: 'C:\\Specific\\Folder' },
    execContext(),
  )

  assert.match(commandLine(harness), /-path %EVERYTHING_TOOL_PATH_ARG%/)
  assert.equal(harness.spawnCalls[0].env.EVERYTHING_TOOL_PATH_ARG, '"C:\\Specific\\Folder"')
  assert.equal(result.warning, undefined)
})

test('an inline path: in the query is guarded as well', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: 'path:C:\\ content:hello' }, execContext())
  assert.match(commandLine(harness), /parent:C:/)
  assert.equal(typeof result.warning, 'string')
  // The inline route must name the inline value, not the (absent) path parameter.
  assert.ok(
    result.warning.includes('the path "C:\\"'),
    `the warning must name the inline scope, got: ${result.warning}`,
  )
})

test('the restriction warning states the four scopes actually treated as too broad', async () => {
  // "a drive root or the Users tree" over-stated the guard: a workspace living
  // at C:\Users\<user>\<project> is not restricted at all, and a caller reading
  // the old wording could avoid content: searches that were never narrowed.
  const harness = createHarness()
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: 'content:hello', path: 'C:\\Users' }, execContext())

  assert.match(result.warning, /a drive root/)
  assert.match(result.warning, /Users or one level under it/, 'the Users scope is one level, not a tree')
  assert.match(result.warning, /Documents and Settings/)
  assert.match(result.warning, /current user home/)
  assert.doesNotMatch(result.warning, /Users tree/, 'the old over-statement must be gone')
})

test('the broad-path guard does not apply to a name search', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: '*.pdf', path: 'C:\\' }, execContext())
  const line = commandLine(harness)

  assert.match(line, /-path %EVERYTHING_TOOL_PATH_ARG%/, 'a name search is scoped, just not depth-limited')
  assert.doesNotMatch(line, /-parent/, 'a name search is never depth-restricted')
  assert.equal(result.warning, undefined)
})

// ---------------------------------------------------------------------------
// Command construction
// ---------------------------------------------------------------------------

test('the console code page is switched to UTF-8 before es runs', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  await tool.execute({ query: '*.pdf' }, execContext())
  assert.match(commandLine(harness), /^chcp 65001>nul & es /)
})

test('shell-special characters in the query are caret-escaped', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  await tool.execute({ query: 'size:>1gb' }, execContext())
  assert.match(commandLine(harness), /size:\^>1gb/)
})

test('spaces are caret-escaped rather than quoted', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  await tool.execute({ query: 'Windows11 25H2.iso' }, execContext())
  const line = commandLine(harness)

  assert.match(line, /Windows11\^ 25H2\.iso/)
  assert.doesNotMatch(line, /"/, 'quotes would turn the query into a literal search')
})

test('percent signs are caret-escaped so cmd cannot expand them', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  await tool.execute({ query: '100%CD%' }, execContext())
  const line = commandLine(harness)

  // Measured: `cmd /c "echo ^%CD^%"` prints the literal `%CD%`, while the same
  // line without carets prints the working directory — so an unescaped
  // `%NAME%` in a query silently becomes something else.
  assert.match(line, /100\^%CD\^%/)
  assert.doesNotMatch(line, /100%CD%/, 'an unescaped %NAME% would be expanded by cmd')
})

test('sort_by is narrowed to the fields es sorts by before it reaches cmd', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  await tool.execute({ query: '*.pdf', sort_by: 'Date-Modified' }, execContext())
  assert.match(commandLine(harness), /-sort date-modified-ascending/)

  // Measured through this tool: the free-form value used to reach the command
  // string verbatim, so `name & echo X` made cmd run two commands.
  const hostile = createHarness()
  const hostileTool = await loadTool(hostile)
  await assert.rejects(
    () => hostileTool.execute({ query: '*.pdf', sort_by: 'name & echo INJECTED' }, execContext()),
    /sort_by must be one of: name, path, size, extension, date-created, date-modified, date-accessed/,
  )
  assert.equal(hostile.spawnCalls.length, 0, 'a rejected sort must never reach the shell')
})

test('attributes is narrowed to the DIR letters es actually filters by', async () => {
  // An accepted value reaches es as /a<letters>. es matches the letters
  // case-insensitively (the folder-only filter is emitted as lowercase /ad),
  // so lower case must keep working.
  for (const [given, emitted] of [['R-H', /\/aR-H/], ['r-h', /\/ar-h/]]) {
    const accepted = createHarness()
    const acceptedTool = await loadTool(accepted)
    await acceptedTool.execute({ query: '*.pdf', attributes: given }, execContext())
    assert.match(commandLine(accepted), emitted)
  }

  // `Z` has the right SHAPE but is not a letter es knows. Measured through this
  // tool: `attributes: 'Z'` returned the same 17807 results as no filter at
  // all, while `attributes: 'D'` narrowed that same query to 4 — es silently
  // ignores an unknown letter, so a guessed one (`X` for "executable") would
  // hand back a normal-looking, unfiltered result set.
  for (const bad of ['Z', 'R & echo INJECTED']) {
    const hostile = createHarness()
    const hostileTool = await loadTool(hostile)
    await assert.rejects(
      () => hostileTool.execute({ query: '*.pdf', attributes: bad }, execContext()),
      /attributes must be one of the DIR letters R H S D A V N T L C O I E/,
    )
    assert.equal(hostile.spawnCalls.length, 0, `a rejected filter ("${bad}") must never reach the shell`)
  }
})

test('the attribute map and the filter whitelist cover the same letters', async () => {
  const harness = createHarness({
    respond: succeedWith(JSON.stringify([{ filename: 'C:\\a.txt', attributes: 0xffff }])),
  })
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: '*.txt', include_attributes: true }, execContext())
  // 0xffff sets every bit the map knows, so this is its whole vocabulary.
  assert.equal(result.results[0].attributes, 'RHSDAVNTLCOIE')

  // Feeding that vocabulary straight back as a filter must be accepted: the
  // letters the tool reports are exactly the letters it filters by. Adding a
  // letter to only one of the two lists fails this test.
  const accepted = createHarness()
  const acceptedTool = await loadTool(accepted)
  await acceptedTool.execute({ query: '*.txt', attributes: 'RHSDAVNTLCOIE' }, execContext())
  assert.match(commandLine(accepted), /\/aRHSDAVNTLCOIE/)
})

test('-r is emitted last, immediately before the query', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  await tool.execute({ query: '.*\\.pdf$', regex: true }, execContext())
  const line = commandLine(harness)

  assert.ok(
    line.indexOf('-r') > line.indexOf('-n'),
    '-r must follow the capped options or es consumes them as search text',
  )
})

// ---------------------------------------------------------------------------
// Path scoping
//
// The path parameter never becomes a `path:` prefix in the query text. Two
// measured reasons (es 1.1.0.37): a caret-escaped space still splits the
// argument, so `path:C:\Program^ Files` arrives as TWO argv elements and the
// function gets a truncated path; and under -r the whole search string is one
// regular expression, so `path:<dir>` is literal text that matches nothing.
// Either way the search returned nothing, silently.
// ---------------------------------------------------------------------------

test('regex mode scopes through the -path option, not a path: prefix', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  await tool.execute({ query: '^index\\.ts$', regex: true, path: 'C:\\proj\\src' }, execContext())
  const line = commandLine(harness)

  assert.ok(line.includes('-path %EVERYTHING_TOOL_PATH_ARG%'), `expected a -path option, got: ${line}`)
  assert.ok(!line.includes('path:C:'), 'the directory must not be folded into the regex')
  assert.equal(harness.spawnCalls[0].env.EVERYTHING_TOOL_PATH_ARG, '"C:\\proj\\src"')
})

test('a space-containing path survives as one quoted argument', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  await tool.execute(
    { query: '^pycharm64\\.exe$', regex: true, path: 'C:\\Program Files\\JetBrains' },
    execContext(),
  )

  assert.equal(
    harness.spawnCalls[0].env.EVERYTHING_TOOL_PATH_ARG,
    '"C:\\Program Files\\JetBrains"',
    'the quotes live in the environment value so cmd cannot tear the path apart',
  )
  assert.ok(
    !commandLine(harness).includes('"'),
    'a quote inside the command string is escaped as \\" by spawn and then mangled by cmd',
  )
})

test('regex mode restricts a broad content search with -parent', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: 'content:needle', regex: true, path: 'C:\\' }, execContext())
  const line = commandLine(harness)

  assert.ok(line.includes('-parent %EVERYTHING_TOOL_PATH_ARG%'), `expected -parent, got: ${line}`)
  assert.ok(line.includes('%EVERYTHING_TOOL_PATH_ARG%'), 'the scope value travels via the environment')
  assert.ok(
    harness.spawnCalls[0].env.EVERYTHING_TOOL_PATH_ARG.startsWith('"'),
    'the environment value carries its own quotes',
  )
  assert.ok(result.warning, 'a restricted content search still warns')
})

test('the path parameter always goes through the -path option', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  await tool.execute({ query: '*.ts', path: 'C:\\proj' }, execContext())
  const line = commandLine(harness)

  assert.match(line, /-path %EVERYTHING_TOOL_PATH_ARG%/)
  assert.ok(!line.includes('path:C:\\proj'), 'the path must not be folded into the query text')
  assert.equal(harness.spawnCalls[0].env.EVERYTHING_TOOL_PATH_ARG, '"C:\\proj"')
})

test('a space-containing path works outside regex mode too', async () => {
  // This mode used to fold the path in as a `path:` prefix with caret-escaped
  // spaces, which still split into separate argv elements: es received
  // ["path:C:\Program", "Files\Internet", "Explorer", "*.exe"], handed the
  // path function a truncated path, and returned nothing -- silently.
  const harness = createHarness()
  const tool = await loadTool(harness)

  await tool.execute({ query: '*.exe', path: 'C:\\Program Files\\Internet Explorer' }, execContext())
  const line = commandLine(harness)

  assert.match(line, /-path %EVERYTHING_TOOL_PATH_ARG%/)
  assert.equal(
    harness.spawnCalls[0].env.EVERYTHING_TOOL_PATH_ARG,
    '"C:\\Program Files\\Internet Explorer"',
    'the value must arrive as one argv element, which only the quoted env route achieves',
  )
  assert.ok(!line.includes('"'), 'and the command string itself must stay quote-free')
})

// ---------------------------------------------------------------------------
// es stdout parsing
// ---------------------------------------------------------------------------

test('es JSON output is mapped into the model-facing result', async () => {
  const harness = createHarness({
    respond: succeedWith(
      JSON.stringify([{ filename: 'C:\\a\\one.pdf', size: 2048, attributes: 32 }]),
    ),
  })
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: '*.pdf' }, execContext())

  assert.equal(result.total, 1)
  assert.equal(result.truncated, false)
  assert.equal(result.query, '*.pdf')
  assert.equal(result.results[0].path, 'C:\\a\\one.pdf')
  assert.equal(result.results[0].size, 2048)
  assert.equal(result.results[0].attributes, 'A')
})

test('the es double-array JSON quirk is unwrapped', async () => {
  const harness = createHarness({
    respond: succeedWith(JSON.stringify([[{ filename: 'C:\\x.pdf' }]])),
  })
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: '*.pdf', include_size: true }, execContext())
  assert.equal(result.total, 1)
  assert.equal(result.results[0].path, 'C:\\x.pdf')
})

test('FILETIME values are rendered as ISO-ish local timestamps', async () => {
  // 2026-01-02T03:04:05Z expressed as Windows FILETIME (100-ns ticks since 1601).
  const filetime = (Date.UTC(2026, 0, 2, 3, 4, 5) / 1000 + 11644473600) * 10_000_000
  const harness = createHarness({
    respond: succeedWith(JSON.stringify([{ filename: 'C:\\a.pdf', date_modified: filetime }])),
  })
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: '*.pdf' }, execContext())
  assert.equal(result.results[0].date_modified, '2026-01-02 03:04:05')
})

test('a timestamp es cannot supply is dropped instead of rendered as 1601', async () => {
  const harness = createHarness({
    respond: succeedWith(
      JSON.stringify([{ filename: 'C:\\a.pdf', date_modified: 0, date_created: null }]),
    ),
  })
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: '*.pdf' }, execContext())
  assert.equal('date_modified' in result.results[0], false)
  assert.equal('date_created' in result.results[0], false)
  assert.equal(result.results[0].path, 'C:\\a.pdf')
})

test('a non-numeric timestamp cannot fail the whole call', async () => {
  // Without the type guard this reached `new Date(NaN).toISOString()` and threw
  // RangeError "Invalid time value", failing the entire call over one field.
  const harness = createHarness({
    respond: succeedWith(JSON.stringify([{ filename: 'C:\\a.pdf', date_modified: 'n/a' }])),
  })
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: '*.pdf' }, execContext())
  assert.equal('date_modified' in result.results[0], false)
  assert.equal(result.results[0].path, 'C:\\a.pdf')
})

test('a directory match does not leak a null extension into the output', async () => {
  // Measured against the real es (Everything CLI) with `-json -ext`:
  //   directory            -> "extension":null
  //   extensionless file   -> "extension":""
  //   normal file          -> "extension":"js"
  // The declared output schema types `extension` as a string, so a null used to
  // make the harness reject the WHOLE result, not just the offending row:
  //   tool "everything_search" returned invalid output:
  //   "value.results[0].extension" must be a string
  // Since folder_only defaults to false, directories are matched by default, so
  // every query whose hits included a folder failed outright.
  const harness = createHarness({
    respond: succeedWith(
      JSON.stringify([
        {
          filename: 'C:\\proj\\node_modules\\playwright-core\\',
          size: 0,
          extension: null,
          attributes: 16,
        },
        { filename: 'C:\\proj\\LICENSE', extension: '' },
        { filename: 'C:\\proj\\a.js', extension: 'js' },
      ]),
    ),
  })
  const tool = await loadTool(harness)

  const result = await tool.execute(
    { query: '*playwright*', include_extension: true, include_size: true },
    execContext(),
  )

  assert.equal(result.results.length, 3)
  assert.ok(
    !('extension' in result.results[0]),
    'a directory must omit the extension key rather than emit null',
  )
  assert.equal(result.results[1].extension, '', 'an extensionless file reports an empty string')
  assert.equal(result.results[2].extension, 'js')
  assert.ok(result.results[0].path.endsWith('\\'), 'a directory is recognisable by its trailing separator')

  // The invariant the host schema actually enforces: no value may be null.
  for (const [i, row] of result.results.entries()) {
    for (const [key, value] of Object.entries(row)) {
      assert.notEqual(value, null, `results[${i}].${key} must not be null`)
    }
  }
})

// es caps its output at -n, so `results.length > max_results` can never happen
// and a full listing is indistinguishable from a complete one without asking.
// These three cases cover the recount that closes that gap.
test('a listing that fills the limit is recounted exactly', async () => {
  const listed = Array.from({ length: 2 }, (_, i) => ({ filename: `C:\\f${i}.pdf` }))
  const harness = createHarness({
    respond: listingThenCount(JSON.stringify(listed), '64546'),
  })
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: '*.pdf', max_results: 2 }, execContext())

  assert.equal(result.total, 64546, 'the true match count, not the number returned')
  assert.equal(result.truncated, true)
  assert.equal(result.results.length, 2)
  assert.equal(harness.spawnCalls.length, 2, 'one listing plus one count query')
})

test('a listing shorter than the limit is its own total, with no extra query', async () => {
  const listed = Array.from({ length: 2 }, (_, i) => ({ filename: `C:\\f${i}.pdf` }))
  const harness = createHarness({ respond: succeedWith(JSON.stringify(listed)) })
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: '*.pdf', max_results: 10 }, execContext())

  assert.equal(result.total, 2)
  assert.equal(result.truncated, false)
  assert.equal(harness.spawnCalls.length, 1, 'the count query costs a spawn, so skip it when unnecessary')
})

test('a full listing whose count cannot be read reports that more may exist', async () => {
  const listed = Array.from({ length: 2 }, (_, i) => ({ filename: `C:\\f${i}.pdf` }))
  const harness = createHarness({
    respond: listingThenCount(JSON.stringify(listed), 'not a number'),
  })
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: '*.pdf', max_results: 2 }, execContext())

  assert.equal(result.truncated, true, 'degrade to "may be more", never assert a capped count as the total')
  assert.equal(result.total, 2)
})

test('a count that never answers is abandoned on its own budget, keeping the listing', async () => {
  const listed = Array.from({ length: 2 }, (_, i) => ({ filename: `C:\\f${i}.pdf` }))
  const harness = createHarness({ respond: listingThenHangingCount(JSON.stringify(listed)) })
  const tool = await loadTool(harness, { countTimeoutMs: 60 })

  const started = Date.now()
  const result = await tool.execute({ query: '*.pdf', max_results: 2 }, execContext())
  const elapsed = Date.now() - started

  assert.equal(harness.spawnCalls.length, 2, 'the count query is still attempted')
  assert.equal(result.results.length, 2, 'the listing survives a count that never answers')
  assert.equal(result.truncated, true, 'an unreadable count degrades to "more may exist"')
  assert.equal(result.total, 2)
  assert.ok(elapsed < 2000, `the count deadline must fire on its own budget; took ${elapsed} ms`)
  // The count aborts on a signal derived from the caller's, so giving up on the
  // count never cancels the call itself.
  assert.equal(harness.spawnCalls[0].signal.aborted, false, "the caller's signal stays clean")
  assert.equal(harness.spawnCalls[1].signal.aborted, true, "the count's own deadline fired")
})

// The two cases below pin the distinction the host's `timeoutOf` buys: a count
// that ran out of THIS tool's budget is not the same event as one the caller
// cancelled, and the diagnostics must not confuse them. Both run through
// `@deepseek-ai/dsh-timeout`'s `deadline`, whose timer is not `unref`'d — so a
// missed disposer would leave an armed timer behind, which the second case
// checks directly.
test('a count that exhausts its budget is reported as this tool\'s own budget', async () => {
  const listed = Array.from({ length: 2 }, (_, i) => ({ filename: `C:\\f${i}.pdf` }))
  const harness = createHarness({ respond: listingThenHangingCount(JSON.stringify(listed)) })
  const tool = await loadTool(harness, { countTimeoutMs: 60 })

  await tool.execute({ query: '*.pdf', max_results: 2 }, execContext())

  assert.equal(harness.warnings.length, 1, 'a degraded count is reported once')
  assert.match(harness.warnings[0], /exceeded its 60ms budget/)
})

test('a count the caller cancelled is not blamed on this tool\'s budget, and leaves no timer', async () => {
  const listed = Array.from({ length: 2 }, (_, i) => ({ filename: `C:\\f${i}.pdf` }))
  const caller = new AbortController()
  const harness = createHarness({
    respond: (spec) => {
      if (!spec.argv[2].includes('-get-result-count')) return succeedWith(JSON.stringify(listed))()
      // The caller walks away while the count is still in flight, so the signal
      // that ends it is the caller's — not the 60s budget armed below.
      caller.abort()
      return hangingUntilAborted(spec.signal)
    },
  })
  const tool = await loadTool(harness, { countTimeoutMs: 60000 })
  const timersBefore = process.getActiveResourcesInfo().filter((t) => t === 'Timeout').length

  const result = await tool.execute({ query: '*.pdf', max_results: 2 }, { signal: caller.signal })

  assert.equal(result.truncated, true, 'a cancelled count still degrades instead of failing the call')
  assert.equal(harness.warnings.length, 1)
  assert.match(harness.warnings[0], /returned no total/)
  assert.doesNotMatch(harness.warnings[0], /exceeded its/, 'the budget never fired, so it must not be named')
  const timersAfter = process.getActiveResourcesInfo().filter((t) => t === 'Timeout').length
  assert.ok(
    timersAfter <= timersBefore,
    `the count budget must dispose its ${60000}ms timer; armed ${timersBefore} -> ${timersAfter}`,
  )
})

test('a listing that exactly equals the limit is not called truncated', async () => {
  const listed = Array.from({ length: 2 }, (_, i) => ({ filename: `C:\\f${i}.pdf` }))
  const harness = createHarness({
    respond: listingThenCount(JSON.stringify(listed), '2'),
  })
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: '*.pdf', max_results: 2 }, execContext())

  assert.equal(result.total, 2)
  assert.equal(result.truncated, false, 'the recount proves the listing was complete')
})

test('an empty es result is reported as zero matches', async () => {
  const harness = createHarness({ respond: succeedWith('[]') })
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: '*.pdf' }, execContext())
  assert.equal(result.total, 0)
  assert.deepEqual(result.results, [])
  assert.equal(result.warning, undefined)
})

test('malformed es output surfaces as ES_FAILED', async () => {
  const harness = createHarness({ respond: succeedWith('not json at all') })
  const tool = await loadTool(harness)

  await assert.rejects(
    () => tool.execute({ query: '*.pdf' }, execContext()),
    (error) => error.code === 'ES_FAILED',
  )
})

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

test('a non-zero es exit surfaces as ES_FAILED with the stderr excerpt', async () => {
  const harness = createHarness({
    respond: () => ({
      done: Promise.resolve({ signal: null, exitCode: 1 }),
      collected: {
        stdout: { readFrom: () => ({ text: '', lossy: false }) },
        stderr: { readFrom: () => ({ text: 'es: bad option', lossy: false }) },
      },
    }),
  })
  const tool = await loadTool(harness)

  await assert.rejects(
    () => tool.execute({ query: '*.pdf' }, execContext()),
    (error) => error.code === 'ES_FAILED' && /bad option/.test(error.message),
  )
})

test('a lossy stdout capture surfaces as ES_RAW_OUTPUT_OVERFLOW', async () => {
  const harness = createHarness({
    respond: () => ({
      done: Promise.resolve({ signal: null, exitCode: 0 }),
      collected: {
        stdout: { readFrom: () => ({ text: '[]', lossy: true }) },
        stderr: { readFrom: () => ({ text: '', lossy: false }) },
      },
    }),
  })
  const tool = await loadTool(harness)

  await assert.rejects(
    () => tool.execute({ query: '*.pdf' }, execContext()),
    (error) => error.code === 'ES_RAW_OUTPUT_OVERFLOW',
  )
})

test('a missing es binary is classified as ES_NOT_FOUND', async () => {
  const harness = createHarness({
    respond: () => {
      throw new Error('spawn cmd ENOENT')
    },
  })
  const tool = await loadTool(harness)

  await assert.rejects(
    () => tool.execute({ query: '*.pdf' }, execContext()),
    (error) => error.code === 'ES_NOT_FOUND',
  )
})

test('a nonexistent working directory is named instead of blamed on PATH', async () => {
  // libuv reports a missing cwd as ENOENT on the executable, so the PATH-shaped
  // message would send the caller to reinstall Everything. Measured against the
  // host's own fault table; the check below is what tells the two apart.
  const harness = createHarness({
    respond: () => {
      throw new Error('spawn cmd ENOENT')
    },
  })
  const tool = await loadTool(harness)
  const missingCwd = 'C:\\definitely\\not\\a\\real\\directory'

  await assert.rejects(
    () =>
      tool.execute(
        { query: '*.pdf' },
        { signal: new AbortController().signal, agent: { session: { header: { cwd: missingCwd } } } },
      ),
    (error) => {
      assert.equal(error.code, 'ES_FAILED')
      assert.match(error.message, /working directory .* does not exist/)
      assert.doesNotMatch(error.message, /not found on PATH/)
      return true
    },
  )
})

test('an already-aborted signal is classified as ES_ABORTED', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    () => tool.execute({ query: '*.pdf' }, { signal: controller.signal }),
    (error) => error.code === 'ES_ABORTED',
  )
})

test('max_results is truncated to an integer and clamped to the absolute cap', async () => {
  // A finite non-integer passes the host's parameter validation, so it does reach
  // es; `-n 2.7` is not a limit es accepts. Non-numbers never get this far (the
  // host answers `"max_results" must be a finite JSON number`) — measured.
  const harness = createHarness()
  const tool = await loadTool(harness)

  await tool.execute({ query: '*.md', max_results: 2.7 }, execContext())
  assert.match(commandLine(harness), /-n 2\b/, 'a fractional limit must not reach es')

  await tool.execute({ query: '*.md', max_results: 1e9 }, execContext())
  assert.match(commandLine(harness, 1), /-n 100000\b/, 'the absolute cap still applies')

  await tool.execute({ query: '*.md', max_results: 0 }, execContext())
  assert.match(commandLine(harness, 2), /-n 1\b/, 'a zero limit is raised to a usable one')
})

// ---------------------------------------------------------------------------
// Failure classification: the seam's outcomes, each mapped to its own code.
// These pin the vocabulary the model sees; a shared "it failed" would leave it
// unable to tell a wrong query from a missing Everything from its own timeout.
// ---------------------------------------------------------------------------

/** A responder that runs to a given outcome without any stdout/stderr content. */
function outcomeRespond(done, collected = {}) {
  return () => ({
    done,
    collected: {
      stdout: { readFrom: () => ({ text: '', lossy: false }) },
      stderr: { readFrom: () => ({ text: '', lossy: false }) },
      ...collected,
    },
  })
}

test('a non-array JSON payload is reported as an unexpected output format', async () => {
  const harness = createHarness({ respond: succeedWith('{"error":"unexpected"}') })
  const tool = await loadTool(harness)

  await assert.rejects(
    () => tool.execute({ query: '*.md' }, execContext()),
    (error) => {
      assert.equal(error.code, 'ES_FAILED')
      assert.match(error.message, /unexpected output format/)
      return true
    },
  )
})

test('a spawn that fails for a non-ENOENT reason reports the underlying message', async () => {
  const harness = createHarness({
    respond: () => {
      throw new Error('spawn EACCES: permission denied')
    },
  })
  const tool = await loadTool(harness)

  await assert.rejects(
    () => tool.execute({ query: '*.md' }, execContext()),
    (error) => {
      assert.equal(error.code, 'ES_FAILED', 'must not be misread as a missing binary')
      assert.match(error.message, /could not start the es command: spawn EACCES/)
      return true
    },
  )
})

test('a rejected process handle is classified as ES_FAILED', async () => {
  const harness = createHarness({
    respond: outcomeRespond(Promise.reject(new Error('handle blew up'))),
  })
  const tool = await loadTool(harness)

  await assert.rejects(
    () => tool.execute({ query: '*.md' }, execContext()),
    (error) => {
      assert.equal(error.code, 'ES_FAILED')
      assert.match(error.message, /could not start the es command: handle blew up/)
      return true
    },
  )
})

test('a seam that hands back no collected streams is classified as ES_FAILED', async () => {
  const harness = createHarness({ respond: () => ({ done: Promise.resolve({ signal: null, exitCode: 0 }) }) })
  const tool = await loadTool(harness)

  await assert.rejects(
    () => tool.execute({ query: '*.md' }, execContext()),
    (error) => {
      assert.equal(error.code, 'ES_FAILED')
      assert.match(error.message, /no collected output streams/)
      return true
    },
  )
})

test('a process killed without an aborted signal is classified as ES_FAILED', async () => {
  const harness = createHarness({
    respond: outcomeRespond(Promise.resolve({ signal: 'SIGTERM', exitCode: null })),
  })
  const tool = await loadTool(harness)

  await assert.rejects(
    () => tool.execute({ query: '*.md' }, execContext()),
    (error) => {
      assert.equal(error.code, 'ES_FAILED', 'nobody cancelled this, so it is a failure, not ES_ABORTED')
      assert.match(error.message, /killed by signal SIGTERM/)
      return true
    },
  )
})

test('a spawn that fails while the call was cancelled reports the cancellation, not ENOENT', async () => {
  // Ordering matters here for a real reason: the seam cannot report "cancelled"
  // separately from "command missing", so a cancelled call whose spawn also threw
  // ENOENT must still come back as ES_ABORTED — otherwise the model is told to
  // reinstall Everything after its own timeout fired.
  const controller = new AbortController()
  const harness = createHarness({
    respond: () => {
      controller.abort()
      throw new Error('spawn cmd ENOENT')
    },
  })
  const tool = await loadTool(harness)

  await assert.rejects(
    () => tool.execute({ query: '*.md' }, { signal: controller.signal }),
    (error) => error.code === 'ES_ABORTED',
  )
})

test('a warning is appended to a non-empty header rather than replacing it', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  const blocks = tool.output.render({}, {
    total: 2,
    truncated: false,
    query: 'content:hello',
    results: [{ path: 'C:\\a.txt' }, { path: 'C:\\b.txt' }],
    warning: 'restricted to immediate children',
  })

  assert.match(blocks[0].text, /^Found 2 results for "content:hello"/)
  assert.match(blocks[0].text, /⚠️ restricted to immediate children/)
})

test('an attributes value es did not report as a number is passed through, not dropped', async () => {
  // The measured contract is a numeric bitmask, so this branch only fires if es
  // changes what it emits — a value is then still better than an empty field.
  const harness = createHarness({
    respond: succeedWith(JSON.stringify([{ filename: 'C:\\a.txt', attributes: 'RHA' }])),
  })
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: '*.txt', include_attributes: true }, execContext())

  assert.equal(result.results[0].attributes, 'RHA')
})

test('a signal aborted after the process finished is classified as ES_ABORTED', async () => {
  const controller = new AbortController()
  const harness = createHarness({
    respond: () => {
      // The process itself reports a clean exit; only the caller's signal says
      // the call was cancelled, and that intent is what the caller needs back.
      controller.abort()
      return {
        done: Promise.resolve({ signal: null, exitCode: 0 }),
        collected: {
          stdout: { readFrom: () => ({ text: '[]', lossy: false }) },
          stderr: { readFrom: () => ({ text: '', lossy: false }) },
        },
      }
    },
  })
  const tool = await loadTool(harness)

  await assert.rejects(
    () => tool.execute({ query: '*.md' }, { signal: controller.signal }),
    (error) => error.code === 'ES_ABORTED',
  )
})

// ---------------------------------------------------------------------------
// Presentation surface
// ---------------------------------------------------------------------------

const SAMPLE = {
  total: 2,
  truncated: false,
  query: '*.pdf',
  results: [
    { path: 'C:\\a\\one.pdf', size: 2048, date_modified: '2026-01-02 03:04:05' },
    { path: 'C:\\b\\two.pdf', attributes: 'A' },
  ],
}

test('render numbers every finding and appends its metadata', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  const blocks = tool.output.render({ query: '*.pdf' }, SAMPLE)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /Found 2 results for "\*\.pdf"/)
  assert.match(blocks[0].text, /\[1\] C:\\a\\one\.pdf \[2\.0 KB, modified: 2026-01-02 03:04:05\]/)
  assert.match(blocks[0].text, /\[2\] C:\\b\\two\.pdf \[attrib: A\]/)
})

test('render reports the zero-match case plainly', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  const blocks = tool.output.render({}, { total: 0, truncated: false, query: '*.pdf', results: [] })
  assert.equal(blocks[0].text, 'No files found')
})

test('render says "at least" when the count proved no exact total', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  // A count that could not be read leaves `total` at the number of rows.
  const floor = tool.output.render({}, {
    total: 2,
    truncated: true,
    query: '*.pdf',
    results: [{ path: 'C:\\a.pdf' }, { path: 'C:\\b.pdf' }],
  })
  assert.match(
    floor[0].text,
    /Found at least 2 results for "\*\.pdf" \(showing first 2; the exact total is unavailable\)/,
  )

  // The card carries the same honesty, and it survives the byte cap on its own
  // path list: the flag is computed from the uncapped rows.
  const meta = tool.output.presentationMeta({}, {
    total: 2,
    truncated: true,
    query: '*.pdf',
    results: [{ path: 'C:\\a.pdf' }, { path: 'C:\\b.pdf' }],
  })
  const view = tool.presentResult({ query: '*.pdf' }, { isError: false, meta })
  assert.equal(view.title, 'Found at least 2 results for "*.pdf"')

  // A count that did prove more than the listing shows keeps the exact wording.
  const exact = tool.output.render({}, {
    total: 64546,
    truncated: true,
    query: '*.pdf',
    results: [{ path: 'C:\\a.pdf' }, { path: 'C:\\b.pdf' }],
  })
  assert.match(exact[0].text, /Found 64546 results for "\*\.pdf" \(showing first 2\)/)
  assert.doesNotMatch(exact[0].text, /at least/)
})

test('a size past the TB unit is capped instead of printing an undefined unit', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  const blocks = tool.output.render({}, {
    total: 1,
    truncated: false,
    query: '*.bin',
    results: [{ path: 'C:\\huge.bin', size: 1024 ** 5 }],
  })
  assert.match(blocks[0].text, /1024\.0 TB/)
  assert.doesNotMatch(blocks[0].text, /undefined/)
})

test('a restricted content search carries its warning into the rendered header', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  const blocks = tool.output.render({}, {
    total: 0,
    truncated: false,
    query: 'content:hello',
    results: [],
    warning: 'restricted',
  })
  assert.match(blocks[0].text, /restricted/)
})

test('presentationMeta projects the discovered path list', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  assert.deepEqual(tool.output.presentationMeta({}, SAMPLE), {
    total: 2,
    truncated: false,
    query: '*.pdf',
    results: ['C:\\a\\one.pdf', 'C:\\b\\two.pdf'],
    totalIsExact: true,
  })
})

test('presentCall titles the pending call with the query and path', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  const view = tool.presentCall({ query: 'size:>1gb', path: 'C:\\docs' })
  assert.equal(view.card, 'generic')
  assert.equal(view.kind, 'search')
  assert.equal(view.title, 'Everything search: size:>1gb in C:\\docs')
  assert.equal(view.rawInput, 'size:>1gb')
})

test('presentResult yields a paths search view, and falls back on error', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  const meta = tool.output.presentationMeta({}, SAMPLE)
  const view = tool.presentResult({ query: '*.pdf' }, { isError: false, meta })

  assert.equal(view.card, 'search')
  assert.equal(view.shape, 'paths')
  assert.equal(view.total, 2)
  assert.equal(view.truncated, false)
  assert.deepEqual(view.paths, ['C:\\a\\one.pdf', 'C:\\b\\two.pdf'])

  assert.equal(tool.presentResult({ query: '*.pdf' }, { isError: true, meta }), undefined)
  assert.equal(tool.presentResult({ query: '*.pdf' }, { isError: false }), undefined)
})

// ---------------------------------------------------------------------------
// 0.2.0-rc.2 integration: concurrency classification and bounded projections
// ---------------------------------------------------------------------------

test('the tool declares itself safe to run in a parallel group', async () => {
  // Left absent, the host's registry classifies every tool as `exclusive`
  // (dsh-tools: `if (!tool?.isConcurrencySafe) return { kind: 'exclusive' }`),
  // which would serialize concurrent searches. A pure read of the Everything
  // index shares no mutable state, so a parallel group is safe.
  const harness = createHarness()
  const tool = await loadTool(harness)

  assert.equal(typeof tool.isConcurrencySafe, 'function')
  assert.equal(tool.isConcurrencySafe({ query: '*.pdf' }), true)
})

test('presentationMeta caps the replayed path list and marks it truncated', async () => {
  // The projection is persisted with the session log, so an exhaustive search
  // (max_results: 100000) must not replay every path into it. This mirrors the
  // host's own capMetaBytes for glob/grep.
  const harness = createHarness()
  const tool = await loadTool(harness)

  const many = Array.from({ length: 500 }, (_, i) => ({
    path: `C:\\dir\\file-${String(i).padStart(4, '0')}-${'z'.repeat(80)}.pdf`,
  }))
  const meta = tool.output.presentationMeta({}, {
    total: 500,
    truncated: false,
    query: '*.pdf',
    results: many,
  })

  assert.ok(meta.results.length > 0, 'a usable prefix must survive')
  assert.ok(meta.results.length < many.length, 'every path must not be kept')
  assert.equal(meta.truncated, true, 'a capped list must never look complete')
  assert.equal(meta.total, 500, 'the true total survives the cap')
  assert.ok(
    Buffer.byteLength(JSON.stringify(meta.results), 'utf8') <= 16 * 1024,
    'the retained list must fit the byte budget',
  )
  assert.deepEqual(
    meta.results,
    many.slice(0, meta.results.length).map((r) => r.path),
    'the retained paths keep result order',
  )
})

test('a capture over the byte cap is rejected even when it is not flagged lossy', async () => {
  // The seam is handed a stdout budget, but a provider that returns more without
  // flagging the loss must not reach the parser oversized. Same two-step check
  // as the host's own completeStdout.
  const harness = createHarness({ respond: succeedWith(`[{"filename":"${'x'.repeat(200)}"}]`) })
  const tool = await loadTool(harness, { rawOutputMaxBytes: 64 })

  await assert.rejects(
    () => tool.execute({ query: '*.pdf' }, execContext()),
    (error) => error.code === 'ES_RAW_OUTPUT_OVERFLOW',
  )
})

// ---------------------------------------------------------------------------
// Plugin-list display metadata (read by the host without loading this plugin)
//
// readPluginMeta() never runs `apply`, so no test above can notice a broken
// locale file, a missing icon entry or a `files` omission: the plugin keeps
// working and only the plugin list goes blank. These two cases state the host's
// own rules locally instead of depending on the host package.
// ---------------------------------------------------------------------------

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const packageManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

/** The host's language-id rule for locale filenames. */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u

test('the display dictionaries the host reads are well formed', () => {
  // The host resolves `<pkg>/locale/en.json` first and then reads every other
  // *.json beside it as a dictionary named by its filename.
  const localeDir = join(packageRoot, 'locale')
  const files = readdirSync(localeDir).filter((entry) => entry.endsWith('.json'))
  assert.ok(files.includes('en.json'), 'the host resolves en.json first, so it must exist')

  for (const file of files) {
    const language = file.slice(0, -'.json'.length)
    assert.match(language, LANGUAGE_ID, `${file} must be named after a language id`)
    const parsed = JSON.parse(readFileSync(join(localeDir, file), 'utf8'))
    for (const field of ['title', 'description']) {
      const value = parsed.meta?.[field]
      // Absent is fine (the host falls back to package.json), but a present and
      // unusable value throws and takes the whole metadata read down with it.
      if (value === undefined) continue
      assert.equal(typeof value, 'string', `${file}: meta.${field} must be a string`)
      assert.notEqual(value.trim(), '', `${file}: meta.${field} must not be empty`)
    }
  }
})

test('the icon and locale files are declared, reachable, and inside the package', () => {
  const icon = packageManifest.icon
  assert.equal(typeof icon, 'string', 'the host reads the top-level icon field')
  assert.ok(!isAbsolute(icon) && !/^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon), 'the icon must be a relative path')

  const root = realpathSync(packageRoot)
  const iconFile = realpathSync(resolve(root, icon))
  const local = relative(root, iconFile)
  assert.ok(!local.startsWith('..') && !isAbsolute(local), 'the icon must stay inside the manifest directory')
  assert.ok(['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(extname(icon).toLowerCase()), 'icon type')
  assert.ok(statSync(iconFile).size <= 256 * 1024, 'the icon must be at most 256 KiB')

  // Neither is in npm's automatic include set, and the host reaches locale files
  // through the export map: dropping either entry degrades silently to a list
  // row with no title, description or icon.
  assert.equal(
    packageManifest.exports?.['./locale/*.json'],
    './locale/*.json',
    'locale files must be exported for the host to resolve them',
  )
  for (const entry of ['icon.svg', 'locale/*.json']) {
    assert.ok(packageManifest.files.includes(entry), `files must include ${entry}`)
  }
})
