/**
 * @zhuixun/channel-weixin — 微信渠道 provider（独立包，iLink 第三方个人号协议，扫码绑定）。
 * 仅依赖 @zhuixun/channels-core；后端能力经 ChannelContext 注入。
 *
 * ⚠️ 合规卡点：个人微信第三方协议存在封号 / 数据合规 / 敏感数据出域风险，须过合规评审后，
 *    再安装为渠道插件并在 settings.channels.plugins 登记 weixin 方可加载。
 */
import crypto from 'node:crypto';
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

const QR_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_BOT_TYPE = '3';
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;

const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_PAUSE_MS = 5 * 60_000;

const ITEM_TYPE_TEXT = 1;
const ITEM_TYPE_VOICE = 3;
/** iLink message_type：机器人发出的消息必须为 BOT(2)，写成 USER(1) 服务端不会投递。 */
const MESSAGE_TYPE_BOT = 2;
/** iLink message_state：整条消息发完为 FINISH(2)。 */
const MESSAGE_STATE_FINISH = 2;

/** 凭据目录：~/.zhuixun/channels（CHANNELS_USER_DIR 可覆盖，与后端 paths 一致）。 */
function channelsDir(): string {
    const override = process.env.CHANNELS_USER_DIR?.trim();
    return override ? override : path.join(os.homedir(), '.zhuixun', 'channels');
}

// ---------------------------------------------------------------------------
// 账号存储
// ---------------------------------------------------------------------------

interface WeixinAccount {
    baseUrl: string;
    token: string;
    accountId?: string;
    userId?: string;
}

function accountFile(): string {
    return path.join(channelsDir(), 'weixin.json');
}

function loadAccount(): WeixinAccount | null {
    try {
        return JSON.parse(fs.readFileSync(accountFile(), 'utf-8')) as WeixinAccount;
    } catch {
        return null;
    }
}

function saveAccount(account: WeixinAccount): void {
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

// APPEND-WX-1

// ---------------------------------------------------------------------------
// iLink HTTP（fetch）
// ---------------------------------------------------------------------------

function randomWechatUin(): string {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildHeaders(token?: string): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': randomWechatUin()
    };
    if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
    return headers;
}

function buildBaseInfo(): Record<string, unknown> {
    return { channel_version: '1.0.0', bot_agent: 'zhuixun' };
}

function joinUrl(baseUrl: string, endpoint: string): string {
    return `${baseUrl.replace(/\/$/, '')}/${endpoint}`;
}

async function ilinkPostRaw(
    baseUrl: string,
    endpoint: string,
    body: Record<string, unknown>,
    token: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal
): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    try {
        const resp = await fetch(joinUrl(baseUrl, endpoint), {
            method: 'POST',
            headers: buildHeaders(token),
            body: JSON.stringify({ ...body, base_info: buildBaseInfo() }),
            signal: ctrl.signal
        });
        return await resp.text();
    } finally {
        clearTimeout(timer);
    }
}

async function ilinkPost<T>(
    baseUrl: string,
    endpoint: string,
    body: Record<string, unknown>,
    token: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal
): Promise<T> {
    return JSON.parse(await ilinkPostRaw(baseUrl, endpoint, body, token, timeoutMs, signal)) as T;
}

async function ilinkGet(baseUrl: string, endpoint: string, timeoutMs: number): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const resp = await fetch(joinUrl(baseUrl, endpoint), { method: 'GET', signal: ctrl.signal });
        return await resp.text();
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// 扫码登录（get_bot_qrcode → get_qrcode_status）
// ---------------------------------------------------------------------------

interface ActiveLogin {
    qrcode: string;
    qrcodeUrl: string;
    startedAt: number;
    apiBaseUrl: string;
}
const activeLogins = new Map<string, ActiveLogin>();

interface QrCodeResp {
    qrcode: string;
    qrcode_img_content: string;
}
interface QrStatusResp {
    status:
        | 'wait'
        | 'scaned'
        | 'confirmed'
        | 'expired'
        | 'scaned_but_redirect'
        | 'need_verifycode'
        | 'verify_code_blocked'
        | 'binded_redirect';
    bot_token?: string;
    ilink_bot_id?: string;
    baseurl?: string;
    ilink_user_id?: string;
    redirect_host?: string;
}

function purgeExpiredLogins(): void {
    for (const [key, login] of activeLogins) {
        if (Date.now() - login.startedAt >= ACTIVE_LOGIN_TTL_MS) activeLogins.delete(key);
    }
}

// APPEND-WX-2

// ---------------------------------------------------------------------------
// 消息适配 + 传输
// ---------------------------------------------------------------------------

interface WxItem {
    type?: number;
    text_item?: { text?: string };
    voice_item?: { text?: string };
}
interface WxMessage {
    from_user_id?: string;
    item_list?: WxItem[];
    context_token?: string;
}
interface GetUpdatesResp {
    ret?: number;
    errcode?: number;
    errmsg?: string;
    msgs?: WxMessage[];
    get_updates_buf?: string;
    longpolling_timeout_ms?: number;
}

/** 每用户最近的 context_token（发送消息需带回）。 */
const contextTokens = new Map<string, string>();

function extractText(items?: WxItem[]): string {
    if (!items?.length) return '';
    for (const item of items) {
        if (item.type === ITEM_TYPE_TEXT && item.text_item?.text != null) return String(item.text_item.text);
        if (item.type === ITEM_TYPE_VOICE && item.voice_item?.text) return String(item.voice_item.text);
    }
    return '';
}

function makeTransport(baseUrl: string, token: string, log: ChannelLogger): MessageTransport {
    const send = async (to: string, text: string): Promise<void> => {
        const raw = await ilinkPostRaw(
            baseUrl,
            'ilink/bot/sendmessage',
            {
                msg: {
                    from_user_id: '',
                    to_user_id: to,
                    client_id: `weixin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    message_type: MESSAGE_TYPE_BOT,
                    message_state: MESSAGE_STATE_FINISH,
                    item_list: text ? [{ type: ITEM_TYPE_TEXT, text_item: { text } }] : undefined,
                    context_token: contextTokens.get(to)
                }
            },
            token,
            15_000
        );
        try {
            const parsed = JSON.parse(raw) as { ret?: number; errcode?: number; errmsg?: string };
            if ((parsed.ret && parsed.ret !== 0) || (parsed.errcode && parsed.errcode !== 0)) {
                log.error('sendmessage 服务端返回错误', {
                    to,
                    ret: parsed.ret,
                    errcode: parsed.errcode,
                    errmsg: parsed.errmsg
                });
            }
        } catch {
            /* 非 JSON 响应忽略 */
        }
    };
    return {
        sendText: (uid, msg) => send(uid, msg),
        sendNotification: (uid, msg) => {
            void send(uid, msg).catch((err) => log.error('通知发送失败', { uid, err: String(err) }));
        },
        startTyping: () => () => {}
    };
}

// APPEND-WX-3

export class WeixinChannel implements Channel {
    readonly id = 'weixin';
    readonly name = '微信';
    status: ChannelStatus = 'idle';
    private ctx: ChannelContext;
    private log: ChannelLogger;

    constructor(ctx: ChannelContext) {
        this.ctx = ctx;
        this.log = ctx.runtime.createLogger('Weixin');
    }

    isConfigured(): boolean {
        const a = loadAccount();
        return !!(a && a.baseUrl && a.token);
    }

    getStatusInfo(): string[] {
        const a = loadAccount();
        if (!this.isConfigured()) return ['❌ 未配置', '在「设置 → 渠道」点「扫码绑定」连接（须先过合规评审）'];
        return [
            `账号: ${a!.accountId ?? '默认'}`,
            `服务: ${a!.baseUrl}`,
            '✅ 已配置',
            '⚠️ 个人号协议，注意合规与封号风险'
        ];
    }

    /** 发起扫码：取二维码内容（前端渲染成二维码图供手机微信扫描）。 */
    async startQrLogin(): Promise<{ sessionKey: string; qrcodeUrl?: string; message: string }> {
        purgeExpiredLogins();
        const sessionKey = crypto.randomUUID();
        try {
            const resp = await ilinkPost<QrCodeResp>(
                QR_BASE_URL,
                `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(DEFAULT_BOT_TYPE)}`,
                { local_token_list: [] },
                undefined,
                15_000
            );
            activeLogins.set(sessionKey, {
                qrcode: resp.qrcode,
                qrcodeUrl: resp.qrcode_img_content,
                startedAt: Date.now(),
                apiBaseUrl: QR_BASE_URL
            });
            return { sessionKey, qrcodeUrl: resp.qrcode_img_content, message: '用手机微信扫描二维码以连接' };
        } catch (err) {
            this.log.error('获取二维码失败', { err: String(err) });
            return { sessionKey, message: `获取二维码失败：${err instanceof Error ? err.message : String(err)}` };
        }
    }

    /** 轮询扫码结果（单次）。前端反复调用直到 connected 或过期。 */
    async pollQrLogin(sessionKey: string): Promise<{ connected: boolean; accountId?: string; message: string }> {
        const login = activeLogins.get(sessionKey);
        if (!login) return { connected: false, message: '登录会话不存在或已过期，请重新发起' };
        if (Date.now() - login.startedAt >= ACTIVE_LOGIN_TTL_MS) {
            activeLogins.delete(sessionKey);
            return { connected: false, message: '二维码已过期，请重新发起' };
        }
        let raw: string;
        try {
            raw = await ilinkGet(
                login.apiBaseUrl,
                `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(login.qrcode)}`,
                QR_LONG_POLL_TIMEOUT_MS
            );
        } catch {
            return { connected: false, message: '等待扫码…' };
        }
        let status: QrStatusResp;
        try {
            status = JSON.parse(raw) as QrStatusResp;
        } catch {
            return { connected: false, message: '等待扫码…' };
        }

        switch (status.status) {
            case 'scaned':
                return { connected: false, message: '已扫描，请在手机上确认' };
            case 'scaned_but_redirect':
                if (status.redirect_host) login.apiBaseUrl = `https://${status.redirect_host}`;
                return { connected: false, message: '正在连接…' };
            case 'need_verifycode':
                return { connected: false, message: '需在手机微信输入验证码（暂不支持），请重试扫码' };
            case 'verify_code_blocked':
                activeLogins.delete(sessionKey);
                return { connected: false, message: '多次验证失败，请稍后再试' };
            case 'expired':
                activeLogins.delete(sessionKey);
                return { connected: false, message: '二维码已过期，请重新发起' };
            case 'binded_redirect':
                activeLogins.delete(sessionKey);
                return { connected: false, message: '该微信已绑定过，无需重复连接' };
            case 'confirmed': {
                if (!status.ilink_bot_id || !status.bot_token) {
                    activeLogins.delete(sessionKey);
                    return { connected: false, message: '登录失败：服务器未返回 bot 凭据' };
                }
                saveAccount({
                    baseUrl: status.baseurl || DEFAULT_BASE_URL,
                    token: status.bot_token,
                    accountId: status.ilink_bot_id,
                    userId: status.ilink_user_id
                });
                activeLogins.delete(sessionKey);
                return { connected: true, accountId: status.ilink_bot_id, message: '已连接到微信' };
            }
            default:
                return { connected: false, message: '等待扫码…' };
        }
    }

    // APPEND-WX-4

    async logout(): Promise<string[]> {
        if (!this.isConfigured()) return ['❌ 未配置微信账号'];
        clearAccount();
        contextTokens.clear();
        return ['✅ 已解绑微信账号'];
    }

    async start(opts: ChannelStartOpts): Promise<void> {
        const account = loadAccount();
        if (!account) throw new Error('未配置微信账号');
        const { baseUrl, token } = account;
        const transport = makeTransport(baseUrl, token, this.log);
        this.log.info('微信监听启动', { baseUrl, accountId: account.accountId });

        try {
            await ilinkPostRaw(baseUrl, 'ilink/bot/msg/notifystart', {}, token, 10_000);
        } catch (err) {
            this.log.warn('notifyStart 失败（忽略）', { err: String(err) });
        }

        let getUpdatesBuf = '';
        let timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
        let failures = 0;

        while (!opts.abortSignal.aborted) {
            try {
                const resp = await ilinkPost<GetUpdatesResp>(
                    baseUrl,
                    'ilink/bot/getupdates',
                    { get_updates_buf: getUpdatesBuf },
                    token,
                    timeoutMs,
                    opts.abortSignal
                );
                if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0)
                    timeoutMs = resp.longpolling_timeout_ms;

                const isApiError =
                    (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
                if (isApiError) {
                    if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
                        this.log.error('微信会话过期，暂停 5 分钟');
                        failures = 0;
                        await this.ctx.sleep(SESSION_PAUSE_MS, opts.abortSignal);
                        continue;
                    }
                    failures++;
                    this.log.error('getUpdates 失败', {
                        ret: resp.ret,
                        errcode: resp.errcode,
                        errmsg: resp.errmsg,
                        failures
                    });
                    await this.ctx.sleep(
                        failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS,
                        opts.abortSignal
                    );
                    if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0;
                    continue;
                }
                failures = 0;
                if (resp.get_updates_buf) getUpdatesBuf = resp.get_updates_buf;

                await Promise.allSettled(
                    (resp.msgs ?? []).map(async (msg) => {
                        const userId = msg.from_user_id?.trim();
                        if (!userId) return;
                        const text = extractText(msg.item_list);
                        if (!text) return;
                        if (msg.context_token) contextTokens.set(userId, msg.context_token);
                        await this.ctx
                            .processMessage(
                                {
                                    channelId: this.id,
                                    channelName: this.name,
                                    userId,
                                    text,
                                    transport,
                                    abortSignal: opts.abortSignal
                                },
                                this.ctx
                            )
                            .catch((err) => this.log.error('processMessage 出错', { userId, err: String(err) }));
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

        try {
            await ilinkPostRaw(baseUrl, 'ilink/bot/msg/notifystop', {}, token, 10_000);
        } catch {
            /* 忽略 */
        }
        this.status = 'idle';
        this.log.info('微信监听结束');
    }

    async stop(): Promise<void> {
        this.status = 'idle';
    }
}

/** 注册微信渠道到 ChannelManager（由宿主在启用时调用）。 */
export function register(manager: ChannelManager, ctx: ChannelContext): void {
    manager.register(new WeixinChannel(ctx));
}
