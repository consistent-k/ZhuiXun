import fs from 'node:fs/promises';
import path from 'node:path';

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readSkillSource, serializeSkillMarkdown } from '@/modules/skills/loader';
import {
    deleteUserSkill,
    exportSkillToZip,
    importSkillFromMarkdown,
    importSkillFromZip,
    readSkillsState,
    userSkillExists,
    writeSkillsState,
    writeUserSkill
} from '@/modules/skills/store';

import { createTempData } from '../helpers/temp-data';
import type { TempData } from '../helpers/temp-data';

let temp: TempData;
const markdown = (name = 'sample', body = '示例正文') =>
    serializeSkillMarkdown({ name, description: '描述: 示例', systemPrompt: body });
const archive = (files: Record<string, string | Uint8Array>) =>
    zipSync(
        Object.fromEntries(
            Object.entries(files).map(([name, value]) => [name, typeof value === 'string' ? strToU8(value) : value])
        )
    );
const skillFile = (...parts: string[]) => path.join(temp.skills, 'sample', ...parts);

beforeEach(async () => {
    temp = await createTempData('skills-store-');
});
afterEach(async () => {
    vi.restoreAllMocks();
    await temp.cleanup();
});

describe('skills store disk and state', () => {
    it('writes, replaces and deletes user skills without removing sibling directories', async () => {
        await expect(userSkillExists(temp.skills, 'sample')).resolves.toBe(false);
        await expect(userSkillExists(temp.skills, '../escape')).resolves.toBe(false);
        const input = { name: 'sample', description: 'first', systemPrompt: 'first body' };
        await expect(writeUserSkill(temp.skills, input)).resolves.toBe(path.join(temp.skills, 'sample'));
        await expect(userSkillExists(temp.skills, 'sample')).resolves.toBe(true);
        await writeUserSkill(temp.skills, { ...input, description: 'second', systemPrompt: 'second body' });
        await expect(readSkillSource(path.join(temp.skills, 'sample'))).resolves.toMatchObject({
            description: 'second',
            systemPrompt: 'second body'
        });
        await writeUserSkill(temp.skills, { ...input, name: 'sibling' });
        await fs.mkdir(skillFile('references'));
        await fs.writeFile(skillFile('references', 'note.md'), 'resource');
        await deleteUserSkill(temp.skills, 'sample');
        await deleteUserSkill(temp.skills, 'sample');
        await expect(userSkillExists(temp.skills, 'sample')).resolves.toBe(false);
        await expect(userSkillExists(temp.skills, 'sibling')).resolves.toBe(true);
        await fs.mkdir(skillFile('SKILL.md'), { recursive: true });
        await expect(userSkillExists(temp.skills, 'sample')).resolves.toBe(false);
        await expect(writeUserSkill(temp.skills, { ...input, name: '../escape' })).rejects.toThrow('非法技能 id');
        await expect(deleteUserSkill(temp.skills, '../escape')).rejects.toThrow('非法技能 id');
    });

    it.each(['not json', 'null', '{}', '{"disabled": "sample"}'])('defaults invalid state %s to empty', async (raw) => {
        await fs.mkdir(temp.skills, { recursive: true });
        await fs.writeFile(path.join(temp.skills, 'skills-state.json'), raw);
        await expect(readSkillsState(temp.skills)).resolves.toEqual({ disabled: [] });
    });

    it('filters non-string disabled values and persists an atomic JSON state without temp files', async () => {
        await expect(readSkillsState(temp.skills)).resolves.toEqual({ disabled: [] });
        await fs.mkdir(temp.skills, { recursive: true });
        await fs.writeFile(path.join(temp.skills, 'skills-state.json'), '{"disabled":["one",1,null,false,"two"]}');
        await expect(readSkillsState(temp.skills)).resolves.toEqual({ disabled: ['one', 'two'] });
        await writeSkillsState(temp.skills, { disabled: ['sample'] });
        await expect(readSkillsState(temp.skills)).resolves.toEqual({ disabled: ['sample'] });
        expect(await fs.readdir(temp.skills)).toEqual(['skills-state.json']);
    });
});

describe('skills store markdown import', () => {
    it('preserves source text exactly and replaces an existing markdown file', async () => {
        const content = '﻿' + markdown().replaceAll('\n', '\r\n');
        await expect(importSkillFromMarkdown(temp.skills, content)).resolves.toBe('sample');
        expect(await fs.readFile(skillFile('SKILL.md'), 'utf8')).toBe(content);
        await importSkillFromMarkdown(temp.skills, markdown('sample', 'replacement'));
        expect(await fs.readFile(skillFile('SKILL.md'), 'utf8')).toBe(markdown('sample', 'replacement'));
    });

    it.each([
        ['not markdown', 'missing frontmatter'],
        ['---\ndescription: no name\n---\nbody', '缺少 name'],
        ['---\nname: ../escape\n---\nbody', 'name 非法'],
        ['---\nname: Invalid\n---\nbody', 'name 非法']
    ])('rejects invalid import before writing: %s', async (content, error) => {
        await expect(importSkillFromMarkdown(temp.skills, content)).rejects.toThrow(error);
        expect(await fs.readdir(temp.root)).toEqual([]);
    });
});

describe('skills store zip import and export', () => {
    it('imports nested resources, filters scripts/tools and round-trips portable resources', async () => {
        const bytes = archive({
            'package/SKILL.md': markdown(),
            'package/references/nested/guide.md': '参考',
            'package/examples/sample.json': '{"ok": true}',
            'package/references/': new Uint8Array(),
            'package/tools/index.js': "throw new Error('untrusted tools must never load')",
            'package/scripts/run.sh': 'not executable',
            'package/README.md': 'not allowlisted',
            'outside.txt': 'outside package'
        });
        await expect(importSkillFromZip(temp.skills, bytes)).resolves.toBe('sample');
        expect(await fs.readdir(path.join(temp.skills, 'sample'))).toEqual(['SKILL.md', 'examples', 'references']);
        expect(await fs.readFile(skillFile('references/nested/guide.md'), 'utf8')).toBe('参考');
        const exported = unzipSync(await exportSkillToZip(path.join(temp.skills, 'sample')));
        expect(Object.keys(exported).sort()).toEqual([
            'SKILL.md',
            'examples/sample.json',
            'references/nested/guide.md'
        ]);
        expect(strFromU8(exported['SKILL.md'])).toBe(markdown());
        expect(strFromU8(exported['references/nested/guide.md'])).toBe('参考');
        await fs.mkdir(skillFile('references/empty'));
        await fs.symlink(path.join(temp.root, 'missing'), skillFile('references/broken-link'));
        const reexported = unzipSync(await exportSkillToZip(path.join(temp.skills, 'sample')));
        expect(Object.keys(reexported).sort()).toEqual(Object.keys(exported).sort());
    });

    it('prefers root SKILL.md and supports resource-free exports', async () => {
        await importSkillFromZip(
            temp.skills,
            archive({
                'nested/SKILL.md': markdown('other'),
                'SKILL.md': markdown()
            })
        );
        expect(strFromU8(unzipSync(await exportSkillToZip(path.join(temp.skills, 'sample')))['SKILL.md'])).toBe(
            markdown()
        );
        await expect(userSkillExists(temp.skills, 'other')).resolves.toBe(false);
        await expect(exportSkillToZip(path.join(temp.skills, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('supports rewrite and explicit resource allowlist while never importing automatically executed tools', async () => {
        await importSkillFromZip(
            temp.skills,
            archive({
                'SKILL.md': markdown('before'),
                'scripts/run.sh': 'reference script',
                'references/drop.md': 'excluded',
                'tools/index.js': 'throw new Error("must not load")'
            }),
            {
                rewriteSkillMd: (source) => source.replace('name: before', 'name: sample'),
                allowedResourceDirs: ['scripts/', 'tools/']
            }
        );
        expect(await fs.readdir(path.join(temp.skills, 'sample'))).toEqual(['SKILL.md', 'scripts']);
        expect(await fs.readFile(skillFile('scripts/run.sh'), 'utf8')).toBe('reference script');
    });

    it('denylist takes precedence, excludes hidden segments and cannot allow tools even with an empty denylist', async () => {
        const bytes = archive({
            'SKILL.md': markdown(),
            'README.md': 'readme',
            'hooks/review.md': 'hook documentation',
            'references/.secret': 'hidden',
            '.git/config': 'hidden',
            'tools/index.js': 'untrusted code',
            'TOOLS/index.js': 'case alias must not load',
            'Tools. /index.js': 'Windows directory alias must not load',
            blocked: 'explicitly denied file',
            'excluded/readme.md': 'explicitly denied dir'
        });
        await importSkillFromZip(temp.skills, bytes, {
            allowedResourceDirs: [],
            blockedResourceDirs: ['blocked/', 'excluded/']
        });
        expect(await fs.readdir(path.join(temp.skills, 'sample'))).toEqual(['README.md', 'SKILL.md', 'hooks']);
        await importSkillFromZip(temp.skills, bytes, { blockedResourceDirs: [] });
        expect(await fs.readdir(path.join(temp.skills, 'sample'))).toEqual([
            'README.md',
            'SKILL.md',
            'blocked',
            'excluded',
            'hooks'
        ]);
        await expect(fs.stat(skillFile('tools'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('replaces old resources on successful reimport', async () => {
        await importSkillFromZip(temp.skills, archive({ 'SKILL.md': markdown(), 'references/old.md': 'old' }));
        await importSkillFromZip(
            temp.skills,
            archive({ 'SKILL.md': markdown('sample', 'new'), 'examples/new.md': 'new' })
        );
        expect(await fs.readdir(path.join(temp.skills, 'sample'))).toEqual(['SKILL.md', 'examples']);
        expect(await fs.readFile(skillFile('SKILL.md'), 'utf8')).toBe(markdown('sample', 'new'));
        expect(await fs.readdir(temp.skills)).toEqual(['sample']);
    });

    it.each([
        '../escape.md',
        'references/../../escape.md',
        'package/../escape.md',
        '/absolute.md',
        'C:/absolute.md',
        'references\\nested.md',
        'references/bad\0name.md',
        './SKILL.md',
        'references/./alias.md'
    ])('rejects zip traversal %s without changing old skill', async (unsafe) => {
        await importSkillFromMarkdown(temp.skills, markdown('sample', 'old'));
        await expect(
            importSkillFromZip(temp.skills, archive({ 'SKILL.md': markdown(), [unsafe]: 'escaped' }))
        ).rejects.toThrow('非法路径');
        expect(await fs.readFile(skillFile('SKILL.md'), 'utf8')).toBe(markdown('sample', 'old'));
        expect(await fs.readdir(temp.root)).toEqual(['skills']);
        expect(await fs.readdir(temp.skills)).toEqual(['sample']);
    });

    it('rejects missing markdown, invalid archives, and invalid names', async () => {
        await expect(importSkillFromZip(temp.skills, archive({ 'README.md': 'no skill' }))).rejects.toThrow(
            '缺少 SKILL.md'
        );
        await expect(importSkillFromZip(temp.skills, archive({ '../SKILL.md': markdown() }))).rejects.toThrow();
        await expect(importSkillFromZip(temp.skills, new Uint8Array([1, 2, 3]))).rejects.toThrow();
        await expect(importSkillFromZip(temp.skills, archive({ 'SKILL.md': markdown('UPPER') }))).rejects.toThrow(
            'name 非法'
        );
        expect(await fs.readdir(temp.root)).toEqual([]);
    });

    it('rejects retained files above 2 MiB and total retained bytes above 15 MiB', async () => {
        await expect(
            importSkillFromZip(
                temp.skills,
                archive({
                    'SKILL.md': markdown(),
                    'references/large.bin': new Uint8Array(2 * 1024 * 1024 + 1)
                })
            )
        ).rejects.toThrow('文件过大');
        const files: Record<string, string | Uint8Array> = { 'SKILL.md': markdown() };
        for (let i = 0; i < 8; i++) files[`references/chunk-${i}.bin`] = new Uint8Array(2 * 1024 * 1024);
        await expect(importSkillFromZip(temp.skills, archive(files))).rejects.toThrow('体积超限');
        expect(await fs.readdir(temp.root)).toEqual([]);
    });

    it('applies the single-file bound to SKILL.md, not just its resources', async () => {
        await expect(
            importSkillFromZip(
                temp.skills,
                archive({
                    'SKILL.md': markdown('sample', 'x'.repeat(2 * 1024 * 1024))
                })
            )
        ).rejects.toThrow('文件过大');
        expect(await fs.readdir(temp.root)).toEqual([]);
    });

    it('limits rewritten markdown too and skips unselected oversized resources without decompressing them', async () => {
        await expect(
            importSkillFromZip(temp.skills, archive({ 'SKILL.md': markdown() }), {
                rewriteSkillMd: () => markdown('sample', 'x'.repeat(2 * 1024 * 1024))
            })
        ).rejects.toThrow('文件过大');
        await expect(
            importSkillFromZip(
                temp.skills,
                archive({
                    'SKILL.md': markdown(),
                    'tools/huge.bin': new Uint8Array(3 * 1024 * 1024),
                    'ignored/huge.bin': new Uint8Array(3 * 1024 * 1024)
                })
            )
        ).resolves.toBe('sample');
        expect(await fs.readdir(path.join(temp.skills, 'sample'))).toEqual(['SKILL.md']);
    });

    it('accepts 300 total files but rejects 301 without replacing an existing skill', async () => {
        const files: Record<string, string> = { 'SKILL.md': markdown() };
        for (let i = 0; i < 299; i++) files[`references/${i}.md`] = 'small';
        await importSkillFromZip(temp.skills, archive(files));
        expect(await fs.readdir(skillFile('references'))).toHaveLength(299);
        files['references/extra.md'] = 'one too many';
        await expect(importSkillFromZip(temp.skills, archive(files))).rejects.toThrow('文件数超限');
        expect(await fs.readdir(skillFile('references'))).toHaveLength(299);
        expect(await fs.readdir(temp.skills)).toEqual(['sample']);
    });

    it('cleans staging and retains old content when a resource write fails', async () => {
        await importSkillFromMarkdown(temp.skills, markdown('sample', 'old'));
        const original = fs.writeFile.bind(fs);
        vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
            if (String(args[0]).endsWith('fail.md')) throw new Error('injected disk write failure');
            return original(...args);
        });
        await expect(
            importSkillFromZip(
                temp.skills,
                archive({
                    'SKILL.md': markdown(),
                    'references/fail.md': 'cannot write'
                })
            )
        ).rejects.toThrow('injected disk write failure');
        expect(await fs.readFile(skillFile('SKILL.md'), 'utf8')).toBe(markdown('sample', 'old'));
        expect(await fs.readdir(temp.skills)).toEqual(['sample']);
    });
});
