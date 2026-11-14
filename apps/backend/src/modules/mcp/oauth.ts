/**
 * OAuth 支持：token 存储 + OAuthClientProvider 实现 + 自定义 OAuth 流程
 *
 * 两种模式：
 * A. 有 registration_endpoint → SDK auth() 自动处理动态注册
 * B. 无 registration_endpoint（如 GitHub）→ 使用 startOAuthFlow() 手动编排
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';

import {
    type OAuthClientProvider,
    discoverOAuthServerInfo,
    startAuthorization,
    exchangeAuthorization
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { writeFileAtomic } from '@/config/atomic-json';
import { paths } from '@/config/paths';
import { oauthCallbackUrl } from '@/config/server';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('MCP:OAuth');

// ── Token Store ──────────────────────────────────────────────

export interface StoredOAuthData {
    tokens?: OAuthTokens;
    clientInformation?: OAuthClientInformationMixed;
    codeVerifier?: string;
    discoveryState?: {
        authorizationServerUrl: string;
        resourceMetadataUrl?: string;
    };
}

/**
 * OAuth token 存储：持久化到 ~/.zhuixun/mcp-oauth.json（含 access/refresh token，0600 落盘），
 * 后端重启后复用，无需重新授权。OAuthClientProvider 接口是同步的，故读取在构造时
 * 同步完成（readFileSync），写入先改内存再异步原子落盘（串行队列 + 临时文件 rename）。
 * 文件损坏退化为空存储（重新授权），绝不 crash。
 */
export class OAuthTokenStore {
    private store = new Map<string, StoredOAuthData>();
    private queue: Promise<unknown> = Promise.resolve();

    // 显式路径便于隔离实例；生产仍默认使用配置层路径，不改变惰性单例语义。
    constructor(private filePath = paths.mcpOAuthFile()) {
        this.loadSync();
    }

    private loadSync(): void {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as Record<string, StoredOAuthData>;
            for (const [name, data] of Object.entries(parsed)) {
                this.store.set(name, data);
            }
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                log.warn('读取 OAuth 持久化文件失败，按空存储处理', {
                    err: err instanceof Error ? err.message : err
                });
            }
        }
    }

    private schedulePersist(): void {
        const snapshot = JSON.stringify(Object.fromEntries(this.store), null, 2);
        this.queue = this.queue.then(async () => {
            try {
                // 0600：token 落盘仅属主可读写；原子写与失败清理统一在 platform/fs。
                await writeFileAtomic(this.filePath, snapshot, { mode: 0o600 });
                // 文件可能此前以更宽松权限创建过，强制收敛到 0600
                await fsp.chmod(this.filePath, 0o600).catch(() => {});
            } catch (err) {
                log.error('持久化 OAuth 存储失败（内存态仍有效）', {
                    err: err instanceof Error ? err.message : err
                });
            }
        });
    }

    /** 等待已提交的持久化任务，供关闭/验证时确认落盘，不使用轮询或延时猜测。 */
    async flush(): Promise<void> {
        await this.queue;
    }

    get(serverName: string): StoredOAuthData {
        if (!this.store.has(serverName)) {
            this.store.set(serverName, {});
        }
        return this.store.get(serverName)!;
    }

    setTokens(serverName: string, tokens: OAuthTokens): void {
        this.get(serverName).tokens = tokens;
        this.schedulePersist();
    }

    getTokens(serverName: string): OAuthTokens | undefined {
        return this.get(serverName).tokens;
    }

    setClientInformation(serverName: string, info: OAuthClientInformationMixed): void {
        this.get(serverName).clientInformation = info;
        this.schedulePersist();
    }

    getClientInformation(serverName: string): OAuthClientInformationMixed | undefined {
        return this.get(serverName).clientInformation;
    }

    setCodeVerifier(serverName: string, verifier: string): void {
        this.get(serverName).codeVerifier = verifier;
        this.schedulePersist();
    }

    getCodeVerifier(serverName: string): string | undefined {
        return this.get(serverName).codeVerifier;
    }

    setDiscoveryState(
        serverName: string,
        state: { authorizationServerUrl: string; resourceMetadataUrl?: string }
    ): void {
        this.get(serverName).discoveryState = state;
        this.schedulePersist();
    }

    getDiscoveryState(
        serverName: string
    ): { authorizationServerUrl: string; resourceMetadataUrl?: string } | undefined {
        return this.get(serverName).discoveryState;
    }

    clear(serverName: string): void {
        this.store.delete(serverName);
        this.schedulePersist();
    }
}

let tokenStoreSingleton: OAuthTokenStore | null = null;

/** 延迟实例化：构造时会读盘，需晚于 bootstrap-settings 解析路径覆盖。 */
function getTokenStore(): OAuthTokenStore {
    if (!tokenStoreSingleton) tokenStoreSingleton = new OAuthTokenStore();
    return tokenStoreSingleton;
}

/** 兼容既有以属性方式访问的调用点，惰性转发到单例。 */
export const tokenStore = {
    get: (name: string) => getTokenStore().get(name),
    setTokens: (name: string, t: OAuthTokens) => getTokenStore().setTokens(name, t),
    getTokens: (name: string) => getTokenStore().getTokens(name),
    setClientInformation: (name: string, i: OAuthClientInformationMixed) =>
        getTokenStore().setClientInformation(name, i),
    getClientInformation: (name: string) => getTokenStore().getClientInformation(name),
    setCodeVerifier: (name: string, v: string) => getTokenStore().setCodeVerifier(name, v),
    getCodeVerifier: (name: string) => getTokenStore().getCodeVerifier(name),
    setDiscoveryState: (name: string, s: { authorizationServerUrl: string; resourceMetadataUrl?: string }) =>
        getTokenStore().setDiscoveryState(name, s),
    getDiscoveryState: (name: string) => getTokenStore().getDiscoveryState(name),
    clear: (name: string) => getTokenStore().clear(name),
    flush: () => getTokenStore().flush()
};

// ── Pending Authorization ────────────────────────────────────

const pendingAuth = new Map<string, { authorizationUrl: string; completed: boolean }>();

export function setPendingAuth(serverName: string, authorizationUrl: string): void {
    pendingAuth.set(serverName, { authorizationUrl, completed: false });
}

export function getPendingAuth(serverName: string): { authorizationUrl: string; completed: boolean } | undefined {
    return pendingAuth.get(serverName);
}

export function completePendingAuth(serverName: string): void {
    const pending = pendingAuth.get(serverName);
    if (pending) {
        pending.completed = true;
    }
}

export function clearPendingAuth(serverName: string): void {
    pendingAuth.delete(serverName);
}

// ── OAuth state（CSRF 防护）─────────────────────────────────
// state 用随机值而非可预测的 `mcp_<name>`：回调时以 state 反查 server，
// 查不到即拒绝，防止伪造/重放回调。授权发起时登记，完成或撤销时清除。

const oauthStateToServer = new Map<string, string>();

/** 生成并登记一个随机 state，返回该 state 字符串。 */
export function createOAuthState(serverName: string): string {
    // 先清除该 server 上一次未完成的 state，避免堆积
    for (const [state, name] of oauthStateToServer) {
        if (name === serverName) oauthStateToServer.delete(state);
    }
    const state = `mcp_${serverName}_${crypto.randomUUID()}`;
    oauthStateToServer.set(state, serverName);
    return state;
}

/** 以回调带回的 state 反查并原子消费；未登记返回 undefined，保留既有无时限语义。 */
export function resolveOAuthState(state: string | undefined): string | undefined {
    if (!state) return undefined;
    const serverName = oauthStateToServer.get(state);
    // 必须在 await token exchange 之前消费，避免并发回调用同一 state 重放。
    // exchange 失败需重新发起授权；既有 consumeOAuthState 调用仍幂等兼容。
    oauthStateToServer.delete(state);
    return serverName;
}

/** 消费（一次性）某个 state。 */
export function consumeOAuthState(state: string): void {
    oauthStateToServer.delete(state);
}

// ── OAuthClientProvider ──────────────────────────────────────

export class MCPOAuthProvider implements OAuthClientProvider {
    private _authorizationUrl?: URL;

    constructor(
        private serverName: string,
        private _redirectUrl: string | URL,
        private _clientMetadata: OAuthClientMetadata,
        private store: typeof tokenStore = tokenStore
    ) {}

    get redirectUrl(): string | URL {
        return this._redirectUrl;
    }

    get clientMetadata(): OAuthClientMetadata {
        return this._clientMetadata;
    }

    clientInformation(): OAuthClientInformationMixed | undefined {
        return this.store.getClientInformation(this.serverName);
    }

    saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
        this.store.setClientInformation(this.serverName, clientInformation);
    }

    tokens(): OAuthTokens | undefined {
        return this.store.getTokens(this.serverName);
    }

    saveTokens(tokens: OAuthTokens): void {
        this.store.setTokens(this.serverName, tokens);
    }

    redirectToAuthorization(authorizationUrl: URL): void {
        this._authorizationUrl = authorizationUrl;
    }

    saveCodeVerifier(codeVerifier: string): void {
        this.store.setCodeVerifier(this.serverName, codeVerifier);
    }

    codeVerifier(): string {
        const verifier = this.store.getCodeVerifier(this.serverName);
        if (!verifier) {
            throw new Error(`No code verifier stored for server "${this.serverName}"`);
        }
        return verifier;
    }

    get authorizationUrl(): URL | undefined {
        return this._authorizationUrl;
    }
}

// ── Custom OAuth Flow (不依赖动态注册) ─────────────────────

export interface OAuthFlowResult {
    authorizationUrl?: string;
    authenticated?: boolean;
}

/** 只注入 SDK 与存储边界，离线验证仍执行真实 OAuth 编排；默认入口保留原单例。 */
export function createOAuthFlow({
    store = tokenStore,
    sdk = { discoverOAuthServerInfo, startAuthorization, exchangeAuthorization }
}: {
    store?: typeof tokenStore;
    sdk?: Pick<
        {
            discoverOAuthServerInfo: typeof discoverOAuthServerInfo;
            startAuthorization: typeof startAuthorization;
            exchangeAuthorization: typeof exchangeAuthorization;
        },
        'discoverOAuthServerInfo' | 'startAuthorization' | 'exchangeAuthorization'
    >;
} = {}) {
    /**
     * 执行完整的 OAuth 流程（适用于不支持动态注册的服务器，如 GitHub）。
     *
     * 流程：
     * 1. Discovery OAuth 元数据
     * 2. 生成 PKCE + authorizationUrl
     * 3. 返回 authorizationUrl 给调用方（前端打开浏览器）
     * 4. 用户授权后回调带 code → 调用 completeOAuthFlow() 完成
     */
    async function startOAuthFlow(
        serverName: string,
        serverUrl: string,
        redirectUrl: string,
        clientMetadata: OAuthClientMetadata,
        scope?: string,
        clientId?: string
    ): Promise<OAuthFlowResult> {
        const existingTokens = store.getTokens(serverName);
        if (existingTokens?.access_token) {
            return { authenticated: true };
        }

        // 1. Discovery
        const serverInfo = await sdk.discoverOAuthServerInfo(serverUrl);
        const authServerUrl = serverInfo.authorizationServerUrl;
        const metadata = serverInfo.authorizationServerMetadata;

        store.setDiscoveryState(serverName, {
            authorizationServerUrl: authServerUrl,
            resourceMetadataUrl: serverInfo.resourceMetadata?.resource
        });

        const hasRegistration = !!metadata?.registration_endpoint;

        if (hasRegistration) {
            // 有 registration_endpoint：使用 SDK 的标准流程
            // 这种情况下应该用 auth()，但这里不走这个分支
            throw new Error('此服务器支持动态注册，请使用标准 auth 流程');
        }

        // 2. 无 registration_endpoint：需要预注册的 client 或使用 public client
        const resolvedClientId = clientId || 'alias';

        const fakeClientInfo: OAuthClientInformationMixed = {
            client_id: resolvedClientId
        };

        // 3. 生成 authorization URL + PKCE
        const { authorizationUrl, codeVerifier } = await sdk.startAuthorization(authServerUrl, {
            metadata: metadata || undefined,
            clientInformation: fakeClientInfo,
            redirectUrl,
            scope,
            // 随机 state 防 CSRF/重放（回调时以此反查 server）
            state: createOAuthState(serverName)
        });

        store.setCodeVerifier(serverName, codeVerifier);
        store.setClientInformation(serverName, fakeClientInfo);

        return { authorizationUrl: authorizationUrl.toString() };
    }

    /**
     * 完成 OAuth 流程：用 authorization code 换取 token。
     */
    async function completeOAuthFlow(serverName: string, authorizationCode: string): Promise<OAuthTokens> {
        const discoveryState = store.getDiscoveryState(serverName);
        if (!discoveryState) {
            throw new Error(`No discovery state for server "${serverName}", please start auth flow first`);
        }

        const clientInfo = store.getClientInformation(serverName);
        if (!clientInfo) {
            throw new Error(`No client information for server "${serverName}"`);
        }

        const codeVerifier = store.getCodeVerifier(serverName);
        if (!codeVerifier) {
            throw new Error(`No code verifier for server "${serverName}"`);
        }

        getConfigForServer(serverName);
        const redirectUrl = oauthCallbackUrl();

        const tokens = await sdk.exchangeAuthorization(discoveryState.authorizationServerUrl, {
            clientInformation: clientInfo,
            authorizationCode,
            codeVerifier,
            redirectUri: redirectUrl
        });

        store.setTokens(serverName, tokens);
        completePendingAuth(serverName);

        return tokens;
    }

    return { startOAuthFlow, completeOAuthFlow };
}

export const { startOAuthFlow, completeOAuthFlow } = createOAuthFlow();

// 临时引用，避免循环依赖
let getConfigForServer: (name: string) => { oauth?: { scope?: string } } | undefined = () => undefined;

export function setConfigResolver(resolver: (name: string) => { oauth?: { scope?: string } } | undefined): void {
    getConfigForServer = resolver;
}
