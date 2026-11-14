/**
 * 系统提示词的有序拼装器。
 *
 * 改造前这段逻辑散在三处：`agent/context/prompts.ts`（基础人设）、`runner.ts` 的
 * withProject/withMemory/withTasks、以及各模块自己的注入文本。现在统一为：
 *
 *   base（各模式指令）→ 风格 → 项目 → 记忆 → 运行时 → 任务清单
 *
 * 各段由调用方（modules/chat、modules/channels）通过 ContextSection 提供，agent 层不认识
 * 任何具体模块。`order` 越小越靠前：静态段在前、易变段在后，尽量保住 provider 前缀缓存。
 */

export interface AgentContext {
    projectId?: string;
    sessionId?: string;
    /** 最新一条用户消息的纯文本，供记忆按相关性召回。 */
    latestUserText?: string;
    /** 会话/请求解析出的表达风格 id；缺省表示跟随默认。 */
    personaId?: string;
}

export interface ContextSection {
    id: string;
    order: number;
    /** 返回 null / 空串表示本段无内容，不参与拼接。 */
    build(ctx: AgentContext): Promise<string | null>;
}

/** 固定顺序常量，避免各调用方各自魔数。 */
export const SECTION_ORDER = {
    base: 10,
    persona: 15,
    project: 20,
    memory: 30,
    runtime: 40,
    tasks: 50
} as const;

/**
 * 稳定段的 order 上限：base / persona / project 在一个会话内基本不变，可作为 provider 前缀缓存的边界；
 * memory（按本轮问题召回）/ runtime（日期）/ tasks 每轮都可能变化，归为易变段。
 */
export const STABLE_SECTION_MAX_ORDER = SECTION_ORDER.project;

/** 拼装结果：稳定前缀与易变后缀分开，供需要显式缓存断点的 provider 使用。 */
export interface InstructionParts {
    stable: string;
    volatile: string;
}

/**
 * 按 order 拼接所有非空段，并按 {@link STABLE_SECTION_MAX_ORDER} 切成稳定 / 易变两部分。
 * 任何一段抛错只记日志并跳过该段——上下文注入失败不应该让整轮对话不可用。
 */
export async function buildInstructionParts(
    base: string,
    sections: readonly ContextSection[],
    ctx: AgentContext,
    onError?: (section: ContextSection, error: unknown) => void
): Promise<InstructionParts> {
    const stable: string[] = [base];
    const volatile: string[] = [];
    for (const section of [...sections].sort((a, b) => a.order - b.order)) {
        try {
            const text = await section.build(ctx);
            if (!text || !text.trim()) continue;
            (section.order <= STABLE_SECTION_MAX_ORDER ? stable : volatile).push(text);
        } catch (error) {
            onError?.(section, error);
        }
    }
    return { stable: stable.join('\n\n'), volatile: volatile.join('\n\n') };
}

/** 拼成单个字符串（不区分稳定 / 易变段的 provider 使用）。 */
export function joinInstructionParts(parts: InstructionParts): string {
    return [parts.stable, parts.volatile].filter((p, i) => i === 0 || p).join('\n\n');
}

/**
 * 按 order 拼接所有非空段。任何一段抛错只记日志并跳过该段——上下文注入失败不应该
 * 让整轮对话不可用（与改造前各 withXxx 的降级语义一致）。
 */
export async function buildInstructions(
    base: string,
    sections: readonly ContextSection[],
    ctx: AgentContext,
    onError?: (section: ContextSection, error: unknown) => void
): Promise<string> {
    return joinInstructionParts(await buildInstructionParts(base, sections, ctx, onError));
}
