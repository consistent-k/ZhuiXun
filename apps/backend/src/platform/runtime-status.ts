import { randomUUID } from 'node:crypto';

import dayjs from 'dayjs';

/**
 * 服务运行时状态。
 *
 * 背景：此前 MCP 连接失败、技能扫描失败都只 console.error 后继续启动，
 * /health 永远返回 ok，外部无法感知服务其实处于降级状态。
 *
 * 改造后不再是模块级可变单例：`bootstrap/services.ts` 在初始化时创建一份实例放进
 * ServiceContainer，/health 通过容器读取。这样测试可以注入独立状态，也不存在
 * 「谁先 import 谁就拿到旧值」的问题。
 */

export type McpStatus = 'ok' | 'degraded' | 'failed' | 'unknown';

export interface RuntimeStatus {
    ready: boolean;
    mcp: McpStatus;
    mcpError?: string;
    skills: number;
    startedAt: string;
    instanceId?: string;
    /** 是否处于危险跳过审批模式（--dangerously-skip-permissions），供 /health 透出、前端警示 */
    dangerSkipPermissions: boolean;
}

export function createRuntimeStatus(): RuntimeStatus {
    return {
        ready: false,
        mcp: 'unknown',
        skills: 0,
        startedAt: dayjs().toISOString(),
        instanceId: randomUUID(),
        dangerSkipPermissions: false
    };
}
