# @deepseek-ai/dsh-tool-everything

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
  "dependencies": {
    "existing-dep": "^1.0.0",
+   "@deepseek-ai/dsh-tool-everything": "*"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
+       "@deepseek-ai/dsh-tool-everything"
      ]
    }
  }
```

**Step 3 — Restart DSH**

The plugin will be loaded on the next DSH startup. After modifying the plugin source, there is no need to re-link — the symlink stays active and changes are reflected automatically.

### Option B: Published npm package (future)

When the package is published to npm:

```powershell
dsh plugin --profile <name> add @deepseek-ai/dsh-tool-everything
```

This adds the dependency and the bundle entry automatically. Then restart DSH.

### Option C: file: protocol (no npm link needed)

If you prefer not to use `npm link`, you can install the plugin as a local file dependency:

```powershell
cd "$env:USERPROFILE\.dsh\profiles\<name>"
pnpm add "file:C:\path\to\dsh-tool-everything"
```

Then manually add `"@deepseek-ai/dsh-tool-everything"` to the `dsh.profile.bundles` array in the same `package.json`, and restart DSH.

### Verify the installation

After restarting DSH, check that the tool is visible to the model:

```powershell
# DSH startup logs should show the bundle loading successfully
# In a conversation, ask the model to list available tools, or call:
# "用 everything_search 搜索所有 PDF 文件"
```

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
| `query` | string | ✅ | — | Everything search query. Supports wildcards, content:, size:, dm:, dc:, da:, ext:, path:, boolean operators, and Everything search syntax. |
| `max_results` | number | ❌ | 50 | Maximum results to return (1–100000). |
| `path` | string | ❌ | — | Restrict search to a specific directory. |
| `regex` | boolean | ❌ | false | Enable regex search mode. |
| `match_case` | boolean | ❌ | false | Case-sensitive matching. |
| `match_whole_word` | boolean | ❌ | false | Match whole words only. |
| `match_path` | boolean | ❌ | false | Match full file path. |
| `file_only` | boolean | ❌ | false | Files only (exclude folders). |
| `folder_only` | boolean | ❌ | false | Folders only (exclude files). |
| `sort_by` | string | ❌ | — | Sort field: `name`, `path`, `size`, `extension`, `date-created`, `date-modified`, `date-accessed`. |
| `sort_desc` | boolean | ❌ | false | Sort descending. |
| `attributes` | string | ❌ | — | Attribute filter, e.g. `"R"` (read-only), `"H"` (hidden). |
| `include_size` | boolean | ❌ | false | Show file sizes. |
| `include_date_modified` | boolean | ❌ | false | Show last modified dates. |
| `include_date_created` | boolean | ❌ | false | Show creation dates. |
| `include_date_accessed` | boolean | ❌ | false | Show last accessed dates. |
| `include_path` | boolean | ❌ | false | Show full directory path. |
| `include_extension` | boolean | ❌ | false | Show file extension. |
| `include_attributes` | boolean | ❌ | false | Show file attributes. |

## Config

| Key | Default | Description |
|-----|---------|-------------|
| `timeoutMs` | `1200000` | Cooperative tool-call timeout budget (ms). 20 minutes, matching a typical deployment's global command timeout. |
| `graceMs` | `3000` | Process termination grace period past timeout (ms). |
| `stderrMaxBytes` | `65536` | Stderr diagnostic tail budget (bytes). |
| `rawOutputMaxBytes` | `20000000` | Max stdout captured for parsing (bytes). |

## How it works

1. The model calls `everything_search` with a query and optional parameters.
2. The plugin spawns `es -json` with the appropriate arguments through the DSH subprocess seam.
3. `es.exe` queries the Everything service (which has indexed all NTFS volumes) and returns JSON results.
4. The plugin parses the JSON, formats results with optional metadata, and returns them to the model.

Because Everything maintains a real-time index, searches are **near-instant** even across millions of files — much faster than filesystem `glob` or `grep` for broad searches.

## Errors

| Error Code | Description |
|------------|-------------|
| `ES_NOT_FOUND` | The `es` command is not installed or not on PATH. |
| `ES_FAILED` | The command failed (non-zero exit, launch failure). |
| `ES_RAW_OUTPUT_OVERFLOW` | The output exceeded the capture budget; narrow the query. |
| `ES_ABORTED` | The tool call was aborted (timeout or cancellation). |

## License

MIT