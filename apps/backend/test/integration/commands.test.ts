import fs from 'node:fs/promises';
import path from 'node:path';

import type { UIMessage } from 'ai';
import { beforeEach, describe, expect, it } from 'vitest';

import { paths } from '@/config/paths';
import { expandCommandParts } from '@/modules/chat/commands';
import {
    CommandError,
    CommandStore,
    expandCommandText,
    expandTemplate,
    getCommandStore,
    parseCommandInvocation,
    splitArgs
} from '@/modules/commands';
import { parseCommandMarkdown, serializeCommandMarkdown } from '@/modules/commands/store';

const dir = () => paths.commandsDir();

beforeEach(async () => {
    await fs.rm(dir(), { recursive: true, force: true });
});

describe('slash command parsing and expansion', () => {
    it.each([
        ['/review src/a.ts', { name: 'review', args: 'src/a.ts' }],
        ['  /fix-bug\n多行\n说明', { name: 'fix-bug', args: '多行\n说明' }],
        ['/plan', { name: 'plan', args: '' }],
        ['/path/to/file', null],
        ['/ review', null],
        ['/Review', null],
        ['review', null],
        [`/${'a'.repeat(33)}`, null]
    ])('parses %j', (text, expected) => {
        expect(parseCommandInvocation(text)).toEqual(expected);
    });

    it('splits quoted args and expands $ARGUMENTS / $N placeholders', () => {
        expect(splitArgs(`a "b c" 'd e' f`)).toEqual(['a', 'b c', 'd e', 'f']);
        expect(expandTemplate('全部：$ARGUMENTS；第一：$1；第三：$3', 'x "y z"')).toBe(
            '全部：x "y z"；第一：x；第三：'
        );
        // 无占位符时把参数追加到末尾，避免用户输入被静默丢弃
        expect(expandTemplate('请审查代码\n', 'src/a.ts')).toBe('请审查代码\n\nsrc/a.ts');
        expect(expandTemplate('请审查代码', '')).toBe('请审查代码');
    });

    it('skips builtin and unknown commands', async () => {
        const lookup = async (name: string) => (name === 'review' ? '审查 $ARGUMENTS' : undefined);
        expect(await expandCommandText('/review a', lookup)).toEqual({
            matched: true,
            name: 'review',
            args: 'a',
            expanded: '审查 a'
        });
        expect(await expandCommandText('/compact 保留', lookup)).toEqual({ matched: false });
        expect(await expandCommandText('/missing', lookup)).toEqual({ matched: false });
        expect(await expandCommandText('hello', lookup)).toEqual({ matched: false });
    });
});

describe('command store', () => {
    it('round-trips frontmatter with quotes and colons, lists sorted and skips invalid files', async () => {
        const store = new CommandStore(dir());
        await expect(store.list()).resolves.toEqual([]);
        const saved = await store.save('review', {
            description: '审查: "代码"\n第二行',
            argumentHint: '<文件>',
            body: '  请审查 $ARGUMENTS  '
        });
        expect(saved).toEqual({
            name: 'review',
            description: '审查: "代码" 第二行',
            argumentHint: '<文件>',
            body: '请审查 $ARGUMENTS'
        });
        await store.save('alpha', { body: '无元信息' });
        expect(await fs.readFile(path.join(dir(), 'alpha.md'), 'utf8')).toBe('无元信息\n');
        await fs.writeFile(path.join(dir(), 'broken.md'), '---\na: [\n---\nx');
        await fs.writeFile(path.join(dir(), 'Bad Name.md'), 'x');
        await fs.writeFile(path.join(dir(), 'new.md'), '内置同名');
        await fs.writeFile(path.join(dir(), 'notes.txt'), 'x');
        await fs.writeFile(path.join(dir(), 'bom.md'), '﻿---\ndescription: 带 BOM\n---\n正文');
        expect(await store.list()).toEqual([
            { name: 'alpha', description: undefined, argumentHint: undefined },
            { name: 'bom', description: '带 BOM', argumentHint: undefined },
            { name: 'review', description: '审查: "代码" 第二行', argumentHint: '<文件>' }
        ]);
        await expect(store.get('new')).resolves.toBeNull();
        await expect(store.get('../x')).resolves.toBeNull();
        await expect(store.bodyOf('review')).resolves.toBe('请审查 $ARGUMENTS');
        await expect(store.bodyOf('missing')).resolves.toBeUndefined();
        await store.delete('review');
        await store.delete('review');
        await expect(store.get('review')).resolves.toBeNull();
    });

    it('rejects invalid names, builtin names and bad bodies', async () => {
        const store = getCommandStore();
        for (const name of ['../x', 'UP', '', 'compact', 'help']) {
            await expect(store.save(name, { body: 'x' })).rejects.toBeInstanceOf(CommandError);
        }
        await expect(store.save('ok', { body: '  ' })).rejects.toThrow('不能为空');
        await expect(store.save('ok', { body: 'x'.repeat(20_001) })).rejects.toThrow('过长');
        await expect(store.delete('../x')).rejects.toThrow('非法');
    });

    it('cleans up the temp file when the target cannot be written', async () => {
        const store = new CommandStore(dir());
        await fs.mkdir(path.join(dir(), 'locked.md'), { recursive: true });
        await expect(store.save('locked', { body: 'x' })).rejects.toThrow();
        expect((await fs.readdir(dir())).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    it('treats an unreadable directory as empty and parses bare markdown', async () => {
        await fs.mkdir(path.dirname(dir()), { recursive: true });
        await fs.writeFile(dir(), 'not a dir');
        await expect(new CommandStore(dir()).list()).resolves.toEqual([]);
        await fs.rm(dir());
        expect(parseCommandMarkdown('x', '只有正文')).toEqual({ name: 'x', body: '只有正文' });
        expect(serializeCommandMarkdown({ body: 'b', description: ' ', argumentHint: undefined })).toBe('b\n');
    });
});

describe('expandCommandParts', () => {
    const user = (id: string, parts: unknown[]): UIMessage => ({
        id,
        role: 'user',
        parts: parts as UIMessage['parts']
    });

    it('uses data-command snapshots for every user message and keeps attachments', async () => {
        const file = { type: 'file', mediaType: 'image/png', url: 'http://x/a.png' };
        const messages = [
            user('u1', [
                { type: 'text', text: '/review a' },
                file,
                { type: 'data-command', data: { name: 'review', args: 'a', expanded: '审查 a（旧版模板）' } }
            ]),
            { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] } as UIMessage,
            user('u2', [{ type: 'text', text: '普通问题' }])
        ];
        const out = await expandCommandParts(messages);
        expect(out[0].parts).toEqual([{ type: 'text', text: '审查 a（旧版模板）' }, file]);
        expect(out[1]).toBe(messages[1]);
        expect(out[2]).toBe(messages[2]);
        expect(messages[0].parts).toHaveLength(3);
    });

    it('falls back to the command store for the last user message only and ignores malformed parts', async () => {
        await getCommandStore().save('plan', { body: '制定计划：$ARGUMENTS' });
        const out = await expandCommandParts([
            user('u1', [{ type: 'text', text: '/plan 旧' }]),
            user('u2', [
                { type: 'data-command', data: { name: 1 } },
                { type: 'text', text: '/plan 新需求' }
            ])
        ]);
        expect(out[0].parts).toEqual([{ type: 'text', text: '/plan 旧' }]);
        expect(out[1].parts).toEqual([{ type: 'text', text: '制定计划：新需求' }]);
        const miss = await expandCommandParts([user('u', [{ type: 'text', text: '/usr/bin 是什么' }])]);
        expect(miss[0].parts).toEqual([{ type: 'text', text: '/usr/bin 是什么' }]);
        const noParts = await expandCommandParts([{ id: 'x', role: 'user' } as unknown as UIMessage]);
        expect(noParts).toHaveLength(1);
    });

    it('keeps the original text when the store lookup fails', async () => {
        await fs.mkdir(path.join(dir(), 'boom.md'), { recursive: true });
        const out = await expandCommandParts([user('u', [{ type: 'text', text: '/boom x' }])]);
        expect(out[0].parts).toEqual([{ type: 'text', text: '/boom x' }]);
        const data = await expandCommandParts([
            user('u', [{ type: 'data-command', data: { name: 'r', expanded: 'e' } }])
        ]);
        expect(data[0].parts).toEqual([{ type: 'text', text: 'e' }]);
    });
});
