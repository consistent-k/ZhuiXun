import { fileURLToPath } from 'node:url';

import type { AskUserQuestionInput, AskUserQuestionOutput } from '@zhuixun/shared';
import type { AbstractChat, UIMessage } from 'ai';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QuestionDraft } from '../../../desktop/src/pages/home/components/AskQuestionCard/model';
import type { Message } from '../../../desktop/src/types/chat';

// 只声明动态导入边界，避免后端 tsconfig 解析 desktop store 内部的 @ 别名。
interface Registry {
    acquire(id: string): AbstractChat<UIMessage>;
    dispose(id: string): void;
    answerQuestion(id: string, callId: string, value: AskUserQuestionOutput): Promise<void>;
    resumeActive(): Promise<void>;
}
interface TestState {
    conversations: Array<{ id: string; title: string; createdAt: number; updatedAt: number }>;
    messagesById: Record<string, Message[]>;
    currentConversationId: string | null;
    questionDraftsByConversation: Record<string, Record<string, QuestionDraft>>;
    setQuestionDraft(id: string, key: string, draft: QuestionDraft): void;
    pruneQuestionState(id: string, messages: Message[]): void;
    setCurrentConversation(id: string): void;
    deleteConversation(id: string): void;
    clearAll(): void;
}
interface Store {
    setState(value: Partial<TestState>): void;
    getState(): TestState;
}
const desktopSrc = fileURLToPath(new URL('../../../desktop/src/', import.meta.url));
const input: AskUserQuestionInput = {
    questions: [
        {
            question: '选择方案',
            header: '方案',
            options: [
                { label: '甲', description: '方案甲' },
                { label: '乙', description: '方案乙' }
            ]
        }
    ]
};
const output: AskUserQuestionOutput = {
    answers: [{ questionIndex: 0, question: '选择方案', selectedOptions: ['甲'] }]
};
const key = JSON.stringify(['question-message', 'question-call']);

function messages(): Message[] {
    return [
        {
            id: 'question-message',
            role: 'assistant',
            content: '',
            timestamp: 1,
            parts: [
                { type: 'step-start' },
                { type: 'tool-askUserQuestion', toolCallId: 'question-call', state: 'input-available', input },
                { type: 'tool-askUserQuestion', toolCallId: 'second-call', state: 'input-available', input }
            ]
        }
    ];
}

function sse(chunks: unknown[]) {
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' }
    });
}

const cleanup: Array<() => void> = [];
afterEach(() => {
    cleanup.splice(0).forEach((dispose) => dispose());
    vi.unstubAllGlobals();
});

async function harness(seed = messages()) {
    const services = {
        fetchConversationApi: vi.fn(async () => ({ code: 0, data: { messages: structuredClone(seed) } })),
        fetchActiveStreamsApi: vi.fn(async () => ({ code: 0, data: { ids: [] as string[] } })),
        fetchConversationsApi: vi.fn(async () => ({ code: 0, data: [] })),
        saveConversationApi: vi.fn(async () => ({ code: 0 })),
        deleteConversationApi: vi.fn(async () => ({ code: 0 })),
        clearConversationsApi: vi.fn(async () => ({ code: 0 })),
        moveConversationApi: vi.fn(async () => ({ code: 0 })),
        renameConversationApi: vi.fn(async () => ({ code: 0 })),
        setConversationPersonaApi: vi.fn(async () => ({ code: 0 }))
    };
    const globalKey = `__questionRegistryTest${crypto.randomUUID()}`;
    Object.assign(globalThis, { [globalKey]: services });
    cleanup.push(() => Reflect.deleteProperty(globalThis, globalKey));
    const bundled = await build({
        stdin: {
            contents: `export { chatRegistry } from './stores/chatRegistry'; export { useChatStore } from './stores/chatStore';`,
            resolveDir: desktopSrc,
            loader: 'ts'
        },
        bundle: true,
        write: false,
        platform: 'node',
        format: 'esm',
        alias: { '@': desktopSrc },
        plugins: [
            {
                name: 'isolated-services',
                setup(builder) {
                    builder.onResolve(
                        { filter: /^(?:@\/services|@\/utils\/request|\.\/appConfigStore|\.\/projectStore)$/ },
                        (args) => ({ path: args.path, namespace: 'question-test' })
                    );
                    builder.onLoad({ filter: /.*/, namespace: 'question-test' }, (args) => ({
                        contents:
                            args.path === '@/services'
                                ? `const services = globalThis[${JSON.stringify(globalKey)}];\n` +
                                  Object.keys(services)
                                      .map((name) => `export const ${name} = (...args) => services.${name}(...args);`)
                                      .join('\n')
                                : args.path === '@/utils/request'
                                  ? `export const API_BASE_URL = 'http://question-test.invalid'; export const authHeaders = () => ({}); export const desktopApprovalBridge = () => undefined;`
                                  : args.path === './appConfigStore'
                                    ? `export const useAppConfigStore = {getState: () => ({defaultAgentMode: 'routed'})};`
                                    : `export const useProjectStore = {getState: () => ({currentProjectId: null})};`,
                        loader: 'js'
                    }));
                }
            }
        ]
    });
    // SDK、Zustand 和 registry 均使用真实实现，只隔离 HTTP 边界及无关配置。
    const url = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString('base64')}`;
    const { chatRegistry: registry, useChatStore: store } = (await import(/* @vite-ignore */ url)) as {
        chatRegistry: Registry;
        useChatStore: Store;
    };
    store.setState({
        conversations: ['a', 'b'].map((id) => ({ id, title: id, createdAt: 1, updatedAt: 1 })),
        messagesById: { a: structuredClone(seed), b: structuredClone(seed) },
        currentConversationId: 'a'
    });
    const fetchFake = vi.fn<typeof fetch>(async () => {
        throw new Error('本用例不应发送 HTTP 请求');
    });
    vi.stubGlobal('fetch', fetchFake);
    cleanup.push(() => ['a', 'b'].forEach((id) => registry.dispose(id)));
    return { registry, store, services, fetchFake };
}

describe('真实 question registry/store 流程', () => {
    it('切到另一会话后仍只回填绑定会话，未答并行题阻止自动 POST', async () => {
        const h = await harness();
        const bound = h.registry.acquire('a');
        const other = h.registry.acquire('b');
        h.store.getState().setCurrentConversation('b');

        await h.registry.answerQuestion('a', 'question-call', output);

        expect(bound.messages[0]!.parts[1]).toMatchObject({ state: 'output-available', output });
        expect(bound.messages[0]!.parts[2]).toHaveProperty('state', 'input-available');
        expect(other.messages[0]!.parts[1]).toHaveProperty('state', 'input-available');
        expect(h.fetchFake).not.toHaveBeenCalled();
    });

    it('重复回答、已过轮次和已删除会话不能再次回填', async () => {
        const h = await harness();
        const chat = h.registry.acquire('a');
        const addToolOutput = vi.spyOn(chat, 'addToolOutput');
        await h.registry.answerQuestion('a', 'question-call', output);
        await expect(h.registry.answerQuestion('a', 'question-call', output)).rejects.toThrow();

        chat.messages = [...chat.messages, { id: 'new-user', role: 'user', parts: [{ type: 'text', text: '下一轮' }] }];
        await expect(h.registry.answerQuestion('a', 'second-call', output)).rejects.toThrow();
        h.store.getState().deleteConversation('a');
        await expect(h.registry.answerQuestion('a', 'second-call', output)).rejects.toThrow();

        expect(addToolOutput).toHaveBeenCalledTimes(1);
        expect(h.fetchFake).not.toHaveBeenCalled();
    });

    it('答案不完整或调用输入已失效时不回填 SDK', async () => {
        const h = await harness();
        const chat = h.registry.acquire('a');
        const addToolOutput = vi.spyOn(chat, 'addToolOutput');
        await expect(h.registry.answerQuestion('a', 'question-call', { answers: [] })).rejects.toThrow();
        chat.messages = [
            {
                id: 'question-message',
                role: 'assistant',
                parts: [
                    {
                        type: 'tool-askUserQuestion',
                        toolCallId: 'question-call',
                        state: 'input-available',
                        input: { question: '旧版问题', options: ['甲', '乙'] }
                    }
                ]
            }
        ];
        await expect(h.registry.answerQuestion('a', 'question-call', output)).rejects.toThrow();
        expect(addToolOutput).not.toHaveBeenCalled();
        expect(h.fetchFake).not.toHaveBeenCalled();
    });

    it('草稿按会话保留，调用移除、删除会话及清空时各自清理', async () => {
        const h = await harness();
        const draft: QuestionDraft = {
            inputFingerprint: 'fingerprint',
            currentQuestion: 0,
            values: { answers: [{ selectedOptionIndexes: [], otherSelected: true, customText: '草稿' }] }
        };
        const removedKey = JSON.stringify(['question-message', 'removed-call']);
        h.store.getState().setQuestionDraft('a', key, draft);
        h.store.getState().setQuestionDraft('a', removedKey, draft);
        h.store.getState().setQuestionDraft('b', key, { ...draft, currentQuestion: 0 });
        h.registry.acquire('a');
        h.store.getState().setCurrentConversation('b');
        h.registry.dispose('a');
        expect(h.store.getState().questionDraftsByConversation.a?.[key]).toEqual(draft);

        h.store.getState().pruneQuestionState('a', messages());
        expect(h.store.getState().questionDraftsByConversation.a).toEqual({ [key]: draft });
        h.store.getState().deleteConversation('a');
        expect(h.store.getState().questionDraftsByConversation.a).toBeUndefined();
        expect(h.store.getState().questionDraftsByConversation.b?.[key]).toEqual(draft);
        h.store.getState().clearAll();
        expect(h.store.getState().questionDraftsByConversation).toEqual({});
    });

    it('SSE replay 收到完整答案只恢复显示，不自动 POST 续跑', async () => {
        const seed = messages();
        seed[0]!.parts.pop();
        const h = await harness(seed);
        h.services.fetchActiveStreamsApi.mockResolvedValue({ code: 0, data: { ids: ['a'] } });
        h.fetchFake.mockImplementation(async (_url, init) => {
            expect(init?.method).toBe('GET');
            return sse([
                { type: 'start', messageId: 'question-message' },
                { type: 'start-step' },
                { type: 'tool-input-available', toolCallId: 'question-call', toolName: 'askUserQuestion', input },
                { type: 'tool-output-available', toolCallId: 'question-call', output },
                { type: 'finish-step' },
                { type: 'finish' }
            ]);
        });

        await h.registry.resumeActive();
        const chat = h.registry.acquire('a');
        await vi.waitFor(() => {
            expect(chat.messages[0]!.parts[1]).toMatchObject({ state: 'output-available', output });
            expect(chat.status).toBe('ready');
        });
        expect(h.fetchFake).toHaveBeenCalledTimes(1);
        expect(String(h.fetchFake.mock.calls[0]![0])).toBe('http://question-test.invalid/api/chat/stream/a/stream');
        expect(chat.error).toBeUndefined();
        // seed 已在 store 中，无需额外 GET 协调答案。
        expect(h.services.fetchConversationApi).not.toHaveBeenCalled();
    });
});
