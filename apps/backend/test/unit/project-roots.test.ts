import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProjectRoot, SavedProject } from '@/modules/projects';
import {
    allRootPaths,
    buildInjectedProject,
    normalizeRoots,
    primaryRootPath,
    resolveEffectiveRoots,
    validateDir
} from '@/modules/projects';

import type { TempData } from '../helpers/temp-data';
import { createTempData } from '../helpers/temp-data';

describe('project roots normalization', () => {
    it('handles empty roots', () => {
        expect(normalizeRoots({})).toEqual([]);
        expect(normalizeRoots({ roots: [] })).toEqual([]);
        expect(primaryRootPath({})).toBeUndefined();
        expect(allRootPaths({})).toEqual([]);
    });

    it('filters malformed roots before selecting exactly one primary without mutating input', () => {
        const roots = [null, {}, { path: '' }, { path: 42 }, { path: '/one' }, { path: '/two' }];
        const original = structuredClone(roots);
        expect(normalizeRoots({ roots: roots as unknown as ProjectRoot[] })).toEqual([
            { path: '/one', primary: true },
            { path: '/two', primary: false }
        ]);
        expect(roots).toEqual(original);
        expect(normalizeRoots({ roots: [null] as unknown as ProjectRoot[] })).toEqual([]);
    });

    it('keeps only the first explicit primary', () => {
        const input = {
            roots: [
                { path: '/additional' },
                { path: '/primary', primary: true },
                { path: '/extra-primary', primary: true }
            ]
        };
        expect(normalizeRoots(input)).toEqual([
            { path: '/additional', primary: false },
            { path: '/primary', primary: true },
            { path: '/extra-primary', primary: false }
        ]);
        expect(primaryRootPath(input)).toBe('/primary');
        expect(allRootPaths(input)).toEqual(['/primary', '/additional', '/extra-primary']);
        expect(input.roots[2].primary).toBe(true);
    });
});

describe('project roots filesystem validation', () => {
    let temp: TempData;
    beforeEach(async () => {
        temp = await createTempData();
    });
    afterEach(async () => {
        await temp.cleanup();
    });

    it('rejects relative, missing and file paths, and accepts an existing directory', async () => {
        const file = path.join(temp.root, 'not-a-directory');
        await fs.writeFile(file, 'content');
        await expect(validateDir('relative/path')).resolves.toEqual({ ok: false, reason: '请填写绝对路径' });
        await expect(validateDir(path.join(temp.root, 'missing'))).resolves.toEqual({
            ok: false,
            reason: '目录不存在或无访问权限'
        });
        await expect(validateDir(file)).resolves.toEqual({ ok: false, reason: '该路径不是文件夹' });
        await expect(validateDir(temp.root)).resolves.toEqual({ ok: true });
    });

    it('does not resolve unconfigured roots', async () => {
        await expect(resolveEffectiveRoots(undefined)).resolves.toEqual({ additionalDirs: [], warnings: [] });
        await expect(resolveEffectiveRoots([])).resolves.toEqual({ additionalDirs: [], warnings: [] });
    });

    it('chooses the explicit primary and drops missing additional roots with a warning', async () => {
        await fs.mkdir(temp.projects);
        await fs.mkdir(temp.tasks);
        const missing = path.join(temp.root, 'missing');
        await expect(
            resolveEffectiveRoots([{ path: temp.tasks }, { path: temp.projects, primary: true }, { path: missing }])
        ).resolves.toEqual({
            primaryDir: temp.projects,
            additionalDirs: [temp.tasks],
            warnings: [`项目附加目录「${missing}」不存在或不可访问，本轮已忽略。`]
        });
    });

    it('falls back for a deleted primary and probes again after the directory is restored', async () => {
        await fs.mkdir(temp.projects);
        await fs.mkdir(temp.tasks);
        const roots = [{ path: temp.projects }, { path: temp.tasks }];
        await expect(resolveEffectiveRoots(roots)).resolves.toEqual({
            primaryDir: temp.projects,
            additionalDirs: [temp.tasks],
            warnings: []
        });
        await fs.rm(temp.projects, { recursive: true });
        await expect(resolveEffectiveRoots(roots)).resolves.toEqual({
            additionalDirs: [temp.tasks],
            warnings: [`项目主工作目录「${temp.projects}」不存在或不可访问，本轮回落到临时工作区。`]
        });
        await fs.mkdir(temp.projects);
        await expect(resolveEffectiveRoots(roots)).resolves.toEqual({
            primaryDir: temp.projects,
            additionalDirs: [temp.tasks],
            warnings: []
        });
    });
});

describe('project prompt injection', () => {
    const project: SavedProject = { version: 1, id: 'demo', name: 'Demo', createdAt: 1, updatedAt: 1 };

    it('omits missing and blank instructions and trims surrounding whitespace', () => {
        expect(buildInjectedProject(null)).toBe('');
        expect(buildInjectedProject(project)).toBe('');
        expect(buildInjectedProject({ ...project, instructions: '  \n  ' })).toBe('');
        expect(buildInjectedProject({ ...project, instructions: '  请先检查依据\n  ' })).toBe(
            '## 项目背景与要求\n以下是当前项目「Demo」的长期设定，请在本轮对话中遵循：\n\n请先检查依据'
        );
    });

    it('truncates only instructions exceeding the 4000-character budget', () => {
        const exact = '医'.repeat(4000);
        expect(buildInjectedProject({ ...project, instructions: exact })).toContain(`\n\n${exact}`);
        expect(buildInjectedProject({ ...project, instructions: exact })).not.toContain('…');
        const injected = buildInjectedProject({ ...project, instructions: `${exact}超限` });
        expect(injected).toContain(`\n\n${exact}…`);
        expect(injected).not.toContain('超限');
    });
});
