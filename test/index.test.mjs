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
import { apply, Config, inject, name } from '../lib/index.js'

/** The host's own prompt-section registry, mirrored for the ordering tests. */
const HOST_SECTION_ORDERS = { TOOL_GLOB: 1400, TOOL_GREP: 1500, TOOL_JOBS: 1600 }

/** Minimal in-memory stand-in for the host services this plugin injects. */
function createHarness(options = {}) {
  const spawnCalls = []
  const tools = []
  const sections = []
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
  }
  return { ctx, tools, sections, spawnCalls }
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

/** The `cmd /c` command string of the first spawn. */
function commandLine(harness) {
  assert.ok(harness.spawnCalls.length > 0, 'expected a spawn call')
  const argv = harness.spawnCalls[0].argv
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

test('a content: search on a drive root is restricted to immediate children', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: 'content:hello', path: 'C:\\' }, execContext())
  const line = commandLine(harness)

  assert.match(line, /parent:C:/, 'broad content search must use parent:')
  assert.doesNotMatch(line, /path:C:/, 'broad content search must not use path:')
  assert.equal(typeof result.warning, 'string')
  assert.ok(result.warning.length > 0)
})

test('a content: search on the Users tree is restricted too', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  await tool.execute({ query: 'content:hello', path: 'C:\\Users' }, execContext())
  assert.match(commandLine(harness), /parent:C:\\Users/)
})

test('a content: search on a narrow path keeps path: and adds no warning', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  const result = await tool.execute(
    { query: 'content:hello', path: 'C:\\Specific\\Folder' },
    execContext(),
  )

  assert.match(commandLine(harness), /path:C:\\Specific\\Folder/)
  assert.equal(result.warning, undefined)
})

test('an inline path: in the query is guarded as well', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: 'path:C:\\ content:hello' }, execContext())
  assert.match(commandLine(harness), /parent:C:/)
  assert.equal(typeof result.warning, 'string')
})

test('the broad-path guard does not apply to a name search', async () => {
  const harness = createHarness()
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: '*.pdf', path: 'C:\\' }, execContext())
  const line = commandLine(harness)

  assert.match(line, /path:C:\\/)
  assert.doesNotMatch(line, /parent:/, 'a name search is never depth-restricted')
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

test('results beyond max_results are capped and flagged as truncated', async () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ filename: `C:\\f${i}.pdf` }))
  const harness = createHarness({ respond: succeedWith(JSON.stringify(entries)) })
  const tool = await loadTool(harness)

  const result = await tool.execute({ query: '*.pdf', max_results: 2 }, execContext())

  assert.equal(result.total, 5)
  assert.equal(result.truncated, true)
  assert.equal(result.results.length, 2)
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
