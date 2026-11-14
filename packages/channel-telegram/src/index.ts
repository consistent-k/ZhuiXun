/**
 * @zhuixun/channel-telegram — Telegram 渠道 provider（独立包）。
 * 仅依赖 @zhuixun/channels-core；后端能力（会话/可恢复流/事件/日志）经 ChannelContext 注入。
 * 用全局 fetch（Node 22+），凭据落 ~/.zhuixun/channels/telegram.json（0600）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
    Channel,
    ChannelContext,
    ChannelLogger,
    ChannelManager,
    ChannelStartOpts,
    ChannelStatus,
    MessageTransport
} from '@zhuixun/channels-core';

const API_BASE = 'https://api.telegram.org';

const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const LONG_POLL_TIMEOUT_S = 30;
const MAX_MESSAGE_LENGTH = 4096;
const TYPING_INTERVAL_MS = 4_000;

/** 凭据目录：~/.zhuixun/channels（CHANNELS_USER_DIR 可覆盖，与后端 paths 一致）。 */
function channelsDir(): string {
    const override = process.env.CHANNELS_USER_DIR?.trim();
    return override ? override : path.join(os.homedir(), '.zhuixun', 'channels');
}

// ---------------------------------------------------------------------------
// 账号存储
// ---------------------------------------------------------------------------

interface TelegramAccount {
    token: string;
    botId?: string;
    botUsername?: string;
}

function accountFile(): string {
    return path.join(channelsDir(), 'telegram.json');
}

function loadAccount(): TelegramAccount | null {
    try {
        return JSON.parse(fs.readFileSync(accountFile(), 'utf-8')) as TelegramAccount;
    } catch {
        return null;
    }
}

function saveAccount(account: TelegramAccount): void {
    fs.mkdirSync(channelsDir(), { recursive: true });
    const file = accountFile();
    fs.writeFileSync(file, JSON.stringify(account, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.chmodSync(file, 0o600);
}

function clearAccount(): void {
    try {
        fs.unlinkSync(accountFile());
    } catch {
        /* 不存在忽略 */
    }
}

function redactToken(token: string): string {
    return token.length <= 6 ? '****' : `${token.slice(0, 6)}…(len=${token.length})`;
}

// APPEND-TG-1

// ---------------------------------------------------------------------------
// Bot API（fetch）
// ---------------------------------------------------------------------------

interface TgResponse<T> {
    ok: boolean;
    result: T;
    description?: string;
}

async function tgCall<T>(
    token: string,
    method: string,
    body?: unknown,
    timeoutMs = 60_000,
    signal?: AbortSignal
): Promise<TgResponse<T>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    try {
        const resp = await fetch(`${API_BASE}/bot${token}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body ?? {}),
            signal: ctrl.signal
        });
        return (await resp.json()) as TgResponse<T>;
    } finally {
        clearTimeout(timer);
    }
}

/** Markdown → Telegram HTML（简版）。先转义 HTML 特殊字符再套标签，避免二次转义与占位符控制字符。 */
function markdownToTelegramHtml(md: string): string {
    const escaped = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escaped
        .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>')
        .replace(/~~([^~]+)~~/g, '<s>$1</s>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<void> {
    const html = markdownToTelegramHtml(text);
    for (let i = 0; i < html.length || i === 0; i += MAX_MESSAGE_LENGTH) {
        const chunk = html.slice(i, i + MAX_MESSAGE_LENGTH);
        if (!chunk) break;
        const resp = await tgCall(token, 'sendMessage', { chat_id: chatId, text: chunk, parse_mode: 'HTML' });
        if (!resp.ok && resp.description?.includes("can't parse entities")) {
            await tgCall(token, 'sendMessage', { chat_id: chatId, text: text.slice(i, i + MAX_MESSAGE_LENGTH) });
        }
    }
}

function makeTransport(token: string, log: ChannelLogger): MessageTransport {
    return {
        sendText: (uid, msg) => sendTelegramMessage(token, uid, msg),
        sendNotification: (uid, msg) => {
            void sendTelegramMessage(token, uid, msg).catch((err) =>
                log.error('通知发送失败', { uid, err: String(err) })
            );
        },
        startTyping: (uid, signal) => {
            let active = true;
            const tick = () => {
                if (active) void tgCall(token, 'sendChatAction', { chat_id: uid, action: 'typing' }).catch(() => {});
            };
            tick();
            const interval = setInterval(tick, TYPING_INTERVAL_MS);
            const stop = () => {
                active = false;
                clearInterval(interval);
            };
            signal?.addEventListener('abort', stop, { once: true });
            return stop;
        }
    };
}

interface TgUpdate {
    update_id: number;
    message?: { from?: { is_bot: boolean }; chat: { id: number }; text?: string };
}

// APPEND-TG-2

export class TelegramChannel implements Channel {
    readonly id = 'telegram';
    readonly name = 'Telegram';
    status: ChannelStatus = 'idle';
    private ctx: ChannelContext;
    private log: ChannelLogger;

    constructor(ctx: ChannelContext) {
        this.ctx = ctx;
        this.log = ctx.runtime.createLogger('Telegram');
    }

    isConfigured(): boolean {
        return loadAccount() !== null;
    }

    getStatusInfo(): string[] {
        const account = loadAccount();
        if (!account) return ['❌ 未配置', '请在「设置 → 渠道」填入 Bot Token 绑定'];
        return [
            `Bot: @${account.botUsername ?? account.botId ?? '未知'}`,
            `Token: ${redactToken(account.token)}`,
            '✅ 已配置'
        ];
    }

    async bind(payload: Record<string, string>): Promise<string[]> {
        const token = (payload.token ?? '').trim();
        if (!token) return ['❌ Token 不能为空'];
        try {
            const resp = await tgCall<{ id: number; is_bot: boolean; username?: string }>(token, 'getMe', {}, 15_000);
            if (!resp.ok) return [`❌ Token 验证失败：${resp.description ?? '未知错误'}`];
            if (!resp.result.is_bot) return ['❌ 该 Token 不属于 Bot'];
            saveAccount({ token, botId: String(resp.result.id), botUsername: resp.result.username });
            return [`✅ 绑定成功！Bot: @${resp.result.username ?? resp.result.id}`];
        } catch (err) {
            return [`❌ Token 验证失败：${err instanceof Error ? err.message : String(err)}`];
        }
    }

    async logout(): Promise<string[]> {
        const account = loadAccount();
        if (!account) return ['❌ 未配置 Telegram Bot'];
        clearAccount();
        return [`✅ 已解绑 Bot: @${account.botUsername ?? account.botId ?? '未知'}`];
    }

    async start(opts: ChannelStartOpts): Promise<void> {
        const account = loadAccount();
        if (!account) throw new Error('未配置 Telegram Bot Token');
        const { token } = account;
        const transport = makeTransport(token, this.log);
        this.log.info('Telegram 监听启动', { bot: account.botUsername });

        let offset = 0;
        let failures = 0;
        while (!opts.abortSignal.aborted) {
            try {
                const resp = await tgCall<TgUpdate[]>(
                    token,
                    'getUpdates',
                    { offset, timeout: LONG_POLL_TIMEOUT_S, allowed_updates: ['message'] },
                    (LONG_POLL_TIMEOUT_S + 10) * 1000,
                    opts.abortSignal
                );
                if (!resp.ok) {
                    failures++;
                    this.log.error('getUpdates 失败', { desc: resp.description, failures });
                    await this.ctx.sleep(
                        failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS,
                        opts.abortSignal
                    );
                    if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0;
                    continue;
                }
                failures = 0;
                for (const update of resp.result) {
                    if (update.update_id >= offset) offset = update.update_id + 1;
                }
                await Promise.allSettled(
                    resp.result.map(async (update) => {
                        const msg = update.message;
                        if (!msg?.text || msg.from?.is_bot) return;
                        await this.ctx
                            .processMessage(
                                {
                                    channelId: this.id,
                                    channelName: this.name,
                                    userId: String(msg.chat.id),
                                    text: msg.text,
                                    transport,
                                    abortSignal: opts.abortSignal
                                },
                                this.ctx
                            )
                            .catch((err) => this.log.error('processMessage 出错', { err: String(err) }));
                    })
                );
            } catch (err) {
                if (opts.abortSignal.aborted) break;
                if (err instanceof Error && err.name === 'AbortError') continue;
                failures++;
                this.log.error('getUpdates 异常', { err: String(err), failures });
                try {
                    await this.ctx.sleep(
                        failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS,
                        opts.abortSignal
                    );
                } catch {
                    break;
                }
                if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0;
            }
        }
        this.status = 'idle';
        this.log.info('Telegram 监听结束');
    }

    async stop(): Promise<void> {
        this.status = 'idle';
    }
}

/** 注册 Telegram 渠道到 ChannelManager（由宿主在启动时调用）。 */
export function register(manager: ChannelManager, ctx: ChannelContext): void {
    manager.register(new TelegramChannel(ctx));
}
