# @zhourenke/dsh-tool-everything

English | [中文](README.zh.md)

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

This plugin is a **DSH profile bundle** — it must be registered in a DSH profile's `package.json` and listed in that profile's `dsh.profile.bundles` array.

### Find your DSH profile

First, determine which profile you are using:

```powershell
# List available profiles
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Name
```

Common profiles: `web`, `tui`, `headless`. The profile directory is `$env:USERPROFILE\.dsh\profiles\<name>\`.

### Option A: Local development (npm link)

Use this when you are developing the plugin locally and want changes to apply immediately.

**Step 1 — Create a global link for the plugin**

```powershell
cd C:\path\to\dsh-tool-everything
npm link
```

This registers the plugin in npm's global `node_modules`, which is the same directory tree DSH's own packages live in, so DSH can resolve it.

**Step 2 — Register the plugin in your profile's package.json**

Edit `$env:USERPROFILE\.dsh\profiles\<name>\package.json`:

```diff
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
+       "@zhourenke/dsh-tool-everything"
      ]
    }
  }
```

**Step 3 — Restart DSH**

The plugin will be loaded on the next DSH startup. After modifying the plugin source, there is no need to re-link — the symlink stays active and changes are reflected automatically.

### Option B: Published npm package (future)

When the package is published to npm:

```powershell
dsh plugin --profile <name> add @zhourenke/dsh-tool-everything
```

This adds the dependency and the bundle entry automatically. Then restart DSH.

### Option C: file: protocol (no npm link needed)

If you prefer not to use `npm link`, you can install the plugin as a local file dependency:

```powershell
cd "$env:USERPROFILE\.dsh\profiles\<name>"
pnpm add "file:C:\path\to\dsh-tool-everything"
```

Then manually add `"@zhourenke/dsh-tool-everything"` to the `dsh.profile.bundles` array in the same `package.json`, and restart DSH.

### Verify the installation

After restarting DSH, check that the tool is visible to the model — ask the model to list its tools, or simply ask it to search for a known file.

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
| `path` | string | ❌ | — | Restrict search to a directory. Space-containing paths work (`C:\Program Files\MacType`). Implemented via Everything's `path:` function, not es's `-path` flag. |
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

On Chinese Windows (and other CJK locales), `es.exe` writes filenames in the system ANSI code page (GB2312/CP936), but the harness subprocess seam decodes child stdout as UTF-8 — garbling every non-ASCII path. `chcp 65001` switches the console code page to UTF-8 before `es` runs, so es emits UTF-8 bytes that decode correctly. This is verified end-to-end: without it, `D:\驱动镜像` becomes `D:\������`.

### Escaping strategy

The query is embedded in one joined `cmd /c` string, with every shell-special character (including SPACE) escaped by caret (`^`), cmd's escape character:

- `size:>1gb` → `size:^>1gb` (not a redirection)
- `*.pdf | *.txt` → `*.pdf^ ^|^ *.txt` (one OR search, not a pipe)
- `Windows11 25H2.iso` → `Windows11^ 25H2.iso` (one multi-word query)

Quotes are NEVER used for the query: es passes them through to Everything, where `"..."` means a literal-phrase search and silently returns zero results.

The `path` argument is folded into the query as Everything's `path:` function prefix (`path:C:\Program^ Files\MacType *.ini`). This deliberately avoids es's `-path` flag: a `-path` value containing spaces needs quotes, and Node.js's Windows command-line quoting mangles quotes inside a joined `cmd /c` string (`\"`), breaking cmd. The `path:` function handles space-containing paths correctly after caret-escaping.

### es argument order matters

es parses options strictly left-to-right and is **greedy** about its search-mode switches: `-r` (regex) and `-i`/`-w`/`-p` (case/whole-word/match-path) must be the LAST options, immediately before the query. Any option that follows them (`-size`, `-n`, `-sort`) is consumed as part of the search text and silently returns zero results. The plugin therefore emits columns → `-n` → filters → sort → `-i -w -p` → `-r` → query.

### Output quirks handled

- `-size` combined with `-r` makes es wrap its JSON in an extra array level (`[[{...}]]`); the parser unwraps one level.
- `-attribs` emits a numeric bitmask (32 = Archive); the plugin converts it to DIR-style letters (`A`, `HS`, `HSD`, ...).
- FILETIME dates (100-ns intervals since 1601) are converted to ISO-8601.

Because Everything maintains a real-time index, searches are **near-instant** even across millions of files — much faster than filesystem `glob` or `grep` for broad searches.

## Errors

| Error Code | Description |
|------------|-------------|
| `ES_NOT_FOUND` | The `cmd` or `es` command is not installed or not on PATH. |
| `ES_FAILED` | The command failed (non-zero exit, launch failure, malformed output). |
| `ES_RAW_OUTPUT_OVERFLOW` | The output exceeded the capture budget; narrow the query. |
| `ES_ABORTED` | The tool call was aborted (timeout or cancellation). |

## Known Limitations

- **Everything's regex engine does not support `(...)` grouping** — `.*\.(pdf|txt)$` returns nothing; use `.*\.pdf$|.*\.txt$` instead.
- **`es` must be on `PATH`**; the plugin does not probe for a fixed install path.
- A `path` value containing BOTH spaces and `&|<>^()` shell characters may not be passed exactly; such directory names are extremely rare on Windows.

## License

MIT
