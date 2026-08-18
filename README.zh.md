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

重启 DSH 后，检查模型是否可以看到该工具：

```powershell
# DSH 启动日志应显示 bundle 加载成功
# 在对话中，让模型列出可用工具，或直接调用：
# "用 everything_search 搜索所有 PDF 文件"
```

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
| `query` | string | ✅ | — | Everything 搜索查询。支持通配符、content:、size:、dm:、dc:、da:、ext:、path:、布尔运算符及 Everything 搜索语法。 |
| `max_results` | number | ❌ | 50 | 最大返回结果数（1–100000）。 |
| `path` | string | ❌ | — | 限制搜索目录。 |
| `regex` | boolean | ❌ | false | 启用正则搜索模式。 |
| `match_case` | boolean | ❌ | false | 区分大小写匹配。 |
| `match_whole_word` | boolean | ❌ | false | 仅匹配完整单词。 |
| `match_path` | boolean | ❌ | false | 匹配完整路径。 |
| `file_only` | boolean | ❌ | false | 仅搜索文件（排除文件夹）。 |
| `folder_only` | boolean | ❌ | false | 仅搜索文件夹（排除文件）。 |
| `sort_by` | string | ❌ | — | 排序字段：`name`、`path`、`size`、`extension`、`date-created`、`date-modified`、`date-accessed`。 |
| `sort_desc` | boolean | ❌ | false | 降序排序。 |
| `attributes` | string | ❌ | — | 属性过滤器，如 `"R"`（只读）、`"H"`（隐藏）。 |
| `include_size` | boolean | ❌ | false | 显示文件大小。 |
| `include_date_modified` | boolean | ❌ | false | 显示最后修改日期。 |
| `include_date_created` | boolean | ❌ | false | 显示创建日期。 |
| `include_date_accessed` | boolean | ❌ | false | 显示最后访问日期。 |
| `include_path` | boolean | ❌ | false | 显示完整目录路径。 |
| `include_extension` | boolean | ❌ | false | 显示文件扩展名。 |
| `include_attributes` | boolean | ❌ | false | 显示文件属性（R、H、S、A 等）。 |

## 配置

| 键 | 默认值 | 说明 |
|-----|:------:|------|
| `timeoutMs` | `30000` | 工具调用的超时时间（毫秒）。 |
| `graceMs` | `3000` | 超时后的进程终止宽限期（毫秒）。 |
| `stderrMaxBytes` | `65536` | 错误输出诊断截取上限（字节）。 |
| `rawOutputMaxBytes` | `20000000` | 标准输出解析上限（字节）。 |

## 工作原理

1. 模型调用 `everything_search`，传入查询和可选参数。
2. 插件通过 DSH 子进程接口调用 `es -json`，并传入相应参数。
3. `es.exe` 查询 Everything 服务（已索引所有 NTFS 卷），返回 JSON 格式结果。
4. 插件解析 JSON，格式化结果并附带元数据，返回给模型。

由于 Everything 维护实时索引，即使跨数百万个文件，搜索也**近乎即时**——对于大范围搜索，比文件系统的 `glob` 或 `grep` 快得多。

## 错误码

| 错误码 | 说明 |
|--------|------|
| `ES_NOT_FOUND` | `es` 命令未安装或不在 PATH 中。 |
| `ES_FAILED` | 命令执行失败（非零退出码、启动失败）。 |
| `ES_RAW_OUTPUT_OVERFLOW` | 输出超出捕获上限；请缩小查询范围。 |
| `ES_ABORTED` | 工具调用被中止（超时或取消）。 |

## 许可证

MIT