# CLAUDE.md

本文件指导 Claude Code（claude.ai/code）在本仓库工作。追寻 是通用桌面 AI 智能体：Electron 桌面壳 + React 19 渲染进程 + Node.js(Hono) 后端（由 Electron 主进程在**进程内**直接起，非子进程），基于 Vercel AI SDK 7。README.md（中文）与 AGENTS.md（英文）是详尽说明，本文件只补充跨文件才能理解的架构与易踩的坑。

## 核心原则

- 以当前检出的源码、`package.json` 与 `settings.json` 为准，不读旧 `.env`/`MODEL_*` 环境变量作配置。删除功能时同步清理指令、技能与文档中的引用。
- 未明确要求改代码就先调查原因，结合源码、日志与运行时证据，区分已确认原因与待验证假设。
- 前端运行时 bug 优先用 ego-browser 实操复现，不要只做静态分析。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖（注意：现 `packages/shared` 是重建的「契约 DTO 包」，与早期被删的那个 shared 定位不同，见「仓库结构」）。
- 修 bug 用中文注释说明原因与依据；发现设计缺陷先与用户对齐，不靠不断堆兜底分支或超时掩盖同步问题。

## 命令与环境

需 pnpm >= 12、Node >= 24（以 `package.json` engines 为准）。以下命令从仓库根执行：

| 用途 | 命令 |
| --- | --- |
| 安装依赖 | `pnpm install` |
| 完整开发（后端 bundle:watch + desktop vite 自动拉起 Electron） | `pnpm start` |
| 仅后端（standalone/tsx，Hono API on 127.0.0.1:31001） | `pnpm dev:backend` |
| 仅桌面（vite 经 vite-plugin-electron 构建 main/preload 并拉起 Electron） | `pnpm dev:desktop` |
| 纯 web 渲染进程（WEB_ONLY=1 vite:8080，不拉 Electron，配合 dev:backend 分离调试） | `pnpm dev:web` |
| 类型检查（前后端一起 `tsc --noEmit`） | `pnpm typecheck` |
| Lint / 自动修（仓库根单一 flat config lint 两个 app） | `pnpm lint` / `pnpm lint:fix` |
| 格式化（Prettier：4 空格、单引号、无尾逗号、宽 120、LF） | `pnpm format` / `pnpm format:check` |
| 生产打包（后端 bundle → 前端构建 → electron-builder 出 dmg/nsis） | `pnpm package` |
| 交互式提交（Conventional Commits） | `pnpm commit` |

`pnpm start` 先 bundle 一次后端，再 concurrently 跑后端 `bundle:watch` 与 desktop vite。

## 实现与验证

- **测试**：后端使用 Vitest。默认 `pnpm test` 运行 unit、integration、http 测试；`pnpm test:contract` 单独运行 lifecycle、MCP、provider、WebFetch、真实端口等 opt-in 契约测试。改动后至少运行 `pnpm typecheck`、`pnpm lint` 和相关测试，如实报告结果，不把已有失败写成通过。`pnpm test:coverage` 强制全后端（分母 `src/**/*.ts`，仅排除 `.d.ts`/`src/index.ts`/`src/server.ts`）statements、branches、functions、lines 四项全局各 ≥80%；contract 用独立配置、不继承该门禁，空跑退出 0 不算能力验证。
- 运行时验证走 `curl localhost:31001/health`（见 README「服务地址」）；默认测试不得写入真实 `~/.zhuixun`、连接真实外部服务或启动真实监听端口。`/health` 透出 MCP 连接状态、`dangerSkipPermissions`、`permissionBaseline`（builtin/external/invalid）与 `hooks` 状态。
- **行为回归**：`test/scenario/*.test.ts` 用 `test/helpers/scenario.ts`（`scriptedModel` 脚本化 MockLanguageModelV4 + 真实 `runChatTurn`）断言工具序列、审批结果与 `stopReason`；测试文件需自行 `vi.mock('@/agent/model/provider')` 把 `createModel` 指向脚本模型（vi.mock 只在测试文件内提升）。真实 shell / 本地端口类用例放 `test/contract/`。
- husky + commitlint 强制 Conventional Commits（`commitlint --edit`）；不在日志、示例、提交中写凭据或真实用户数据。

## 仓库结构

前后端通过 HTTP(JSON) 解耦。**跨 HTTP 的契约 DTO 走 `packages/shared`（`@zhuixun/shared`）单一真源**（纯类型、零运行时、零依赖，两端 `import type` 引用、构建时完全擦除）；收录范围仅限两端本就该一字不差的 DTO（响应信封、Task、memory、permission、SkillHub、`ProviderView` 等），**后端内部 domain/落盘类型刻意不收**（如含 `ToolSet` 的 `LoadedSkill`、含 `version/roots` 的 `SavedProject`、含 `apiKey` 的 `ProviderConfig`、MCP 的 `MCPServerStatus`），强合会把后端内部结构泄露给前端。接法：后端 domain 文件在原定义处 `import type` 后 `export type` 转发、前端 `src/types/*.d.ts` re-export 转发，两端 `@/` 引用路径均不变。

- `packages/`：workspace 子包。`shared`（上述契约 DTO）、`channels-core` + `channel-telegram` / `channel-weixin`（渠道能力）。

- `apps/backend/src/`：Hono 后端，按「垂直模块 + 显式契约」组织：
    - `bootstrap/`：组合根（`app.ts` 只装配中间件与路由、`services.ts` 建 `ServiceContainer`、`lifecycle.ts` 端口/监听/停机）。
    - `http/`：交付层（`routes/index.ts` 统一导出 + 各域 `routes/<域>/index.ts` 薄路由 + `middleware/` + `respond.ts` 统一信封）。
    - `modules/<域>/`：业务模块，每个含 `index.ts`（唯一公开面）、`service.ts`/`store.ts`；域包括 `chat`（含 `turn-machine.ts`）、`conversations`、`memory`、`persona`、`permission`（含声明式策略 `policy.ts`/`rules.ts`/`baseline.ts`）、`hooks`、`commands`、`projects`、`tasks`、`skills`、`mcp`、`channels`。关键不变量（顺序、幂等、锁与边界）写在对应 `index.ts` / `service.ts` 的注释里。
    - `agent/`：Harness 内核（`context/` 提示词拼装、`tools/` 执行与审批接线（`approval-pipeline.ts`、`hook-wrapper.ts` 只依赖端口）、`model/`（含 `resilience.ts` 重试判定）、`loop/`（护栏 `guard.ts`、`prepare-step.ts` 合并器）、`compaction/`），只提供能力、不做装配，**不得运行时 import `modules/*`**。
    - `platform/`：通用能力（`logging/`、`fs/id.ts`、`command.ts`、`runtime-status.ts`、`tool-naming.ts`）。
    - `config/`：配置与路径唯一读取层（叶子，不得 import 其他 src 模块）。
- 模块边界靠各模块 `index.ts`（唯一公开面）+ code review 维护；不引入额外的架构检查脚本。
- `apps/desktop/`：Electron 壳（`electron/` 的 main+preload）+ 渲染进程（`src/`：React Router + Zustand(含 persist) + antd 6 + antd-style + @ant-design/x + AI SDK useChat，`@/` 别名映射 `./src/`，vite dev 端口 8080）。
- README.md（中文）/ AGENTS.md（英文）：详尽说明，先于本文件。

## 架构边界

- **前端只走 HTTP 到后端，不碰 Node**。前端调 `127.0.0.1:31001`，base URL 可用 `VITE_API_BASE_URL` 覆盖。渲染进程 `contextIsolation:true` + `nodeIntegration:false` + `sandbox:true`。
- **后端只绑 `127.0.0.1`**（暴露读密钥、起子进程等高危能力，绝不能对局域网可达）。
- **启动链**：`index.ts` / `server.ts` 第一行必须 `import './config/bootstrap-settings'`（在任何模块前加载 `settings.json`、把 `env` 段注入 `process.env`，让后续 config 访问器读到就绪配置）→ `bootstrap/lifecycle.ts` 调 `bootstrap/services.ts` 的 `initializeServices()`（加载 `.mcp.json`、建 `MCPClientManager`、扫描技能，返回 `ServiceContainer`）。
- **MCP 连接异步不阻塞 HTTP server 启动**：server 立即可用，MCP 连不上降级，初始化失败**不退进程**，`/health` 暴露 503。
- **记忆与会话真源在后端**，非前端：记忆落盘 Markdown（`~/.zhuixun/`），会话每会话一文件 + `index.json`（`~/.zhuixun/sessions/`）。前端 store 只是镜像。

## Agent 组装（`modules/chat/agents/runner.ts`）

两种模式由 `/api/chat/stream` 请求体决定（见 `http/routes/chat/index.ts` → `modules/chat/service.ts`）：

- `createRoutedAgent`（默认）：合并元工具 + 记忆工具 + 交互工具 + 已启用技能工具 + shell 工具 + **全部** MCP 工具，systemPrompt 内联技能 catalog。
- `createProgressiveAgent`（`agentMode: 'progressive'`）：元/搜索、记忆/交互/任务、只读检索（Grep/Glob/LS）、WebFetch（开启时）与子 Agent（Task）为初始活跃工具；全部 MCP 工具以 `deferLoading:true` 常驻 `liveTools`（schema 恒在），由 `search`（SDK `toolSearch`）发现后激活；技能工具与 Bash/Read/Write/Edit 由 `load_skill` 按声明绑定后加入。模型说「没有文件系统工具」时先查 `app.defaultAgentMode`。**坑**：`tools`、`prepareCall` 与 `onSkillLoaded` 必须共用同一个 `liveTools` 可变引用，加载时先包装 hooks 再 `Object.assign`，本轮后续 step 才能立即调用；`prepareCall` 只在每轮 generate/stream 开始时执行一次，不能靠新快照逐步补工具。审批续跑按历史 `tool-load_skill` 预挂载技能工具，MCP 无需 seeding。
- **工具审批**：`runner.ts` 的 `buildToolApproval` 返回 AI SDK **generic 审批函数**（不是按工具名的 map），由 `agent/tools/approval-pipeline.ts` 按顺序判定：策略 deny → PreToolUse hook deny → 策略 ask / hook ask / hook 故障（有 UI 弹确认、危险模式放行、无 UI 拒绝）→ hook allow / 策略 allow（Write/Edit 目标在系统目录仍需确认）→ 既有 broker（`modules/permission/broker.ts`：Bash/Write/Edit 查记忆规则与信任项目，其它工具 `not-applicable`）。**坑**：未命中规则且原本无需审批的工具必须返回 `not-applicable`，否则每个只读调用都弹审批卡；`askUserQuestion` 豁免。Write 入参字段是 `path`（bash-tool），Edit 才是 `file_path`。子 agent（Task）与渠道 agent 同一套策略、`hasUi:false`（需确认一律拒绝）。与「设置→命令授权」的自动放行是两个独立概念。
- **声明式策略**（`modules/permission`）：团队基线 = 内置 `baseline.ts`，或 `~/.zhuixun/policy/permissions.json` 存在时**整体替换**（损坏时全部工具降级为 ask，不回落内置）；用户规则存 `permissions.json` v3 的 `rules`。Bash 规则按命令头匹配并对复合命令切段（跳过 `env`/`nohup`/`sudo` 等包装），allow 规则要求每段命中且无重定向/命令替换；Read 规则同时作用于 Grep/Glob/LS，并下推为 rg 的 `--glob !…`；Bash 命令含 `.zhuixun` 一律 ask（保护 hooks.json 与权限文件本身）。审计写 `audit/permission-audit.jsonl`。
- **Hooks**（`modules/hooks`）：`~/.zhuixun/hooks.json` 只手工编辑；仅在 `settings.hooks.enabled` 且文件 sha256 等于 `trustedHash` 时执行（mtime 变化即重读，`settings.hooks` 不参与导入导出）。PreToolUse 进审批管线；PostToolUse 由 `wrapToolsWithHooks` 包装 execute（routed 在工具合并后统一包，progressive 在每次 `Object.assign` 进 `liveTools` 前包，保持同一引用）；Stop 在 UI 消息流 `onEnd` fire-and-forget。执行器复用 Bash 的 shell 选择与进程组 kill。
- **循环护栏与重试**：`loopSettings` 显式设置 `stopWhen`（`agent/loop/guard.ts`：步数上限 + 同错/同调用熔断，阈值前一步注入纠偏提示）与 `maxRetries`，`prepareStep` 经 `composePrepareStep` 合并轮内压缩 → Anthropic 缓存断点 → 纠偏提示。**坑**：不设 `stopWhen` 时 AI SDK 默认 20 步静默截停。首输出前的流式错误由 `withPreOutputRecovery` 处理（超窗压缩 handler、可重试错误 handler），已有输出后不重试。finish metadata 带 `stopReason`/`steps`。
- **slash 命令**（`modules/commands`）：`~/.zhuixun/commands/<name>.md`；前端发送前调 `/api/commands/expand`，用户消息带 `data-command` part（展开快照），`modules/chat/commands.ts` 的 `expandCommandParts` 只在喂模型的副本里替换文本，落库保留原文。内置 `/new` `/help` `/compact` 由前端处理；`/compact` → `POST /api/conversations/:id/compact`（`forceCompactContext`，标记写 `metadata.manualCompaction`，与自动压缩的 `compaction` 分键）。
- **记忆工具**（`read_memory` / `write_memory` / `delete_memory`）只在记忆开关开启时挂载；`modules/chat/context.ts` 的 memory 段恒推两层 `MEMORY.md` 索引、并按最新用户问题跨层召回 ≤5 条相关记忆正文确定性拼进 systemPrompt。
- **智能体风格**（`modules/persona`）：内置 + 自定义表达风格，默认「标准」零注入；请求体 `personaId` > 会话已存 `personaId` > `settings.persona.defaultId`。风格段只影响语气/结构/详略，显式声明不覆盖项目要求、记忆事实与工具审批；渠道 Agent 用默认风格，子 Agent 不注入。
- **systemPrompt 拼装**：`agent/context/builder.ts` 按 `order` 拼 `base → persona → project → memory → runtime → tasks`；各段由 `modules/chat/context.ts` 提供，agent 层不认识具体模块。

## 技能系统

- **两类根**（应用不内置技能）：外部只读根 `~/.agents/skills` + `~/.agents`（`SKILLS_EXTERNAL_DIRS` 覆盖，source=builtin，只发现不写入，可启停/导出、不可编辑删除）；用户可写根 `~/.zhuixun/skills`（`SKILLS_USER_DIR` 覆盖，CRUD/导入/广场安装都落这里）。先扫外部、后扫用户，同 id 用户技能覆盖。
- 路径用 `os.homedir()` 而非 `__dirname`：dev(tsx 跑 src) 与打包(app.js 在只读 resources) 下 `__dirname` 含义不同且 resources 不可写。
- **坑**：技能目录下 `tools/index.js` 会在加载时被 `import()` 执行，故应用写入路径（zip 导入、SkillHub 安装）一律不落 `tools/`。
- **格式**：每技能一目录含 `SKILL.md`（frontmatter + 正文即 systemPrompt）。frontmatter 用标准 `yaml` 库解析/序列化（`modules/skills/loader.ts`）：写入端给含冒号/逗号的值加引号保往返，读取端对畸形 YAML 报错并跳过该技能。`allowed-tools`/`disallowed-tools` 是 Claude Code 风格**单行逗号串**（如 `allowed-tools: Bash, Read, mcp__x__y`），非 YAML 数组——按标量读入再按逗号切分。
- **加载结果**：`load_skill` 成功以工具结果返回 `instructions`（原输出字段 `systemPrompt` 改名；内部存储与编辑字段仍为 `systemPrompt`，不改写 Agent 系统指令）、`directory`（默认工作区模式下用户技能的完整工作区副本，其余情况为 registry 解析出的源目录）、`files`（相对该目录的资源清单，不含 `SKILL.md`）。默认工作区每轮把启用用户技能同步进 `os.tmpdir()/zhuixun-workspace/<目录名>`：`.md` 由 bash-tool `uploadDirectory` seed，脚本等其它资源由 `shell-tools.ts` 的 `seedSkillResources` 复制（跳过顶层 `tools/`、符号链接，大小与 mtime 未变不重写）；副本缺文件时 `load_skill` 退回源目录。**坑**：只 seed `.md` 会留下同名缺脚本的副本，模型按相对路径找不到脚本；直接指向 `~/.zhuixun/skills` 又会因 Bash 含 `.zhuixun` 一律 ask。`availableTools` 只列本技能关联且当前实际可用的工具，不是本轮工具全集；空列表不阻止使用已有 WebFetch 等相关工具，也不授予额外权限或自动执行资源脚本。
- **技能误调用修复**：SDK `repairToolCall` 仅在 `NoSuchToolError` 的未知工具名精确匹配已启用技能 id（或仅差大小写 / `_`↔`-` 且唯一命中）、且当前工具集中有 `load_skill` 时，改写为 `load_skill({ skillId })` 后交回 SDK；不处理 provider 已执行调用、不覆盖已有工具、不猜测其他未知名或修复参数错误，仍走正常审批与 hooks。`load_skill` 的 `skillId` 用同一套查找（`agent/tools/skill-lookup.ts` 的 `findSkillMetadata`，对齐 AI SDK cookbook 不区分大小写的 loadSkill），命中后统一使用规范 id；停用与多候选仍拒绝。
- 启停状态记在 `skills-state.json`（停用集，读-改-写整段串行化避免并发丢更新）。
- SkillHub（skillhub.cn）技能广场安装：302→COS、slug→name 归一、scripts 剥离等坑已处理。

## 生产构建与进程模型

- `pnpm package`：先 `@zhuixun/backend bundle`（tsup/esbuild `noExternal:[/.*/]` 把后端含全部依赖打成单文件 `apps/backend/dist/server.js`，**导出 `startServer()`、不自跑**）→ `@zhuixun/desktop package`：`vite build` 经 **vite-plugin-electron** 一次产三端（渲染进程→`dist/`、主进程→`dist-electron/main.js` ESM、preload→`dist-electron/preload.cjs` CJS，sandbox 下 preload 必须 CJS）→ electron-builder（读 `electron-builder.yml`，出 mac dmg / win nsis）。
- **后端在主进程内跑**：`electron/main.ts` 于 `app.whenReady` 后 `await import(server.js)` 调 `startServer()`，监听 `127.0.0.1:31001`，无独立子进程、无随包 node 二进制。dev 指 `apps/backend/dist/server.js`，prod 指 `process.resourcesPath/backend/server.js`（electron-builder `extraResources` 从 `apps/backend/dist` 拷入）。`before-quit` 调 `backend.close()` 优雅关闭。prod 必须由 `electron/main.ts` 置 `NODE_ENV=production`，否则退回 dev 语义。
- prod 经自定义 `app://local` 协议加载 SPA 并附 CSP；外链交系统浏览器（`setWindowOpenHandler`）。
- **MCP stdio 坑**：`modules/mcp/manager.ts` 的 `resolveStdioLaunch` 把裸 `node`/`npx` 路由到 `process.execPath`（Electron 下是 Electron 可执行文件），故对这类启动注入 `ELECTRON_RUN_AS_NODE=1` 让其以纯 node 跑（纯 node 形态忽略该变量，无副作用）。随包 `npx-cli.js` 经 `ZHUIXUN_BACKEND_RESOURCES` 定位。Finder 启动 PATH 太窄会致 spawn ENOENT，manager 会补 PATH。

## 配置与密钥

- **密钥永不经前端往返**：`.env`/`.mcp.json` 已 gitignore，从 `.env.example`/`.mcp.example.json` 拷贝。GET `/api/settings/model` 只透出各 provider 的 `configured` 布尔，apiKey 不明文下发；对话时后端按激活模型（或请求体 `model` 引用 `providerName/modelName`）从已存 provider 解析密钥。
- **模型配置多 provider**：`settings.json` 的 `model` 段为 `{ providers: [{ name, kind: openai|anthropic|google|openai-compatible, baseURL, apiKey, models[] }], activeModel: "name/modelName" }`（真源 `config/settings-store.ts`，实例化 `agent/model/provider.ts`：openai/anthropic/google 走原生 SDK、openai-compatible 走 `@ai-sdk/openai-compatible`）。**settings.json 是唯一来源**——无旧配置迁移、不读 `MODEL_*` 环境变量，全部经前端「设置→模型配置」增删改；`activeModel` 以 provider `name` 引用，重命名联动改写。
- **时间处理统一用 dayjs**：格式化/解析/时区走 dayjs，前端 `import @/utils/dayjs`；纯 epoch `Date.now()` 不动。

## 约定与坑

- **端口顺延**：默认 31001（`config/server.ts` 的 `port()`，`PORT` 可覆盖；选 31001 而非常见的 3001 以避开大量 dev server 冲突与各平台临时端口范围）。`startServer()` 监听前用 `net` 探测，被占用从 31001 起逐一 +1、最多 20 个；选定端口写回 `process.env.PORT`（使 `port()`/`oauthCallbackUrl()` 反映真实端口）并随 `RunningBackend.port` 返回，经 preload 注入渲染进程（`window.zhuixun.backendPort`）供前端拼 base URL 与 CSP 放行。连续 20 个都占用才抛错（standalone 报错退出、Electron 弹原生 dialog 退出）。清理残留：`lsof -nP -iTCP:31001 -sTCP:LISTEN`（无独立 node 进程，残留多是没退干净的 Electron 或 standalone tsx）。
- **流式错误排障**：AI SDK 默认把异常吞成 "An error occurred."。`onError` 钩子 dev 透传真实原因、prod 只给提示（完整堆栈留服务端）。看不到细节先查 `.env` 的 LLM key 与 `/health` 的 mcp 字段。
- **危险跳过审批模式**：后端带 `--dangerously-skip-permissions` 或 `ZHUIXUN_DANGEROUSLY_SKIP_PERMISSIONS=1` 启动 → 所有需确认的调用放行（含 rm/复合命令、策略 ask、hook ask），但**策略 deny 与 hook deny 仍生效**；旗标解析在 `config/danger-mode.ts`、判定在 `agent/tools/approval-pipeline.ts` 与 `modules/permission/broker.ts`、接线在 `modules/chat/agents/runner.ts` 的 `buildToolApproval`。只认服务端启动态（不可从请求/前端开启）、root/uid 0 下拒绝启用并降级、`/health` 透出 `dangerSkipPermissions`、前端输入框常驻红色 Tag。
- **ESLint 在仓库根**：单一 flat config 分 frontend 块（浏览器全局 + React 插件）与 backend 块（Node 全局，无 React）；启用 `consistent-type-imports`、`unused-imports`、`import-x/order`（`@/**` 内部分组）。两包 TS strict + `verbatimModuleSyntax`，React 仅函数组件；hooks 中含 JSX 的文件用 `.tsx`。
- **模块解析（前后端一致）**：两包 tsconfig 均 `moduleResolution: bundler` + `noEmit`，相对导入**不带扩展名**。**跨模块用 `@/`（→ `src/*`），同目录用 `./`**，别再手动加 `.js` 后缀（NodeNext 老习惯）。后端 dev 走 `tsx`（standalone），生产走 **tsup**（单文件 `dist/server.js` 导出 `startServer()` 供主进程 import）；`typecheck`/`build` 都是 `tsc --noEmit` 纯类型门禁。
