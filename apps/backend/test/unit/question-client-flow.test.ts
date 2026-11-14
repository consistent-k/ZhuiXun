import type { AskUserQuestionInput, AskUserQuestionOutput } from '@zhuixun/shared';
import {
    lastAssistantMessageIsCompleteWithToolCalls,
    type ChatTransport,
    type UIMessage,
    type UIMessageChunk
} from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { Chat } from '../../../desktop/node_modules/@ai-sdk/react';

const input: AskUserQuestionInput = {
    questions: [
        {
            question: '方向？',
            header: '方向',
            multiSelect: true,
            options: [
                { label: 'A, B', description: '组合方向' },
                { label: 'C', description: '另一方向' }
            ]
        },
        {
            question: '如何补充？',
            header: '补充',
            options: [
                { label: '详细', description: '详细说明' },
                { label: '简短', description: '简要说明' }
            ]
        }
    ]
};
const output: AskUserQuestionOutput = {
    answers: [
        { questionIndex: 0, question: '方向？', selectedOptions: ['A, B', 'C'], customText: '同时考虑复盘' },
        { questionIndex: 1, question: '如何补充？', selectedOptions: [], customText: '附上检查记录' }
    ]
};

function pending(parallel = false): UIMessage[] {
    return [
        { id: 'u', role: 'user', parts: [{ type: 'text', text: '选择' }] },
        {
            id: 'a',
            role: 'assistant',
            parts: [
                { type: 'step-start' },
                { type: 'tool-askUserQuestion', toolCallId: 'q', state: 'input-available', input },
                ...(parallel
                    ? [
                          {
                              type: 'tool-askUserQuestion' as const,
                              toolCallId: 'q2',
                              state: 'input-available' as const,
                              input
                          }
                      ]
                    : [])
            ]
        }
    ];
}

function transport() {
    const sendMessages = vi.fn<ChatTransport<UIMessage>['sendMessages']>(async () => {
        const chunks: UIMessageChunk[] = [
            { type: 'start', messageId: 'continued' },
            { type: 'start-step' },
            { type: 'text-start', id: 'text' },
            { type: 'text-delta', id: 'text', delta: '完成' },
            { type: 'text-end', id: 'text' },
            { type: 'finish-step' },
            { type: 'finish' }
        ];
        return new ReadableStream<UIMessageChunk>({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk);
                controller.close();
            }
        });
    });
    return {
        sendMessages,
        reconnectToStream: vi.fn<ChatTransport<UIMessage>['reconnectToStream']>(async () => null)
    } satisfies ChatTransport<UIMessage>;
}

describe('客户端问题直接回填流程', () => {
    it('整组数组及自定义答案直接回填 SDK，只自动提交一次且不新增用户消息', async () => {
        const io = transport();
        const chat = new Chat({
            id: 'conv',
            messages: pending(),
            transport: io,
            sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls
        });

        await chat.addToolOutput({ tool: 'askUserQuestion', toolCallId: 'q', output });

        await vi.waitFor(() => expect(chat.status).toBe('ready'));
        expect(io.sendMessages).toHaveBeenCalledTimes(1);
        const request = io.sendMessages.mock.calls[0]![0];
        expect(request.trigger).toBe('submit-message');
        expect(request.messages[1]!.parts[1]).toMatchObject({ state: 'output-available', input, output });
        expect(request.messages.filter((message) => message.role === 'user')).toHaveLength(1);
        expect(chat.error).toBeUndefined();
    });

    it('并行调用尚未全部回答时不续跑，最后一个回答完成后才自动提交', async () => {
        const io = transport();
        const chat = new Chat({
            messages: pending(true),
            transport: io,
            sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls
        });

        await chat.addToolOutput({ tool: 'askUserQuestion', toolCallId: 'q', output });
        expect(chat.messages[1]!.parts[1]).toHaveProperty('state', 'output-available');
        expect(chat.messages[1]!.parts[2]).toHaveProperty('state', 'input-available');
        expect(io.sendMessages).not.toHaveBeenCalled();

        await chat.addToolOutput({ tool: 'askUserQuestion', toolCallId: 'q2', output });
        await vi.waitFor(() => expect(chat.status).toBe('ready'));
        expect(io.sendMessages).toHaveBeenCalledTimes(1);
        expect(io.sendMessages.mock.calls[0]![0].messages[1]!.parts.slice(1)).toEqual([
            expect.objectContaining({ toolCallId: 'q', state: 'output-available', output }),
            expect.objectContaining({ toolCallId: 'q2', state: 'output-available', output })
        ]);
    });
});
