import fs from 'node:fs/promises';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { paths } from '@/config/paths';
import { appendAssistantMessage, appendUserMessage, channelSessionId, loadHistory } from '@/modules/channels';
import {
    createConversationStore,
    getConversationStore,
    isValidConversationId,
    type ConversationOrigin,
    type StoredMessage
} from '@/modules/conversations';
import { flushLogs } from '@/platform/logging/index';

const origin: ConversationOrigin = {
    kind: 'channel',
    channelId: 'session-fake',
    channelName: '测试渠道',
    imUserId: 'contact@example'
};

// 公共 setup 在导入业务代码前隔离 home 和全部路径；这里只清理本文件创建的会话。
const ids = new Set<string>();
function sessionId(user: string): string {
    const id = channelSessionId(origin.channelId, user);
    ids.add(id);
    return id;
}

afterAll(async () => {
    vi.restoreAllMocks();
    for (const id of ids) await getConversationStore().delete(id);
    await flushLogs();
});

describe('渠道会话落盘适配', () => {
    it('生成稳定、合法且有界的 id，保留渠道和用户区分', () => {
        const id = channelSessionId('telegram', 'a.b/c:@用户_-9');
        expect(id).toBe('channel_telegram_a-b-c----_-9');
        expect(channelSessionId('telegram', 'a.b/c:@用户_-9')).toBe(id);
        expect(isValidConversationId(id)).toBe(true);
        expect(channelSessionId('telegram', 'a'.repeat(100))).toBe(`channel_telegram_${'a'.repeat(80)}`);
        expect(channelSessionId('c'.repeat(100), 'u'.repeat(100))).toHaveLength(128);
        expect(channelSessionId('telegram', '')).toBe('channel_telegram_');
        expect(channelSessionId('weixin', 'same')).not.toBe(channelSessionId('telegram', 'same'));
    });

    it('先落用户气泡与 origin，再追加助手消息；独立 store 能从磁盘恢复', async () => {
        const id = sessionId('new');
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_735_000_000_000);
        try {
            await expect(loadHistory(id)).resolves.toEqual([]);
            await appendUserMessage(id, origin, '  初次咨询  ');
            const first = await getConversationStore().get(id);
            expect(first).toMatchObject({
                title: '初次咨询',
                origin,
                createdAt: 1_735_000_000_000,
                messages: [
                    {
                        id: '1735000000000-u',
                        role: 'user',
                        content: '  初次咨询  ',
                        parts: [{ type: 'text', text: '  初次咨询  ' }],
                        timestamp: 1_735_000_000_000
                    }
                ]
            });
            clock.mockReturnValue(1_735_000_000_100);
            await appendAssistantMessage(id, '这是回复');
            clock.mockReturnValue(1_735_000_000_200);
            await appendUserMessage(id, { ...origin, imUserId: '不应覆盖' }, '再次提问');

            const reopened = createConversationStore(paths.sessionsDir());
            const saved = await reopened.get(id);
            expect(saved).toMatchObject({ title: '初次咨询', origin, createdAt: first!.createdAt });
            expect(saved!.messages.map((message) => message.id)).toEqual([
                '1735000000000-u',
                '1735000000100-a',
                '1735000000200-u'
            ]);
            await expect(loadHistory(id)).resolves.toEqual([
                { role: 'user', content: '  初次咨询  ' },
                { role: 'assistant', content: '这是回复' },
                { role: 'user', content: '再次提问' }
            ]);
            expect(await reopened.list()).toContainEqual(expect.objectContaining({ id, origin, title: '初次咨询' }));
        } finally {
            clock.mockRestore();
        }
    });

    it.each([
        ['blank', '   ', '渠道会话'],
        ['short', '短标题', '短标题'],
        ['exact', '中'.repeat(20), '中'.repeat(20)],
        ['long', `  ${'文'.repeat(21)}  `, `${'文'.repeat(20)}...`]
    ])('按文本生成标题：%s', async (user, text, expected) => {
        const id = sessionId(user);
        await appendUserMessage(id, origin, text);
        expect(await getConversationStore().get(id)).toMatchObject({ title: expected });
    });

    it('保留已有标题、项目、来源、创建时间；缺省来源和空标题由首条入站信息补齐', async () => {
        const id = sessionId('metadata');
        const store = getConversationStore();
        await store.upsert(id, {
            title: '桌面指定标题',
            projectId: 'project-fake',
            origin,
            createdAt: 42,
            messages: []
        });
        await appendUserMessage(id, { ...origin, imUserId: 'changed' }, '不能改标题');
        await appendAssistantMessage(id, '回复');
        expect(await store.get(id)).toMatchObject({
            title: '桌面指定标题',
            projectId: 'project-fake',
            origin,
            createdAt: 42,
            messages: [{ role: 'user' }, { role: 'assistant' }]
        });

        const emptyId = sessionId('empty-metadata');
        await store.upsert(emptyId, { title: '', createdAt: 0, messages: [] });
        await appendUserMessage(emptyId, origin, '补齐标题');
        const filled = await store.get(emptyId);
        expect(filled).toMatchObject({ title: '补齐标题', origin });
        expect(filled!.createdAt).toBeGreaterThan(0);
    });

    it('空回复不写盘，助手消息不凭空创建会话', async () => {
        const missing = sessionId('missing');
        await appendAssistantMessage(missing, '没有用户消息');
        expect(await getConversationStore().get(missing)).toBeNull();
        await expect(fs.stat(path.join(paths.sessionsDir(), `${missing}.json`))).rejects.toMatchObject({
            code: 'ENOENT'
        });

        const id = sessionId('empty-reply');
        await appendUserMessage(id, origin, '已有消息');
        const file = path.join(paths.sessionsDir(), `${id}.json`);
        const before = await fs.readFile(file, 'utf8');
        await appendAssistantMessage(id, '');
        expect(await fs.readFile(file, 'utf8')).toBe(before);
    });

    it('历史只传纯文本 user/assistant，过滤其他角色后取最后 50 条而不裁剪落盘', async () => {
        const id = sessionId('history');
        const messages: StoredMessage[] = Array.from({ length: 55 }, (_, i) => ({
            id: `message-${i}`,
            role: i % 2 ? 'assistant' : 'user',
            content: `text-${i}`,
            parts: [{ type: 'text', text: `part-${i}` }]
        }));
        // 旧落盘文件可能含模型侧角色；通过真实存储模拟升级前文件，验证适配层过滤而非 mock。
        const legacyMessage = { id: 'system', role: 'system', content: '不应发给模型' } as unknown as StoredMessage;
        await getConversationStore().upsert(id, {
            title: '历史',
            createdAt: 1,
            messages: [...messages, legacyMessage]
        });
        expect(await loadHistory(id)).toEqual(messages.slice(5).map(({ role, content }) => ({ role, content })));
        expect((await getConversationStore().get(id))!.messages).toHaveLength(56);
    });
});
