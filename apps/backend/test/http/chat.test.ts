import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '@/http/middleware/error-handler';
import { createChatRouter } from '@/http/routes/chat';
import { ChatTurnError } from '@/modules/chat';
import { MCPClientManager } from '@/modules/mcp';
import { SkillRegistry } from '@/modules/skills';

const chat = vi.hoisted(() => ({
    run: vi.fn(),
    record: vi.fn(),
    reconnect: vi.fn(),
    active: vi.fn(),
    canStore: vi.fn(),
    allowed: vi.fn(),
    save: vi.fn(),
    read: vi.fn()
}));
vi.mock('@/modules/chat', () => ({
    ChatTurnError: class extends Error {
        constructor(
            readonly status: number,
            message: string
        ) {
            super(message);
        }
    },
    runChatTurn: chat.run,
    getResumableStreamStore: () => ({ record: chat.record, reconnect: chat.reconnect, getActiveIds: chat.active }),
    canStoreAttachment: chat.canStore,
    isAllowedAttachment: chat.allowed,
    saveAttachment: chat.save,
    readAttachment: chat.read,
    MAX_IMAGE_BYTES: 8,
    MAX_FILE_BYTES: 16
}));
const registry = new SkillRegistry(new MCPClientManager([]), '/fake');
let ready = true;
const app = new Hono();
app.route(
    '/',
    createChatRouter(() => (ready ? registry : undefined))
);
app.onError(errorHandler);
const input = {
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hi' }], metadata: { usage: 1 } }],
    model: 'demo/m',
    agentMode: 'routed',
    sessionId: 'conv',
    projectId: 'proj'
};
function chunks() {
    return new ReadableStream({
        start(controller) {
            controller.enqueue({ type: 'start', messageId: 'a1' });
            controller.enqueue({ type: 'finish' });
            controller.close();
        }
    });
}
async function post(body: unknown, status = 200) {
    const response = await app.request('/api/chat/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    expect(response.status).toBe(status);
    return response;
}
async function upload(
    name: string | undefined,
    type = 'text/plain',
    content = 'hello',
    sessionId: string | null = 'conv',
    status = 200
) {
    const body = new FormData();
    if (name !== undefined) body.append('file', new File([content], name, { type }));
    if (sessionId !== null) body.append('sessionId', sessionId);
    const response = await app.request('/api/chat/upload', { method: 'POST', body });
    expect(response.status).toBe(status);
    const result = (await response.json()) as { code: number; data: unknown; message: string };
    expect(result.code).toBe(status === 200 ? 0 : status);
    return result;
}
beforeEach(() => {
    vi.resetAllMocks();
    ready = true;
    chat.run.mockImplementation(async () => ({ stream: chunks(), chatId: 'conv', canResume: false }));
    chat.canStore.mockReturnValue(true);
    chat.allowed.mockReturnValue(true);
    chat.save.mockResolvedValue({ id: 'file', url: '/api/chat/files/conv/file' });
    chat.active.mockReturnValue(['conv']);
});

describe('chat HTTP boundary with fake chat use case, real SDK SSE response', () => {
    it('requires initialized registry, validates shapes and preserves metadata to the use case', async () => {
        ready = false;
        expect(await (await post(input, 503)).json()).toMatchObject({ code: 503 });
        ready = true;
        for (const body of [
            null,
            {},
            { messages: [] },
            { messages: [{ role: 1 }] },
            { ...input, agentMode: 'invalid' }
        ])
            expect(await (await post(body, 400)).json()).toMatchObject({
                code: 400,
                message: expect.stringContaining('请求参数不合法')
            });
        expect(chat.run).not.toHaveBeenCalled();
        const response = await post(input);
        expect(chat.run).toHaveBeenCalledWith(input, registry, expect.any(AbortSignal));
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
        expect(await response.text()).toContain('"messageId":"a1"');
    });

    it('blocks parallel session turns and only cancels the matching request', async () => {
        const requestId = '2c02b1aa-fdac-44eb-8db9-8e66d41ecfc5';
        let signal: AbortSignal | undefined;
        chat.run.mockImplementationOnce(async (_input, _registry, turnSignal: AbortSignal) => {
            signal = turnSignal;
            return {
                stream: new ReadableStream({
                    start(controller) {
                        turnSignal.addEventListener('abort', () => controller.close(), { once: true });
                    }
                }),
                chatId: input.sessionId,
                canResume: false
            };
        });
        const response = await post({ ...input, requestId });
        await post(input, 409);
        const cancel = (id: string) => app.request(`/api/chat/conv/cancel?requestId=${id}`, { method: 'POST' });
        expect(await (await cancel('wrong')).json()).toMatchObject({ data: { cancelled: false } });
        expect(signal?.aborted).toBe(false);
        expect(await (await cancel(requestId)).json()).toMatchObject({ data: { cancelled: true } });
        expect(signal?.aborted).toBe(true);
        await response.text();
        await (await post(input)).text();
    });

    it('records resumable SSE, replays valid IDs, returns 204 for invalid or expired streams', async () => {
        let recorded = '';
        chat.run.mockResolvedValueOnce({ stream: chunks(), chatId: 'conv', canResume: true });
        chat.record.mockImplementation(async (_id, stream: ReadableStream<string>) => {
            const reader = stream.getReader();
            try {
                for (;;) {
                    const next = await reader.read();
                    if (next.done) break;
                    recorded += next.value;
                }
            } finally {
                await reader.cancel();
                reader.releaseLock();
            }
        });
        const response = await post(input);
        expect(await response.text()).toContain('[DONE]');
        await vi.waitFor(() => expect(recorded).toContain('[DONE]'));
        expect(chat.record).toHaveBeenCalledWith('conv', expect.any(ReadableStream));
        expect((await app.request('/api/chat/stream/bad%21/stream')).status).toBe(204);
        expect(chat.reconnect).not.toHaveBeenCalled();
        expect((await app.request('/api/chat/stream/conv/stream')).status).toBe(204);
        let cancelled = false;
        chat.reconnect.mockReturnValueOnce(
            new ReadableStream({
                start(c) {
                    c.enqueue(new TextEncoder().encode('data: replay\n\n'));
                },
                cancel() {
                    cancelled = true;
                }
            })
        );
        const replay = await app.request('/api/chat/stream/conv/stream');
        expect(replay.status).toBe(200);
        expect(replay.headers.get('content-type')).toContain('text/event-stream');
        const reader = replay.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: replay\n\n');
        await reader.cancel();
        reader.releaseLock();
        expect(cancelled).toBe(true);
        const active = await app.request('/api/chat/active');
        expect(active.status).toBe(200);
        expect(await active.json()).toEqual({ code: 0, data: { ids: ['conv'] } });
    });

    it('maps use case errors and malformed JSON via the actual error envelope', async () => {
        chat.run.mockRejectedValueOnce(new ChatTurnError(409, 'turn busy'));
        expect(await (await post(input, 409)).json()).toEqual({ code: 409, message: 'turn busy' });
        chat.run.mockRejectedValueOnce(new Error('turn failed'));
        expect(await (await post(input, 500)).json()).toEqual({ code: 500, message: 'turn failed' });
        const bad = await app.request('/api/chat/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{'
        });
        expect(bad.status).toBe(500);
        expect(((await bad.json()) as { code: number }).code).toBe(500);
    });

    it('validates multipart attachments and size/type limits, passes exact data and reports storage failure', async () => {
        expect((await upload('note.txt')).data).toMatchObject({ id: 'file' });
        expect(chat.save).toHaveBeenLastCalledWith('conv', {
            data: new TextEncoder().encode('hello'),
            filename: 'note.txt',
            mediaType: 'text/plain'
        });
        await upload(undefined, 'text/plain', '', 'conv', 400);
        await upload('note.txt', 'text/plain', 'hello', null, 400);
        chat.canStore.mockReturnValueOnce(false);
        await upload('note.txt', 'text/plain', 'hello', 'bad', 400);
        expect((await upload('table.XLS', '', 'hello', 'conv', 400)).message).toContain('旧版 .xls');
        chat.allowed.mockReturnValueOnce(false);
        expect((await upload('binary.exe', '', 'hello', 'conv', 400)).message).toContain('不支持的文件类型');
        await upload('image.png', 'image/png', '123456789', 'conv', 400);
        await upload('big.txt', 'text/plain', '12345678901234567', 'conv', 400);
        // Node 原生 multipart 会把空 filename 解析成文本字段，因此不是可上传的 File。
        await upload('', '', 'ok', 'conv', 400);
        chat.save.mockRejectedValueOnce(new Error('disk failed'));
        expect((await upload('note.txt', 'text/plain', 'hello', 'conv', 500)).message).toBe('disk failed');
        const malformed = await app.request('/api/chat/upload', {
            method: 'POST',
            headers: { 'content-type': 'multipart/form-data' },
            body: 'broken'
        });
        expect(malformed.status).toBe(400);
        expect(((await malformed.json()) as { message: string }).message).toContain('请求体解析失败');
    });

    it('serves raw attachments with encoded name, MIME and private caching, or empty 404', async () => {
        const missing = await app.request('/api/chat/files/conv/missing');
        expect(missing.status).toBe(404);
        expect(await missing.text()).toBe('');
        chat.read.mockResolvedValueOnce({
            meta: { filename: '中文 file.txt', mediaType: 'text/plain' },
            data: new TextEncoder().encode('content')
        });
        const response = await app.request('/api/chat/files/conv/file');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/plain');
        expect(response.headers.get('content-disposition')).toBe(
            `inline; filename="${encodeURIComponent('中文 file.txt')}"`
        );
        expect(response.headers.get('cache-control')).toBe('private, max-age=3600');
        expect(await response.text()).toBe('content');
        expect(chat.read).toHaveBeenLastCalledWith('conv', 'file');
    });
});
