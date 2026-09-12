[English](README.en.md) | **中文**

# @zhourenke/dsh-tool-everything

**为 DSH 模型提供 `everything_search` 工具：基于 Everything 的全盘极速文件搜索。**

在 Windows 上调用 voidtools [Everything](https://www.voidtools.com/) 的索引，毫秒级搜遍整个磁盘（不局限于工作区），支持完整的 Everything 搜索语法（通配符、布尔、`size:`、`content:` 全文等）。

## 它擅长什么

- **全盘搜索**：给个名字片段、类型、大小、日期就能定位文件
- **全文检索**：`content:` 按文件内容找文件（需限定目录，见下文）
- **元数据**：可一并返回大小、创建/修改/访问时间、扩展名、属性
- **快**：Everything 常驻后台维护 NTFS 索引，查询是索引查找，不是目录扫描

## 前置条件

| 需要 | 说明 |
|---|---|
| Windows | NTFS 卷（Everything 的索引基于 NTFS） |
| Everything | voidtools 官方免费软件，需**安装并运行** |
| es.exe | Everything 的命令行客户端，需在 `PATH` 中 |

验证：

```powershell
es -h
```

能看到 ES 帮助信息即就绪。

## 安装

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-tool-everything"
```

重启 DSH 后生效，模型即可调用 `everything_search`。卸载：

```powershell
dsh plugin --profile web remove @zhourenke/dsh-tool-everything
```

## 快速上手

在模型会话里直接说人话即可，例如：

- 「找 D 盘下 1GB 以上的文件」→ `query: size:>1gb`，`path: D:\`
- 「找 Projects 里包含 TODO 的文本文件」→ `query: content:TODO`，`path: C:\Projects`
- 「找 2024 年 7 月改过的所有 PDF」→ `query: *.pdf dm:2024-07-01..2024-07-31`

## 搜索语法速查

`everything_search` 直接接受 [Everything 搜索语法](https://www.voidtools.com/support/everything/searching/)。常用写法：

| 想找 | 查询 |
|---|---|
| 某类文件 | `*.pdf` |
| 名称含关键词 | `report* 2024`（多个词 = 都要满足） |
| 任一类（OR） | `*.pdf \| *.txt` |
| 排除 | `!*.tmp` |
| 分组 | `<*.mp3 \| *.flac>` |
| 按大小 | `size:>1gb`、`size:500mb..2gb` |
| 按时间 | `dm:2024-01-01..2024-12-31`、`dm:today`（`dm:` 修改 / `dc:` 创建 / `da:` 访问，写法相同） |
| 按路径 | `path:C:\Projects ext:ts`（**路径含空格请用 `path` 参数**） |
| 按属性 | `attributes:H` 隐藏文件、`attributes:D` 文件夹 |
| 精确短语 | `"quarterly report"` |
| 全文内容 | `content:TODO`（必须配合范围，见下） |

注意：Everything 的正则模式**不支持 `(...)` 分组**，请用顶层或运算，如 `.*\.pdf$|.*\.txt$`。

## 参数

| 参数 | 类型 | 默认 | 说明 |
|---|---|:---:|---|
| `query` | string | — | 必填。Everything 搜索查询。 |
| `path` | string | — | 只在这个目录（含子目录）里搜；含空格的路径用它最可靠；**`content:` 搜索建议必填**。 |
| `max_results` | number | 50 | 最多返回多少条（1–100000）。要全量用 100000；一般查询用默认即可。 |
| `sort_by` | string | 相关度/名称 | `name`、`path`、`size`、`extension`、`date-created`、`date-modified`、`date-accessed`。 |
| `sort_desc` | boolean | false | 配合 `sort_by` 降序。 |
| `regex` | boolean | false | 正则模式；不支持 `(...)` 分组。 |
| `match_case` | boolean | false | 区分大小写。 |
| `match_whole_word` | boolean | false | 整词匹配。 |
| `match_path` | boolean | false | 在完整路径上匹配，而不只是文件名。 |
| `file_only` | boolean | false | 只要文件（排除文件夹）。 |
| `folder_only` | boolean | false | 只要文件夹（排除文件）。 |
| `attributes` | string | — | 属性过滤，DIR 风格：`R` 只读、`H` 隐藏、`S` 系统、`D` 目录、`A` 归档；`-` 前缀表示排除（`"R-H"` = 只读且非隐藏）；可组合（`"RHS"` = 只读+隐藏+系统）。 |
| `include_size` | boolean | false | 返回大小（字节）。 |
| `include_date_modified` | boolean | false | 返回最后修改时间。 |
| `include_date_created` | boolean | false | 返回创建时间。 |
| `include_date_accessed` | boolean | false | 返回最后访问时间。 |
| `include_path` | boolean | false | 返回完整路径。 |
| `include_extension` | boolean | false | 返回扩展名。 |
| `include_attributes` | boolean | false | 返回属性字母串（如 `A`、`HS`）。 |

## 结果长什么样

返回 `total`（匹配总数）、`truncated`（是否可能还有更多）、`results[]`。每条结果：

- `path`：完整路径（日期、属性等已格式化为可读形式）；**文件夹以 `\` 结尾**
- 请求的元数据：`size`（字节整数）、`date_modified` / `date_created` / `date_accessed`（`2026-01-02 03:04:05` 式）、`extension`（有扩展名返回如 `js`；无扩展名文件返回 `""`；**文件夹不输出该字段**）、`attributes`（字母串）
- `warning`：内容搜索范围被自动收窄时出现——**读到它就说明结果不完整，应改用更具体的目录**

默认同时匹配文件与文件夹；结果数顶到 `max_results` 时，插件会自动补一次计数查询把 `total` 取准。

## 内容搜索（content:）的规则

`content:` 全文搜索会遍历文件内容，范围过大可能卡死 Everything，因此有硬性护栏：

- **必须限定范围**：通过 `path` 参数，或查询内联 `path:...`，二选一。完全没有范围会被**直接拒绝**。
- **广域范围会被收窄**：对驱动器根目录（`C:\`）、`C:\Users`（及其下一层）、`C:\Documents and Settings`（同理）、当前用户主目录搜索时，自动降级为**只搜直接子级（一层，不递归）**，并在 `warning` 中说明。
- **推荐**：搜内容时给具体目录，例如 `content:secret_key` + `path: C:\Projects\MyApp`。

## 给 Agent 的调用要点

- 工具名 `everything_search`；**全盘搜索**，不受工作区限制
- 默认最多 50 条、默认包含文件夹；要全量用 `max_results: 100000`，只要文件用 `file_only: true`
- 目录以 `\` 结尾且没有 `extension`，凭这两点区分文件与文件夹
- 读到 `warning` 就调整：内容搜索范围被收窄了
- 搜内容必须先给一个具体目录

## 错误码

| 错误码 | 含义 |
|---|---|
| `ES_NOT_FOUND` | `es` 或 `cmd` 不可用（Everything 未安装 / es.exe 不在 PATH） |
| `ES_FAILED` | 执行失败（例如无范围的 `content:` 被拒绝） |
| `ES_RAW_OUTPUT_OVERFLOW` | 输出过大；请缩小查询范围 |
| `ES_ABORTED` | 调用被中止（超时或取消） |

## 已知限制（实测确认）

- **Everything 未运行时**搜索失败——先启动 Everything。
- **硬链接文件可能搜不到**：Everything 的实时索引不收录新建的硬链接（pnpm 等包管理器装进 `node_modules` 的文件会这样），在 Everything 中执行 Force Rebuild 后出现。属 Everything 自身行为，非插件缺陷。
- **正则不支持分组**；**内联 `path:` 不支持含空格的路径**（含空格一律用 `path` 参数）。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `timeoutMs` | 1200000 | 单次搜索超时（毫秒） |
| `graceMs` | 3000 | 超时后终止进程的宽限（毫秒） |
| `stderrMaxBytes` | 65536 | 报错时截取的 stderr 上限（字节） |
| `rawOutputMaxBytes` | 20000000 | 输出解析上限（字节） |

## 兼容性

在 **DSH v0.1.5-rc.1**（2026-09）下测试通过。

## 许可证

MIT