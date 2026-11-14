import type { ApiResponse } from '@zhuixun/shared';
import axios, { type AxiosError, type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';

import { SUCCESS_CODE } from '@/constant/code';
import { staticApi } from '@/utils/antdStatic';

/**
 * 后端统一响应体（契约 DTO）。本项目后端沿用 `data` 字段（非团队默认模板里的 `result`）。
 * 历史代码广泛以 BaseResponse 名引用，故保留为 @zhuixun/shared 的 ApiResponse 别名。
 */
export type BaseResponse<T = unknown> = ApiResponse<T>;

/** 默认后端端口，与后端 config/server.ts 的 port() 默认值保持一致（冷门端口，避开临时端口范围）。 */
const DEFAULT_BACKEND_PORT = 31001;

/**
 * 解析后端基地址。优先级：
 * 1. VITE_API_BASE_URL 显式覆盖（dev:web 前后端分离、或指向远端后端）；
 * 2. Electron 主进程经 preload 注入的真实端口 window.zhuixun.backendPort
 *    —— 后端端口被占用会自动顺延，这里据此发现实际地址；
 * 3. 兜底默认端口（dev:web 纯浏览器无 preload、或未注入时）。
 */
function resolveApiBaseUrl(): string {
    if (import.meta.env.VITE_API_BASE_URL) return import.meta.env.VITE_API_BASE_URL;
    const injectedPort = typeof window !== 'undefined' ? window.zhuixun?.backendPort : undefined;
    const port = injectedPort && injectedPort > 0 ? injectedPort : DEFAULT_BACKEND_PORT;
    return `http://localhost:${port}`;
}

export const API_BASE_URL = resolveApiBaseUrl();

/** 仅向 Electron 自己启动的 HTTP 后端发送会话授权凭证。 */
export function desktopApprovalBridge() {
    const bridge = window.zhuixun;
    if (!bridge?.backendPort) return;
    const url = new URL(API_BASE_URL, window.location.href);
    if (
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(url.hostname) &&
        url.port === String(bridge.backendPort)
    )
        return bridge.approval;
}

const AUTH_TOKEN = import.meta.env.VITE_API_AUTH_TOKEN || '';

/** 认证头：仅在配置了 token 时附带。供 SSE / multipart 等不走 request 的原生 fetch 复用。 */
export function authHeaders(): Record<string, string> {
    return AUTH_TOKEN ? { 'x-zhuixun-token': AUTH_TOKEN } : {};
}

/** 请求配置：在 axios 基础上扩展前缀 / 错误提示开关 */
export interface RequestConfig extends AxiosRequestConfig {
    /** 自定义 API 前缀 */
    customPreFix?: string;
    /** 隐藏全局错误提示（默认接口错误由拦截器统一 message.error 提示） */
    hideError?: boolean;
    /** POST / PUT / PATCH 的请求体 */
    data?: unknown;
}

/**
 * 统一请求封装：基于 axios 的 BaseRequest 类，导出 `request` 单例，支持 get/post/put/delete/patch。
 * - 请求拦截：注入本地共享 token、按 customPreFix 改写 URL；
 * - 响应处理：一律 resolve 成 `{ code, data, message }`，业务码非 0 或网络错误时统一 message.error
 *   （可用 hideError 关闭），调用方统一用 `res.code === SUCCESS_CODE` 判定，避免未捕获的 reject。
 */
class BaseRequest {
    private instance: AxiosInstance;

    constructor() {
        this.instance = axios.create({
            baseURL: API_BASE_URL,
            headers: { 'Content-Type': 'application/json' }
        });
        this.instance.interceptors.request.use((config) => {
            const cfg = config as typeof config & RequestConfig;
            for (const [k, v] of Object.entries(authHeaders())) config.headers.set(k, v);
            if (cfg.customPreFix && config.url) config.url = `${cfg.customPreFix}${config.url}`;
            return config;
        });
    }

    private async run<T>(
        exec: Promise<AxiosResponse<BaseResponse<T>>>,
        config?: RequestConfig
    ): Promise<BaseResponse<T>> {
        try {
            const res = await exec;
            const body = res.data;
            if (body?.code !== SUCCESS_CODE && !config?.hideError) {
                staticApi.message?.error(body?.message || '请求失败');
            }
            return body;
        } catch (err) {
            const ae = err as AxiosError<BaseResponse<T>>;
            const envelope: BaseResponse<T> = {
                code: ae.response?.data?.code ?? ae.response?.status ?? -1,
                message: ae.response?.data?.message || ae.message || '请求失败'
            };
            if (!config?.hideError) staticApi.message?.error(envelope.message);
            return envelope;
        }
    }

    get<T>(url: string, config?: RequestConfig): Promise<BaseResponse<T>> {
        return this.run<T>(this.instance.get(url, config), config);
    }

    post<T>(url: string, config?: RequestConfig): Promise<BaseResponse<T>> {
        return this.run<T>(this.instance.post(url, config?.data, config), config);
    }

    put<T>(url: string, config?: RequestConfig): Promise<BaseResponse<T>> {
        return this.run<T>(this.instance.put(url, config?.data, config), config);
    }

    delete<T>(url: string, config?: RequestConfig): Promise<BaseResponse<T>> {
        return this.run<T>(this.instance.delete(url, config), config);
    }

    patch<T>(url: string, config?: RequestConfig): Promise<BaseResponse<T>> {
        return this.run<T>(this.instance.patch(url, config?.data, config), config);
    }
}

const request = new BaseRequest();

export default request;
