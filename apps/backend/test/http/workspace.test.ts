import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { WorkspaceFileView } from '@zhuixun/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { paths } from '@/config/paths';
import { createWorkspaceRouter } from '@/http/routes/workspace';
import { getConversationStore } from '@/modules/conversations';
import { getPolicyEngine } from '@/modules/permission';
import {
    beginWorkspace,
    createWorkspaceTools,
    readWorkspace,
    updateWorkspace,
    workspaceIdentity
} from '@/modules/workspace';

const router = createWorkspaceRouter();
let id: string;
let turnId: string;
let root: string;
async function resolve(file: string, session = id) {
    const response = await router.request(`/api/conversations/${session}/files/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'workspace', path: file, name: path.basename(file), turnId })
    });
    return { status: response.status, body: (await response.json()) as { code: number; data: WorkspaceFileView } };
}
const content = (file: WorkspaceFileView, session = id) =>
    router.request(`/api/conversations/${session}/files/${file.fileId}/content`);

beforeEach(async () => {
    id = randomUUID();
    turnId = randomUUID();
    root = path.join(paths.sessionsDir(), `test-files-${id}`);
    await fs.mkdir(root, { recursive: true });
    await getConversationStore().upsert(id, {
        title: '预览测试',
        createdAt: Date.now(),
        messages: [{ id: turnId, role: 'user', content: '报告', parts: [{ type: 'text', text: '报告' }] }]
    });
    await beginWorkspace(id, turnId, root, [], true);
});

describe('workspace HTTP 文件边界', () => {
    it('读取文本，拒绝跨会话 ticket，端口无关的身份保持不变', async () => {
        await fs.writeFile(path.join(root, 'report.md'), '# 报告');
        const { body } = await resolve('report.md');
        expect(body.data.preview).toBe('markdown');
        expect(await (await content(body.data)).text()).toBe('# 报告');
        expect((await content(body.data, randomUUID())).status).toBe(410);
        const a = await workspaceIdentity();
        const b = await workspaceIdentity();
        expect(a).toEqual(b);
    });
    it('拒绝路径穿越和目录符号链接逃逸', async () => {
        const outside = path.join(paths.sessionsDir(), `outside-${id}.txt`);
        await fs.writeFile(outside, 'private');
        expect((await resolve(outside)).status).toBe(403);
        await fs.symlink(outside, path.join(root, 'alias.txt'));
        expect((await resolve('alias.txt')).status).toBe(403);
    });
    it('ask 确认前不返回正文，确认仅绑定本次版本，deny 不可绕过', async () => {
        const policy = vi
            .spyOn(getPolicyEngine(), 'evaluate')
            .mockResolvedValue({ decision: 'ask', reason: 'test', source: 'user' });
        try {
            await fs.writeFile(path.join(root, 'report.txt'), 'v1');
            const { body } = await resolve('report.txt');
            expect(body.data.approvalRequired).toBe(true);
            expect((await content(body.data)).status).toBe(428);
            const url = `/api/conversations/${id}/files/${body.data.fileId}/approve`;
            expect(
                (
                    await router.request(url, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ approved: true })
                    })
                ).status
            ).toBe(200);
            expect(await (await content(body.data)).text()).toBe('v1');
            policy.mockResolvedValue({ decision: 'deny', reason: 'deny', source: 'user' });
            expect((await content(body.data)).status).toBe(403);
        } finally {
            policy.mockRestore();
        }
    });
    it('拒绝解析后替换的文件、超限和伪装 PDF', async () => {
        await fs.writeFile(path.join(root, 'report.txt'), 'before');
        const first = await resolve('report.txt');
        await fs.writeFile(path.join(root, 'report.txt'), 'after changed');
        expect((await content(first.body.data)).status).toBe(409);
        await fs.writeFile(path.join(root, 'big.txt'), Buffer.alloc(1024 ** 2 + 1, 65));
        const big = await resolve('big.txt');
        expect(big.body.data.tooLarge).toBe(true);
        expect((await content(big.body.data)).status).toBe(413);
        await fs.writeFile(path.join(root, 'fake.pdf'), '<script>bad</script>');
        expect((await content((await resolve('fake.pdf')).body.data)).status).toBe(415);
    });
    it('超限文件经一次性下载能力流式下载，链接不能复用', async () => {
        const data = Buffer.alloc(1024 ** 2 + 10, 65);
        await fs.writeFile(path.join(root, 'large.txt'), data);
        const { body } = await resolve('large.txt');
        const result = await router.request(`/api/conversations/${id}/files/${body.data.fileId}/download`, {
            method: 'POST'
        });
        const { data: ticket } = (await result.json()) as { data: { url: string } };
        const download = await router.request(ticket.url);
        expect(download.headers.get('content-disposition')).toContain('attachment;');
        expect((await download.arrayBuffer()).byteLength).toBe(data.byteLength);
        expect((await router.request(ticket.url)).status).toBe(410);
    });
    it('并发快照串行合并，产物登记验证文件且不自动登记源码', async () => {
        await Promise.all(
            ['one', 'two'].map((name) =>
                updateWorkspace(id, turnId, (turn) => {
                    turn.summary.sources.push({ id: name, name });
                })
            )
        );
        expect((await readWorkspace(id)).turns[0].summary.sources).toHaveLength(2);
        await fs.writeFile(path.join(root, 'deliver.md'), '# 交付');
        const tools = createWorkspaceTools(id, turnId);
        const result = await tools.register_artifact.execute!(
            { path: 'deliver.md' },
            { toolCallId: 'register-1', messages: [], context: {} }
        );
        expect(result).toMatchObject({ ok: true });
        const response = await router.request(`/api/conversations/${id}/workspace`);
        expect(((await response.json()) as { data: { artifacts: unknown[] }[] }).data[0].artifacts).toHaveLength(1);
    });
});
