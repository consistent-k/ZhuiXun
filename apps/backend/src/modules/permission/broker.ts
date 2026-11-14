import { isDangerouslySkipPermissions } from '@/config/danger-mode';

import type { RememberInput } from './store';
import { getPermissionStore } from './store';

/**
 * 审批策略端口。
 *
 * 改造前这套判定写在 `runner.ts` 的 `buildToolApproval` 里（策略 + 接线混在一起），
 * 现在 agent 只负责把 broker 映射到 AI SDK 的 `toolApproval`，判定与安全底线留在本模块。
 *
 * 注意：「设置 → 命令授权」的自动放行总开关与前端 `ToolApprovalCard` 的逐次确认是两个
 * 独立概念——前者影响这里返回 approved 的范围，后者只在返回 user-approval 时出现。
 */

export type ApprovalDecision = 'approved' | 'user-approval';

export interface ApprovalContext {
    /** 当前会话 id，用于「仅本次会话」范围的规则匹配。 */
    sessionId?: string;
    throwOnError?: boolean;
    /** 信任项目的根集合；仅当项目被用户显式信任时存在。 */
    trust?: { roots: string[] };
}

export interface IPermissionBroker {
    /** 复合命令、危险命令头、异常一律返回 user-approval；信任态同样不放行危险头。 */
    resolveBash(command: string, ctx: ApprovalContext): Promise<ApprovalDecision>;
    /** 相对路径、系统目录、异常一律返回 user-approval；信任态只放行根内路径。 */
    resolveWrite(filePath: string, ctx: ApprovalContext): Promise<ApprovalDecision>;
}

/** 正常模式：查永久规则 + 会话内存 + 信任项目，最终由 permission store 做安全底线判定。 */
interface ApprovalResolver {
    resolveBashApproval(
        command: string,
        sessionId?: string,
        trust?: { roots: string[] },
        throwOnError?: boolean
    ): Promise<ApprovalDecision>;
    resolveWriteApproval(
        filePath: string,
        sessionId?: string,
        trust?: { roots: string[] },
        throwOnError?: boolean
    ): Promise<ApprovalDecision>;
}

class StorePermissionBroker implements IPermissionBroker {
    constructor(private readonly store: ApprovalResolver) {}

    resolveBash(command: string, ctx: ApprovalContext): Promise<ApprovalDecision> {
        return this.store.resolveBashApproval(command, ctx.sessionId, ctx.trust, ctx.throwOnError);
    }

    resolveWrite(filePath: string, ctx: ApprovalContext): Promise<ApprovalDecision> {
        return this.store.resolveWriteApproval(filePath, ctx.sessionId, ctx.trust, ctx.throwOnError);
    }
}

/** 危险跳过模式：全放行（旗标只认服务端启动态，见 config/danger-mode）。 */
class DangerModeBroker implements IPermissionBroker {
    async resolveBash(): Promise<ApprovalDecision> {
        return 'approved';
    }

    async resolveWrite(): Promise<ApprovalDecision> {
        return 'approved';
    }
}

/** 渠道/无审批 UI 场景：恒需确认（调用方据此拒绝执行）。 */
class DenyPermissionBroker implements IPermissionBroker {
    async resolveBash(): Promise<ApprovalDecision> {
        return 'user-approval';
    }

    async resolveWrite(): Promise<ApprovalDecision> {
        return 'user-approval';
    }
}

/** 按服务端启动态选择 broker；危险模式优先级最高。 */
export function createPermissionBroker(
    opts: { dangerMode?: boolean; store?: ApprovalResolver } = {}
): IPermissionBroker {
    if (opts.dangerMode ?? isDangerouslySkipPermissions()) return new DangerModeBroker();
    return new StorePermissionBroker(opts.store ?? getPermissionStore());
}

/** 无审批 UI 的场景（IM 渠道）使用。 */
export function createDenyPermissionBroker(): IPermissionBroker {
    return new DenyPermissionBroker();
}

/** 与本 broker 配套的「记住本次操作」入口，HTTP 路由直接复用。 */
export function rememberPermission(input: RememberInput) {
    return getPermissionStore().remember(input);
}
