import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { WorkspaceFileReference, WorkspaceFileView } from '@zhuixun/shared';

import { paths } from '@/config/paths';
import { getConversationStore } from '@/modules/conversations';
import { getPolicyEngine } from '@/modules/permission';
import { getProjectStore } from '@/modules/projects';

import { readWorkspace } from './store';

export class WorkspaceError extends Error {
    constructor(
        public status: number,
        message: string
    ) {
        super(message);
    }
}
function within(root: string, file: string) {
    const rel = path.relative(root, file);
    return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}
export function fingerprint(stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** 每次真实读取重新解析范围与 Read 策略，引用和 fileId 均不是授权。 */
export async function inspectFile(id: string, ref: WorkspaceFileReference) {
    const conversation = await getConversationStore().get(id);
    if (!conversation) throw new WorkspaceError(404, '会话不存在');
    const state = await readWorkspace(id);
    const turn = ref.turnId ? state.turns.find((t) => t.summary.turnId === ref.turnId) : state.turns.at(-1);
    let raw: string;
    let name = ref.name;
    let attachmentType: string | undefined;
    let roots: string[];
    if (ref.kind === 'attachment') {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(ref.attachmentId)) throw new WorkspaceError(400, '附件引用不正确');
        raw = path.join(paths.sessionUploadsDir(id), ref.attachmentId);
        roots = [paths.sessionUploadsDir(id)];
        const metadataFile = await fs.realpath(`${raw}.meta.json`);
        if (!within(await fs.realpath(paths.sessionUploadsDir(id)), metadataFile))
            throw new WorkspaceError(403, '附件元信息不在会话目录内');
        const meta = JSON.parse(await fs.readFile(metadataFile, 'utf8')) as {
            filename: string;
            mediaType: string;
        };
        name = meta.filename;
        attachmentType = meta.mediaType;
    } else {
        if (!turn || !conversation.messages.some((m) => m.role === 'user' && m.id === turn.summary.turnId))
            throw new WorkspaceError(404, '未找到文件所属轮次的工作目录');
        raw = path.resolve(turn.cwd, ref.path);
        const project = conversation.projectId ? await getProjectStore().get(conversation.projectId) : null;
        // 历史目录只负责定位；项目变更后按当前有效根重新校验，不能沿用旧授权。
        roots = turn.temporary
            ? [turn.cwd]
            : (conversation.projectId ? (project?.roots ?? []) : (conversation.roots ?? [])).map((r) => r.path);
    }
    const real = await fs.realpath(raw);
    const allowed = await Promise.all(
        roots.map(async (root) => {
            try {
                const canonical = await fs.realpath(root);
                return within(canonical, real);
            } catch {
                return false;
            }
        })
    );
    if (!allowed.some(Boolean)) throw new WorkspaceError(403, '文件不在本会话允许的目录内');
    for (const file of new Set([raw, real])) {
        const decision = await getPolicyEngine().evaluate('Read', { path: file }, { cwd: turn?.cwd });
        if (decision.decision === 'deny') throw new WorkspaceError(403, '读取权限规则禁止访问该文件');
    }
    const decisions = await Promise.all(
        [...new Set([raw, real])].map((file) => getPolicyEngine().evaluate('Read', { path: file }, { cwd: turn?.cwd }))
    );
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new WorkspaceError(400, '只能预览普通文件');
    const ext = path.extname(ref.kind === 'workspace' ? real : name).toLowerCase();
    let preview: WorkspaceFileView['preview'] = 'unsupported';
    let mediaType = 'application/octet-stream';
    if (['.md', '.markdown'].includes(ext)) {
        preview = 'markdown';
        mediaType = 'text/markdown';
    } else if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
        preview = 'image';
        mediaType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
    } else if (ext === '.pdf') {
        preview = 'pdf';
        mediaType = 'application/pdf';
    } else if (
        /^\.(txt|json|jsonc|js|jsx|mjs|cjs|ts|tsx|css|less|scss|html|htm|xml|svg|yaml|yml|toml|ini|csv|log|sh|bash|py|rs|go|java|sql|vue|svelte|c|cpp|h|rb|tex|conf)$/i.test(
            ext
        ) ||
        /^(Dockerfile|Makefile|LICENSE|README)$/i.test(name)
    ) {
        preview = 'text';
        mediaType = 'text/plain';
    }
    if (ref.kind === 'attachment' && preview === 'unsupported' && attachmentType === 'text/plain') {
        preview = 'text';
        mediaType = 'text/plain';
    }
    const limit =
        preview === 'text' || preview === 'markdown'
            ? 1024 ** 2
            : preview === 'image'
              ? 10 * 1024 ** 2
              : 20 * 1024 ** 2;
    return {
        real,
        stat,
        name: path.basename(name || real),
        preview,
        mediaType,
        limit,
        approvalRequired: decisions.some((d) => d.decision === 'ask'),
        version: fingerprint(stat)
    };
}

interface FileTicket {
    id: string;
    ref: WorkspaceFileReference;
    version: string;
    expires: number;
    approved: boolean;
}
const tickets = new Map<string, FileTicket>();

/** 只生成会话绑定、限时的描述符，不在 resolve 阶段读取正文。 */
export async function resolveFile(id: string, reference: WorkspaceFileReference): Promise<WorkspaceFileView> {
    const info = await inspectFile(id, reference);
    for (const [key, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(key);
    if (tickets.size >= 1000) tickets.delete(tickets.keys().next().value!);
    const fileId = randomUUID();
    tickets.set(fileId, {
        id,
        ref: reference,
        version: info.version,
        expires: Date.now() + 5 * 60_000,
        approved: false
    });
    return {
        fileId,
        resourceKey: createHash('sha256').update(`${id}\0${info.real}`).digest('hex'),
        reference,
        name: info.name,
        size: info.stat.size,
        version: info.version,
        mediaType: info.mediaType,
        preview: info.preview,
        limit: info.limit,
        tooLarge: info.stat.size > info.limit,
        approvalRequired: info.approvalRequired
    };
}
function ticketFor(id: string, fileId: string) {
    const ticket = tickets.get(fileId);
    if (!ticket || ticket.id !== id || ticket.expires < Date.now())
        throw new WorkspaceError(410, '文件访问已过期，请刷新');
    return ticket;
}

/** 用户点击确认后仅授权这一个文件版本；策略 deny 始终优先。 */
export async function approveFile(id: string, fileId: string) {
    const ticket = ticketFor(id, fileId);
    const info = await inspectFile(id, ticket.ref);
    if (info.version !== ticket.version) throw new WorkspaceError(409, '文件已变化，请重新预览并确认');
    ticket.approved = true;
}

/** 使用同一文件句柄校验身份并有界读取，拒绝符号链接替换和增长后的超限。 */
export async function readFileContent(id: string, fileId: string) {
    const ticket = ticketFor(id, fileId);
    const info = await inspectFile(id, ticket.ref);
    if (info.version !== ticket.version) throw new WorkspaceError(409, '文件已变化，请刷新预览');
    if (info.approvalRequired && !ticket.approved) throw new WorkspaceError(428, '请先确认读取该文件');
    if (info.preview === 'unsupported') throw new WorkspaceError(415, '暂不支持该文件类型的预览');
    if (info.stat.size > info.limit) throw new WorkspaceError(413, '文件超过预览大小限制');
    const handle = await fs.open(info.real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        if (fingerprint(await handle.stat()) !== info.version) throw new WorkspaceError(409, '文件已变化，请刷新预览');
        // 打开句柄后再次验证目录和权限，避免目录符号链接在初次校验后被切换。
        const rechecked = await inspectFile(id, ticket.ref);
        if (rechecked.real !== info.real || rechecked.version !== info.version)
            throw new WorkspaceError(409, '文件已变化');
        const bytes = Buffer.alloc(info.stat.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
            if (!bytesRead) break;
            offset += bytesRead;
        }
        if (offset !== info.stat.size || fingerprint(await handle.stat()) !== info.version)
            throw new WorkspaceError(409, '文件正在写入，请稍后刷新');
        const data = bytes.subarray(0, offset);
        if (info.preview === 'text' || info.preview === 'markdown') {
            if (data.includes(0)) throw new WorkspaceError(415, '文件包含二进制内容，不能按文本预览');
        } else if (info.preview === 'pdf' && !data.subarray(0, 5).equals(Buffer.from('%PDF-')))
            throw new WorkspaceError(415, '不是有效的 PDF 文件');
        return { data, info };
    } finally {
        await handle.close();
    }
}

const downloads = new Map<string, { id: string; fileId: string; expires: number }>();

/** 经 API 访问闸及文件权限校验后，签发一次性浏览器下载能力，避免把 API token 放入 URL。 */
export async function createFileDownload(id: string, fileId: string) {
    const ticket = ticketFor(id, fileId);
    const info = await inspectFile(id, ticket.ref);
    if (info.version !== ticket.version) throw new WorkspaceError(409, '文件已变化，请刷新');
    if (info.approvalRequired && !ticket.approved) throw new WorkspaceError(428, '请先确认读取该文件');
    for (const [key, value] of downloads) if (value.expires < Date.now()) downloads.delete(key);
    if (downloads.size >= 100) throw new WorkspaceError(429, '下载请求过多，请稍后重试');
    const token = randomUUID() + randomUUID();
    downloads.set(token, { id, fileId, expires: Date.now() + 30_000 });
    return { url: `/workspace-download/${token}` };
}

/** 顶层导航不能带自定义认证头：下载仅接受短时一次性能力，仍重新校验目录、策略及文件身份。 */
export async function consumeFileDownload(token: string) {
    const download = downloads.get(token);
    downloads.delete(token);
    if (!download || download.expires < Date.now()) throw new WorkspaceError(410, '下载链接已过期');
    const ticket = ticketFor(download.id, download.fileId);
    const info = await inspectFile(download.id, ticket.ref);
    if (info.approvalRequired && !ticket.approved) throw new WorkspaceError(428, '需要重新确认读取');
    if (info.version !== ticket.version) throw new WorkspaceError(409, '文件已变化');
    const handle = await fs.open(info.real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const check = await inspectFile(download.id, ticket.ref);
        if (
            check.real !== info.real ||
            check.version !== info.version ||
            fingerprint(await handle.stat()) !== info.version
        )
            throw new WorkspaceError(409, '文件已变化');
        const stream = handle.createReadStream({
            autoClose: true,
            ...(info.stat.size ? { end: info.stat.size - 1 } : {})
        });
        return { stream, name: info.name };
    } catch (error) {
        await handle.close();
        throw error;
    }
}
