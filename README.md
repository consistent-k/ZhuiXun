# 追寻 · 个人 AI 助理

## 项目概述

追寻是一款桌面个人 AI 助理，基于 **Electron + React 19 + Node.js（Hono）+ Vercel AI SDK 7** 技术栈构建。能力通过可插拔的**技能（Skills）**与 **MCP 连接器**扩展，支持多模型 provider、长期记忆、智能体风格、会话管理、声明式权限策略、Hooks 与 slash 命令。

桌面版和 CLI 共用 `~/.zhuixun` 中的设置和会话。

## 终端客户端

在源码工作区运行 `pnpm dev:cli` 启动追寻 CLI。终端使用与桌面版相同的后端，支持流式对话、工具审批、会话恢复，以及 Telegram 和微信渠道管理。详见 [CLI 使用说明](apps/cli/README.md)。

## 技术栈

| 层级 | 技术选型 | 说明 |
| --- | --- | --- |
| 桌面应用壳 | Electron | 跨平台桌面应用（macOS + Windows），Chromium + Node.js 运行时 |
| 前端框架 | React 19 + TypeScript | UI 界面（渲染进程） |
| UI 组件库 | antd 6 + antd-style | 组件库 + CSS-in-JS |
| 状态管理 | Zustand | 轻量级状态管理（含 persist 中间件） |
| AI 核心 | Vercel AI SDK 7（`ai@7` + `@ai-sdk/*@4.x`） | `streamText` / `useChat`、Tool 调用、流式响应 |
| 后端服务 | Node.js + Hono | 由 **Electron 主进程在进程内**直接起（非子进程），监听 `localhost:31001` |
| MCP 集成 | `@modelcontextprotocol/sdk` | 通过 stdio 接入外部 MCP 服务 |
| 本地存储 | `~/.zhuixun/`（后端落盘） | 会话 / 记忆 / 技能 / 配置的真源都在后端，前端 store 只是镜像 |

## 项目结构

```
zhuixun-agent/
├── apps/
│   ├── desktop/               # Electron 桌面应用
│   │   ├── electron/          # 主进程 + preload（main.ts / preload.ts）
│   │   ├── src/               # 渲染进程源代码（React）
│   │   ├── vite.config.ts     # vite + vite-plugin-electron（统一构建三端）
│   │   └── electron-builder.yml  # 打包配置（dmg / nsis / portable）
│   └── backend/               # Node.js 后端（Hono），bundle 为 dist/server.js
│       ├── src/               # 后端源代码（server.ts 导出 startServer）
│       └── tsup.config.ts     # 后端打包配置（单文件 ESM）
├── packages/                  # 内部渠道包（channels-core / channel-*）
├── pnpm-workspace.yaml        # pnpm 工作区配置
├── settings.example.json / .mcp.example.json   # 配置模板（复制后填写，不进 git）
└── package.json               # 根 package.json
```

> 注：跨 HTTP 的契约 DTO 统一放在 `packages/shared`（纯类型、零运行时、构建时擦除）；后端内部 domain/落盘类型刻意不收。Electron 主进程 `import` 后端 bundle 在进程内起 HTTP，渲染进程仍只经 `localhost:31001` 访问。

## 环境要求

- **Node.js >= 24**（后端与工具链要求）
- **pnpm >= 12**
- Xcode Command Line Tools（macOS）

## 快速开始

### 1. 安装依赖

```bash
# 在项目根目录执行
pnpm install
```

### 2. 配置密钥（自托管）

运行时配置的真源是用户可写目录的 `~/.zhuixun/settings.json`（模型接入 + `env` 环境变量透传），**含明文 apiKey、不进 git**：

```bash
# settings.json：模型 providers 与 activeModel + env 段（PORT、日志等）
mkdir -p ~/.zhuixun
cp settings.example.json ~/.zhuixun/settings.json   # 按需填写；模型配置也可在应用「设置」里填
cp .mcp.example.json ~/.zhuixun/.mcp.json           # 按需修改 MCP 服务命令与参数
```

两个文件都是可选的：不拷贝也能启动，模型在「设置 → 模型配置」里填，MCP server 在「技能 → 连接器」里增删（写回 `~/.zhuixun/.mcp.json`）。路径可用 `SETTINGS_CONFIG_PATH` / `MCP_CONFIG_PATH` 覆盖，二者均不进版本库。启动时 `config/bootstrap-settings` 把 `settings.json` 的 `env` 段注入 `process.env`（**已存在的真实环境变量优先，不被覆盖**），`.mcp.json` 内只写 `${VAR}` 占位符，运行时解析为对应的 `process.env` 值。

> 安全底线：`ZHUIXUN_DANGEROUSLY_SKIP_PERMISSIONS` / `API_AUTH_TOKEN` / `ALLOWED_ORIGINS` 等敏感键**不会**从 `settings.json` 的 `env` 段注入，必须通过真实环境变量 / CLI 提供。

### 3. 开发模式

```bash
# 根目录一键起：bundle 后端 → concurrently(后端 bundle:watch + desktop vite，vite 自动拉起 Electron)
pnpm start
```

> 后端由 Electron 主进程在进程内启动（dev 与 prod 一致）。vite-plugin-electron 负责构建 main/preload 并在改动时重启 Electron，渲染进程走 vite HMR；后端产物由 `bundle:watch` 维护。改后端源码后需重启 `pnpm start`（后端 bundle 与 Electron 进程未做联动热替换）。也可只跑后端做接口调试：`pnpm dev:backend`（tsx watch，端口 31001）。

#### 纯 Web 模式（前后端分离，不启动 Electron）

只想在浏览器里调前端、后端作为独立 HTTP 服务时，分两个终端启动：

```bash
pnpm dev:backend     # 终端 1：standalone 后端（tsx watch，Hono 跑在 127.0.0.1:31001，不碰 Electron）
pnpm dev:web         # 终端 2：纯 web 渲染进程（WEB_ONLY=1，vite 跑在 8080，不拉起 Electron 窗口）
```

然后浏览器打开 `http://localhost:8080`。原理：`WEB_ONLY=1` 时 `apps/desktop/vite.config.ts` 不挂 `vite-plugin-electron`，只跑渲染进程。注意纯 web 下 `window.zhuixun`（`platform` / `getAppVersion`）为 `undefined`——前端仅在极少数非关键处用到，核心功能全走 HTTP，不受影响。

### 4. 生产构建 / 打包

```bash
pnpm package
```

根脚本依次执行：

- `pnpm --filter @zhuixun/backend bundle`：用 tsup/esbuild 把后端打包为单一 `dist/server.js`（导出 `startServer()`，无需 node_modules）；
- `pnpm --filter @zhuixun/desktop package`：`vite build` 经 **vite-plugin-electron** 产出渲染进程 `dist/` + 主进程 `dist-electron/main.js` + preload `dist-electron/preload.cjs`，再 `electron-builder` 出当前平台安装包（各平台命令见下方「按平台打包」）；
- `electron-builder.yml` 的 `extraResources` 把 `apps/backend/dist` 拷入安装包的 `resources/backend/`。

运行时 Electron 主进程 `app.whenReady` 后 `import` `resources/backend/server.js` 调 `startServer()`，在**进程内**监听 `localhost:31001`；`before-quit` 优雅关闭（无子进程）。

macOS 关闭主窗口后可从 Dock 恢复，Windows 可从系统托盘恢复。关闭窗口期间会话和后台任务继续运行。macOS 可用菜单「追寻 → 退出追寻」或 `⌘Q` 退出，Windows 可用托盘菜单「退出追寻」。

#### 按平台打包

| 命令 | 产物 | 可在哪台机器上执行 |
| --- | --- | --- |
| `pnpm package` | 当前系统对应平台、当前 CPU 架构 | 任意 |
| `pnpm package:mac` | macOS `.dmg` + `.zip`（架构同本机，Apple 芯片即 arm64） | 仅 macOS |
| `pnpm package:mac:universal` | macOS 通用包（arm64 + x64 合一，体积约翻倍） | 仅 macOS |
| `pnpm package:win` | Windows x64 NSIS 安装包 `Setup.exe` + 免安装 `portable.exe` | Windows，或 macOS / Linux 交叉 |
| `pnpm package:all` | 同时产出 macOS + Windows | 仅 macOS |

产物统一输出到 `apps/desktop/release/`：

```text
ZhuiXun-<版本>-arm64.dmg / -arm64.zip   # macOS（zip 供 electron-updater 读取）
ZhuiXun-Setup-<版本>.exe                     # Windows 安装版（可选安装目录）
ZhuiXun-<版本>-portable.exe                  # Windows 免安装版
latest.yml / latest-mac.yml                     # 自动更新 feed
mac-arm64/ win-unpacked/                        # 未打包的 app 目录，可直接运行调试
```

需要其他架构/参数时，直接在 `apps/desktop` 下调用 electron-builder（须先在根目录执行过 `pnpm --filter @zhuixun/backend bundle`）：

```bash
cd apps/desktop
pnpm build                                   # 渲染进程 + main + preload
pnpm exec electron-builder --mac --x64       # Intel Mac
pnpm exec electron-builder --win --arm64     # Windows ARM
pnpm exec electron-builder --win nsis        # 只出 NSIS 安装包（不出 portable）
pnpm exec electron-builder --mac --dir       # 只产出未打包目录，最快，用于冒烟验证
```

注意：

- **macOS 包只能在 macOS 上构建**（依赖 `hdiutil` / 系统签名工具）；Windows 包可从 macOS 交叉构建，首次会自动下载 NSIS 工具链。同时出两端最省事的是在 Mac 上跑 `pnpm package:all`，正式发布建议走 CI matrix（mac + windows runner 各出各的）。
- **当前未配置 Apple Developer ID / Windows 证书**：macOS 首次打开需「右键→打开」或在「系统设置→隐私与安全性」放行；Windows 会出现 SmartScreen 提示。本机若装有开发者证书，electron-builder 会自动拿来签名。
- **macOS 必须保持 ad-hoc 签名**（`electron-builder.yml` 的 `mac.identity: "-"`）：没有证书时 electron-builder 默认**跳过签名**，产物会保留 Electron 自带的二进制签名（`Identifier=Electron`、`Info.plist=not bound`），macOS 会因此**拒绝应用发送系统通知**（`UNErrorDomain 1`），且 `Notification.isSupported()` 仍为 true、不会报错。`CSC_IDENTITY_AUTO_DISCOVERY=false` 会重新触发这个问题，除非你本来就不需要系统通知。
- **Linux** 目前未在 `electron-builder.yml` 中配置 `linux` 目标；需要时补 `linux: { target: [AppImage, deb], icon: build/icon.png }` 后用 `--linux` 构建（需在 Linux 或 Docker 中执行）。
- 版本号取自 `apps/desktop/package.json` 的 `version`，发版前先改这里。

#### GitHub 发版

默认发布仓库与客户端更新源为 `consistent-k/zhuixun-agent`。首次使用时，将本地 `origin` 指向实际 GitHub 仓库并启用 Actions。客户端默认从公有仓库读取更新。若仓库地址不同，请同步调整 [打包配置](./apps/desktop/electron-builder.yml) 和 [客户端更新渠道](./apps/desktop/electron/update-channels.ts) 中的 owner/repo。工作流使用 GitHub 提供的 `GITHUB_TOKEN`。

1. 更新 `apps/desktop/package.json` 的 `version`，并在 [CHANGELOG.md](./CHANGELOG.md) 新建对应版本段。首发可使用当前的 `2.0.0`。
2. 提交并推送包含上述变更和工作流的分支。在 GitHub 的 **Actions → Desktop release → Run workflow** 可以先运行检查和打包，安装包可从该次运行的 **Artifacts** 下载。
3. 给要发版的提交打同版本标签并推送。以 `2.0.0` 为例：

    ```bash
    git tag -a v2.0.0 -m "追寻 v2.0.0"
    git push origin v2.0.0
    ```

4. 构建通过后，到 **Releases** 检查草稿中的说明和附件，点击 **Publish release**。附件包含 macOS Apple 芯片版、Windows x64 安装版和免安装版，以及客户端读取的 `latest.yml`、`latest-mac.yml` 和差分更新文件。发布后 Windows 安装版可从应用内下载更新，macOS 检测到更新后打开下载页。

### 5. 配置 AI 模型

1. 应用启动后，点击侧栏左下角「设置」→「模型配置」
2. 新增 provider：类型选 OpenAI / Anthropic / Google Gemini / OpenAI 兼容（DeepSeek、千帆、本地网关等）
3. 填写 API 地址（如 `https://api.openai.com/v1`、`https://generativelanguage.googleapis.com/v1beta`）、API Key 与可用模型列表
4. 保存后选定激活模型（以 `provider名/模型名` 引用）

配置写入 `~/.zhuixun/settings.json`，apiKey 只存后端、不回传前端。

## 技能（Skills）

应用**不内置技能**，技能全部来自本地目录，按以下根扫描（后扫的同名技能覆盖先扫的）：

| 目录 | 来源 | 说明 |
| --- | --- | --- |
| `~/.agents/skills`、`~/.agents` | builtin（只读） | 兼容跨工具技能约定，只发现不写入；可启停、导出，不可编辑/删除。`SKILLS_EXTERNAL_DIRS` 可覆盖 |
| `~/.zhuixun/skills` | user（可写） | 主技能根，前端增删改、导入的技能都落这里。`SKILLS_USER_DIR` 可覆盖 |

每个技能是一个目录，含 `SKILL.md`（YAML frontmatter + 正文作为 systemPrompt），frontmatter 支持 `name`、`description`、`triggers`、`allowed-tools` / `disallowed-tools`（Claude Code 风格的单行逗号串）、`metadata.display_name`（中文展示名）等。

获取技能的方式：

- **技能页 → 技能**：新建 / 编辑 / 删除、导入（`.md` 或 `.zip`）、导出、启用 / 停用（停用集记录在 `skills-state.json`）。
- **技能广场**：浏览 SkillHub 并一键安装到 `~/.zhuixun/skills`。
- **技能页 → 连接器**：管理 MCP server，其工具与技能一同挂给 Agent。

## 智能体风格

「设置 → 智能体风格」提供内置的**标准 / 循证严谨 / 简明高效**，也可以创建自定义风格。风格只影响语气、结构、详略和术语解释方式，不改变事实判断、工具权限、项目要求或记忆事实。

- **默认风格**：新会话在未单独指定风格时跟随设置页的默认选择。
- **会话级覆盖**：对话页顶部「风格」下拉可单独切换；选择「跟随默认」可清除覆盖。
- **生效时机**：切换只影响下一条消息，不回溯改写已生成的回答。
- **存储位置**：自定义风格与默认选择落在 `~/.zhuixun/settings.json` 的 `persona` 段；会话只保存可选的 `personaId`。

## 运行护栏与上下文

- **模型重试**：限流 / 过载 / 网络中断时自动重试（请求建立阶段由 SDK 按 `retry-after` 退避；首个确定性输出前的流式错误由后端退避重试，界面显示「正在重试（n/m）」）。已开始输出后不再自动重试，消息下方提供「重试」。密钥无效、模型不存在等错误给出可读提示。
- **循环护栏**：单轮工具调用步数上限（默认 40）、同一工具以相同错误或相同参数重复调用达到阈值（默认 3）时暂停，达到前一次先提示模型换方法；暂停后消息下方提供「继续」。在「设置 → 运行护栏」调整。
- **Prompt 缓存**：Anthropic 模型为稳定的系统提示前缀与最新消息打缓存断点；OpenAI 及兼容网关由服务端自动缓存。用量指示器展示缓存读 / 写 token。
- **上下文压缩**：超阈值自动摘要早期消息；也可在输入框发送 `/compact [需要保留的要点]` 手动压缩（不受自动压缩开关影响，会话生成中不可用）。

## slash 命令

在输入框输入 `/` 弹出命令联想：

| 命令              | 说明                                   |
| ----------------- | -------------------------------------- |
| `/new`            | 新建对话                               |
| `/help`           | 列出所有命令                           |
| `/compact [要点]` | 手动压缩当前对话上下文                 |
| `/<自定义> 参数`  | 用户命令宏：把模板展开为完整提示词发送 |

自定义命令在「设置 → 命令」中管理，落在 `~/.zhuixun/commands/<name>.md`（`COMMANDS_USER_DIR` 可覆盖）：frontmatter 写 `description`、`argument-hint`，正文是模板，`$ARGUMENTS` 替换为全部参数、`$1`…`$9` 为按位参数（支持引号）。命令只是提示词模板，不执行任何程序。气泡显示原文，展开内容随消息保存。

## Hooks

在工具调用前（`PreToolUse`）、后（`PostToolUse`）与回答结束（`Stop`）以本机 shell 执行命令，例如格式化、lint、通知。配置文件 `~/.zhuixun/hooks.json`（`HOOKS_CONFIG_PATH` 可覆盖）**只能手工编辑**：

```json
{
    "PreToolUse": [
        { "matcher": "Bash|Write|Edit", "hooks": [{ "type": "command", "command": "~/bin/check.sh", "timeout": 10 }] }
    ],
    "PostToolUse": [
        {
            "matcher": "Edit|Write",
            "hooks": [{ "type": "command", "command": "npx prettier --write \"$ZHUIXUN_FILE_PATH\"" }]
        }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "~/bin/notify.sh" }] }]
}
```

- **信任闸口**：总开关默认关闭；文件内容（sha256）须在「设置 → Hooks」审阅后点「信任当前配置」才会执行，文件一改即回到「待信任」。信任状态不参与设置导入导出。
- **协议**：stdin 收到 JSON `{ event, sessionId, projectId, cwd, toolName, toolInput, toolOutput? }`，环境变量 `ZHUIXUN_HOOK_EVENT` / `ZHUIXUN_TOOL_NAME` / `ZHUIXUN_FILE_PATH`。退出码 0 时可在 stdout 输出 `{ "decision": "allow" | "deny" | "ask", "reason", "additionalContext" }`；退出码 2 表示阻断（stderr 为原因）；其它失败 / 超时（默认 10s，上限 60s）在 PreToolUse 降级为需确认。PostToolUse 的 `additionalContext` 回传给模型。
- 执行记录写入 `~/.zhuixun/audit/hooks-audit.jsonl`（不记录工具入参与产出）。

## 服务地址

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| 后端 API | http://localhost:31001 | Node.js（Hono），跑在 Electron 主进程内 |
| 健康检查 | http://localhost:31001/health | 返回 `ok` / `degraded`（含 MCP 状态、权限基线来源、Hooks 状态） |
| 技能列表 | http://localhost:31001/api/skills | 返回已发现技能的元数据（含启停状态） |
| 会话流式接口 | http://localhost:31001/api/chat/stream | SSE 流式响应 |
| 前端 Vite（仅 dev） | http://localhost:8080 | 开发服务器 |

## 常用命令

```bash
pnpm install                       # 安装依赖（需 pnpm >= 12）

pnpm start                         # 一键开发：后端 bundle:watch + desktop vite（自动拉起 Electron）

# 纯 web 分离模式（不启动 Electron）
pnpm dev:backend                   # 独立后端（tsx watch，端口 31001）
pnpm dev:web                       # 纯 web 渲染进程（WEB_ONLY=1 vite，端口 8080，不拉起 Electron）

# 后端（单独）
cd apps/backend && pnpm dev        # standalone 开发模式（tsx watch，端口 31001）
pnpm bundle                        # 打包为 dist/server.js（esbuild 单文件，供主进程 import）

# 桌面（单独）
cd apps/desktop && pnpm dev        # vite（经 vite-plugin-electron 构建 main/preload 并拉起 Electron）
cd apps/desktop && pnpm dev:web    # vite 纯 web（WEB_ONLY=1，不拉起 Electron）

# 打包
pnpm package                       # 后端 bundle + desktop vite build + electron-builder（当前平台）
pnpm package:mac                   # macOS dmg + zip（仅 macOS 上可执行）
pnpm package:mac:universal         # macOS 通用包（arm64 + x64）
pnpm package:win                   # Windows x64 安装版 + 免安装版（可在 macOS 交叉构建）
pnpm package:all                   # macOS + Windows 一次出齐（仅 macOS 上可执行）

# 校验
pnpm typecheck                     # 前后端类型检查
pnpm lint                          # eslint
```

## 文档导航

- [CLAUDE.md](./CLAUDE.md) / [AGENTS.md](./AGENTS.md)：架构大图、跨文件约定与易踩的坑

## 故障排查

### Electron 启动失败

```bash
pnpm --filter @zhuixun/desktop exec electron --version   # 确认 Electron 二进制已下载
# 若缺失：pnpm rebuild electron（下载对应平台运行时）
xcode-select --install                                        # 安装 Xcode Command Line Tools（macOS）
```

### 后端服务无法连接（前端提示连不上 localhost:31001）

```bash
curl http://localhost:31001/health    # 检查后端是否运行（应返回 ok / degraded）
# 后端跑在 Electron 主进程内：确认 Electron 已启动，且 apps/backend/dist/server.js 已 bundle
# 单独调试后端：在 apps/backend 手动 pnpm dev（tsx）
# 残留占用：lsof -nP -iTCP:31001 -sTCP:LISTEN -t | xargs -r kill
```

### 流式接口报错只显示 "An error occurred."

后端 `createAgentUIStreamResponse` 已配置 `onError` 钩子透传真实错误；若仍看不到细节，检查「设置」或 `~/.zhuixun/settings.json` 中 LLM API Key 是否正确，以及 `/health` 的 `mcp` 字段是否为 `ok`/`degraded`。

### WebFetch 代理

在「设置 → Web 访问」填写可信 HTTP(S) 代理地址（无用户名和密码），并在允许列表逐行填写目标域名。代理模式只访问明确列出的 HTTPS 域名，重定向同样受限，目标域名由代理解析。若本机网络使用 Fake-IP，这可以避开本机的合成地址。

例如，AI SDK 定时检查可填写 `registry.npmjs.org` 和 `raw.githubusercontent.com`。保存后可在同一页面测试 URL。代理地址留空时使用直连，WebFetch 会校验并固定公网 IP。代理地址属于本机配置，不参与导入导出。

## 安全考虑

1. **API Key / 密钥存储**：模型 apiKey 存于本地 `~/.zhuixun/settings.json`（明文、gitignore、文件权限 0600、永不回传前端）；MCP 密钥通过 `${VAR}` 占位符注入 `.mcp.json`，均不进版本库。
2. **应用数据**：处理在本地完成；调用 LLM / MCP 时按用户配置走对应服务。
3. **最小权限**：Electron 渲染进程 `contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`，只经 HTTP 与后端通信、不下放 Node 能力；生产经自定义 `app://` 协议加载 SPA 并附加 CSP，外链交系统浏览器。后端仅绑定 `127.0.0.1`。
4. **工具审批**：每次工具调用依次经过 **声明式权限策略 → PreToolUse hooks → 已记住的授权**：
    - `Bash` / `Write` / `Edit` 默认需用户逐次确认（前端审批卡）；命中「已记住」的命令头 / 写入目录、或处于信任项目时免确认（`rm` / `sudo` 等高危及含 `&&` / `|` / 重定向的复合命令永不记忆）。
    - **团队基线**（「设置 → 命令授权 → 策略规则」只读展示）内置三类：危险命令需确认（`Bash(rm:*)`、`Bash(git push:*)`、`Bash(git reset:*)`、`Bash(git clean:*)`）、嵌套 shell 需确认（`bash` / `sh` / `zsh` / `eval` / `pwsh` / `powershell` / `cmd`）、密钥文件读取拒绝（`.env*`、`*.pem`、`*.key`、`~/.ssh`、`~/.aws`、本应用的 `settings.json` / `mcp-oauth.json`，同时作用于 Grep / Glob / LS）。`~/.zhuixun/policy/permissions.json`（`PERMISSION_POLICY_PATH` 可覆盖）存在时**整体替换**内置基线，损坏时所有工具调用需确认。
    - **用户规则**：同一面板增删 `deny` / `ask` / `allow` 规则，语法 `Tool` 或 `Tool(参数)`，如 `Bash(npm run:*)`、`Read(./secrets/**)`、`WebFetch(domain:*.example.com)`、`MCP(github_*)`；「试算」可查看某次调用会命中哪条规则。命令涉及 `~/.zhuixun` 一律需确认。
    - 拒绝 / 需确认 / 按规则放行的决策写入 `~/.zhuixun/audit/permission-audit.jsonl`。子任务（Task）与 IM 渠道没有确认界面，需确认的调用一律拒绝。
    - 规则是纵深防御而非沙箱：变量拼接、脚本文件等仍可能绕过 Bash 规则；`cat .env` 不受 Read 规则约束（但 Bash 本身默认需确认）。

### ⚠️ 危险跳过审批模式（--dangerously-skip-permissions）

对齐 Claude Code 的同名标志。后端以下列任一方式启动后进入该模式，**所有原本需要确认的调用（`Bash` 含 `rm` / 复合命令、`Write` / `Edit`、策略 ask 规则、hook 要求确认）不再弹确认、直接执行**；**策略中的 deny 规则（含内置的密钥文件读取拒绝）与 hook 的拒绝仍然生效**：

```bash
# 方式一：CLI 参数（开发模式单跑后端时最方便）
cd apps/backend && pnpm start --dangerously-skip-permissions
# 方式二：环境变量（打包形态用，写进系统环境变量，Electron 主进程会透传给进程内后端）
ZHUIXUN_DANGEROUSLY_SKIP_PERMISSIONS=1 pnpm dev:backend
```

**这是高危能力，请仅在受控自用环境开启：**

- 本应用跑的是**本机真实 shell**，模型可无确认地删除 / 覆盖文件、联网。建议配合系统快照 / 容器 / 专用账号使用。
- 该模式**只认服务端启动态**（CLI 参数 / 环境变量），无法从前端界面或模型工具调用开启，也无法在运行时切换——改配置后需**重启后端**。
- **root/uid 0 下会拒绝启用**并降级为普通审批（仅告警），从机制上排除最坏情况。
- 开启后仍有可观测：后端启动打 `warn` 告警、`/health` 返回 `dangerSkipPermissions: true`、前端输入框底部常驻红色 Tag「已跳过所有命令确认」、`~/.zhuixun/audit/shell-audit.jsonl` 照旧全量记录每条命令（唯一事后追溯手段）。
- 与「设置 → 命令授权」的自动放行开关是**两个独立概念**：后者只对已记住的安全命令头免确认；本模式放行一切需确认的调用，且覆盖前者，但不越过 deny 规则。
