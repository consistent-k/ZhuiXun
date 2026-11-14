import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as MCP from '@/modules/mcp';
import type * as Skills from '@/modules/skills';
import type * as Installer from '@/modules/skills/skillhub/installer';
import type * as Mapper from '@/modules/skills/skillhub/mapper';

let SkillRegistry: typeof Skills.SkillRegistry;
let MCPClientManager: typeof MCP.MCPClientManager;
let installMarketSkill: typeof Installer.installMarketSkill;
let normalizeSkillHubSkillMd: typeof Mapper.normalizeSkillHubSkillMd;
let root: string;
let userDir: string;
let registry: Skills.SkillRegistry;
const cfg = { apiBase: 'https://skillhub.invalid', timeoutMs: 1000 };
const markdown = (extra = '', body = '# Instructions\n\nUse references/guide.md.') =>
    `---\nslug: sample\ndescription: Test skill\n${extra}---\n\n${body}\n`;

beforeAll(async () => {
    // 公共 setup 必须先隔离 home 和全部配置路径，再导入会初始化路径/日志/OAuth store 的真实模块。
    expect(process.env.ZHUIXUN_TEST_HOME).toBe(os.homedir());
    for (const key of [
        'SETTINGS_CONFIG_PATH',
        'MCP_CONFIG_PATH',
        'MCP_OAUTH_PATH',
        'SESSIONS_USER_DIR',
        'PROJECTS_USER_DIR',
        'TASKS_USER_DIR',
        'MEMORY_USER_DIR',
        'PERMISSION_USER_DIR',
        'STREAMS_USER_DIR',
        'SKILLS_USER_DIR',
        'SKILLS_EXTERNAL_DIRS',
        'LOG_DIR',
        'CHANNELS_USER_DIR'
    ]) {
        const relative = path.relative(os.homedir(), process.env[key] ?? '/unconfigured');
        expect(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)), key).toBe(true);
    }
    ({ SkillRegistry } = await import('@/modules/skills'));
    ({ MCPClientManager } = await import('@/modules/mcp'));
    ({ installMarketSkill } = await import('@/modules/skills/skillhub/installer'));
    ({ normalizeSkillHubSkillMd } = await import('@/modules/skills/skillhub/mapper'));
});

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhuixun-skillhub-'));
    userDir = path.join(root, 'skills');
    // 空 MCP 配置从不 connect，外部技能根显式为空，不能扫描真实 ~/.agents。
    registry = new SkillRegistry(new MCPClientManager([]), userDir, []);
});

afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
});

function serve(entries: Record<string, string | Uint8Array>) {
    const bytes = zipSync(
        Object.fromEntries(
            Object.entries(entries).map(([name, value]) => [name, typeof value === 'string' ? strToU8(value) : value])
        ),
        { level: 1 }
    );
    const transport = vi.fn<typeof fetch>().mockImplementation(
        async () =>
            new Response(new Uint8Array(bytes), {
                headers: { 'content-type': 'application/zip' }
            })
    );
    vi.stubGlobal('fetch', transport);
    return transport;
}

async function install(version?: string, canonical?: string, displayName?: string) {
    return installMarketSkill(registry, cfg, 'SAMPLE', version, undefined, canonical, displayName);
}

async function seedPrevious() {
    const dir = path.join(userDir, 'sample');
    await fs.mkdir(dir, { recursive: true });
    const old = '---\nname: sample\ndescription: Old skill\n---\n\nKeep this old body.\n';
    await fs.writeFile(path.join(dir, 'SKILL.md'), old);
    await fs.writeFile(path.join(dir, 'old.txt'), 'previous resource');
    await registry.scan();
    return old;
}

async function expectPrevious(old: string) {
    expect(await fs.readFile(path.join(userDir, 'sample/SKILL.md'), 'utf8')).toBe(old);
    expect(await fs.readFile(path.join(userDir, 'sample/old.txt'), 'utf8')).toBe('previous resource');
    expect(await fs.readdir(userDir)).toEqual(['sample']);
    expect(registry.getMetadataById('sample')?.description).toBe('Old skill');
}

describe('SkillHub installer with real registry and temporary disk', () => {
    it('installs nested zip, strips load-time tools/hidden files, and keeps inert resources/provenance', async () => {
        const transport = serve({
            'bundle/SKILL.md': markdown('version: 2.3.4\nauthor: Example\nlicense: MIT\n'),
            'bundle/tools/index.js': 'throw new Error("must never execute")',
            'bundle/tools/deep/payload.js': 'untrusted tool data',
            'bundle/references/guide.md': 'reference',
            'bundle/examples/demo.md': 'example',
            'bundle/scripts/task.sh': 'inert script bytes',
            'bundle/hooks/pre.sh': 'inert hook bytes',
            'bundle/README.md': 'readme',
            'bundle/FAQ.txt': 'faq',
            'bundle/.git/config': 'hidden',
            'bundle/references/.private/data': 'hidden nested',
            'bundle/.DS_Store': 'hidden mac data',
            'bundle/empty/': new Uint8Array(),
            'outside.txt': 'outside bundle'
        });
        const signal = new AbortController().signal;
        await expect(
            installMarketSkill(registry, cfg, 'SAMPLE', 'v1.0', signal, ' @Team/sample ', ' 市场展示名 ')
        ).resolves.toEqual({ id: 'team-sample', slug: 'sample', version: '2.3.4', canonicalName: '@Team/sample' });
        const [url, init] = transport.mock.calls[0];
        expect(new URL(String(url)).searchParams.get('namespace')).toBe('@Team');
        expect(init?.signal).toBe(signal);
        expect(init?.redirect).toBe('follow');
        const dir = path.join(userDir, 'team-sample');
        expect((await fs.readdir(dir)).sort()).toEqual([
            'FAQ.txt',
            'README.md',
            'SKILL.md',
            'examples',
            'hooks',
            'references',
            'scripts'
        ]);
        for (const [file, content] of Object.entries({
            'references/guide.md': 'reference',
            'examples/demo.md': 'example',
            'scripts/task.sh': 'inert script bytes',
            'hooks/pre.sh': 'inert hook bytes',
            'README.md': 'readme',
            'FAQ.txt': 'faq'
        }))
            expect(await fs.readFile(path.join(dir, file), 'utf8')).toBe(content);
        expect(await fs.readdir(path.join(dir, 'references'))).toEqual(['guide.md']);
        expect(await fs.readdir(userDir)).toEqual(['team-sample']);
        const md = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
        expect(md).toContain(
            'source_slug: sample | source_version: 2.3.4 | source_author: Example | source_license: MIT'
        );
        expect(md).toContain('# Instructions\n\nUse references/guide.md.');
        expect(registry.getMetadataById('team-sample')).toMatchObject({
            name: '市场展示名',
            source: 'user',
            editable: true,
            sourceCanonical: '@Team/sample'
        });
        // 调用真实 loader，证明 tools/index.js 未落盘且 scripts/hooks 不会被自动执行。
        const loaded = await registry.load('team-sample');
        expect(loaded?.tools).toEqual({});
        expect(loaded?.toolInfo).toEqual([]);
        expect(loaded?.systemPrompt).toContain('# Instructions');
    });

    it('keeps same-slug namespaces separate and replaces only the reinstalled namespace', async () => {
        serve({ 'SKILL.md': markdown('version: 1\n'), 'old.txt': 'first' });
        await install(undefined, '@one/sample');
        await install(undefined, '@two/sample');
        expect(
            registry
                .listMetadata()
                .map((meta) => meta.id)
                .sort()
        ).toEqual(['one-sample', 'two-sample']);
        serve({ 'SKILL.md': markdown('version: 2\n', 'updated body'), 'new.txt': 'second' });
        await expect(install(undefined, '@one/sample')).resolves.toMatchObject({ id: 'one-sample', version: '2' });
        expect((await fs.readdir(path.join(userDir, 'one-sample'))).sort()).toEqual(['SKILL.md', 'new.txt']);
        expect(await fs.readFile(path.join(userDir, 'two-sample/old.txt'), 'utf8')).toBe('first');
        expect(registry.getMetadataById('two-sample')?.sourceCanonical).toBe('@two/sample');
        expect(await fs.readdir(userDir)).toHaveLength(2);
    });

    it('prefers root SKILL.md over nested alternatives and falls back to requested version', async () => {
        serve({
            'nested/SKILL.md': markdown('version: 9.9\n', 'nested body'),
            'SKILL.md': markdown('', 'root body')
        });
        await expect(install(' v1.4 ')).resolves.toEqual({
            id: 'sample',
            slug: 'sample',
            version: 'v1.4',
            canonicalName: undefined
        });
        expect((await registry.getSkillSource('sample'))?.systemPrompt).toContain('root body');
        serve({ 'SKILL.md': markdown() });
        await expect(install()).resolves.toMatchObject({ version: '' });
    });

    it.each([
        [{ 'README.md': 'no skill here' }, '技能包缺少 SKILL.md'],
        [{ 'SKILL.md': 'broken markdown' }, 'missing frontmatter'],
        [{ 'SKILL.md': '---\nslug: [broken\n---\nbody' }, 'Flow sequence'],
        [{ 'SKILL.md': markdown(), '../escape.txt': 'escape' }, '非法路径'],
        [{ 'bad/../SKILL.md': markdown() }, '技能包含非法路径：bad/../SKILL.md'],
        [{ 'SKILL.md': '---\nslug: bad_slug\n---\nbody' }, '不符合命名规则']
    ])('rejects invalid archive %# without changing previous version', async (entries, error) => {
        const old = await seedPrevious();
        serve(entries);
        await expect(install()).rejects.toThrow(error);
        await expectPrevious(old);
        expect(await fs.readdir(root)).toEqual(['skills']);
    });

    it('rejects corrupt ZIP after nonfatal source-version probe without touching disk', async () => {
        const old = await seedPrevious();
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([0x50, 0x4b, 0, 0])))
        );
        await expect(install()).rejects.toThrow();
        await expectPrevious(old);
    });

    it('leaves old skill intact on HTTP failure or abort and never creates staging', async () => {
        const old = await seedPrevious();
        vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('failure', { status: 502 })));
        await expect(install()).rejects.toThrow('下载失败 HTTP 502');
        await expectPrevious(old);
        const aborted = new DOMException('request aborted', 'AbortError');
        vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(aborted));
        await expect(install()).rejects.toBe(aborted);
        await expectPrevious(old);
    });

    it('cleans real staging and preserves old skill when resource writes fail', async () => {
        const old = await seedPrevious();
        // 不 mock store/installer：先写成文件再要求其为目录，真实 FS 确定性触发 ENOTDIR/EEXIST。
        serve({ 'SKILL.md': markdown(), 'references/conflict': 'file', 'references/conflict/child.txt': 'child' });
        await expect(install()).rejects.toMatchObject({ code: expect.stringMatching(/^(EEXIST|ENOTDIR)$/) });
        await expectPrevious(old);
        serve({ 'SKILL.md': markdown('', 'retry after cleanup') });
        await expect(install()).resolves.toMatchObject({ id: 'sample' });
        expect(await fs.readdir(userDir)).toEqual(['sample']);
        expect((await registry.getSkillSource('sample'))?.systemPrompt).toContain('retry after cleanup');
    });

    it('cleans staging on failed first install and allows a subsequent valid install', async () => {
        serve({ 'SKILL.md': markdown(), 'SKILL.md/child.txt': 'conflicts with staged markdown' });
        await expect(install()).rejects.toMatchObject({ code: expect.stringMatching(/^(EEXIST|ENOTDIR)$/) });
        expect(await fs.readdir(userDir)).toEqual([]);
        expect(registry.listMetadata()).toEqual([]);
        serve({ 'SKILL.md': markdown() });
        await expect(install()).resolves.toMatchObject({ id: 'sample' });
        expect(await fs.readdir(userDir)).toEqual(['sample']);
    });

    it('enforces per-resource 2 MiB boundary but does not count filtered tools', async () => {
        serve({
            'SKILL.md': markdown(),
            'references/boundary': new Uint8Array(2 * 1024 * 1024),
            'tools/large.js': new Uint8Array(2 * 1024 * 1024 + 1)
        });
        await expect(install()).resolves.toMatchObject({ id: 'sample' });
        expect((await fs.stat(path.join(userDir, 'sample/references/boundary'))).size).toBe(2 * 1024 * 1024);
        expect(await fs.readdir(path.join(userDir, 'sample'))).not.toContain('tools');
        const old = await fs.readFile(path.join(userDir, 'sample/SKILL.md'), 'utf8');
        serve({ 'SKILL.md': markdown(), 'references/oversized': new Uint8Array(2 * 1024 * 1024 + 1) });
        await expect(install()).rejects.toThrow('技能包文件过大：references/oversized');
        expect(await fs.readFile(path.join(userDir, 'sample/SKILL.md'), 'utf8')).toBe(old);
        expect(await fs.readdir(userDir)).toEqual(['sample']);
    });

    it('accepts 300 retained files including SKILL.md and rejects the 301st', async () => {
        const entries: Record<string, string> = { 'SKILL.md': markdown() };
        for (let i = 0; i < 299; i++) entries[`resources/${i}.txt`] = 'data';
        serve(entries);
        await expect(install()).resolves.toMatchObject({ id: 'sample' });
        expect(await fs.readdir(path.join(userDir, 'sample/resources'))).toHaveLength(299);
        serve({ ...entries, 'resources/extra.txt': 'data' });
        await expect(install()).rejects.toThrow('技能包文件数超限');
        expect(await fs.readdir(path.join(userDir, 'sample/resources'))).toHaveLength(299);
        expect(await fs.readdir(userDir)).toEqual(['sample']);
    });

    it('checks 15 MiB uncompressed total after rewrite, accepting exact limit and rejecting one byte over', async () => {
        const md = markdown();
        const entries: Record<string, string | Uint8Array> = { 'SKILL.md': md };
        const remaining = 15 * 1024 * 1024 - strToU8(normalizeSkillHubSkillMd(md)).byteLength;
        let left = remaining;
        for (let i = 0; left > 0; i++) {
            const size = Math.min(left, 2 * 1024 * 1024);
            entries[`resources/${i}.bin`] = new Uint8Array(size);
            left -= size;
        }
        serve(entries);
        await expect(install()).resolves.toMatchObject({ id: 'sample' });
        const resourceFiles = await fs.readdir(path.join(userDir, 'sample/resources'));
        expect(resourceFiles).toHaveLength(8);
        serve({ ...entries, 'extra-byte': new Uint8Array(1) });
        await expect(install()).rejects.toThrow('技能包体积超限');
        expect(await fs.readdir(userDir)).toEqual(['sample']);
        expect(await fs.readdir(path.join(userDir, 'sample/resources'))).toEqual(resourceFiles);
    });
});
