**English** | [中文](README.md)

# @zhourenke/dsh-tool-everything

**Model-facing Everything search tool** — `everything_search` — powered by **es.exe** (Everything command-line client) for blazing-fast file search on Windows.

Leverages the [Everything](https://www.voidtools.com/) search engine by voidtools to provide near-instant file search across NTFS volumes, supporting the full Everything search syntax.

## Prerequisites

- **Windows** (NTFS volumes)
- **[Everything](https://www.voidtools.com/)** by voidtools (free, installed and running)
- **es.exe** — the command-line client that ships with Everything, or available as a [standalone download](https://www.voidtools.com/downloads/). Must be discoverable on `PATH`.

Verify the installation:

```powershell
es -h
```

Should print the ES help text.

## Installation

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-tool-everything"
```

This installs the package from GitHub, detects the `dsh.bundle` declaration, and automatically registers it as a profile layer. Restart DSH to activate.

To uninstall:

```powershell
dsh plugin --profile web remove @zhourenke/dsh-tool-everything
```

### Verify the installation

After restarting DSH, check that the tool is visible to the model — ask the model to list its tools, or simply ask it to search for a known file.

## Compatibility

Tested with **DSH v0.1.5-rc.1** (September 2026). The plugin requires the following runtime packages:

- `@deepseek-ai/schemastery` (configuration schema)
- `@deepseek-ai/cordis` (plugin framework)
- `@deepseek-ai/dsh-tools` (tool definitions)
- `@deepseek-ai/dsh-llm` (LLM error types)
- `@deepseek-ai/dsh-subprocess` (subprocess seam)
- `@deepseek-ai/dsh-system-prompt` (system-prompt section registration)

Install dependencies before use with the corresponding DSH version.

This plugin is distributed via git (route A): the build artifacts under `lib/` (including the `lib/types/` declarations) are committed alongside the source, so the single command above installs a ready-to-run plugin. No local build and no `prepare` script are involved.

## Usage

Once installed, the model can call `everything_search` with any Everything search query:

### Examples

| Query | Description |
|-------|-------------|
| `*.pdf` | All PDF files |
| `report* 2024` | Files starting with "report" containing "2024" |
| `size:>1gb` | Files larger than 1 GB |
| `dm:2024-01-01..2024-12-31` | Files modified in 2024 |
| `ext:txt content:hello` | Text files containing "hello" |
| `C:\Projects\* ext:ts` | TypeScript files under C:\Projects |
| `*.jpg dc:2024-06-01` | JPEGs created on June 1, 2024 |
| `!hidden` | Exclude hidden files |

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | ✅ | — | Everything search query. Supports wildcards (`*`, `?`), `content:`, `size:`, `dm:`, `dc:`, `da:`, `ext:`, `path:`, boolean operators (`\|`, `!`, `<...>`), and Everything search syntax. |
| `max_results` | number | ❌ | 50 | Maximum results to return (1–100000). Use 100000 for exhaustive searches; prefer narrow queries for speed. |
| `path` | string | ❌ | — | Restrict search to a directory, recursively. Space-containing paths work. Passed as es's `-path` option (or `-parent` for a broad `content:` search), never folded into the query as a `path:` prefix. **Required when using `content:`** — searches without a path are rejected to prevent the Everything engine from freezing. |
| `regex` | boolean | ❌ | false | Enable regex search mode (`-r`). Note: Everything's regex engine does NOT support `(...)` grouping — use top-level alternation like `.*\.pdf$\|.*\.txt$`. |
| `match_case` | boolean | ❌ | false | Case-sensitive matching (`-i`). Default is case-insensitive. |
| `match_whole_word` | boolean | ❌ | false | Match whole words only (`-w`). |
| `match_path` | boolean | ❌ | false | Match the full file path (`-p`). |
| `file_only` | boolean | ❌ | false | Files only, exclude folders (`/a-d`). |
| `folder_only` | boolean | ❌ | false | Folders only, exclude files (`/ad`). |
| `sort_by` | string | ❌ | — | Sort field: `name`, `path`, `size`, `extension`, `date-created`, `date-modified`, `date-accessed`. |
| `sort_desc` | boolean | ❌ | false | Sort descending when `sort_by` is set. |
| `attributes` | string | ❌ | — | Attribute filter, DIR-style. Letters: `R` read-only, `H` hidden, `S` system, `D` directory, `A` archive, `V` device, `N` normal, `T` temporary, `L` reparse point, `C` compressed, `O` offline, `I` not content indexed, `E` encrypted. Prefix with `-` to exclude: `"R-H"` = read-only AND not hidden. Combine: `"RHS"` = read-only, hidden, and system. |
| `include_size` | boolean | ❌ | false | Include file size in results. |
| `include_date_modified` | boolean | ❌ | false | Include last modified date (`dm`). |
| `include_date_created` | boolean | ❌ | false | Include creation date (`dc`). |
| `include_date_accessed` | boolean | ❌ | false | Include last accessed date (`da`). |
| `include_path` | boolean | ❌ | false | Include the full path AND filename (es `-full-path-and-name`). |
| `include_extension` | boolean | ❌ | false | Include file extension. |
| `include_attributes` | boolean | ❌ | false | Include file attributes as DIR-style letters (`A`, `HS`, `HSD`, ...). |

## Config

| Key | Default | Description |
|-----|---------|-------------|
| `timeoutMs` | `1200000` | Cooperative tool-call timeout budget (ms). |
| `graceMs` | `3000` | Process termination grace period past timeout (ms). |
| `stderrMaxBytes` | `65536` | Stderr diagnostic tail budget (bytes). |
| `rawOutputMaxBytes` | `20000000` | Max stdout captured for parsing (bytes). |

## How it works

1. The model calls `everything_search` with a query and optional parameters.
2. The plugin spawns `cmd /c chcp 65001>nul & es -json ...` through the DSH subprocess seam.
3. `es.exe` queries the Everything service (which has indexed all NTFS volumes) and returns JSON results.
4. The plugin parses the JSON, converts FILETIME dates and attribute bitmasks, formats results, and returns them to the model.

### Why `cmd /c chcp 65001`?

On Chinese Windows (and other CJK locales), `es.exe` writes filenames in the system ANSI code page (GB2312/CP936), but the harness subprocess seam decodes child stdout as UTF-8 — garbling every non-ASCII path. `chcp 65001` switches the console code page to UTF-8 before `es` runs, so es emits UTF-8 bytes that decode correctly. This is verified end-to-end: without it, `D:\驱动镜像` becomes `D:\`.

### Escaping strategy

The query is embedded in one joined `cmd /c` string, with every shell-special character (including SPACE) escaped by caret (`^`), cmd's escape character:

- `size:>1gb` → `size:^>1gb` (not a redirection)
- `*.pdf | *.txt` → `*.pdf^ ^|^ *.txt` (one OR search, not a pipe)
- `Windows11 25H2.iso` → `Windows11^ 25H2.iso` (one multi-word query)

Quotes are NEVER used for the query: es passes them through to Everything, where `"..."` means a literal-phrase search and silently returns zero results.

The `path` argument is **never folded into the query** as a `path:` prefix; it is passed as es's `-path` option (or `-parent` for a broad `content:` search). The prefix fold-in used by earlier versions failed in two independent ways, both measured against es 1.1.0.37:

- A space-containing path is split apart even after caret-escaping: `path:C:\Program^ Files` reaches es as **two** argv elements (`path:C:\Program` and `Files`), so the function receives a truncated path and the search silently returns nothing.
- Under `-r` it cannot work at all: es compiles the entire search string as one regular expression, so `path:C:\dir` degrades into literal text that matches no filename.

The `-path` value may contain spaces and therefore needs quotes — and a quote inside this `cmd /c` string is escaped to `\"` by Node.js and then torn apart by cmd (measured: `-path "C:\Program Files"` reaches es as two argv elements, the first carrying a stray quote). The value is therefore passed through the `EVERYTHING_TOOL_PATH_ARG` environment variable: **the quotes live in the variable's value**, leaving the command string itself free of any quote character.

### es argument order matters

es parses options strictly left-to-right and is **greedy** about its search-mode switches: `-r` (regex) and `-i`/`-w`/`-p` (case/whole-word/match-path) must be the LAST options, immediately before the query. Any option that follows them (`-size`, `-n`, `-sort`) is consumed as part of the search text and silently returns zero results. The plugin therefore emits columns → `-n` → filters → sort → `-i -w -p` → `-path`/`-parent` → `-r` → query.

### Output quirks handled

- `-size` combined with `-r` makes es wrap its JSON in an extra array level (`[[{...}]]`); the parser unwraps one level.
- `-attribs` emits a numeric bitmask (32 = Archive); the plugin converts it to DIR-style letters (`A`, `HS`, `HSD`, ...).
- FILETIME dates (100-ns intervals since 1601) are converted to ISO-8601.

Because Everything maintains a real-time index, searches are **near-instant** even across millions of files — much faster than filesystem `glob` or `grep` for broad searches.

### Content search safety guard

`content:` reads file content through system iFilters, which can freeze Everything while scanning millions of files. The plugin enforces two safeguards:

- **No path → rejected**: `content:` without a `path` parameter (or inline `path:` in the query) is rejected with `ES_FAILED` and a message asking for a narrower scope.
- **Broad path → auto-restricted**: `content:` targeting a drive root (e.g. `C:\`), the Users tree (`C:\Users`, `C:\Users\AnyUser`), the current home directory, or any of these with wildcard suffixes (e.g. `C:\*`), is restricted to immediate children only via es's `-parent` option (one level, no recursion into subdirectories). A warning is shown in the results.

Always specify a concrete path such as `path:C:\Specific\Folder` when searching file contents. Wildcard patterns like `C:\*` are also considered broad and will be restricted.

## Errors

| Error Code | Description |
|------------|-------------|
| `ES_NOT_FOUND` | The `cmd` or `es` command is not installed or not on PATH. |
| `ES_FAILED` | The command failed (non-zero exit, launch failure, malformed output). Content searches without a `path` parameter are also rejected as `ES_FAILED`. |
| `ES_RAW_OUTPUT_OVERFLOW` | The output exceeded the capture budget; narrow the query. |
| `ES_ABORTED` | The tool call was aborted (timeout or cancellation). |

## Known Limitations

Everything below is a **measured** boundary, not a guess. Entries marked es 1.1.0.37 were reproduced end to end on that version.

### Query semantics

- **Regex does not support `(...)` grouping** (es 1.1.0.37) — `(dll|exe)$` returns nothing while the equivalent `dll|exe` matches normally. Use an unparenthesised alternation instead, e.g. `.*\.pdf$|.*\.txt$`.
- **An inline `path:` is inert in regex mode** — with `regex: true` the whole search string is compiled as one regular expression, so `path:` participates as literal text. Use the `path` parameter for that case.
- **An inline `path:` cannot express a space-containing path** — the space in `path:C:\Program Files\x` is treated by Everything itself as a word separator. Always use the `path` parameter for space-containing paths; it travels as the `-path` option and is not affected.
- **The total degrades if the recount fails** — when a listing fills the limit the plugin issues one follow-up `es -get-result-count` for the true total; if that query fails, the result is flagged as "there may be more" rather than reporting a number that could be too low.

### Index coverage

- **Hard-linked files may be unsearchable** — package managers such as pnpm install dependencies as hard links, and Everything's live NTFS index **does not pick up newly created hard links**; they appear only after a Force Rebuild in Everything. The symptom is that files inside `node_modules` cannot be found while a freshly created ordinary file in the same directory (e.g. `node_modules\.modules.yaml`) can. Confirmed by a controlled experiment: two files with identical content in one directory, differing only in link count — the one with 1 link was indexed, the one with 4 was not. This is Everything's behaviour (matching reports on the voidtools forum), not a plugin defect.
- **`es` must be on `PATH`**; the plugin does not probe for a fixed install path.

### Safety guard

- **`content:` requires a `path` parameter** — scanning file contents without a path, or across broad paths (drive roots, the Users tree, user home directories), forces Everything to read every file via system iFilters and freezes the program. The plugin rejects bare `content:` searches as `ES_FAILED` and auto-restricts broad paths to immediate children only.

## License

MIT

Tested with DSH v0.1.5-rc.1.