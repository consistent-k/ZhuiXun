# @zhuixun/channels-core

渠道（IM 接入）抽象层：**契约 + 管理器 + 通用消息管线**。让通用 Agent 能经 Telegram、微信等 IM 触达，复用后端同一套 Agent 能力。

本包**零后端依赖**——会话落盘、可恢复流、事件总线、日志等后端能力全部经 `ChannelRuntime` 注入。因此渠道 provider 可脱离后端源码，作为**独立包 / 第三方插件**开发与维护。

> 后端不内置任何 provider。所有渠道（含内置的 Telegram / 微信）都以插件形态从 `~/.zhuixun/channels/plugins/<id>/` 动态加载。本文讲如何开发一个这样的插件。

---

## 一、核心概念

| 概念 | 说明 |
| --- | --- |
| `Channel` | 渠道契约。你的 provider 实现它：`start`/`stop`/`isConfigured`/`getStatusInfo`，可选 `bind`/`startQrLogin`/`pollQrLogin`/`logout`。 |
| `ChannelManager` | 管理器（注册 / 启停 / 状态）。**由后端持有单例**，插件拿不到全局单例，只在 `register(manager, ctx)` 时收到它。 |
| `ChannelContext` (`ctx`) | 运行上下文，注册时注入。含 `runAgent`（调 AI）、`runtime`（后端能力）、`processMessage`（通用管线）、`sleep`。 |
| `ChannelRuntime` (`ctx.runtime`) | 后端能力注入面：会话 id / 历史 / 落盘 / 可恢复流 / 事件 / 日志。 |
| `MessageTransport` | 消息收发接口，由 provider 实现，交给 `processMessage` 用来回消息 / 发通知 / 打字态。 |

关键设计：**插件运行时无需 `import` 本包**。契约类型仅作 `import type`（编译期擦除），一切运行时能力都从 `ctx` 拿。这样 esbuild 打成自包含 ESM 后零运行时依赖，打包态（无 node_modules 的 sidecar）也能加载。

---

## 二、一个插件长什么样

一个渠道插件是一个包（或一个自包含 `.mjs`），**必须导出一个 `register` 函数**：

```ts
import type { Channel, ChannelContext, ChannelManager, ChannelStartOpts } from '@zhuixun/channels-core';

export function register(manager: ChannelManager, ctx: ChannelContext): void {
    manager.register(new MyChannel(ctx));
}
```

`register` 是后端加载插件后唯一调用的入口。约定签名 `(manager, ctx) => void`。

### 最小 Channel 骨架

```ts
class MyChannel implements Channel {
    readonly id = 'mychannel'; // 唯一 id，[A-Za-z0-9_-]，与插件目录名一致
    readonly name = '我的渠道'; // 侧栏展示名
    status: ChannelStatus = 'idle';

    constructor(private ctx: ChannelContext) {}

    /** 凭据是否就绪（决定「启动」按钮是否可点）。 */
    isConfigured(): boolean {
        return !!loadAccount()?.token;
    }

    /** 前端渠道卡片展示的多行状态文本。 */
    getStatusInfo(): string[] {
        return this.isConfigured() ? ['✅ 已配置'] : ['❌ 未配置'];
    }

    /** monitor 主循环：拉消息 → 交给通用管线 → 收发。opts.abortSignal 用于优雅停止。 */
    async start(opts: ChannelStartOpts): Promise<void> {
        const transport = makeTransport(/* ... */);
        while (!opts.abortSignal.aborted) {
            const inbound = await pollInbound(opts.abortSignal); // 你的协议：长轮询 / webhook 队列
            for (const msg of inbound) {
                await this.ctx.processMessage(
                    {
                        channelId: this.id,
                        channelName: this.name,
                        userId: msg.from,
                        text: msg.text,
                        transport,
                        abortSignal: opts.abortSignal
                    },
                    this.ctx
                );
            }
        }
    }

    async stop(): Promise<void> {
        this.status = 'idle'; // 真正的中断由 manager abort abortSignal 完成
    }
}
```

`start` 是后台运行的**长驻循环**，`ChannelManager.start(id)` 会 `void` 掉它（不阻塞调用方）并在 `abortSignal` 触发时退出。所有退避 sleep 用 `ctx.sleep(ms, opts.abortSignal)`，abort 时会 reject 让循环尽快退出。

---

## 三、通用消息管线 `ctx.processMessage`

绝大多数 provider **不用自己写 AI 编排**——收到一条 inbound 文本后，构造 `ProcessMessageParams` 丢给 `ctx.processMessage` 即可。它内部完成：

1. 落用户消息 + 发 `inbound` 事件（前端侧栏据此出现 / 上浮会话）
2. 读历史 → `ctx.runAgent(history, { sessionId, abortSignal })`
3. 消费 UI message stream：累积文本回复；`tool-input-start` / `reasoning-start` 时经 transport 发 IM 通知；同时把 chunk 旁路录入可恢复流（前端逐字回放）
4. 落 AI 回复 → `transport.sendText` 发回 IM → 发 `reply` 事件（出错发 `error` 事件 + 兜底提示）

你只需实现 `MessageTransport`：

```ts
const transport: MessageTransport = {
    sendText: async (userId, text) => {
        /* 调你的协议发消息 */
    },
    sendNotification: (userId, text) => {
        /* 轻量通知，可 no-op */
    },
    startTyping: (userId, signal) => () => {} // 返回「停止打字态」回调；不支持就返回 no-op
};
```

可选 `filterReply(text)`：对回复文本做后处理（如微信剥离 markdown），默认原样。

> 渠道 Agent 是**受限工具集**：只挂只读 MCP + 白名单技能工具，**没有 Bash/Write**（无人值守渠道没有审批 UI）。这是后端 `createChannelRunAgent` 决定的，插件无需关心。

### 需要更细控制时

`ctx.runAgent` 也可直接调（自行消费 `toUIMessageStream()`），但那样要自己处理落盘 / 事件 / 可恢复流。除非有特殊编排需求，**优先用 `ctx.processMessage`**。

---

## 四、绑定 / 凭据

后端「设置 → 渠道」的绑定按钮，会按你实现的可选方法路由：

- **表单绑定**：实现 `bind(payload: Record<string, string>): Promise<string[]>`（如 Telegram 收 `{ token }`）。前端弹表单，提交调 `bind`，返回值作状态提示。
- **扫码绑定**：实现 `startQrLogin()` + `pollQrLogin(sessionKey)`（如微信）。前端渲染二维码并轮询直到 `connected`。
- **解绑**：可选 `logout(): Promise<string[]>`，清凭据。

### 凭据落盘约定

为保持插件**零后端耦合**，自己用 `node:os` homedir 解析目录，落 `~/.zhuixun/channels/<id>.json`，**权限 0600**（apiKey/token 明文）：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function channelsDir(): string {
    const override = process.env.CHANNELS_USER_DIR?.trim(); // 与后端 paths 一致
    return override ? override : path.join(os.homedir(), '.zhuixun', 'channels');
}
function accountFile(): string {
    return path.join(channelsDir(), '<id>.json');
}

function saveAccount(a: unknown): void {
    fs.mkdirSync(channelsDir(), { recursive: true });
    fs.writeFileSync(accountFile(), JSON.stringify(a, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.chmodSync(accountFile(), 0o600);
}
```

参考实现见 `packages/channel-telegram/src/index.ts`（表单绑定）与 `packages/channel-weixin/src/index.ts`（扫码绑定）。

---

## 五、打包成插件并安装

后端从 `~/.zhuixun/channels/plugins/<id>/` 加载插件。每个插件目录需要两样东西：

```
~/.zhuixun/channels/plugins/<id>/
├── index.mjs      # 自包含 ESM（bundle 后，仅依赖 node 内建）
└── plugin.json    # { "name": "展示名", "entry": "index.mjs" }
```

用 esbuild 把你的 provider 源码打成自包含 ESM（`@zhuixun/channels-core` 仅 `import type`，会被擦除，故无运行时依赖）：

```bash
esbuild src/index.ts --bundle --format=esm --platform=node --target=node20 \
  --outfile=~/.zhuixun/channels/plugins/<id>/index.mjs
```

内置的 Telegram / 微信可直接用现成脚本一键安装（dogfood 同一条动态加载路径）：

```bash
pnpm channels:install-plugins    # 见 apps/backend/scripts/install-channel-plugins.mjs
```

### 在 settings.json 登记

安装后，在 `~/.zhuixun/settings.json` 的 `channels.plugins` 允许列表里登记 id，**重启后端**后才会加载：

```json
{
    "channels": {
        "plugins": ["telegram", "weixin", "<id>"]
    }
}
```

只有列在 `plugins` 里的 id 才会被加载（允许列表 = 用户主动授权）。

---

## 六、加载与安全约束

加载逻辑见 `apps/backend/src/core/channels/registry.ts`：

- **允许列表**：只加载 `channels.plugins` 里登记的 id。
- **id 白名单**：`/^[A-Za-z0-9_-]+$/`，防路径穿越。
- **entry 越界校验**：`plugin.json` 的 `entry` 解析后必须仍在插件目录内（防 `entry: "../../evil.js"`）。
- **仅受信目录**：只从用户可写的 `~/.zhuixun/channels/plugins/` 加载。

⚠️ **装渠道插件 = 授予其与后端同等权限**（同进程、可读凭据、可发网络请求）。只安装可信来源的插件；这也是为什么加载必须经用户在 `plugins` 里主动登记，而非自动发现。

## 七、开发速查

1. 新建包 `packages/channel-<id>/`，`src/index.ts` 实现 `class XxxChannel implements Channel` + `export function register(manager, ctx)`。
2. 仅 `import type` 本包；运行时能力全走 `ctx`（`processMessage` / `sleep` / `runtime` / `runAgent`）。
3. 凭据落 `~/.zhuixun/channels/<id>.json`（0600），自解析目录。
4. esbuild 打成自包含 `index.mjs` + 写 `plugin.json`，放进 `~/.zhuixun/channels/plugins/<id>/`。
5. `settings.json` 的 `channels.plugins` 登记 id，重启后端。
6. 「设置 → 渠道」出现卡片：配置 / 启动 / 绑定。

### 契约参考

| 导出                                               | 来源                                                        |
| -------------------------------------------------- | ----------------------------------------------------------- |
| `Channel` / `ChannelStatus` / `ChannelStartOpts`   | 渠道契约与状态                                              |
| `ChannelContext` / `ChannelRuntime` / `RunAgentFn` | 注入的运行上下文与能力                                      |
| `MessageTransport` / `ProcessMessageParams`        | 消息收发与管线入参                                          |
| `ChannelMessageEvent` / `ChannelOrigin`            | 事件与会话来源标记                                          |
| `ChannelManager`                                   | 管理器类（后端持有实例）                                    |
| `processMessage` / `sleep`                         | 通用管线与可中断 sleep（也经 `ctx` 注入，插件优先用 `ctx`） |

完整类型定义见 `src/types.ts`；两个内置参考实现见 `packages/channel-telegram`、`packages/channel-weixin`。
