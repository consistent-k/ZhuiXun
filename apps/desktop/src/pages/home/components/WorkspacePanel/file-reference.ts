import type { WorkspaceFileReference } from '@zhuixun/shared';
import { createContext } from 'react';

export const FileTurnContext = createContext<string | undefined>(undefined);

/** 仅识别明确文件链接；普通代码文本和外网链接不转为本地路径。 */
export function parseFileReference(href: string, turnId?: string): WorkspaceFileReference | undefined {
    if (href.startsWith('/__zhuixun_file_reference__?')) {
        const query = new URLSearchParams(href.split('?')[1]);
        const file = query.get('path');
        const line = Number(query.get('line'));
        if (file)
            return {
                kind: 'workspace',
                path: file,
                name: file.split(/[/\\]/).at(-1) ?? file,
                turnId,
                ...(line > 0 ? { line } : {})
            };
        return;
    }
    const attachment = href.match(/\/api\/chat\/files\/([^/?#]+)\/([^/?#]+)/);
    if (attachment) return { kind: 'attachment', attachmentId: attachment[2], name: '附件', turnId };
    if (/^(?:https?:|mailto:|javascript:|data:|#)/i.test(href)) return;
    let file: string;
    try {
        file = decodeURIComponent(href);
    } catch {
        return;
    }
    if (file.startsWith('file://')) file = file.slice(7);
    if (!/^(?:\/|\.\.?[/\\]|[A-Za-z]:[/\\])/.test(file) && !/^[^:#?]+\.[a-z0-9]+((?::|#L)\d+)?$/i.test(file)) return;
    const line = file.match(/(?::|#L)(\d+)$/);
    if (line) file = file.slice(0, line.index);
    return {
        kind: 'workspace',
        path: file,
        name: file.split(/[/\\]/).at(-1) ?? file,
        turnId,
        ...(line ? { line: Number(line[1]) } : {})
    };
}
