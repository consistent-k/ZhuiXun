import { Readable } from 'node:stream';

import { Hono } from 'hono';
import { z } from 'zod';

import { allowedOrigins } from '@/config/server';
import { fail, ok } from '@/http/respond';
import { getConversationStore, isValidConversationId } from '@/modules/conversations';
import {
    approveFile,
    createFileDownload,
    consumeFileDownload,
    readFileContent,
    resolveFile,
    workspaceIdentity,
    WorkspaceError,
    workspaceSummaries
} from '@/modules/workspace';

const referenceSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('workspace'),
        path: z.string().min(1).max(4096),
        name: z.string().max(200),
        turnId: z.string().max(200).optional(),
        line: z.number().int().positive().optional()
    }),
    z.object({
        kind: z.literal('attachment'),
        attachmentId: z.string().min(1).max(128),
        name: z.string().max(200),
        turnId: z.string().max(200).optional()
    })
]);

/** 文件预览走 HTTP 访问闸；ask 必须先经过 UI 的独立确认接口。 */
export function createWorkspaceRouter() {
    const router = new Hono();
    router.onError((error, c) => {
        if (error instanceof WorkspaceError) return fail(c, error.status, error.message);
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fail(c, 404, '文件不存在或已被删除');
        throw error;
    });
    router.get('/workspace-download/:token', async (c) => {
        const origin = c.req.header('origin');
        if (origin && !allowedOrigins().includes(origin)) return fail(c, 403, '来源不被允许');
        const { stream, name } = await consumeFileDownload(c.req.param('token'));
        return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
            headers: {
                'Content-Type': 'application/octet-stream',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "sandbox; default-src 'none'",
                'Referrer-Policy': 'no-referrer',
                'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
            }
        });
    });
    router.post('/api/conversations/:id/files/:fileId/download', async (c) =>
        ok(c, await createFileDownload(c.req.param('id'), c.req.param('fileId')))
    );
    router.get('/api/workspace/identity', async (c) => ok(c, await workspaceIdentity()));
    router.use('/api/conversations/:id/*', async (c, next) => {
        if (!isValidConversationId(c.req.param('id') ?? '')) return fail(c, 400, '非法会话 id');
        await next();
    });
    router.get('/api/conversations/:id/workspace', async (c) => {
        const id = c.req.param('id');
        const conversation = await getConversationStore().get(id);
        if (!conversation) return fail(c, 404, '会话不存在');
        return ok(
            c,
            await workspaceSummaries(
                id,
                new Set(conversation.messages.filter((m) => m.role === 'user').map((m) => m.id))
            )
        );
    });
    router.post('/api/conversations/:id/files/resolve', async (c) => {
        const parsed = referenceSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return fail(c, 400, '文件引用不合法');
        return ok(c, await resolveFile(c.req.param('id'), parsed.data));
    });
    router.post('/api/conversations/:id/files/:fileId/approve', async (c) => {
        const body = await c.req.json().catch(() => null);
        if (body?.approved !== true) return fail(c, 400, '未确认读取');
        await approveFile(c.req.param('id'), c.req.param('fileId'));
        return ok(c, { approved: true });
    });
    router.get('/api/conversations/:id/files/:fileId/content', async (c) => {
        const { data, info } = await readFileContent(c.req.param('id'), c.req.param('fileId'));
        return new Response(new Uint8Array(data), {
            headers: {
                'Content-Type': info.mediaType,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'none'",
                'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(info.name)}`
            }
        });
    });
    return router;
}
