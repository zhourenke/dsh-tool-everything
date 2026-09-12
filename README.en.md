**English** | [中文](README.md)

# @zhourenke/dsh-tool-everything

**Provides DSH models with the `everything_search` tool: whole-disk, near-instant file search on Windows, powered by Everything.**

It queries the voidtools [Everything](https://www.voidtools.com/) index and searches the entire disk in milliseconds — not scoped to the workspace — with full Everything search syntax (wildcards, boolean operators, `size:`, `content:` full-text, and more).

## What it does well

- **Whole-disk search**: find files by name fragment, type, size, or date
- **Full-text search**: `content:` finds files by their contents (a scope is required, see below)
- **Metadata**: optionally return size, created/modified/accessed dates, extension, and attributes
- **Fast**: Everything maintains an NTFS index in the background; searches are index lookups, not directory walks

## Prerequisites

| Requirement | Notes |
|---|---|
| Windows | NTFS volumes (Everything indexes NTFS) |
| Everything | Free software by voidtools; must be **installed and running** |
| es.exe | Everything's command-line client; must be on `PATH` |

Verify:

```powershell
es -h
```

If it prints the ES help text, you're ready.

## Installation

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-tool-everything"
```

Restart DSH, and the model can call `everything_search`. To uninstall:

```powershell
dsh plugin --profile web remove @zhourenke/dsh-tool-everything
```

## Quick start

In a model session, just ask in plain language, for example:

- "Find files larger than 1 GB on D:" → `query: size:>1gb`, `path: D:\`
- "Find text files containing TODO in Projects" → `query: content:TODO`, `path: C:\Projects`
- "Find all PDFs modified in July 2024" → `query: *.pdf dm:2024-07-01..2024-07-31`

## Search-syntax cheat sheet

`everything_search` accepts the [Everything search syntax](https://www.voidtools.com/support/everything/searching/) directly. Common patterns:

| Looking for | Query |
|---|---|
| A file type | `*.pdf` |
| Name contains keywords | `report* 2024` (multiple terms = all must match) |
| Any of several (OR) | `*.pdf \| *.txt` |
| Exclude | `!*.tmp` |
| Grouping | `<*.mp3 \| *.flac>` |
| By size | `size:>1gb`, `size:500mb..2gb` |
| By date | `dm:2024-01-01..2024-12-31`, `dm:today` (`dm:` modified / `dc:` created / `da:` accessed — same syntax) |
| By path | `path:C:\Projects ext:ts` (**use the `path` parameter for paths containing spaces**) |
| By attributes | `attributes:H` hidden files, `attributes:D` folders |
| Exact phrase | `"quarterly report"` |
| Full text | `content:TODO` (a scope is required, see below) |

Note: Everything's regex mode does **not** support `(...)` grouping — use top-level alternation such as `.*\.pdf$|.*\.txt$`.

## Parameters

| Parameter | Type | Default | Description |
|---|---|:---:|---|
| `query` | string | — | Required. The Everything search query. |
| `path` | string | — | Restrict the search to this directory (recursively); the most reliable way to pass a path containing spaces; **strongly recommended for `content:` searches**. |
| `max_results` | number | 50 | Maximum results to return (1–100000). Use 100000 for exhaustive searches; the default is fine for most queries. |
| `sort_by` | string | relevance/name | `name`, `path`, `size`, `extension`, `date-created`, `date-modified`, `date-accessed`. |
| `sort_desc` | boolean | false | Sort descending when `sort_by` is set. |
| `regex` | boolean | false | Regex mode; `(...)` grouping is not supported. |
| `match_case` | boolean | false | Case-sensitive matching. |
| `match_whole_word` | boolean | false | Whole-word matching. |
| `match_path` | boolean | false | Match against the full path, not just the file name. |
| `file_only` | boolean | false | Files only (exclude folders). |
| `folder_only` | boolean | false | Folders only (exclude files). |
| `attributes` | string | — | DIR-style attribute filter: `R` read-only, `H` hidden, `S` system, `D` directory, `A` archive; prefix `-` to exclude (`"R-H"` = read-only AND not hidden); combine (`"RHS"` = read-only, hidden, and system). |
| `include_size` | boolean | false | Return the size in bytes. |
| `include_date_modified` | boolean | false | Return the last-modified date. |
| `include_date_created` | boolean | false | Return the creation date. |
| `include_date_accessed` | boolean | false | Return the last-accessed date. |
| `include_path` | boolean | false | Return the full path. |
| `include_extension` | boolean | false | Return the file extension. |
| `include_attributes` | boolean | false | Return attributes as DIR-style letters (e.g. `A`, `HS`). |

## What results look like

The tool returns `total` (the match count), `truncated` (whether more may exist), and `results[]`. Each result:

- `path`: the full path (dates and attributes are already formatted for reading); **folders end with `\`**
- Requested metadata: `size` (integer bytes), `date_modified` / `date_created` / `date_accessed` (formatted like `2026-01-02 03:04:05`), `extension` (the extension such as `js`; `""` for an extensionless file; **omitted for folders**), `attributes` (letter string)
- `warning`: present when a content-search scope was auto-restricted — **if you see it, the results may be incomplete; use a more specific directory**

Files and folders are matched by default; when the listing fills `max_results`, the plugin automatically issues a count query so `total` is accurate.

## Content-search (content:) rules

`content:` scans file contents through system iFilters, and scanning too broadly can freeze Everything. Hard safeguards apply:

- **A scope is required**: provide it via the `path` parameter or an inline `path:` in the query — one of the two. With no scope at all, the search is **rejected outright**.
- **Broad scopes are restricted**: targeting a drive root (`C:\`), `C:\Users` (or one level below it), `C:\Documents and Settings` (likewise), or the current user's home directory is automatically downgraded to **immediate children only (one level, no recursion)**, with a `warning` in the results.
- **Recommended**: give a concrete directory, e.g. `content:secret_key` + `path: C:\Projects\MyApp`.

## Notes for agents calling the tool

- Tool name: `everything_search`; **whole-disk**, not scoped to the workspace
- Default: up to 50 results, files and folders; use `max_results: 100000` for exhaustive results and `file_only: true` for files only
- Folders end with `\` and have no `extension` — use those two signals to tell files from folders
- If you see a `warning`, adjust: the content-search scope was restricted
- Always provide a concrete directory for content searches

## Error codes

| Code | Meaning |
|---|---|
| `ES_NOT_FOUND` | `es` or `cmd` unavailable (Everything not installed / es.exe not on PATH) |
| `ES_FAILED` | Execution failed (e.g. a `content:` search with no scope was rejected) |
| `ES_RAW_OUTPUT_OVERFLOW` | Output too large; narrow the query |
| `ES_ABORTED` | Call aborted (timeout or cancellation) |

## Known limitations (measured)

- **If Everything is not running**, searches fail — start Everything first.
- **Hard-linked files may be unsearchable**: Everything's live index does not pick up newly created hard links (files installed into `node_modules` by pnpm and similar package managers behave this way); they appear after a Force Rebuild in Everything. This is Everything's own behaviour, not a plugin defect.
- **Regex does not support grouping**; **an inline `path:` cannot express a path containing spaces** — use the `path` parameter in that case.

## Configuration

| Key | Default | Description |
|---|---|---|
| `timeoutMs` | 1200000 | Single-search timeout (ms) |
| `graceMs` | 3000 | Process-termination grace period past timeout (ms) |
| `stderrMaxBytes` | 65536 | Stderr tail budget for diagnostics (bytes) |
| `rawOutputMaxBytes` | 20000000 | Max stdout captured for parsing (bytes) |

## Compatibility

Tested with **DSH v0.1.5-rc.1** (September 2026).

## License

MIT