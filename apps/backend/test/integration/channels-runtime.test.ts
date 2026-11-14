import fs from 'node:fs/promises';

import {
    processMessage,
    sleep,
    type ChannelContext,
    type ChannelMessageEvent,
    type MessageTransport
} from '@zhuixun/channels-core';
import type { UIMessageChunk } from 'ai';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { paths } from '@/config/paths';
import { buildChannelRuntime, channelEvents } from '@/modules/channels';
import { getResumableStreamStore } from '@/modules/chat';
import { createConversationStore, getConversationStore } from '@/modules/conversations';
import { flushLogs } from '@/platform/logging/index';

const ids = new Set<string>();
const runtime = buildChannelRuntime();

function id(user: string): string {
    const value = runtime.channelSessionId('runtime-fake', user);
    ids.add(value);
    return value;
}

async function readRecording(sessionId: string): Promise<string> {
    const stream = getResumableStreamStore().reconnect(sessionId);
    expect(stream).not.toBeNull();
    return new Response(stream!).text();
}

afterEach(async () => {
    // 关闭真实临时流文件和 TTL 计时器，不能让后台写入跨越公共 setup 的目录清理。
    await getResumableStreamStore().dispose();
    await flushLogs();
    vi.restoreAllMocks();
});

afterAll(async () => {
    for (const sessionId of ids) {
        await getConversationStore().delete(sessionId);
        await fs.rm(paths.streamFile(sessionId), { force: true });
    }
    await flushLogs();
});

describe('buildChannelRuntime 真实宿主能力装配', () => {
    it('每次构造独立适配对象，但共享会话、流录制与事件单例', async () => {
        const another = buildChannelRuntime();
        expect(another).not.toBe(runtime);
        const sessionId = id('direct');
        const origin = { kind: 'channel' as const, channelId: 'runtime-fake', imUserId: 'direct' };
        await runtime.appendUserMessage(sessionId, origin, '用户消息');
        await another.appendAssistantMessage(sessionId, '助手回复');
        await expect(runtime.loadHistory(sessionId)).resolves.toEqual([
            { role: 'user', content: '用户消息' },
            { role: 'assistant', content: '助手回复' }
        ]);
        expect(await createConversationStore(paths.sessionsDir()).get(sessionId)).toMatchObject({ origin });

        const frame = 'data: {"type":"text-delta","delta":"回复"}\n\n';
        runtime.recordStream(
            sessionId,
            new ReadableStream<string>({
                start(controller) {
                    controller.enqueue(frame);
                    controller.close();
                }
            })
        );
        expect(await readRecording(sessionId)).toBe(frame);
        expect(getResumableStreamStore().getActiveIds()).not.toContain(sessionId);

        const listener = vi.fn();
        const unsubscribe = channelEvents.subscribe(listener);
        const event: ChannelMessageEvent = {
            type: 'reply',
            channelId: 'runtime-fake',
            channelName: 'Fake',
            userId: 'direct',
            sessionId,
            text: '助手回复',
            ts: 123
        };
        try {
            another.emitEvent(event);
            expect(listener).toHaveBeenCalledExactlyOnceWith(event);
        } finally {
            unsubscribe();
        }

        const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
        runtime.createLogger('RuntimeFixture').info('测试日志');
        expect(
            logs.mock.calls.some(
                ([line]) => String(line).includes('RuntimeFixture') && String(line).includes('测试日志')
            )
        ).toBe(true);
    });

    it('fake 模型和 transport 经过真实消息管道，先落用户消息，再流式录制、落回复与发事件', async () => {
        const sessionId = id('pipeline');
        const events: ChannelMessageEvent[] = [];
        const unsubscribe = channelEvents.subscribe((event) => events.push(event));
        const stopTyping = vi.fn();
        const transport: MessageTransport = {
            startTyping: vi.fn(() => stopTyping),
            sendNotification: vi.fn(),
            sendText: vi.fn(async () => {})
        };
        const chunks: UIMessageChunk[] = [
            { type: 'text-start', id: 'answer' },
            { type: 'reasoning-start', id: 'thought' },
            { type: 'tool-input-start', toolCallId: 'tool-1', toolName: 'Read' },
            { type: 'text-delta', id: 'answer', delta: '**原始' },
            { type: 'text-delta', id: 'answer', delta: '回复**' },
            { type: 'text-end', id: 'answer' }
        ];
        const abortController = new AbortController();
        const runAgent = vi.fn<ChannelContext['runAgent']>(async (history, opts) => {
            // runAgent 开始前用户消息已在磁盘，入站事件也已经发出。
            expect(history).toEqual([{ role: 'user', content: '问题' }]);
            expect(await getConversationStore().get(sessionId)).toMatchObject({ messages: [{ content: '问题' }] });
            expect(events.map(({ type }) => type)).toEqual(['inbound']);
            expect(opts).toEqual({ sessionId, abortSignal: abortController.signal });
            return {
                toUIMessageStream: async function* () {
                    for (const chunk of chunks) yield chunk;
                }
            };
        });
        try {
            await processMessage(
                {
                    channelId: 'runtime-fake',
                    channelName: 'Fake',
                    userId: 'pipeline',
                    text: '问题',
                    transport,
                    abortSignal: abortController.signal,
                    filterReply: (text) => text.replaceAll('**', '')
                },
                { runtime, runAgent, processMessage, sleep }
            );
            expect(runAgent).toHaveBeenCalledTimes(1);
            expect(transport.startTyping).toHaveBeenCalledExactlyOnceWith('pipeline', abortController.signal);
            expect(transport.sendNotification).toHaveBeenNthCalledWith(1, 'pipeline', '思考中…');
            expect(transport.sendNotification).toHaveBeenNthCalledWith(2, 'pipeline', '正在使用工具：Read');
            expect(transport.sendText).toHaveBeenCalledExactlyOnceWith('pipeline', '原始回复');
            expect(stopTyping).toHaveBeenCalledTimes(1);
            expect(events).toEqual([
                expect.objectContaining({ type: 'inbound', sessionId, text: '问题' }),
                expect.objectContaining({ type: 'reply', sessionId, text: '原始回复' })
            ]);
            expect(await runtime.loadHistory(sessionId)).toEqual([
                { role: 'user', content: '问题' },
                { role: 'assistant', content: '**原始回复**' }
            ]);
            expect(await readRecording(sessionId)).toBe(
                chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')
            );
        } finally {
            unsubscribe();
        }
    });

    it('模型失败仍保留用户消息、关闭录制并推 error；不伪造助手回复', async () => {
        const sessionId = id('failure');
        const events: ChannelMessageEvent[] = [];
        const unsubscribe = channelEvents.subscribe((event) => events.push(event));
        const stopTyping = vi.fn();
        const transport: MessageTransport = {
            startTyping: () => stopTyping,
            sendNotification: vi.fn(),
            sendText: vi.fn(async () => {})
        };
        const runAgent = vi.fn<ChannelContext['runAgent']>(async () => {
            throw new Error('fake model unavailable');
        });
        try {
            await processMessage(
                {
                    channelId: 'runtime-fake',
                    channelName: 'Fake',
                    userId: 'failure',
                    text: '保留问题',
                    transport
                },
                { runtime, runAgent, processMessage, sleep }
            );
            expect(await runtime.loadHistory(sessionId)).toEqual([{ role: 'user', content: '保留问题' }]);
            expect(events.map(({ type }) => type)).toEqual(['inbound', 'error']);
            expect(events[1]).toMatchObject({ text: 'fake model unavailable', sessionId });
            expect(transport.sendText).toHaveBeenCalledExactlyOnceWith(
                'failure',
                '⚠️ 处理失败：fake model unavailable'
            );
            expect(stopTyping).toHaveBeenCalledTimes(1);
            expect(await readRecording(sessionId)).toBe('');
        } finally {
            unsubscribe();
        }
    });
});
