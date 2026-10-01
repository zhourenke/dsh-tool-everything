# 开发注意事项（Development Notes）

> 面向本插件的维护者与开发者。使用者（含模型 Agent）请阅读 [README.md](README.md)。
> 更完整的开发、发布与排错经验在工作区级文档 `PLUGIN_RELEASE_GUIDE.md`（**不在本仓库内**，见文末「经验沉淀」）。

## 仓库结构

| 路径 | 说明 |
|---|---|
| `src/index.ts` | 唯一源码：Cordis 插件，导出 `{ apply, Config, inject, name }` |
| `lib/index.js` + `lib/types/` | 构建产物（`tsc` 输出），**随源码一起提交**（路线 A，git 分发） |
| `test/index.test.mjs` | `node --test` 测试（当前 79 项，`lib/index.js` 行覆盖 100%） |
| `cordis.patch.yml` | `dsh.bundle.patch` 指向的 profile 层 patch |
| `icon.svg` + `locale/{en,zh}.json` | 插件列表的显示元数据：宿主**不激活插件**就能读到名称、说明与图标（见「实现要点」第 8 节） |
| `package.json` | `main`/`exports["."]` 指向 `lib/index.js`；`dsh.bundle` 声明 patch 文件 |

## 本地开发与构建

```powershell
pnpm install          # 拉取构建/测试依赖
pnpm run typecheck    # tsc --noEmit
pnpm run build        # tsc -> lib/
pnpm test             # pnpm run build && node --test
```

- **产物必须与源码同步提交**：只改 `src/` 而不提交 `lib/`，git 安装会跑到旧代码。测试失败先确认是不是 build 步骤挂了（`pnpm test` 内部先 build）。
- **不要加 `prepare` 脚本**：路线 A 要求安装命令不触发构建，`lib/` 已在仓库里。
- `node --test` 用裸形式；给 `test` 目录参数会 MODULE_NOT_FOUND，给 glob 会静默 0 测试。

## 开发挂载：让 DSH 加载你改的代码

推荐 **profile 本地连接点**：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\@zhourenke\dsh-tool-everything" -Target "C:\path\to\this\repo"
```

同时确保 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里包含 `@zhourenke/dsh-tool-everything`。卸载开发连接点要**手动**删连接点并从 `bundles` 移除——`dsh plugin remove` 对连接点安装无效（pnpm 报 `ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS`）。

实测教训（2026-09，详见工作区指南「连接点安装 ≠ 正式安装」）：

- **改了代码必须重启 DSH** 才生效——运行中的进程已把旧 `lib/` 载入模块缓存。判断"加载了没有"，以会话记录里最新一轮 `request/header` 的工具表为准，**不以"没报错"为准**（名字从 `bundles` 移除后 profile 照常启动、插件静默不存在）。
- **`bundles` 里列了名字但解析目标不存在 = 整个 profile 启动失败**（硬失败）。报错只有一句 `cannot resolve profile bundle ... from the dsh installation or <profileDir>`，措辞会把人引向"依赖没装"，真实原因是解析目标没了。
- **共享农场 `~/.dsh/profiles/node_modules/` 不是持久存放开发连接点的地方**（整组消失过一次，农场自身没坏）；放 profile 本地的连接点在清理中存活。连接点一律建在 profile 自己的 `node_modules` 下。

## 实现要点（为什么这样做）

### 1. 为什么用 `cmd /c chcp 65001>nul & es -json ...`

中文 Windows（及其他 CJK 区域）上 es 按系统 ANSI 代码页（GB2312/CP936）输出文件名，而 DSH 子进程按 UTF-8 解码 stdout——非 ASCII 路径全会乱码。先 `chcp 65001` 再跑 es，es 输出 UTF-8 字节即可正确解码。端到端实测：不加时 `D:\驱动镜像` 变成 `D:\`。

### 2. 查询转义：caret、绝不用引号、path 走环境变量

查询被嵌进一条 `cmd /c` 字符串，所有 shell 特殊字符（**含空格**）用 caret（`^`，cmd 的转义符）转义：

- `size:>1gb` → `size:^>1gb`（不会被当作重定向）
- `*.pdf | *.txt` → `*.pdf^ ^|^ *.txt`（保持一次 OR 搜索，不是管道）
- `Windows11 25H2.iso` → `Windows11^ 25H2.iso`（保持多词查询）
- `100%CD%` → `100^%CD^%`（不被 cmd 的 `%NAME%` 替换吃掉；实测 `cmd /c "echo ^%CD^%"` 打印字面 `%CD%`，不加 caret 则打印当前目录）

查询**绝不用引号**：es 会把引号原样传给 Everything，其中 `"..."` 表示精确短语搜索，会静默返回 0 结果。

**非查询参数走白名单，不走转义。** `sort_by` 与 `attributes` 同样会被拼进这条 `cmd /c` 字符串，早期版本原样透传，于是 `sort_by: "name & echo X"` 让 cmd 执行了两条命令、`attributes: "R & echo X"` 同理（实测：构造出的命令行里 `&` 裸露，而 `cmd /c "echo a & echo b"` 确实输出两行）。现在 `parseEverythingArgs` 在拼串之前就把两者收窄：`sort_by` 只接受 schema 里写明的那 7 个字段（大小写不敏感、统一小写），`attributes` 只接受那 13 个 DIR 字母（`R H S D A V N T L C O I E`，每个字母可带 `-`/`+` 前缀）。非法值抛错并列出合法取值（`sort_by` 列全部 7 个，`attributes` 列全部 13 个），连 es 都不会 spawn。

**字母集合本身必须校验，只校验字符形状不够。** 实测（同一查询 `*.md`，全部走本插件）：`attributes: 'Z'` 与不加过滤返回**同一个总数 17807**，而 `attributes: 'D'` 只有 4 条——**es 对未知字母静默忽略**。逐个核对合法字母时又测到 `R` → 657、`A` → 17635，都 ≠ 17807，确认合法字母确实在过滤；而 `H`、`S`、`V`、`N`、`T` 五个**始终没测出结果**（见「经验沉淀」里的那次故障），所以"这 13 个字母都被 es 认作过滤器"目前只有 `R`/`A`/`D` 有实测、其余 10 个属于推断（依据是它们与 `-attribs` 输出的字母集完全相同）。也就是说，一个猜出来的字母（比如给"可执行"猜 `X`）会返回看起来完全正常、实际**未过滤**的结果集，这正是本工作区最忌讳的失败类别。所以白名单写的是那 13 个字母本身（`ATTRIBUTE_LETTERS`，见 `src/index.ts`），`formatAttributes` 的映射表用同一套字母，测试里有一条不变式把两张表钉在同一集合上。es 自己只拒绝非字母字符（`/aZZ9` → `Error 4: Unknown attribute: 9`，退出码 4），而插件永远不会走到那个分支——正则先把字符挡住了。

**新增任何进入命令行的参数都要按同一模式处理**——白名单比转义更好，因为错误信息能直接告诉调用方合法取值。

`path` 参数**不折叠进查询**，而是作为 es 的 `-path` 选项传递（广域 `content:` 搜索则用 `-parent`）。早期版本用 `path:` 前缀折叠，两种失败方式均已实测：

- 含空格的路径即使 caret 转义后仍会被拆开：`path:C:\Program^ Files` 到达 es 时是**两个** argv 元素（`path:C:\Program` 与 `Files`），`path:` 函数只拿到被截断的路径，静默返回 0 结果。
- 正则模式下更彻底：`-r` 会把整个搜索串当作一条正则编译，`path:C:\dir` 退化为字面文本，任何文件名都匹配不上。

`-path` 取值可能含空格因而需要引号，而引号放进这条 `cmd /c` 字符串会被 Node.js 转义成 `\"`、再被 cmd 拆散（实测 `-path "C:\Program Files"` 到达 es 时第一个元素还带着多余的引号）。所以**取值通过环境变量 `EVERYTHING_TOOL_PATH_ARG` 传递**：引号存放在环境变量的值中，命令字符串本身不含任何引号字符。

### 3. es 参数顺序很关键

es 从左到右严格解析选项，且对其搜索模式开关是**贪婪**的：`-r`（正则）和 `-i`/`-w`/`-p`（大小写/全词/匹配路径）必须是**最后一个选项**、紧跟查询之前。任何出现在它们之后的选项（`-size`、`-n`、`-sort`）都会被当作搜索文本的一部分，静默返回 0 结果。构造顺序固定为：

```
显示列 → -n → 过滤 → 排序 → -i -w -p → -path/-parent → -r → 查询
```

### 4. 已处理的输出怪癖

- `-size` 与 `-r` 组合时，es 会把 JSON 多包一层数组（`[[{...}]]`）；解析器解开一层。
- `-attribs` 输出数字位掩码（如 16 = 目录，32 = 归档）；转换为 DIR 风格字母（`R H S D A V N T L C O I E`）。
- FILETIME（自 1601 年起 100ns 间隔）转换为 `2026-01-02 03:04:05` 式可读格式。**不可用的时间戳直接丢字段**：0 是 Windows API 的「未设置」值，格式化出来是 1601-01-01（没人要这个日期）；非数值或超出 `Date` 范围的值会让 `toISOString()` 抛 `RangeError: Invalid time value`，那是整次调用失败，而不是少一个元数据字段。守卫写成 `typeof === 'number' && Number.isFinite && > 0`，两处都有测试。

### 5. content: 安全护栏

`content:` 走系统 iFilter 读文件内容，范围过大能把 Everything 卡死。两层保护：

- **无范围 → 拒绝**：query 无 `content:` 范围（无 `path` 参数且无内联 `path:`）时直接抛 `ES_FAILED`，不给 es 发命令。
- **广域路径 → 收窄为直接子级一层**：`isBroadPath()` 只认四种形态——盘根（`C:\`）、`C:\Users` 或其**正下一级**、`C:\Documents and Settings` 同理、当前用户主目录。命中时结果里附加 `warning`，模型读到就该改用更具体的目录。

机制注意：两条实现路径不同——path 参数路由用 es 的 `-parent` **选项**，内联 `path:` 路由用 Everything 的 `parent:` **函数**。**面向模型的文案只讲效果与补救、不点机制**（这条纪律由提交 `3c26a1a` 确立）：点中任何一个，对另一条路都是错的。

**同步纪律**：判据代码、判据注释、系统提示词描述、运行时警告是四处独立副本，会各自漂移，源头常在注释。改判据后**先改注释、再改全部模型可见文案**，并在注释里写明「此处清单必须与那条消息同步」。`isBroadPath()` 的四个形态与 `contentSearchRestrictedWarning()` 的措辞必须逐字一致。

### 6. 目录的 `extension` 是 null（已修，防同类问题）

实测 `es -json -ext`：目录 → `"extension":null`；无扩展名文件 → `""`；普通文件 → 扩展名本身（950 行样本中 null 与「目录」100% 重合）。目录的 null 一旦进结构化输出，宿主 schema 校验（`extension` 为 string）会**整条拒收**——不是只丢那一行。

修复（提交 `06f485f`）：输出时 `typeof entry.extension === 'string'` 才带上该字段；目录仍可凭路径结尾 `\` 识别。**任何新字段都要防同类问题**：输出前断言所有值非 null（测试里有通用不变式）。

### 7. 附加查询要有独立预算，且必须能降级

`max_results` 被填满时，插件会再发一次 `es -get-result-count` 去拿精确总数。它只是**附加信息**：列表已经拿到手，拿不到总数时 `countMatches` 返回 `undefined`，调用方降级为"可能还有更多"（`truncated: true`）。

这条降级路径只有在计数查询**不跟主查询共用那 20 分钟预算**时才有意义。原先两者共用 `timeoutMs`，于是一次卡住的 `es` 会把整个调用的预算吃光：宿主在 `1200000 ms` 处终止调用，**连已经取到的列表一起丢掉**（2026-09-28 实测，见「经验沉淀」）。现在计数查询跑在**宿主自己的超时算术**上（`@deepseek-ai/dsh-timeout` 的 `deadline(exec.signal, countTimeoutMs, COUNT_TIMEOUT_CODE)`）：它把"调用方取消"与"计数自己的短预算"融进同一个信号（默认 5 秒，配置项 `countTimeoutMs`），并用 `timeoutOf(signal, code)` 让降级处能分辨是哪一边先开枪——预算先到记 `count pass exceeded its Nms budget`，取消先到记 `count pass returned no total (...)`（否则日志里"Everything 卡住"与"调用方走人"长得一模一样，而这两种故障的处置方式完全不同）。

**这里有两个实测出来的坑。** 其一，**`deadline` 的定时器没有 unref**（0.2.0-rc.2 实测：`process.getActiveResourcesInfo()` 里确实多出一个 `Timeout`），所以 `finally` 里的 `budget[Symbol.dispose]()` 不是可选项——漏掉它，一次提前结束的计数会把事件循环吊到预算耗尽为止（用的是宿主 API，就按宿主的约定清理）。其二，它要求 `tsconfig` 的 `lib` 里有 `esnext.disposable`，否则连 `Symbol.dispose` 这个名字都不存在、`tsc` 直接报错。

测试里假 seam 的形态不是凭空写的：计数用例只在被 abort 时结束，结束值 `{ signal: 'SIGTERM', exitCode: null }` 取自 `SubprocessOutcome` 的声明，而"abort 会终止子进程"既有 seam 文档（"the spec's abort signal" 启动终止其托管范围）也有实测兜底——宿主今天终止那 5 个卡住的调用后，没有任何 `es` 残留。

假 seam 还必须处理一个**顺序**：调用方**恰好在 spawn 期间**取消时，信号在监听器挂上之前就已经 aborted，而 `abort()` 对已中止的信号不再派发事件——只挂监听器的假 seam 会永久挂住（第一版测试就这么挂死，180 秒后被我掐掉；真实 seam 对已中止的信号直接不启动或立即终止，所以假 seam 必须先查 `signal.aborted` 再挂）。

降级之后还有一步：计数拿不到时 `total` 只是**下界**（等于返回的行数），于是正文那句话说成 `Found at least N results for "…" (showing first N; the exact total is unavailable)`，而不是 `Found N`。否则 17807 个匹配会被写成 `Found 1 result`，而系统提示词那边明确写着 `"Found N" is the TRUE match count`——模型照读就会给出一个"看起来很确定"的错误答案。实测：把 `countTimeoutMs` 临时钉成 `1 ms`，旧文案输出 `Found 1 result for "*.md" (showing first 1)`，同一调用里列表本身是完好的。判定用 `totalIsExact`：计数成功且总数大于列表长度时 `total > 已返回行数` 必然成立，所以 `truncated && total <= 行数` 恰好等价于"总数未知"；卡片那边要传**未截断**的行数（`presentationMeta` 自己的路径预算会砍短那份列表，用砍过的长度判断会漏判）。

**推广**：凡是"主结果之外的附加调用"（计数、探测、补充元数据）都要有自己的短预算与降级路径，否则它会把主结果的预算吃光；宿主只在**整个调用**的超时点终止，不会替你把两者分开。

### 8. 插件列表的显示元数据（0.1.7 起，非运行时读取）

插件列表里的名称、说明与图标**不经过插件代码**：宿主用 `readPluginMeta()` 直接读包内文件——`locale/<语言>.json` 里的 `{"meta":{"title":…,"description":…}}`，以及顶层 `icon` 字段指向的图片。因此这条路径**没有任何运行时测试能覆盖**：`apply` 的用例全绿，插件列表里照样可能没有名字。

容易漏的地方：

- **`locale/*.json` 必须写进 `exports`**（`"./locale/*.json": "./locale/*.json"`）：宿主是按 `<包名>/locale/en.json` 这个**模块说明符**解析的，没暴露就解析不到；解析不到返回 `undefined` 而**不是**异常，于是列表静默地没有名字。
- **`icon.svg` 与 `locale/*.json` 都不在 npm 的自动包含集里**，必须同时写进 `files`；漏了只是"没有图标"，同样不报错。
- **失败模式不对称**：图标无效只降级成"没有图标"，而 `meta.title` / `meta.description` **存在但不是非空字符串会让宿主的元数据读取整体失败**——内部 `textOf` 抛错、被 `readPluginMeta` 捕获成 `{ error }` 返回（0.2.0-rc.2 复核：`textOf` 仍是 `throw`，所以"连已读到的图标一起丢"这句话仍然成立），列表里既没有名字也没有说明和图标。语言文件名（`en.json` / `zh.json`，文件名就是语言 id）与顶层字段名 `icon`（不是 `dsh.icon`）都由宿主规定，写错不会解析成别的东西，只是不生效。

**验证要用宿主自己的函数，而不是本地结构接口**：`readPluginMeta(name, parentURL)` 的 `parentURL` 必须是**本插件实际解析到的那棵树**的基址（连接点安装时就是 profile 目录）——给错目录得到的是 `undefined` 而**不是异常**，这正是这类检查最容易假绿的地方；命令即指南「DSH 升级后的复核」第 13 步。本地那两条断言在 `test/index.test.mjs` 末尾：语言 id 合规、存在值必须是非空字符串、图标在包目录内且 ≤256 KiB、`exports` 与 `files` 两项都在。

**它与 `lib/` 的改动不同：不需要重启 DSH。** 宿主是在 `listPlugins()` 里**按次现读**的，改完刷新插件列表就能看到。

### 9. 与 DSH 0.2.0-rc.2 的交融面（复核于 2026-09-30）

迁到 **0.2.0-rc.2** 时先做的是"别重复造轮子"这一步：宿主这次把**工具调用的超时**和**超大结果的留存**都收成了公共机制，插件原先自己写的那部分就该让出去。逐项对照（判据都是宿主代码本身，不是文档）：

| 插件里的机制 | 0.2.0-rc.2 的提供方 | 处置 |
|---|---|---|
| 工具调用超时（`timeoutMs` 配置） | `ToolDefinition.timeoutMs` + `dsh-tool-call-timeout-policy` | **本就是宿主实现**：包装层读 `ctx.tools.get(name)?.timeoutMs`，把自己的 `deadline` 信号临时换进 `exec.signal`，赢了就返回结构化 `TOOL_TIMEOUT`。插件只声明预算、转发 `exec.signal`，没有自己的定时器 |
| 计数查询的预算融合 | `@deepseek-ai/dsh-timeout` 的 `deadline` / `timeoutOf` | **改用它**：手写的 `AbortSignal.any([exec.signal, AbortSignal.timeout(...)])` 由宿主这一层取代（见「实现要点」第 7 节） |
| 超大结果的恢复路径 | `dsh-spill-policy`（+ `ctx.spillStore`，默认组合里已启用） | **插件不必做**：策略层把超预算的 content 存下来，只保留首尾并附上 locator + retrieval hint，而插件渲染的每一行都在那份 content 里 |
| `presentationMeta` 的 16 KiB 预算 | 无（官方 `dsh-tool-fs-search` 也自带 `capMetaBytes`） | 保留：策略层**只缩 content、从不缩 meta**，这份预算是每个工具自己的责任 |
| 并发分类 | `ToolDefinition.isConcurrencySafe` | 用宿主字段（官方声明它的仍是五个：`dsh-tool-fs` 的 read/read_image、`dsh-tool-web` 的 web_search/web_fetch、`dsh-tool-subagent` 的 list_subagent_models；0.2.0-rc.2 复核未变） |
| 搜索本身 | 官方 `glob` / `grep`（`dsh-tool-fs-search`，ripgrep） | **互补，不是重复**，见下 |

**与官方 `glob`/`grep` 的边界（实测了它们在 0.2.0-rc.2 的完整参数表）**：`glob` 只有 `pattern` + `path`，`grep` 只有 `pattern` + `path` + `include`，默认落在**会话工作区**，靠 ripgrep **遍历文件系统**。本插件的差异不是"也能按名字搜文件"，而是**索引**与**查询语言**：Everything 查的是常驻 NTFS 索引（不遍历磁盘），语言里有 `size:`/`dm:`/`dc:`/`da:`/`ext:`/`attributes:` 这些**元数据条件**、布尔与 `<a|b>` 分组、以及必须限定范围的 `content:`。默认全盘、元数据过滤、工作区之外这三件事官方工具都不覆盖——系统提示词里那句分工（工作区内优先 glob/grep）就是这条边界的落地。

**官方 glob/grep 自带 spill，而本插件不需要，原因要记住**：它们把结果**采样**成 `globMaxResults`（默认 100）行再渲染，完整列表只在内存里，所以必须自己 `saveText` 并附 locator；本插件渲染的是它**取到的每一行**，超预算部分交给策略层留存。维护时守住这条差异：一旦本插件改成"只渲染抽样"，就必须自己接管 spill，否则模型会把抽样当成全部。

**复核判据（都可重跑，命令见指南「DSH 升级后的复核」）**：

- `pnpm run typecheck` 对 0.2.0-rc.2 类型**零报错**——本插件导入的是宿主类型而非本地镜像，所以这一步就是漂移判据：`defineTool`/`ToolDefinition`、`SubprocessSpawnSpec`/`SubprocessHandle`/`SubprocessOutcome`、`PromptSection`、`HarnessError` 全部未变。
- 准入闸门 `evaluatePluginCompatibility()` → `COMPATIBLE`（runtime 0.2.0-rc.2）。
- 显示元数据 `readPluginMeta()` 仍返回中英标题、说明与图标，且无 `error` 字段。
- `inject` 的服务名与官方 `dsh-tool-fs-search` **逐字相同**（`tools`/`systemPrompt`/`subprocess`；`logger` 是环境对象、不进 `inject`，官方同样只用不注入）。
- 载荷断言通过（10 个文件，含 `icon.svg` 与两个 locale）。

## 测试要点

- mock es 输出必须贴近真实 es 的形态，否则 schema 违规测不出来——**mock 发不出的字段，测试永远看不见它违反 schema**。fixture 至少覆盖：目录（`extension: null`）、无扩展名文件（`extension: ""`）、普通文件（`extension: "js"`）。
- **注入类缺陷只能靠断言命令串本身**：mock seam 不经过真实 cmd，`sort_by`/`attributes` 里裸露的 `&` 在 mock 下"测试全绿"。所以回归测试断言的是构造出来的命令行（合法值被白名单收窄成 `-sort date-modified-ascending`、`/aR-H`，非法值在 spawn 之前就抛错），以及"被拒绝的调用不得 spawn"。
- 通用断言：遍历每条结果，**任何字段值不得为 null**。
- 判断插件有没有被 DSH 加载，用会话记录的最新一轮 `request/header` 工具表，别问模型"你看到新提示词了吗"（模型侧策略会拒绝逐字复述，且观感可能滞后于下发内容）。
- 当前 79 项全部通过。
- **找冗余逻辑和死代码要靠覆盖率，不要靠肉眼**：`node --test --experimental-test-coverage --test-reporter=lcov` 给出 `lib/index.js` 每一行的执行次数，未执行的行就是"要么是死代码、要么是没有测试的可达路径"，两类必须分开处理（见下）。
- **错误分支要有专门的用例**：这类代码不写用例就永远测不到，而它恰恰是模型唯一能看到的"出事时的说法"。现在每个 `EverythingError` 分支各有一条用例（非数组 JSON、非 ENOENT 的启动失败、`done` 被拒、没有 collected 流、被信号杀死、取消先于 ENOENT、预算 vs 取消），`--test-coverage` 对 `lib/index.js` 报 **100% 行覆盖**（250/250）。

### 10. 冗余与死代码清理（2026-09-30，覆盖率驱动）

用 `--experimental-test-coverage` 把 `lib/index.js` 逐行过了一遍，**未执行的行分成两类**，处置完全不同：

**删掉的（先证明它不可能执行）**：

- **`entry.path` 回退**：原代码是 `entry.filename ?? entry.path ?? '(unknown)'`。实测 `es -json -full-path-and-name` 的输出里**只有 `filename`**、没有 `path` 键，所以那一层回退永远不会命中。接口 `EsResultEntry` 随之收紧到实测词汇（`extension: string | null`、`attributes: number | null`），`path` 字段直接删除。
- **`typeof process !== 'undefined'` 守卫**：这个模块只在宿主 Node 进程里运行（它注入宿主服务），浏览器分支不可能出现。
- **`header || 'No files found'` 回退**：`render` 里 `total === 0` 且带 warning 时 `header` 必然已被赋成 `⚠️ …`，那个 `||` 是死的。顺带把 `total === 0` 的分支合并成一处早返回（同时去掉了零结果 + 警告时多出来的两个前导空行）。
- **`applyEverythingTool` → `apply` 的包装层**：原来是 `apply` 调用 `applyEverythingTool`，纯转发，合并成一个函数（loader 只认 `apply`）。
- **两个重复的 `warning` 展开表达式**：两处 return 用同一段条件展开，抽成 `restrictedWarningField(input)`；同时把 `_contentSearchRestricted` 布尔量删掉——`_contentSearchRestrictedPath` 的值本身就是那个标志（路径为空时才可能歧义，而 `isBroadPath` 只对非空路径成立）。

**保留的（可达，只是缺用例）→ 补用例，不删代码**：`parseEsOutput` 的非数组拒绝、`formatAttributes` 的非数字透传、spawn 失败的四种形态、`collected` 缺失、信号后于进程结束、各 `include_*` 列与 `file_only`/`folder_only`/`match_case`/`match_whole_word`/`match_path`/`sort_desc` 开关、非 Error 抛出、stderr 摘要被截断、以及 `apply` 收到未过 schema 的裸配置。补完后 **`lib/index.js` 行覆盖 100%（1258/1258）**，分支覆盖 91.4%——剩下没走到的分支全是"字段缺失/时间为空"这类不存在的输入形态（如 `filename` 缺失、`stdout.text` 缺失），不是没测到的功能。

**顺手修掉的三个真问题**（都是清理时读出来的，不是风格问题）：

- **`spawn ENOENT` 的归因**：libuv 对**不存在的 cwd** 也报 `ENOENT`（指南故障表已收录），原代码一律回"es.exe 没装在 PATH 里"，会把"会话工作目录被删了"误导成"重装 Everything"。现在先 `existsSync(workdir)` 再决定文案与错误码（`ES_NOT_FOUND` / `ES_FAILED`），并且**这一步排在"信号已取消"判断之后**——取消优先于 ENOENT，否则模型会收到"去装 es.exe"这种与它自己超时无关的建议。
- **`errorMessage()` 取代 `(error as Error).message ?? String(error)`**：后者对"抛出的不是 Error"这种情形错两次（非 Error 对象会静默走 `??` 兜底；抛 `null` 时属性访问本身抛 TypeError，**在被 catch 的路径里抛出**，正好把要报的失败换成一个无关的 TypeError）。seam 里四处失败边界统一用这一个函数。
- **计数低于手上的行数时不能采信**（分支覆盖翻出来的）：`-get-result-count` 若返回空载荷（`''` / `[]`），`countMatches` 会按"没有匹配"返回 `0`，于是 `total = 0` 而 `results` 里明明有行——渲染出来就是**一边列文件、一边写"No files found"**，属于最坏的那种失败形态（自相矛盾的结论）。现在 `exact < results.length` 一律当作"计数不可信"：保留行数、置 `truncated`，按"至少 N 条"如实说。`totalIsExact` 的同一原则在这里又用了一次——**不报没有证过的总数**。

## 面向模型的文案（两处落点，互不同步）

| 写法 | 落点 | 会话记录里读它的位置 |
|---|---|---|
| `ctx.systemPrompt.section({...})` | 请求的 system 槽 | `system/message` 的 `data.message.content[0].text` |
| `defineTool` 的 `description` | 工具表 | `request/header` 的 `data.header.tools[]` |
| `output.render` 返回的 `text` | 工具结果正文 | 该次工具调用的 result 块 |

同时改两处后，系统提示词的长度增量**不等于**两处增量之和——工具描述根本不在 system 槽里。验证改没改上，以记录为准。表格里前两处会一起出现在同一次请求里，但**解释第三处的规则写在第一处**：正文里 `Found at least N …` 是什么意思，由系统提示词那句 `"Found at least N" means that count could not be read` 交代——改一处就必须改另一处，它们不会互相提醒。

工具用 `throw` 报出的参数校验错误也是**模型可见文案**（还有一处，容易漏）：`sort_by` 与 `attributes` 的合法取值就写在那条报错里，改白名单时必须一起改——否则模型只会知道"这个值不行"，而不知道哪些值行。

## 运行时依赖（与 DSH 版本匹配）

| 包 | 用途 |
|---|---|
| `@deepseek-ai/schemastery` | 配置校验 |
| `@deepseek-ai/cordis` | 插件框架 |
| `@deepseek-ai/dsh-tools` | 工具定义 |
| `@deepseek-ai/dsh-llm` | LLM 错误类型 |
| `@deepseek-ai/dsh-subprocess` | 子进程接口 |
| `@deepseek-ai/dsh-system-prompt` | 系统提示词段落注册 |
| `@deepseek-ai/dsh-timeout` | 计数的独立预算（`deadline`/`timeoutOf`），见「实现要点」第 7 节 |

已测试版本：**DSH v0.2.0-rc.2**（2026-09）。升级 DSH 后逐个核对**值导入**是否仍是宿主导出（过渡 API 会悄悄变成内部符号，插件解析到自己的私有副本时永远看不见）。

`schemastery` 是唯一进 `dependencies` 的包（代码真正 import 它），范围写 **`~3.18.4`**：宿主的每一个包都声明 `~3.18.4`，宿主实体也是 3.18.4，所以插件解析到的是**同一个 `.pnpm/@deepseek-ai+schemastery@3.18.4`**。此前写 `^3.18.2` 时 lock 把本包钉在 3.18.2，同一进程里存在两份 schemastery——它不报错（`Config` 只被 cordis 当鸭子类型调用），但类型图会因此分叉，`TS2883` 就是那份分叉的产物。**升级 DSH 时把这条范围一起复核**（宿主换到新的 schemastery 行时必须同步跟）。

## 与宿主版本的绑定点（0.2.0-rc.2）

`devDependencies` 里那几个宿主包**钉死版本号而非范围**：它们决定 `tsc` 拿哪一版类型校验。**连接点挂载时运行时用的是宿主那一份**，所以不钉死就会出现"类型按旧版通过、运行按新版行为"的错位——本插件曾长期拿 0.1.5-rc.1 的类型编译。

| 绑定点 | 内容 | 为何必须 |
|---|---|---|
| `peerDependencies` | 五个宿主包 `^0.2.0-rc.2`，`cordis` 走自己的版本线 `^4.0.4` | 预发布版本只被「同一 major.minor.patch 且带预发布」的范围放行，`^0.1.7-rc.2` 匹配不到 0.2.0-rc.2；`cordis` 不参与宿主准入闸门（判定只看 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`），工作区各插件一致写 `^4.0.4` |
| `devDependencies` | 同一组版本号，精确 | 让 `tsc` 按新宿主校验；否则类型检查是假绿 |
| 导入的宿主类型 | `SubprocessSpawnSpec`/`SubprocessHandle`/`SubprocessOutcome`、`PromptSection`、`ToolRunContext`/`ToolCallView`/`ToolResultView` | 本地结构接口**不会**因宿主漂移而报错（指南「类型定义原则」）；改用宿主类型后 `exec.agent.session.header.cwd` 这类访问点全部受检 |
| `Config` 的标注 | `configSchema as unknown as ReturnType<typeof z.any>` | 三种写法实测：原样导出在**两份 schemastery 同版本**时能过、分叉时报 `TS2883`（"cannot be named without a reference to 'Schema'"）；直接标注两边都报 `TS2322`（`Schema` 的 `data` 参数逆变，与副本数量无关）；断言恒过但放弃检查。宿主换 schemastery 行会让两份实体重新分叉，断言让那时只多一个可移植声明、而不是构建直接红 |

### 交融点（用满新版能力，而不只是"能跑"）

- **`isConcurrencySafe: () => true`**：宿主对缺席者一律判 `exclusive`（`if (!tool?.isConcurrencySafe) return { kind: 'exclusive' }`），会把并发搜索无谓串行化。Everything 索引查询是纯读、无共享可变状态，可安全进并行组。
- **presenter 返回宿主视图类型**：`presentResult` 返回的就是宿主的 `SearchPathsResultView`（`card: 'search'` + `shape: 'paths'`），与官方 glob 同一张卡；`presentCall` 保持 `card: 'generic'` + `kind: 'search'`——宿主文档明确：搜索的待定态没有路径可显示。
- **`presentationMeta` 封顶 16 KiB**：该投影**随会话日志持久化**，穷举搜索（`max_results: 100000`）不能把每条路径都写进去。按宿主 `capMetaBytes` 的口径逐条量**序列化后**的长度——Windows 路径的反斜杠在 JSON 里是 `\\`，用 `byteLength(path)` 估算会把预算低估约一倍（第一版就是这么错的，被新测试抓住）。
- **stdout 双重校验**：`lossy` → `ES_RAW_OUTPUT_OVERFLOW`；未标记 lossy 但字节数超预算同样拒绝。与官方 `completeStdout` 同形，两个发现类工具的失败方式一致。
- **spill 有意不接（指的是原始 stdout 那一层）**：seam 提供 `SubprocessOutputRead.spillPath`（大输出落盘），但官方 `completeStdout` 在 lossy 时**直接失败**而不读 spill——不解析可能不完整的流。本插件跟随该决定。注意这与 0.2.0 的 `dsh-spill-policy` **不是同一层**：那一层管的是模型可见 content 的留存与提取（见「实现要点」第 9 节），本插件没有理由重造。
- **工具调用的超时交给宿主**：`defineTool({ timeoutMs })` 声明预算，`dsh-tool-call-timeout-policy` 负责武装 `exec.signal` 并把超时转成 `TOOL_TIMEOUT`。插件内**没有**自己的定时器，也不把超时翻译成自定义错误码——两条路径同时存在就必然有一条是死代码（见「实现要点」第 9 节）。
- **计数预算用宿主的超时算术**：`@deepseek-ai/dsh-timeout` 的 `deadline`/`timeoutOf`，而不是手写 `AbortSignal.any` + `AbortSignal.timeout`（见「实现要点」第 7 节）。
- **插件列表的显示元数据**：`locale/{en,zh}.json` + `icon.svg` + 顶层 `icon` 字段，宿主不激活插件就能读出名称、说明与图标（见「实现要点」第 8 节）。

## 经验沉淀

### 观测到的一次 es 全面挂起（2026-09-28）

排查 `attributes` 字母时，一批 **5 个并发**的全盘属性查询（`attributes` 分别为 `H`/`S`/`V`/`N`/`T`，其余参数相同：`query: '*.md'`、`max_results: 1`）全部耗到宿主的工具超时（`1200000 ms`，与插件 `DEFAULT_TIMEOUT_MS` 同值）才失败。此后连**不带任何过滤**的 `es -n 3 *.md` 也不再返回——而同一命令 20 分钟前只要约 100 ms。

同时测到 **Everything（PID 3228）持续占满一个核**：5 秒墙钟内消耗 4.97 秒 CPU；约 40 分钟前该进程累计 CPU 为 `5151 s`，故障时已到 `13784 s`。`es` 进程随后全部消失（宿主超时会回收整棵进程树），没有残留。

- **事实**：那 5 个字母"计数是否被过滤"因此没测出来；查询挂住时插件侧没有提前失败的手段，整个调用会耗满 20 分钟预算再失败，**连已经拿到的列表一起丢掉**（附加计数查询现已改为独立短预算，见「实现要点」；主查询本身仍然只能等宿主的预算）。
- **推断（未证实）**：触发条件是"全盘 `attributes` 查询"这类需要逐条评估属性的工作（Everything 1.4 可能需要为整个索引准备属性数据），并发会放大它；我几次用 `Stop-Process -Force` 强杀卡住的 `es` 也可能有份。
- **与本次改动无关**：挂住时宿主跑的还是改动前的 `lib/`。

教训：探测这种可能让索引长时间忙的查询要**串行、小步**，发现第一个查询变慢就停下，别再并发加探测（我当时又并发发了一批，等于往火里加油）。

工作区级文档 `PLUGIN_RELEASE_GUIDE.md`（位于仓库外的 `DSH_Workspace/CreatePlugin/`，**不随 git 分发**）收录了更完整的开发、发布与排错经验：构建提交纪律、连接点安装的连带后果、模型文案的落点与取证、`tsc` 拼接缝等。开发时对照查阅。

**版本号怎么算、什么时候改，也以它为准**（「插件版本号」一节）：号写成「宿主版本收掉预发布里的点 + `.<n>`」（`0.2.0-rc.2` → `0.2.0-rc2.1`，即面向该宿主的第 1 个版本），而**改号只在用户要求时发生**——用户会在推送前提出，没提就不要动 `package.json` 的 `version`，也不要追问"要不要升号／要不要推送"。

## 许可证

MIT
