# @deepseek-ai/dsh-tool-everything

[English](README.md) | 中文

**模型可调用的 Everything 搜索工具** — `everything_search` — 基于 **es.exe**（Everything 命令行客户端），在 Windows 上实现极速文件搜索。

利用 voidtools 的 [Everything](https://www.voidtools.com/) 搜索引擎，在 NTFS 卷上实现近乎即时的文件搜索，支持完整的 Everything 搜索语法。

## 前置条件

- **Windows**（NTFS 卷）
- **[Everything](https://www.voidtools.com/)** by voidtools（免费，已安装并运行）
- **es.exe** — Everything 自带的命令行客户端，也可[单独下载](https://www.voidtools.com/downloads/)。必须能在 `PATH` 中找到。

验证安装：

```powershell
es -h
```

应显示 ES 帮助信息。

## 安装

本插件是一个 **DSH 配置文件包（profile bundle）**——必须在 DSH 配置文件的 `package.json` 中注册，并添加到 `dsh.profile.bundles` 列表中。

### 找到你的 DSH 配置文件

首先确定你使用的是哪个配置文件（profile）：

```powershell
# 列出所有可用的配置文件
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Name
```

常见的配置文件：`web`、`tui`、`headless`。配置文件目录为 `$env:USERPROFILE\.dsh\profiles\<名称>\`。

### 方式 A：本地开发（npm link）

在本地开发插件时使用此方式，修改源码后无需重新链接，改动立即生效。

**第 1 步 — 创建插件的全局链接**

```powershell
cd C:\path\to\dsh-tool-everything
npm link
```

这会在 npm 的全局 `node_modules` 中注册该插件。由于 DSH 自身的包也位于同一目录树中，DSH 可以解析到该链接。

**第 2 步 — 在配置文件的 package.json 中注册插件**

编辑 `$env:USERPROFILE\.dsh\profiles\<名称>\package.json`：

```diff
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

**第 3 步 — 重启 DSH**

下次启动 DSH 时插件会被加载。修改插件源码后无需重新链接——符号链接持续有效，改动会自动同步。

### 方式 B：通过 npm 发布后（未来）

当包发布到 npm 后：

```powershell
dsh plugin --profile <名称> add @deepseek-ai/dsh-tool-everything
```

该命令会自动添加依赖项和 bundle 条目。然后重启 DSH。

### 方式 C：file: 协议（无需 npm link）

如果不想使用 `npm link`，可以将插件安装为本地文件依赖：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\<名称>"
pnpm add "file:C:\path\to\dsh-tool-everything"
```

然后在同一 `package.json` 的 `dsh.profile.bundles` 数组中手动添加 `"@deepseek-ai/dsh-tool-everything"`，并重启 DSH。

### 验证安装

重启 DSH 后，让模型列出可用工具，或直接让它搜索一个已知文件。

## 使用方法

安装后，模型可以调用 `everything_search` 并传入任何 Everything 搜索查询：

### 示例

| 查询 | 说明 |
|------|------|
| `*.pdf` | 所有 PDF 文件 |
| `report* 2024` | 文件名以 "report" 开头且包含 "2024" 的文件 |
| `size:>1gb` | 大于 1GB 的文件 |
| `dm:2024-01-01..2024-12-31` | 2024 年内修改过的文件 |
| `ext:txt content:hello` | 包含 "hello" 的文本文件 |
| `C:\Projects\* ext:ts` | C:\Projects 下的 TypeScript 文件 |
| `*.jpg dc:2024-06-01` | 2024 年 6 月 1 日创建的 JPEG 图片 |
| `!hidden` | 排除隐藏文件 |

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:----:|:------:|------|
| `query` | string | ✅ | — | Everything 搜索查询。支持通配符（`*`、`?`）、`content:`、`size:`、`dm:`、`dc:`、`da:`、`ext:`、`path:`、布尔运算符（`\|`、`!`、`<...>`）及 Everything 搜索语法。 |
| `max_results` | number | ❌ | 50 | 最大返回结果数（1–100000）。需要穷举搜索时用 100000；一般建议用更窄的查询以保证速度。 |
| `path` | string | ❌ | — | 限制搜索目录。含空格的路径可用（`C:\Program Files\MacType`）。通过 Everything 的 `path:` 函数实现，而非 es 的 `-path` 参数。 |
| `regex` | boolean | ❌ | false | 启用正则搜索模式（`-r`）。注意：Everything 正则引擎**不支持 `(...)` 分组**——请用顶层交替，如 `.*\.pdf$\|.*\.txt$`。 |
| `match_case` | boolean | ❌ | false | 区分大小写匹配（`-i`）。默认不区分。 |
| `match_whole_word` | boolean | ❌ | false | 仅匹配完整单词（`-w`）。 |
| `match_path` | boolean | ❌ | false | 匹配完整路径（`-p`）。 |
| `file_only` | boolean | ❌ | false | 仅搜索文件，排除文件夹（`/a-d`）。 |
| `folder_only` | boolean | ❌ | false | 仅搜索文件夹，排除文件（`/ad`）。 |
| `sort_by` | string | ❌ | — | 排序字段：`name`、`path`、`size`、`extension`、`date-created`、`date-modified`、`date-accessed`。 |
| `sort_desc` | boolean | ❌ | false | 设置 `sort_by` 后降序排序。 |
| `attributes` | string | ❌ | — | 属性过滤器，DIR 风格。字母含义：`R` 只读、`H` 隐藏、`S` 系统、`D` 目录、`A` 归档、`V` 设备、`N` 普通、`T` 临时、`L` 重解析点、`C` 压缩、`O` 离线、`I` 未索引内容、`E` 加密。前缀 `-` 表示排除：`"R-H"` = 只读且非隐藏。组合：`"RHS"` = 只读、隐藏且系统。 |
| `include_size` | boolean | ❌ | false | 显示文件大小。 |
| `include_date_modified` | boolean | ❌ | false | 显示最后修改日期（`dm`）。 |
| `include_date_created` | boolean | ❌ | false | 显示创建日期（`dc`）。 |
| `include_date_accessed` | boolean | ❌ | false | 显示最后访问日期（`da`）。 |
| `include_path` | boolean | ❌ | false | 显示完整路径**和**文件名（es `-full-path-and-name`）。 |
| `include_extension` | boolean | ❌ | false | 显示文件扩展名。 |
| `include_attributes` | boolean | ❌ | false | 显示文件属性，DIR 风格字母（`A`、`HS`、`HSD` 等）。 |

## 配置

| 键 | 默认值 | 说明 |
|-----|:------:|------|
| `timeoutMs` | `1200000` | 工具调用的超时时间（毫秒）。20 分钟，与部署的全局命令超时一致。 |
| `graceMs` | `3000` | 超时后的进程终止宽限期（毫秒）。 |
| `stderrMaxBytes` | `65536` | 错误输出诊断截取上限（字节）。 |
| `rawOutputMaxBytes` | `20000000` | 标准输出解析上限（字节）。 |

## 工作原理

1. 模型调用 `everything_search`，传入查询和可选参数。
2. 插件通过 DSH 子进程接口执行 `cmd /c chcp 65001>nul & es -json ...`。
3. `es.exe` 查询 Everything 服务（已索引所有 NTFS 卷），返回 JSON 格式结果。
4. 插件解析 JSON，转换 FILETIME 日期和属性位掩码，格式化结果并返回给模型。

### 为什么用 `cmd /c chcp 65001`？

在中文 Windows（及其他 CJK 区域）上，`es.exe` 按系统 ANSI 代码页（GB2312/CP936）输出文件名，而 DSH 子进程接口按 UTF-8 解码子进程 stdout——所有非 ASCII 路径都会乱码。`chcp 65001` 在 es 运行前把控制台代码页切到 UTF-8，es 输出 UTF-8 字节即可正确解码。已端到端验证：不加它时，`D:\驱动镜像` 会变成 `D:\������`。

### 转义策略

查询被嵌入到一条 `cmd /c` 命令字符串中，所有 shell 特殊字符（**包括空格**）都用 caret（`^`，cmd 的转义符）转义：

- `size:>1gb` → `size:^>1gb`（不会被当作重定向）
- `*.pdf | *.txt` → `*.pdf^ ^|^ *.txt`（保持一次 OR 搜索，不是管道）
- `Windows11 25H2.iso` → `Windows11^ 25H2.iso`（保持多词查询）

查询**绝不用引号**：es 会把引号原样传给 Everything，其中 `"..."` 表示精确短语搜索，会静默返回 0 结果。

`path` 参数被折叠进查询作为 Everything 的 `path:` 函数前缀（`path:C:\Program^ Files\MacType *.ini`）。这刻意避开了 es 的 `-path` 参数：含空格的 `-path` 值需要引号，而 Node.js 在 Windows 上的命令行引号处理会破坏拼接在 `cmd /c` 字符串内的引号（`\"`），导致 cmd 解析失败。`path:` 函数在 caret 转义后能正确处理含空格的路径。

### es 参数顺序很关键

es 从左到右严格解析选项，且对其搜索模式开关是**贪婪**的：`-r`（正则）和 `-i`/`-w`/`-p`（大小写/全词/匹配路径）必须是**最后一个选项**，紧跟查询之前。任何出现在它们之后的选项（`-size`、`-n`、`-sort`）都会被当作搜索文本的一部分，静默返回 0 结果。因此插件按 显示列 → `-n` → 过滤 → 排序 → `-i -w -p` → `-r` → 查询 的顺序构造命令。

### 已处理的输出怪癖

- `-size` 与 `-r` 组合时，es 会把 JSON 多包一层数组（`[[{...}]]`）；解析器会解开一层。
- `-attribs` 输出数字位掩码（32 = 归档）；插件会转换为 DIR 风格字母（`A`、`HS`、`HSD` 等）。
- FILETIME 日期（自 1601 年起 100 纳秒间隔）会转换为 ISO-8601 格式。

由于 Everything 维护实时索引，即使跨数百万个文件，搜索也**近乎即时**——对于大范围搜索，比文件系统的 `glob` 或 `grep` 快得多。

## 错误码

| 错误码 | 说明 |
|--------|------|
| `ES_NOT_FOUND` | `cmd` 或 `es` 命令未安装或不在 PATH 中。 |
| `ES_FAILED` | 命令执行失败（非零退出码、启动失败、输出格式错误）。 |
| `ES_RAW_OUTPUT_OVERFLOW` | 输出超出捕获上限；请缩小查询范围。 |
| `ES_ABORTED` | 工具调用被中止（超时或取消）。 |

## 已知限制

- **Everything 正则引擎不支持 `(...)` 分组**——`.*\.(pdf|txt)$` 返回空；请用 `.*\.pdf$|.*\.txt$`。
- **`es` 必须在 `PATH` 中**；插件不探测固定安装路径。
- `path` 值同时包含空格和 `&|<>^()` 等 shell 字符时可能无法精确传递；此类目录名在 Windows 上极为罕见。

## 许可证

MIT
