import type { Context, Next } from 'hono';

import { allowedOrigins, apiAuthToken } from '@/config/server';

/**
 * 本地 HTTP 服务的访问控制。
 *
 * 背景：后端同时暴露「读模型密钥」「起 MCP 子进程」两类高危能力，且监听在本机端口。
 * 若不设防，用户在浏览器里打开的任意网页都能 `fetch('http://localhost:3001/...')`
 * 跨源命中这些端点（密钥窃取 / RCE）。这里用两道闸拦截：
 *
 * 1) Origin 白名单：只放行 Electron 渲染进程与本地 dev 前端的固定来源。浏览器对跨源请求
 *    （含简单 GET）都会带上自己的 `Origin`，恶意站点的 Origin 不在名单内即 403——
 *    不依赖浏览器「拒绝读取响应」的 CORS 语义，而是在请求进入业务前直接挡掉。
 *    无 Origin 的请求（OAuth 回调这类顶层导航、本机 curl）放行：配合监听 127.0.0.1，
 *    本机之外无法触达。
 * 2) 可选共享 token：设置了 API_AUTH_TOKEN 时，/api/* 需带匹配的 x-zhuixun-token
 *    请求头（前端从 VITE_API_AUTH_TOKEN 注入）。用于需要更强隔离的部署，默认关闭以保证
 *    开箱即用。OAuth 回调是浏览器导航、无法带自定义头，故豁免。
 */

/** hono/cors 的 origin 回调：命中白名单才回显该源，否则不下发 ACAO。 */
export function corsOriginResolver(origin: string): string | undefined {
    return allowedOrigins().includes(origin) ? origin : undefined;
}

/** 无需 token 的 /api 路径（浏览器顶层导航，带不了自定义请求头）。 */
const TOKEN_EXEMPT_PATHS = ['/api/mcp/oauth/callback'];

/**
 * 无需 token 的 /api 路径前缀：对话附件读取由 `<img src>` 等原生资源标签发起，无法带自定义请求头。
 * 仍受 Origin 白名单 + 127.0.0.1 监听 + 会话作用域 id 校验保护。
 */
const TOKEN_EXEMPT_PREFIXES = ['/api/chat/files/'];

/** /api/* 访问闸：Origin 白名单 + 可选共享 token。 */
export async function apiGuard(c: Context, next: Next): Promise<Response | void> {
    const origin = c.req.header('origin');
    if (origin && !allowedOrigins().includes(origin)) {
        return c.json({ code: 403, message: '来源不被允许' }, 403);
    }

    const requiredToken = apiAuthToken();
    const exempt =
        TOKEN_EXEMPT_PATHS.includes(c.req.path) || TOKEN_EXEMPT_PREFIXES.some((p) => c.req.path.startsWith(p));
    if (requiredToken && !exempt) {
        const provided = c.req.header('x-zhuixun-token');
        if (provided !== requiredToken) {
            return c.json({ code: 401, message: '未授权' }, 401);
        }
    }

    await next();
}
