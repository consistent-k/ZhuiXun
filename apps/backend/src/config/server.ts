/**
 * HTTP 服务与 OAuth 回调相关配置。收口此前重复的：
 * - `Number(process.env.PORT || 3001)`（6 处：index / oauth / manager×4 / routes/mcp）
 * - `http://localhost:${PORT}/api/mcp/oauth/callback`（3 文件 6 处拼接）
 * - CORS 白名单默认值 + ALLOWED_ORIGINS / API_AUTH_TOKEN（auth 中间件）
 */
import { list, num, optional } from './env';

/**
 * 监听 host：**写死回环地址，绝不暴露为 env**。后端暴露读密钥 / 起子进程等高危能力，
 * 配成 0.0.0.0 对局域网可达会造成密钥窃取 / RCE。这是安全底线，不是可配置项。
 */
export const HOST = '127.0.0.1';

/**
 * HTTP 监听端口，默认 31001（PORT 可覆盖）。
 * 选 31001 而非常见的 3001：3001 与大量 dev server 冲突；31001 落在 Linux(32768–60999) 与
 * mac/win(49152–65535) 的临时端口范围之外，不易与系统出站端口相撞，且作为「老 3001」的衍生好记。
 * 实际监听端口在启动时可能因占用自动顺延（见 server.ts 的 startServer），顺延后会写回 process.env.PORT，
 * 使本访问器与 oauthCallbackUrl() 等后续读取者始终反映真实端口。
 */
export function port(): number {
    return num('PORT', 31001);
}

/** OAuth 回调 URL。前端/浏览器导航访问，故用 localhost 而非绑定的 127.0.0.1。 */
export function oauthCallbackUrl(): string {
    return `http://localhost:${port()}/api/mcp/oauth/callback`;
}

/**
 * 内置允许来源：
 * - Electron 渲染进程：打包形态经自定义协议 `app://local` 加载 SPA；
 * - 本地 dev 前端（vite 8080），Electron dev 下渲染进程指向它。
 */
const DEFAULT_ALLOWED_ORIGINS = ['app://local', 'http://localhost:8080', 'http://127.0.0.1:8080'];

/** 允许来源集合：内置默认 + ALLOWED_ORIGINS（逗号分隔）扩展。每次调用求值。 */
export function allowedOrigins(): string[] {
    return [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...list('ALLOWED_ORIGINS')])];
}

/** 可选共享鉴权 token（API_AUTH_TOKEN）；未设返回 undefined 即关闭 token 校验。 */
export function apiAuthToken(): string | undefined {
    return optional('API_AUTH_TOKEN');
}
