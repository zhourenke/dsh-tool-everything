# 开发注意事项（Development Notes）

> 面向本插件的维护者与开发者。使用者（含模型 Agent）请阅读 [README.md](README.md)。
> 更完整的开发、发布与排错经验在工作区级文档 `PLUGIN_RELEASE_GUIDE.md`（**不在本仓库内**，见文末「经验沉淀」）。

## 仓库结构

| 路径 | 说明 |
|---|---|
| `src/index.ts` | 唯一源码：Cordis 插件，导出 `{ apply, Config, inject, name }` |
| `lib/index.js` + `lib/types/` | 构建产物（`tsc` 输出），**随源码一起提交**（路线 A，git 分发） |
| `test/index.test.mjs` | `node --test` 测试（当前 43 项） |
| `cordis.patch.yml` | `dsh.bundle.patch` 指向的 profile 层 patch |
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

实测教训（2026-09，详见工作区指南 §6.1）：

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

查询**绝不用引号**：es 会把引号原样传给 Everything，其中 `"..."` 表示精确短语搜索，会静默返回 0 结果。

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
- FILETIME（自 1601 年起 100ns 间隔）转换为 `2026-01-02 03:04:05` 式可读格式。

### 5. content: 安全护栏

`content:` 走系统 iFilter 读文件内容，范围过大能把 Everything 卡死。两层保护：

- **无范围 → 拒绝**：query 无 `content:` 范围（无 `path` 参数且无内联 `path:`）时直接抛 `ES_FAILED`，不给 es 发命令。
- **广域路径 → 收窄为直接子级一层**：`isBroadPath()` 只认四种形态——盘根（`C:\`）、`C:\Users` 或其**正下一级**、`C:\Documents and Settings` 同理、当前用户主目录。命中时结果里附加 `warning`，模型读到就该改用更具体的目录。

机制注意：两条实现路径不同——path 参数路由用 es 的 `-parent` **选项**，内联 `path:` 路由用 Everything 的 `parent:` **函数**。**面向模型的文案只讲效果与补救、不点机制**（这条纪律由提交 `3c26a1a` 确立）：点中任何一个，对另一条路都是错的。

**同步纪律**：判据代码、判据注释、系统提示词描述、运行时警告是四处独立副本，会各自漂移，源头常在注释。改判据后**先改注释、再改全部模型可见文案**，并在注释里写明「此处清单必须与那条消息同步」。`isBroadPath()` 的四个形态与 `contentSearchRestrictedWarning()` 的措辞必须逐字一致。

### 6. 目录的 `extension` 是 null（已修，防同类问题）

实测 `es -json -ext`：目录 → `"extension":null`；无扩展名文件 → `""`；普通文件 → 扩展名本身（950 行样本中 null 与「目录」100% 重合）。目录的 null 一旦进结构化输出，宿主 schema 校验（`extension` 为 string）会**整条拒收**——不是只丢那一行。

修复（提交 `06f485f`）：输出时 `typeof entry.extension === 'string'` 才带上该字段；目录仍可凭路径结尾 `\` 识别。**任何新字段都要防同类问题**：输出前断言所有值非 null（测试里有通用不变式）。

## 测试要点

- mock es 输出必须贴近真实 es 的形态，否则 schema 违规测不出来——**mock 发不出的字段，测试永远看不见它违反 schema**。fixture 至少覆盖：目录（`extension: null`）、无扩展名文件（`extension: ""`）、普通文件（`extension: "js"`）。
- 通用断言：遍历每条结果，**任何字段值不得为 null**。
- 判断插件有没有被 DSH 加载，用会话记录的最新一轮 `request/header` 工具表，别问模型"你看到新提示词了吗"（模型侧策略会拒绝逐字复述，且观感可能滞后于下发内容）。
- 当前 43 项全部通过。

## 面向模型的文案（两处落点，互不同步）

| 写法 | 落点 | 会话记录里读它的位置 |
|---|---|---|
| `ctx.systemPrompt.section({...})` | 请求的 system 槽 | `system/message` 的 `data.message.content[0].text` |
| `defineTool` 的 `description` | 工具表 | `request/header` 的 `data.header.tools[]` |

同时改两处后，系统提示词的长度增量**不等于**两处增量之和——工具描述根本不在 system 槽里。验证改没改上，以记录为准。

## 运行时依赖（与 DSH 版本匹配）

| 包 | 用途 |
|---|---|
| `@deepseek-ai/schemastery` | 配置校验 |
| `@deepseek-ai/cordis` | 插件框架 |
| `@deepseek-ai/dsh-tools` | 工具定义 |
| `@deepseek-ai/dsh-llm` | LLM 错误类型 |
| `@deepseek-ai/dsh-subprocess` | 子进程接口 |
| `@deepseek-ai/dsh-system-prompt` | 系统提示词段落注册 |

已测试版本：**DSH v0.1.5-rc.1**（2026-09）。升级 DSH 后逐个核对**值导入**是否仍是宿主导出（过渡 API 会悄悄变成内部符号，插件解析到自己的私有副本时永远看不见）。

## 经验沉淀

工作区级文档 `PLUGIN_RELEASE_GUIDE.md`（位于仓库外的 `DSH_Workspace/CreatePlugin/`，**不随 git 分发**）收录了更完整的开发、发布与排错经验：构建提交纪律、连接点安装的连带后果、模型文案的落点与取证、`tsc` 拼接缝等。开发时对照查阅。

## 许可证

MIT