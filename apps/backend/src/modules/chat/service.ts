import { randomUUID } from 'node:crypto';

import type { ApprovalMode, SessionEventSource, SessionTurnOutcome } from '@zhuixun/shared';
import {
    convertToModelMessages,
    createAgentUIStream,
    createUIMessageStream,
    getToolName,
    isToolUIPart,
    type LanguageModelUsage,
    type UIMessage
} from 'ai';
import type { UIMessageChunk } from 'ai';

import {
    createOverflowHandler,
    maybeCompactContext,
    reactiveCompactContext,
    withPreOutputRecovery,
    type CompactionMarker,
    type PreOutputRecoveryHandler
} from '@/agent/compaction';
import type { LoopStopReason } from '@/agent/loop/guard';
import { createRetryHandler, describeModelError } from '@/agent/model/resilience';
import { QuestionValidationError, validateQuestionMessages } from '@/agent/tools/question-validation';
import { activeModel, modelByRef } from '@/config/model';
import type { ResolvedModel } from '@/config/types';
import { normalizeAttachments } from '@/modules/chat/attachments/normalize';
import { expandCommandParts } from '@/modules/chat/commands';
import { withStreamObserver } from '@/modules/chat/stream-observer';
import type { ApprovalTurn, IConversationService, StoredMessage } from '@/modules/conversations';
import { generateConversationTitle, getConversationStore, isValidConversationId } from '@/modules/conversations';
import { createHookRunner } from '@/modules/hooks';
import type { TranscriptMessage } from '@/modules/memory';
import { runMemoryMaintenance } from '@/modules/memory';
import type { ProjectRoot } from '@/modules/projects';
import { getProjectStore, resolveEffectiveRoots } from '@/modules/projects';
import type { SkillRegistry } from '@/modules/skills';
import { createLogger } from '@/platform/logging/index';

import {
    createProgressiveAgent,
    createRoutedAgent,
    createTurnLoopGuard,
    type AgentWorkspace,
    type HistoryMessage
} from './agents/runner';
import { hasDesktopApprovalGrant } from './approval-grants';
import { sessionRuntime } from './session-runtime';
import { TurnMachine } from './turn-machine';
import type { TurnPhase } from './turn-state';

const log = createLogger('Chat');

function assertValidQuestionMessages(messages: UIMessage[]): void {
    try {
        validateQuestionMessages(messages);
    } catch (error) {
        if (error instanceof QuestionValidationError) throw new ChatTurnError(error.status, error.message);
        throw error;
    }
}

/** 一轮对话的输入（已完成 HTTP 层 zod 校验）。 */
export interface ChatTurnInput {
    messages: UIMessage[];
    /** 单次覆盖：`providerName/modelName`；缺省用激活模型。 */
    model?: string;
    agentMode?: 'routed' | 'progressive';
    /** 单次风格覆盖；缺省时会话已存 id，再缺省跟随全局默认。 */
    personaId?: string;
    approvalMode?: ApprovalMode;
    approvalGrant?: string;
    sessionId?: string;
    projectId?: string;
    /**
     * 内部字段（不来自 HTTP）：本轮触发来源。后台唤醒/自驱轮次传 job/goal，
     * 用于会话忙闲登记与唤醒预算重置；缺省按真人输入（user）。
     */
    origin?: SessionEventSource;
    /**
     * 内部字段：是否由 runChatTurn 登记会话忙闲。后台轮次由 background.ts 提前同步登记，
     * 这里传 false 避免重复计数；HTTP 路径缺省 true。
     */
    manageSession?: boolean;
}

export type ChatTurnStream = ReturnType<typeof createUIMessageStream<UIMessage>>;

export interface ChatTurnHandle {
    /** 直接交给 createUIMessageStreamResponse 的 UI 消息流。 */
    stream: ChatTurnStream;
    chatId: string;
    /** 有合法 sessionId 时才录制可恢复流（无会话 id 无法恢复）。 */
    canResume: boolean;
}

/** 带 HTTP 语义的业务错误：路由据此映射状态码，其余异常按 500 处理。 */
export class ChatTurnError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'ChatTurnError';
    }
}

/** 从 file part 派生一个可读标签（用于仅附件消息的标题/内容兜底）。 */
function attachmentLabel(parts: Array<{ type?: string; mediaType?: string; filename?: string }>): string {
    const file = parts.find((p) => p.type === 'file');
    if (!file) return '';
    const isImage = (file.mediaType ?? '').startsWith('image/');
    const name = file.filename ? ` ${file.filename}` : '';
    return isImage ? `[图片]${name}` : `[文件]${name}`;
}

/**
 * usage → 落库/下发形态。
 *
 * 关键：totalTokens 是压缩判阈的基线，必须代表「本轮结束时的上下文大小」。provider 未给 totalTokens 时
 * 用 input+output 兜底；不要用整轮所有 step 的累加（见 stream 的 finish-step 处理）。
 */
function toUsageMetadata(usage: LanguageModelUsage) {
    const { inputTokens, outputTokens, totalTokens, inputTokenDetails } = usage;
    const fallbackTotal =
        inputTokens != null || outputTokens != null ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined;
    return {
        inputTokens,
        outputTokens,
        totalTokens: totalTokens ?? fallbackTotal,
        cachedInputTokens: inputTokenDetails?.cacheReadTokens,
        cacheWriteTokens: inputTokenDetails?.cacheWriteTokens
    };
}

/** UIMessage[] → 落库结构：抽出文本、透明保留 parts，丢弃无内容/无工具/无附件的消息 */
function toStoredMessages(messages: UIMessage[]): StoredMessage[] {
    return messages
        .map((msg) => {
            const parts = (msg.parts ?? []) as Array<{
                type?: string;
                text?: string;
                mediaType?: string;
                filename?: string;
            }>;
            const text = parts
                .filter((p) => p.type === 'text')
                .map((p) => p.text ?? '')
                .join('');
            const hasTool = parts.some(
                (p) => typeof p.type === 'string' && (p.type.startsWith('tool-') || p.type === 'dynamic-tool')
            );
            const hasFile = parts.some((p) => p.type === 'file');
            // 仅附件（无文本）消息：content 兜底为附件标签，避免落库后气泡/标题为空
            const content = text || (hasFile ? attachmentLabel(parts) : '');
            return {
                id: msg.id,
                role: msg.role === 'assistant' ? ('assistant' as const) : ('user' as const),
                content,
                parts: msg.parts as unknown[],
                // 透传 metadata（含本轮最后一步 usage），供历史会话还原 token 用量展示
                metadata: msg.metadata,
                timestamp: Date.now(),
                _keep: content.length > 0 || hasTool || hasFile
            };
        })
        .filter((m) => m._keep)
        .map(({ _keep, ...m }) => m);
}

/** 取最新一条用户消息的纯文本（供记忆召回按当前问题挑相关条目）。 */
function extractLatestUserText(messages: UIMessage[], latestOnly = false): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'user') continue;
        const parts = (msg.parts ?? []) as Array<{ type?: string; text?: string }>;
        const text = parts
            .filter((p) => p.type === 'text')
            .map((p) => p.text ?? '')
            .join('')
            .trim();
        if (text || latestOnly) return text || undefined;
    }
    return undefined;
}

/** 最近一条用户消息的 id，作为文件检查点的「用户轮」key（回滚以此消息为边界）。 */
function extractLatestUserMessageId(messages: UIMessage[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') return messages[i]?.id;
    }
    return undefined;
}

/** 近 N 条消息转为抽取用的纯文本转写（丢弃无文本消息）。 */
function toTranscript(messages: UIMessage[], limit = 12): TranscriptMessage[] {
    return messages
        .slice(-limit)
        .map((m) => {
            const parts = (m.parts ?? []) as Array<{ type?: string; text?: string }>;
            const content = parts
                .filter((p) => p.type === 'text')
                .map((p) => p.text ?? '')
                .join('')
                .trim();
            return { role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content };
        })
        .filter((m) => m.content.length > 0);
}

/**
 * 落库前合并：以原始（引用式、全量）历史为底，追加本轮模型新产出的消息（新 id）。
 * 关键点：
 * 1) 归一化会把附件展开成 base64；用原始消息保证落库是引用式，不撑大会话文件。
 * 2) 上下文自动压缩后，喂给模型的是「摘要 + 近期消息」，finalMessages 不含被摘要的早期消息；
 *    这里以原始全量 uiMessages 为底，保证磁盘与界面始终保留完整历史（非破坏式压缩）。
 */
function mergeOriginalParts(original: UIMessage[], final: UIMessage[]): UIMessage[] {
    const origIds = new Set(original.filter((m) => m.id).map((m) => m.id));
    const appended = final.filter((m) => !(m.id && origIds.has(m.id)));
    // SDK 续跑可能沿用最后一条 assistant id；不能因为 id 已存在就丢掉本轮新工具调用。
    const finalById = new Map(final.map((m) => [m.id, m]));
    return [...original.map((m) => (m.role === 'assistant' ? (finalById.get(m.id) ?? m) : m)), ...appended];
}

/**
 * 落库一轮会话：`appendMessages` 内部串行 + 按 id 合并，起始 user 与 onEnd assistant
 * 两次并发调用不会互相覆盖（旧实现是队列外读 + 整单覆盖，存在覆盖风险）。
 * 幂等、best-effort，失败不影响流式；问题答案也走既有会话保存，不要求独立 ACK。
 */
async function persistTurn(
    store: IConversationService,
    chatId: string,
    messages: UIMessage[],
    ctx: { projectId?: string; roots?: ProjectRoot[]; personaId?: string; approvalTurn?: ApprovalTurn },
    requireSave = false
): Promise<void> {
    if (!isValidConversationId(chatId)) return;
    const stored = toStoredMessages(messages);
    if (stored.length === 0) return;
    try {
        await store.appendMessages(chatId, stored, {
            projectId: ctx.projectId,
            roots: ctx.roots,
            personaId: ctx.personaId,
            approvalTurn: ctx.approvalTurn
        });
    } catch (err) {
        if (requireSave) throw err;
        log.warn('服务端落库失败（忽略，前端仍会落库）', { chatId, err });
    }
}

/**
 * 首轮会话标题生成（并发、不阻塞流式）：仅当会话尚无 AI 标题且处于首轮（无 assistant 消息）时，
 * 用激活模型总结首条用户消息，落库为权威标题（`updateTitle` 置 titleAuto 锁），
 * 并在生成成功时回调上报，供流末 finish metadata 即时下发前端。
 * best-effort：任何失败都忽略，标题沿用派生值。
 */
async function maybeGenerateFirstTurnTitle(
    store: IConversationService,
    chatId: string,
    messages: UIMessage[],
    model: ResolvedModel,
    onTitle: (title: string) => void
): Promise<void> {
    try {
        const firstUser = toStoredMessages(messages).find((m) => m.role === 'user')?.content;
        if (!firstUser) return;
        const existing = await store.get(chatId);
        const hasAssistant = (existing?.messages ?? []).some((m) => m.role === 'assistant');
        if (existing?.titleAuto || hasAssistant) return; // 已 AI 命名或非首轮
        const title = await generateConversationTitle(firstUser, model);
        if (!title) return;
        onTitle(title);
        await store.updateTitle(chatId, title, { auto: true });
    } catch (err) {
        log.warn('首轮标题生成失败（忽略）', { chatId, err });
    }
}

/**
 * 本轮停止原因（写入 finish metadata，前端据此提示「继续」/「重试」）：
 * 护栏截停优先；否则流出错记为 error；正常结束不写。
 */
function resolveStopReason(guard: LoopStopReason | undefined, failed: boolean): LoopStopReason | 'error' | undefined {
    return guard ?? (failed ? 'error' : undefined);
}

/** 解析模型：请求指定引用优先，否则用激活模型；密钥始终留在后端。 */
function resolveModel(ref?: string): ResolvedModel {
    const config = ref ? modelByRef(ref) : activeModel();
    if (!config || !config.apiKey) {
        throw new ChatTurnError(
            400,
            ref
                ? `模型引用无效或未配置密钥：${ref}`
                : '未配置激活模型，请先在「设置 → 模型配置」中添加 provider 并选择激活模型'
        );
    }
    return config;
}

/**
 * 执行一轮对话。
 *
 * 顺序（由 TurnMachine 保证）：
 *   preparing（模型/项目/工作区）→ starting（落 user + 启动标题）→ compacting → streaming
 *   → finalizing（落 assistant + 记忆维护）→ completed。
 * 失败在任意阶段进入 failed；已发生的落库不回滚。
 */
export async function runChatTurn(
    input: ChatTurnInput,
    registry: SkillRegistry | undefined,
    signal?: AbortSignal
): Promise<ChatTurnHandle> {
    if (!registry) throw new ChatTurnError(503, '服务尚未就绪（技能注册表未初始化）');

    const machine = new TurnMachine();
    const { agentMode, sessionId, projectId } = input;
    let { messages } = input;
    const store = getConversationStore();
    // 会话忙闲收尾（try 内按 chatId 赋值；catch 也要能调用）。
    let endSession: (outcome: SessionTurnOutcome) => void = () => {};

    try {
        // ---------- preparing ----------
        assertValidQuestionMessages(messages);
        const sessionConv = sessionId && isValidConversationId(sessionId) ? await store.get(sessionId) : null;
        const turnId = extractLatestUserMessageId(messages);
        const latest = messages.at(-1);
        const saved = sessionConv?.messages?.at(-1);
        const stepStart = latest?.parts?.map((part) => part.type).lastIndexOf('step-start') ?? -1;
        const submitted =
            latest?.role === 'assistant'
                ? (latest.parts ?? [])
                      .slice(stepStart + 1)
                      .filter(isToolUIPart)
                      .filter(
                          (part) =>
                              part.state === 'approval-responded' ||
                              (getToolName(part) === 'askUserQuestion' && part.state === 'output-available')
                      )
                : [];
        const submittedById = new Map(submitted.map((part) => [part.toolCallId, part]));
        const continuing = submitted.length > 0;

        if (continuing) {
            const savedTurnId = sessionConv?.messages?.filter((msg) => msg.role === 'user').at(-1)?.id;
            if (
                !saved ||
                saved.role !== 'assistant' ||
                saved.id !== latest?.id ||
                savedTurnId !== turnId ||
                submittedById.size !== submitted.length
            ) {
                throw new ChatTurnError(409, '会话交互已更新，请重新打开会话');
            }
            const pending =
                sessionConv?.approvalTurn?.turnId === turnId ? sessionConv?.approvalTurn?.pending : undefined;
            // 会话整单写入接口可编辑历史。工具批准只认流结束时由服务端登记的待执行快照。
            if (
                (!pending || pending.id !== saved.id) &&
                submitted.some((part) => part.state === 'approval-responded')
            ) {
                throw new ChatTurnError(409, '待审批工具已失效，请重新发起请求');
            }
            const savedParts = ((pending?.id === saved.id ? pending.parts : saved.parts) ?? []) as UIMessage['parts'];
            const savedStep = savedParts.map((part) => part.type).lastIndexOf('step-start');
            // SDK 会执行续跑消息中的已批准调用。入参和工具名必须使用服务端保存的快照。
            const parts = savedParts.map((part, index): UIMessage['parts'][number] => {
                if (index <= savedStep || !isToolUIPart(part)) return part;
                const response = submittedById.get(part.toolCallId);
                if (!response) return part;
                submittedById.delete(part.toolCallId);
                if (
                    part.state === 'approval-requested' &&
                    response.state === 'approval-responded' &&
                    part.approval.id === response.approval?.id &&
                    typeof response.approval.approved === 'boolean'
                ) {
                    return {
                        ...part,
                        state: 'approval-responded',
                        approval: {
                            ...part.approval,
                            approved: response.approval.approved
                        }
                    };
                }
                if (
                    part.state === 'input-available' &&
                    getToolName(part) === 'askUserQuestion' &&
                    response.state === 'output-available' &&
                    getToolName(response) === 'askUserQuestion'
                ) {
                    return { ...part, state: 'output-available', output: response.output };
                }
                throw new ChatTurnError(409, '会话交互已更新，请重新打开会话');
            });
            if (submittedById.size) throw new ChatTurnError(409, '会话交互已更新，请重新打开会话');
            messages = [...messages.slice(0, -1), { ...latest, parts }];
            assertValidQuestionMessages(messages);
        } else if (
            latest?.role === 'assistant' &&
            latest.parts?.some(
                (part) =>
                    isToolUIPart(part) && (part.state === 'approval-requested' || part.approval?.approved === true)
            )
        ) {
            throw new ChatTurnError(409, '待审批工具已失效，请重新发起请求');
        }

        // 续跑只认服务端记录。旧会话没有记录时按默认审批处理。
        const approvalMode = continuing
            ? sessionConv?.approvalTurn?.turnId === turnId
                ? sessionConv?.approvalTurn?.mode
                : undefined
            : input.approvalMode;
        if (approvalMode === 'full-access' && (!turnId || !hasDesktopApprovalGrant(sessionId, input.approvalGrant))) {
            throw new ChatTurnError(403, '完全访问授权无效或已失效，请在桌面端重新授权后发起新一轮');
        }
        const approvalTurn: ApprovalTurn | undefined = turnId ? { turnId, mode: approvalMode ?? 'ask' } : undefined;
        const config = resolveModel(input.model);
        const project = projectId ? await getProjectStore().get(projectId) : null;
        // slash 命令展开只作用于喂模型的副本，落库保留用户原文。
        const expandedMessages = await expandCommandParts(messages);
        const latestUserText = extractLatestUserText(expandedMessages);
        const sourceRoots = sessionConv?.roots ?? project?.roots;
        const personaId = input.personaId ?? sessionConv?.personaId;
        const resolvedRoots = await resolveEffectiveRoots(sourceRoots);
        const workspace: AgentWorkspace = {
            primaryDir: resolvedRoots.primaryDir,
            additionalDirs: resolvedRoots.additionalDirs,
            warnings: resolvedRoots.warnings,
            trusted: project?.trusted,
            // 已冻结的主根必须仍在当前可信项目的根集合内，移动项目后不沿用旧根做自动审查。
            ...(approvalMode === 'auto-review' &&
            project?.trusted &&
            project.roots?.some((root) => root.path === resolvedRoots.primaryDir)
                ? { reviewRoot: resolvedRoots.primaryDir }
                : {})
        };

        const uiMessages = messages;
        const canResume = !!sessionId && isValidConversationId(sessionId);
        const chatId = sessionId && canResume ? sessionId : randomUUID();

        // 会话忙闲登记（供后台唤醒/自驱判断「该会话是否正在跑」）。后台路径由 background.ts 提前登记，
        // 这里传 manageSession:false 跳过；没有合法会话 id 的草稿轮无从唤醒，也不登记。
        const origin: SessionEventSource = input.origin ?? 'user';
        const trackSession = canResume && input.manageSession !== false;
        let sessionEnded = false;
        endSession = (outcome: SessionTurnOutcome) => {
            if (!trackSession || sessionEnded) return;
            sessionEnded = true;
            sessionRuntime.endTurn(chatId, origin, outcome);
        };
        if (trackSession) sessionRuntime.beginTurn(chatId, origin);

        let aiTitle: string | undefined;

        // ---------- starting ----------
        machine.start(chatId);

        // 附件归一化：远端 provider 取不到 localhost，调模型前展开为内联字节；原始消息仍用于落库。
        const modelMessages = await normalizeAttachments(expandedMessages);

        // 请求起始先落一次（含本轮 user 消息），刷新时能看到用户气泡。
        // 普通消息的起始写入由会话存储队列排序。交互续跑先消费待处理状态，再执行工具。
        if (canResume) {
            const initialSave = persistTurn(
                store,
                chatId,
                uiMessages,
                { projectId, roots: sourceRoots, personaId, approvalTurn },
                continuing
            );
            if (latest?.role === 'assistant') await initialSave;
        }

        // 首轮标题与主回答流并发生成，不阻塞流式。
        if (canResume) {
            void maybeGenerateFirstTurnTitle(store, chatId, expandedMessages, config, (t) => {
                aiTitle = t;
            });
        }

        // 失败如实回显：完整堆栈留服务端日志；限流/鉴权/模型不存在等归类为可读提示（附原始原因便于排查）。
        let streamFailed = false;
        // 只做格式化、无副作用：AI SDK 的 toUIMessageStream 也用它为每个 tool-error 生成 errorText，
        // 工具出错（如未知工具名、参数校验失败）会作为 output-error 交回模型继续处理，不代表本轮失败。
        const toClientError = (error: unknown) => {
            const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            const friendly = describeModelError(error);
            return friendly ? `${friendly}\n（原因：${raw}）` : raw;
        };
        // 真正的整轮失败只有两种：模型流里的 error part（由 withStreamObserver 识别）、execute/合流抛错（外层 onError）。
        const failTurn = (error: unknown) => {
            streamFailed = true;
            log.error('流式执行出错', { err: error });
            machine.fail(error);
        };
        const loopGuard = createTurnLoopGuard();
        // 每轮一个 hook 运行器：每次执行都重读配置与信任状态，hooks.json 被改后立即停止执行
        const hooks = createHookRunner({ sessionId: chatId, projectId, cwd: workspace.primaryDir });

        const stream = createUIMessageStream<UIMessage>({
            execute: async ({ writer }) => {
                let streamMessages = modelMessages;
                let compactionMarker: CompactionMarker | undefined;

                // ---------- compacting ----------
                machine.to('compacting');
                if (canResume) {
                    try {
                        const outcome = await maybeCompactContext({
                            store,
                            sessionId: chatId,
                            messages: modelMessages,
                            model: config,
                            onCompacting: () =>
                                writer.write({
                                    type: 'data-compaction',
                                    data: { phase: 'start' },
                                    transient: true
                                })
                        });
                        streamMessages = outcome.modelInput;
                        compactionMarker = outcome.marker;
                    } catch (err) {
                        log.warn('上下文压缩失败（忽略，使用全量历史）', { err });
                    }
                    if (compactionMarker) {
                        writer.write({
                            type: 'data-compaction',
                            data: { phase: 'done', ...compactionMarker },
                            transient: true
                        });
                    }
                }

                // ---------- streaming ----------
                machine.to('streaming');
                const runtime = {
                    loopGuard,
                    hooks,
                    approvalMode,
                    // 只审查本轮用户原文。无文本的请求不会沿用上一轮的授权，slash 展开也不算授权。
                    approvalRequest:
                        approvalMode === 'auto-review' ? extractLatestUserText(uiMessages, true) : undefined,
                    signal
                };
                const agent =
                    agentMode === 'progressive'
                        ? await createProgressiveAgent(
                              registry,
                              config,
                              registry.getMCPAdapter(),
                              registry.getMCPDiscovery(),
                              sessionId,
                              projectId,
                              workspace,
                              // 工具审批后续跑时据此预挂载历史里已动态加载过的技能/MCP 工具
                              messages as HistoryMessage[],
                              latestUserText,
                              turnId,
                              personaId,
                              runtime
                          )
                        : await createRoutedAgent(
                              registry,
                              config,
                              registry.getMCPAdapter(),
                              sessionId,
                              projectId,
                              project?.skillPreset,
                              workspace,
                              latestUserText,
                              turnId,
                              personaId,
                              runtime
                          );

                // 首输出前错误恢复链（重试复用同一 agent 实例）：
                // 1) 超窗 → 用更激进的检查点重压一次再重试（仅合法会话，需读写检查点）；
                // 2) 限流/过载/断连 → 退避重试，期间下发瞬态 data-retry 供前端展示「正在重试」。
                const handlers: PreOutputRecoveryHandler[] = [];
                if (canResume) {
                    handlers.push(
                        createOverflowHandler(async (options) => {
                            try {
                                const outcome = await reactiveCompactContext({
                                    store,
                                    sessionId: chatId,
                                    messages: modelMessages,
                                    model: config,
                                    onCompacting: () =>
                                        writer.write({
                                            type: 'data-compaction',
                                            data: { phase: 'start' },
                                            transient: true
                                        })
                                });
                                if (!outcome.changed) return null;
                                streamMessages = outcome.modelInput;
                                if (outcome.marker) {
                                    compactionMarker = outcome.marker;
                                    writer.write({
                                        type: 'data-compaction',
                                        data: { phase: 'done', ...outcome.marker },
                                        transient: true
                                    });
                                }
                                const prompt = await convertToModelMessages(outcome.modelInput, {
                                    tools: agent.tools
                                });
                                const nextOptions = { ...options, prompt };
                                const retried = await agent.stream(nextOptions as Parameters<typeof agent.stream>[0]);
                                return { stream: retried.stream, options: nextOptions };
                            } catch (err) {
                                log.warn('上下文超限后的反应式压缩失败', { err });
                                return null;
                            }
                        })
                    );
                }
                handlers.push(
                    createRetryHandler({
                        onRetry: (event) => {
                            log.warn('模型请求失败，准备重试', { chatId, ...event });
                            writer.write({ type: 'data-retry', data: { phase: 'start', ...event }, transient: true });
                        },
                        onRecovered: () =>
                            writer.write({ type: 'data-retry', data: { phase: 'done' }, transient: true })
                    })
                );
                // 观察放在恢复层外：已被重试恢复的首输出前错误不会到这里，只看到最终下发的 part。
                const reactiveAgent = withStreamObserver(withPreOutputRecovery(agent, handlers), (part) => {
                    if (part.type === 'error') {
                        failTurn(part.error);
                    } else if (part.type === 'tool-error') {
                        log.warn('工具调用出错，错误已交回模型', {
                            chatId,
                            toolName: part.toolName,
                            toolCallId: part.toolCallId,
                            err: part.error
                        });
                    }
                });

                // 只记录最后一步的 usage：它才代表本轮结束时的上下文大小。
                // finish.totalUsage 是所有 step 的累加，多步工具轮会重复计算输入，不能用作压缩判阈基线。
                let lastStepUsage: LanguageModelUsage | undefined;

                const agentStream = await createAgentUIStream({
                    agent: reactiveAgent,
                    uiMessages: streamMessages,
                    // 请求中止必须传至模型流；仅接收 signal 而不转交会让断开后的生成继续消耗资源。
                    abortSignal: signal,
                    messageMetadata: ({ part }) => {
                        if (part.type === 'finish-step') {
                            lastStepUsage = part.usage;
                            return undefined;
                        }
                        if (part.type === 'finish') {
                            const stopReason = resolveStopReason(loopGuard.state.stopReason, streamFailed);
                            if (loopGuard.state.stopReason) {
                                log.info('工具循环护栏截停', { chatId, ...loopGuard.state });
                            }
                            return {
                                usage: toUsageMetadata(lastStepUsage ?? part.totalUsage),
                                ...(aiTitle ? { title: aiTitle } : {}),
                                ...(compactionMarker ? { compaction: compactionMarker } : {}),
                                ...(stopReason ? { stopReason, steps: loopGuard.state.steps } : {})
                            };
                        }
                        return undefined;
                    },
                    generateMessageId: () => randomUUID(),
                    // 轮结束（含审批暂停、出错、中断）落库：客户端已离开也不丢回复。
                    onEnd: canResume
                        ? async ({ messages: finalMessages, isAborted }) => {
                              // SDK 在 abort part 后仍调用 onEnd，保留部分回复，但不能记成 completed。
                              if (isAborted && machine.phase === 'streaming') machine.abort();
                              const merged = mergeOriginalParts(uiMessages, finalMessages);
                              // 出错/中止时 onError 可能已把状态推进到终态；此时仍要落库，但不再迁移。
                              if (machine.phase === 'streaming' || machine.phase === 'compacting') {
                                  machine.to('finalizing');
                              }
                              const lastMessage = merged.at(-1);
                              const pending =
                                  lastMessage?.role === 'assistant' &&
                                  lastMessage.parts.some(
                                      (part) =>
                                          isToolUIPart(part) &&
                                          (part.state === 'approval-requested' ||
                                              (getToolName(part) === 'askUserQuestion' &&
                                                  part.state === 'input-available'))
                                  )
                                      ? { id: lastMessage.id, parts: lastMessage.parts }
                                      : undefined;
                              await persistTurn(store, chatId, merged, {
                                  projectId,
                                  roots: sourceRoots,
                                  personaId,
                                  approvalTurn: approvalTurn ? { ...approvalTurn, pending } : undefined
                              });
                              void runMemoryMaintenance({
                                  transcript: toTranscript(merged),
                                  projectId,
                                  sessionId: chatId
                              }).catch((err) => {
                                  // 维护是后台 best-effort，拒绝必须被观察，不能成为未处理 Promise。
                                  log.warn('记忆维护失败（忽略）', { chatId, err });
                              });
                              if (machine.phase === 'finalizing') machine.to('completed');
                              // Stop hooks：fire-and-forget，仅通知 / 记录，不阻止结束
                              void hooks
                                  .stop({
                                      stopReason: resolveStopReason(loopGuard.state.stopReason, streamFailed),
                                      lastAssistantText: lastAssistantText(merged)
                                  })
                                  .catch((err) => log.warn('Stop hooks 执行失败（忽略）', { chatId, err }));
                              // 会话忙闲收尾：onEnd 在正常结束、出错与中断时都会触发（含客户端断开）。
                              endSession(isAborted ? 'aborted' : streamFailed ? 'failed' : 'completed');
                          }
                        : undefined,
                    onError: toClientError
                });
                writer.merge(agentStream as unknown as ReadableStream<UIMessageChunk>);
            },
            onError: (error) => {
                failTurn(error);
                endSession('failed');
                return toClientError(error);
            }
        });

        return { stream, chatId, canResume };
    } catch (error) {
        machine.fail(error);
        endSession('failed');
        throw error;
    }
}

/** 取最后一条 assistant 消息的文本（Stop hooks 输入）。 */
function lastAssistantText(messages: UIMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role !== 'assistant') continue;
        return message.parts
            .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
            .map((p) => p.text)
            .join('\n');
    }
    return '';
}

/** 供路由使用的阶段快照（诊断/日志，不参与业务）。 */
export function turnPhaseOf(machine: TurnMachine): TurnPhase {
    return machine.phase;
}
