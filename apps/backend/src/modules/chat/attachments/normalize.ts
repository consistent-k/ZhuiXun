import type { UIMessage } from 'ai';

import { extractAttachmentText, isExtractable } from './extract';
import { parseAttachmentRef, readAttachment } from './store';

interface FilePartLike {
    type: string;
    mediaType?: string;
    filename?: string;
    url?: string;
    [k: string]: unknown;
}

function toBase64DataUrl(data: Uint8Array, mediaType: string): string {
    return `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`;
}

/**
 * 把消息里的「引用式」附件 part 归一化为模型可读的内联 part，供 `createAgentUIStreamResponse` 前调用。
 *
 * - 引用 URL（`/api/chat/files/<sid>/<id>`）→ 读本地字节：
 *   · CSV / Excel / docx / 纯文本·代码 → 服务端提取为文本，作为 text part 注入；
 *   · 图片 / PDF → 内联为 base64 data URL 的 file part（远端 provider 取不到 localhost，必须内联）。
 *   读不到（已失效）则剔除该 part，并在消息末尾追加一条文本说明。
 * - 已是 data URL 或外部 http URL 的 file part：原样保留，交给 AI SDK 处理。
 * - 非 user 消息、非 file part：原样透传。
 *
 * 不做模型能力门禁——图片/PDF 一律内联喂给模型；若模型/端点不支持，由 provider 报错经流式如实回显给用户。
 *
 * 返回**新数组**，不修改入参——入参会以引用式原样落库，只有喂给模型的副本才展开为字节，避免会话文件被 base64 撑大。
 *
 * @param messages 前端传入的 UIMessage 列表
 * @returns 归一化后的 UIMessage 列表
 */
export async function normalizeAttachments(messages: UIMessage[]): Promise<UIMessage[]> {
    return Promise.all(
        messages.map(async (msg) => {
            if (msg.role !== 'user' || !Array.isArray(msg.parts)) return msg;

            const nextParts: unknown[] = [];
            const dropped: string[] = [];
            let changed = false;

            for (const raw of msg.parts as FilePartLike[]) {
                if (raw?.type !== 'file' || typeof raw.url !== 'string') {
                    nextParts.push(raw);
                    continue;
                }
                const ref = parseAttachmentRef(raw.url);
                if (!ref) {
                    // 非本地引用（外部 URL / data URL）：交给 SDK 处理
                    nextParts.push(raw);
                    continue;
                }
                changed = true;
                const label = raw.filename || '附件';
                const file = await readAttachment(ref.sid, ref.id);
                if (!file) {
                    dropped.push(`${label}（已失效）`);
                    continue;
                }
                const mediaType = raw.mediaType || file.meta.mediaType;
                const filename = raw.filename || file.meta.filename;

                // CSV / Excel / docx / 纯文本·代码：服务端提取为文本，作为 text part 注入
                if (isExtractable(mediaType, filename)) {
                    const text = await extractAttachmentText(mediaType, filename, file.data);
                    if (text) {
                        nextParts.push({
                            type: 'text',
                            text: `\n\n【附件：${filename}】\n${text}\n`
                        });
                    } else {
                        dropped.push(label);
                    }
                    continue;
                }

                // 图片 / PDF 等：一律内联为 base64 data URL 交给模型（不做能力门禁）
                nextParts.push({
                    type: 'file',
                    mediaType,
                    filename,
                    url: toBase64DataUrl(file.data, mediaType)
                });
            }

            if (!changed) return msg;
            if (dropped.length > 0) {
                nextParts.push({
                    type: 'text',
                    text: `\n\n（已忽略 ${dropped.length} 个已失效或无法解析的附件：${dropped.join('、')}）`
                });
            }
            return { ...msg, parts: nextParts } as UIMessage;
        })
    );
}
