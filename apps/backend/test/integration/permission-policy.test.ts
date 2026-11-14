import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { paths } from '@/config/paths';
import { BUILTIN_BASELINE, createPermissionStore, loadBaseline, PolicyEngine } from '@/modules/permission';
import { flushPermissionAudit, recordPermissionAudit } from '@/modules/permission/policy';

import type { TempData } from '../helpers/temp-data';
import { createTempData } from '../helpers/temp-data';

let temp: TempData;
let policyFile: string;
let store: ReturnType<typeof createPermissionStore>;

beforeEach(async () => {
    temp = await createTempData('zhuixun-policy-');
    policyFile = path.join(temp.root, 'policy', 'permissions.json');
    vi.stubEnv('PERMISSION_POLICY_PATH', policyFile);
    store = createPermissionStore(path.join(temp.permissions, 'permissions.json'));
});
afterEach(async () => {
    vi.unstubAllEnvs();
    await temp.cleanup();
});

async function writePolicy(content: string) {
    await fs.mkdir(path.dirname(policyFile), { recursive: true });
    await fs.writeFile(policyFile, content);
}

describe('permission policy engine', () => {
    it('uses the built-in baseline when no external file exists', async () => {
        await expect(loadBaseline()).resolves.toEqual({ rules: BUILTIN_BASELINE, source: 'builtin' });
        const engine = new PolicyEngine(store);
        await expect(engine.evaluate('Read', { path: '.env' }, { cwd: temp.root })).resolves.toMatchObject({
            decision: 'deny',
            source: 'baseline'
        });
        expect(await engine.grepExcludeGlobs()).toContain('!**/.env');
        await expect(engine.view()).resolves.toMatchObject({
            baselineSource: 'builtin',
            baselinePath: policyFile,
            user: { deny: [], ask: [], allow: [] },
            invalid: []
        });
    });

    it('replaces the built-in baseline entirely with a valid external file and reloads on change', async () => {
        await writePolicy(JSON.stringify({ ask: ['Bash(curl:*)'], deny: ['Bad('] }));
        const engine = new PolicyEngine(store);
        // 外部基线整体替换：内置 Read(**/.env) deny 不再生效
        await expect(engine.evaluate('Read', { path: '.env' }, { cwd: temp.root })).resolves.toEqual({
            decision: 'none'
        });
        await expect(engine.evaluate('Bash', { command: 'curl x' })).resolves.toMatchObject({ decision: 'ask' });
        const view = await engine.view();
        expect(view).toMatchObject({ baselineSource: 'external', invalid: ['baseline: Bad('] });
        // 缓存命中（同 mtime/size）
        await expect(loadBaseline()).resolves.toMatchObject({ source: 'external' });
        await writePolicy(JSON.stringify({ deny: ['Bash(curl:*)'], ask: [] }) + '\n'.repeat(4));
        await expect(engine.evaluate('Bash', { command: 'curl x' })).resolves.toMatchObject({ decision: 'deny' });
    });

    it.each(['{bad', '[]', '{"deny":"Read"}', '{"ask":[1]}'])(
        'degrades every tool to ask for a corrupt external baseline %s without falling back',
        async (raw) => {
            await writePolicy(raw);
            const engine = new PolicyEngine(store);
            await expect(engine.evaluate('Read', { path: 'README.md' })).resolves.toMatchObject({
                decision: 'ask',
                rule: 'baseline-invalid'
            });
            await expect(engine.view()).resolves.toMatchObject({
                baselineSource: 'invalid',
                baselineError: expect.stringContaining('解析失败')
            });
        }
    );

    it('treats an unreadable external baseline as invalid', async () => {
        // 父路径是普通文件 → stat 报 ENOTDIR（非 ENOENT），不能当作「未配置」回落内置基线
        await writePolicy('{}');
        vi.stubEnv('PERMISSION_POLICY_PATH', path.join(policyFile, 'nested.json'));
        await expect(loadBaseline()).resolves.toMatchObject({ source: 'invalid', error: '基线文件无法读取' });
    });

    it('persists user rules as v3 and merges them after the baseline', async () => {
        const engine = new PolicyEngine(store);
        await store.setRules({ deny: [], ask: [], allow: ['Bash(npm test)', 'Nope('] });
        await expect(engine.evaluate('Bash', { command: 'npm test' })).resolves.toMatchObject({
            decision: 'allow',
            source: 'user'
        });
        expect((await engine.view()).invalid).toEqual(['user: Nope(']);
        const disk = JSON.parse(await fs.readFile(path.join(temp.permissions, 'permissions.json'), 'utf8'));
        expect(disk).toMatchObject({ version: 3, rules: { allow: ['Bash(npm test)', 'Nope('] } });
        // 落盘手改出的非字符串项读入时丢弃
        await fs.writeFile(
            path.join(temp.permissions, 'permissions.json'),
            JSON.stringify({ version: 3, rules: { deny: ['Read', 3], ask: 'x' } })
        );
        const reloaded = createPermissionStore(path.join(temp.permissions, 'permissions.json'));
        await expect(reloaded.getRules()).resolves.toEqual({ deny: ['Read'], ask: [], allow: [] });
    });

    it('fails safe to ask when the rule store throws', async () => {
        const engine = new PolicyEngine({ getRules: () => Promise.reject(new Error('disk')) });
        await expect(engine.evaluate('Read', {})).resolves.toMatchObject({ decision: 'ask', rule: 'policy-error' });
        await expect(engine.grepExcludeGlobs()).resolves.toEqual([]);
    });

    it('audits deny / ask / allow decisions with a truncated subject only', async () => {
        recordPermissionAudit({ toolName: 'Read', input: { path: 'x' }, decision: { decision: 'none' } });
        recordPermissionAudit({
            sessionId: 's',
            toolName: 'Bash',
            input: { command: `git push ${'x'.repeat(400)}` },
            decision: { decision: 'ask', rule: 'Bash(git push:*)', source: 'baseline' }
        });
        await flushPermissionAudit();
        const lines = (await fs.readFile(paths.permissionAuditFile(), 'utf8')).trim().split('\n');
        const last = JSON.parse(lines.at(-1)!);
        expect(last).toMatchObject({
            sessionId: 's',
            tool: 'Bash',
            decision: 'ask',
            ruleId: 'Bash(git push:*)',
            source: 'baseline'
        });
        expect(last.inputPreview).toHaveLength(300);
        expect(lines.some((l) => l.includes('"decision":"none"'))).toBe(false);
    });
});
