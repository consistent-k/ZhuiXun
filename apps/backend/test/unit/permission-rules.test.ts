import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BUILTIN_BASELINE } from '@/modules/permission/baseline';
import {
    commandSegments,
    compileRuleSet,
    evaluateRules,
    inputSubject,
    normalizeRuleSet,
    parsePermissionRule,
    readDenyExcludeGlobs,
    resolveTarget,
    ruleMatches,
    toolPath,
    type PolicyContext,
    type PolicySnapshot
} from '@/modules/permission/rules';

const home = os.homedir();
const ctx: PolicyContext = { cwd: '/project', isMcpTool: (name) => name.startsWith('github_') };

function snapshot(user: { deny?: string[]; ask?: string[]; allow?: string[] } = {}, baseline = BUILTIN_BASELINE) {
    const invalid: string[] = [];
    const snap: PolicySnapshot = {
        baseline: compileRuleSet(baseline, 'baseline', invalid),
        user: compileRuleSet(user, 'user', invalid)
    };
    return { snap, invalid };
}

const decide = (tool: string, input: unknown, user?: Parameters<typeof snapshot>[0]) =>
    evaluateRules(snapshot(user).snap, tool, input, ctx);

describe('permission rule parsing', () => {
    it.each([
        ['Bash', { tool: 'Bash' }],
        ['Bash(git push:*)', { tool: 'Bash', spec: 'git push:*' }],
        ['  Read(**/.env)  ', { raw: 'Read(**/.env)', tool: 'Read', spec: '**/.env' }],
        ['WebFetch(domain:*.example.com)', { tool: 'WebFetch', spec: 'domain:*.example.com' }],
        ['MCP(github_*)', { tool: 'MCP', spec: 'github_*' }],
        ['create_skill', { tool: 'create_skill' }],
        ['Bash(*)', { tool: 'Bash', spec: '*' }]
    ])('accepts %s', (raw, expected) => {
        expect(parsePermissionRule(raw)).toMatchObject(expected);
    });

    it.each([
        ['', '不能为空'],
        ['x'.repeat(501), '过长'],
        ['Bash(', '格式不合法'],
        ['1Bash', '格式不合法'],
        ['Bash()', '参数不能为空'],
        ['Bash(  )', '参数不能为空'],
        ['Bash(env)', 'Bash 规则参数不合法'],
        ['WebFetch(example.com)', 'domain:'],
        ['create_skill(x)', '不支持参数']
    ])('rejects %j', (raw, message) => {
        expect(() => parsePermissionRule(raw)).toThrow(message);
    });

    it('rejects non-string input and normalizes / dedupes user rule sets', () => {
        expect(() => parsePermissionRule(42 as unknown as string)).toThrow('不能为空');
        expect(normalizeRuleSet({ deny: [' Read(a) ', 'Read(a)'], ask: [] })).toEqual({
            deny: ['Read(a)'],
            ask: [],
            allow: []
        });
        expect(() => normalizeRuleSet({ deny: 'Read' as unknown as string[] })).toThrow('字符串数组');
        expect(() => normalizeRuleSet({ allow: Array.from({ length: 201 }, () => 'Read') })).toThrow('上限');
        expect(() => normalizeRuleSet({ ask: ['Bash('] })).toThrow();
    });

    it('compiles valid rules and records invalid ones with their source', () => {
        const invalid: string[] = [];
        const compiled = compileRuleSet(
            { deny: ['Read', 'Bad(', 7 as unknown as string], ask: 'x' as unknown as string[] },
            'user',
            invalid
        );
        expect(compiled.deny.map((r) => r.raw)).toEqual(['Read']);
        expect(compiled.ask).toEqual([]);
        expect(invalid).toEqual(['user: Bad(', 'user: 7']);
        expect(compileRuleSet(undefined, 'x', invalid)).toEqual({ deny: [], ask: [], allow: [] });
    });
});

describe('permission rule matching', () => {
    it('splits compound commands including substitutions and subshells', () => {
        expect(commandSegments('git status && rm -rf x; echo $(git push) | (sh)')).toEqual([
            'git status',
            'rm -rf x',
            'echo',
            'git push',
            'sh'
        ]);
    });

    it('matches Bash heads across segments, wrappers, env assignments, paths and quotes', () => {
        const rule = parsePermissionRule('Bash(git push:*)');
        const hit = (command: unknown) => ruleMatches(rule, 'Bash', { command }, ctx, 'restrict');
        expect(hit('git push --force origin main')).toBe(true);
        expect(hit('git status && git push')).toBe(true);
        expect(hit('FOO=1 env -i nohup /usr/bin/git push')).toBe(true);
        expect(hit('"git" push')).toBe(true);
        expect(hit('git status')).toBe(false);
        expect(hit('git')).toBe(false);
        expect(hit('gitx push')).toBe(false);
        expect(hit('')).toBe(false);
        expect(hit(42)).toBe(false);
        expect(ruleMatches(rule, 'Read', { command: 'git push' }, ctx, 'restrict')).toBe(false);
        expect(ruleMatches(parsePermissionRule('Bash'), 'Bash', { command: 'ls' }, ctx, 'restrict')).toBe(true);
        expect(ruleMatches(parsePermissionRule('Bash(*)'), 'Bash', { command: 'ls' }, ctx, 'restrict')).toBe(true);
        expect(ruleMatches(parsePermissionRule('Bash(RM)'), 'Bash', { command: 'rm x' }, ctx, 'restrict')).toBe(true);
    });

    it('allow rules require every segment to match and no redirection / substitution', () => {
        const rule = parsePermissionRule('Bash(npm run:*)');
        const allow = (command: string) => ruleMatches(rule, 'Bash', { command }, ctx, 'allow');
        expect(allow('npm run build')).toBe(true);
        expect(allow('npm run build && npm run test')).toBe(true);
        expect(allow('npm run build && rm -rf /')).toBe(false);
        expect(allow('npm run build > out.txt')).toBe(false);
        expect(allow('npm run $(whoami)')).toBe(false);
    });

    it('matches path rules with ~, relative, absolute and ** globs; Read covers search tools', () => {
        const env = parsePermissionRule('Read(**/.env)');
        const ssh = parsePermissionRule('Read(~/.ssh/**)');
        const rel = parsePermissionRule('Write(./dist/**)');
        const abs = parsePermissionRule('Edit(/etc/**)');
        expect(ruleMatches(env, 'Read', { path: '.env' }, ctx, 'restrict')).toBe(true);
        expect(ruleMatches(env, 'Read', { path: '/other/app/.env' }, ctx, 'restrict')).toBe(true);
        expect(ruleMatches(env, 'Read', { path: '.env.example' }, ctx, 'restrict')).toBe(false);
        expect(ruleMatches(ssh, 'Read', { path: '~/.ssh/id_rsa' }, ctx, 'restrict')).toBe(true);
        expect(ruleMatches(ssh, 'Read', { path: path.join(home, '.ssh', 'config') }, ctx, 'restrict')).toBe(true);
        // 目录类工具：目录本身落在 dir/** 内即命中
        expect(ruleMatches(ssh, 'LS', { path: '~/.ssh' }, ctx, 'restrict')).toBe(true);
        expect(ruleMatches(ssh, 'Grep', { pattern: 'x', path: '~/.ssh' }, ctx, 'restrict')).toBe(true);
        expect(ruleMatches(ssh, 'Glob', { pattern: '*' }, { cwd: home }, 'restrict')).toBe(false);
        expect(ruleMatches(rel, 'Write', { path: 'dist/a.js' }, ctx, 'restrict')).toBe(true);
        expect(ruleMatches(rel, 'Edit', { file_path: '/project/dist/a.js' }, ctx, 'restrict')).toBe(true);
        expect(ruleMatches(rel, 'Read', { path: 'dist/a.js' }, ctx, 'restrict')).toBe(false);
        expect(ruleMatches(abs, 'Write', { path: '/etc/hosts' }, ctx, 'restrict')).toBe(true);
        expect(ruleMatches(parsePermissionRule('Read'), 'Grep', {}, ctx, 'restrict')).toBe(true);
        expect(ruleMatches(env, 'Write', {}, ctx, 'restrict')).toBe(false);
        expect(ruleMatches(parsePermissionRule('Read(src/**)'), 'Read', { path: 'src/a' }, {}, 'restrict')).toBe(
            path.posix.matchesGlob(path.resolve('src/a').replace(/\\/g, '/'), `${process.cwd()}/src/**`)
        );
        expect(ruleMatches(env, 'Read', {}, ctx, 'restrict')).toBe(false);
        expect(ruleMatches(parsePermissionRule('Read([)'), 'Read', { path: 'x' }, ctx, 'restrict')).toBe(false);
    });

    it('matches WebFetch domains, MCP globs and exact tool names', () => {
        const web = parsePermissionRule('WebFetch(domain:*.example.com)');
        expect(ruleMatches(web, 'WebFetch', { url: 'https://docs.example.com/a' }, ctx, 'restrict')).toBe(true);
        expect(ruleMatches(web, 'WebFetch', { url: 'https://example.com.' }, ctx, 'restrict')).toBe(true);
        expect(ruleMatches(web, 'WebFetch', { url: 'https://evil.com' }, ctx, 'restrict')).toBe(false);
        expect(ruleMatches(web, 'WebFetch', { url: 'not a url' }, ctx, 'restrict')).toBe(false);
        expect(ruleMatches(web, 'Read', {}, ctx, 'restrict')).toBe(false);
        expect(ruleMatches(parsePermissionRule('WebFetch'), 'WebFetch', {}, ctx, 'restrict')).toBe(true);
        const mcp = parsePermissionRule('MCP(github_*)');
        expect(ruleMatches(mcp, 'github_search', {}, ctx, 'restrict')).toBe(true);
        expect(ruleMatches(mcp, 'github_x', {}, {}, 'restrict')).toBe(false);
        expect(ruleMatches(parsePermissionRule('MCP'), 'github_y', {}, ctx, 'restrict')).toBe(true);
        expect(ruleMatches(parsePermissionRule('create_skill'), 'create_skill', {}, ctx, 'restrict')).toBe(true);
        expect(ruleMatches(parsePermissionRule('create_skill'), 'update_skill', {}, ctx, 'restrict')).toBe(false);
    });

    it('extracts tool paths, subjects and absolute targets', () => {
        expect(toolPath('Edit', { file_path: 'a' })).toBe('a');
        expect(toolPath('Write', { path: 'b' })).toBe('b');
        expect(toolPath('Grep', {})).toBe('.');
        expect(toolPath('LS', null)).toBeUndefined();
        expect(inputSubject('Bash', { command: 'ls' })).toBe('ls');
        expect(inputSubject('WebFetch', { url: 'https://x.dev' })).toBe('https://x.dev');
        expect(inputSubject('Read', { path: 'a', content: 'secret' })).toBe('a');
        expect(inputSubject('Task', {})).toBe('');
        expect(resolveTarget('~', ctx)).toBe(home);
        expect(resolveTarget('', ctx)).toBe(path.resolve('/project'));
        expect(resolveTarget('x', {})).toBe(path.resolve('x'));
    });
});

describe('permission policy evaluation', () => {
    it('applies the built-in baseline: secret reads deny, dangerous / nested shells ask', () => {
        expect(decide('Read', { path: '.env' })).toMatchObject({
            decision: 'deny',
            rule: 'Read(**/.env)',
            source: 'baseline'
        });
        expect(decide('Read', { path: '~/.zhuixun/settings.json' }).decision).toBe('deny');
        expect(decide('Grep', { pattern: 'k', path: '~/.aws' }).decision).toBe('deny');
        expect(decide('Read', { path: 'cert/server.pem' }).decision).toBe('deny');
        expect(decide('Bash', { command: 'git push --force' })).toMatchObject({
            decision: 'ask',
            rule: 'Bash(git push:*)'
        });
        expect(decide('Bash', { command: 'bash -c "git push"' })).toMatchObject({
            decision: 'ask',
            rule: 'Bash(bash:*)'
        });
        expect(decide('Bash', { command: 'ls && rm -rf build' }).decision).toBe('ask');
        expect(decide('Bash', { command: 'git status' })).toEqual({ decision: 'none' });
        expect(decide('Read', { path: 'README.md' })).toEqual({ decision: 'none' });
    });

    it('orders deny → app-data floor → ask → allow and merges user rules', () => {
        expect(decide('Bash', { command: 'cat ~/.zhuixun/hooks.json' })).toMatchObject({
            decision: 'ask',
            source: 'floor'
        });
        expect(decide('Bash', { command: 'cp a ~/.zhuixun/x' }, { deny: ['Bash(cp:*)'] })).toMatchObject({
            decision: 'deny',
            source: 'user'
        });
        expect(decide('Bash', { command: 'npm test' }, { allow: ['Bash(npm:*)'] })).toMatchObject({
            decision: 'allow',
            source: 'user',
            reason: expect.stringContaining('用户规则')
        });
        expect(decide('Bash', { command: 'rm x' }, { allow: ['Bash(rm:*)'] }).decision).toBe('ask');
        expect(decide('WebFetch', { url: 'https://a.dev' }, { ask: ['WebFetch(domain:a.dev)'] }).decision).toBe('ask');
    });

    it('fails safe when the external baseline is invalid but still honours user deny', () => {
        const { snap } = snapshot({ deny: ['Read(**/secret)'] }, { deny: [], ask: [], allow: [] });
        snap.baselineInvalid = true;
        expect(evaluateRules(snap, 'Read', { path: 'x' }, ctx)).toMatchObject({
            decision: 'ask',
            rule: 'baseline-invalid'
        });
        expect(evaluateRules(snap, 'Read', { path: 'a/secret' }, ctx).decision).toBe('deny');
    });

    it('pushes unanchored Read-deny globs down to ripgrep', () => {
        const { snap } = snapshot({ deny: ['Read(**/*.pem)', 'Read(/abs/**)', 'Bash(rm:*)'] });
        expect(readDenyExcludeGlobs(snap)).toEqual([
            '!**/.env',
            '!**/.env.local',
            '!**/.env.*.local',
            '!**/*.pem',
            '!**/*.key'
        ]);
    });
});
