import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConfig } from '@/config/types';

const provider = (name = 'fixture', extra: Partial<ProviderConfig> = {}): ProviderConfig => ({
    name,
    kind: 'openai-compatible',
    baseURL: 'https://model.example.invalid/v1',
    apiKey: 'synthetic-test-key',
    models: ['workspace', 'vendor/model'],
    ...extra
});

async function load(raw?: unknown) {
    if (raw === undefined) fs.rmSync(process.env.SETTINGS_CONFIG_PATH!, { force: true });
    else fs.writeFileSync(process.env.SETTINGS_CONFIG_PATH!, JSON.stringify(raw));
    vi.resetModules();
    return import('@/config/settings-store');
}

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    for (const key of ['FIXTURE_A', 'FIXTURE_B', 'FIXTURE_C']) delete process.env[key];
    vi.restoreAllMocks();
});

describe('settings source and persistence', () => {
    it('uses safe defaults for absent and damaged JSON, caches until a new module instance', async () => {
        let store = await load();
        expect(store.getModelSettings()).toEqual({ providers: [], activeModel: undefined });
        expect(store.resolveActiveModel()).toBeNull();
        expect(store.listEnvKeys()).toEqual([]);
        expect(store.getAppSettings()).toEqual({
            defaultAgentMode: 'routed',
            autoCompactEnabled: true,
            autoCompactThreshold: 80,
            maxAgentSteps: 40,
            repeatErrorLimit: 3,
            modelMaxRetries: 3,
            promptCaching: true,
            maxConsecutiveWakes: 3,
            goalMaxRounds: 5
        });
        expect(store.getMemorySettings()).toEqual(store.MEMORY_DEFAULTS);
        expect(store.getChannelsSettings()).toEqual({});
        expect(store.getSkillhubSettings()).toEqual(store.SKILLHUB_DEFAULTS);
        expect(store.getWebSettings()).toEqual(store.WEB_DEFAULTS);
        fs.writeFileSync(process.env.SETTINGS_CONFIG_PATH!, '{broken');
        expect(store.getModelSettings().providers).toEqual([]);
        vi.resetModules();
        store = await import('@/config/settings-store');
        expect(store.getModelSettings().providers).toEqual([]);
        expect(console.warn).toHaveBeenCalled();
    });

    it('persists providers without exposing keys and prunes orphan metadata', async () => {
        const store = await load();
        const view = store.addProvider(
            provider('one', {
                modelMeta: { workspace: { contextWindow: 8192 }, orphan: { contextWindow: 10 }, 'vendor/model': {} }
            })
        );
        expect(view).toMatchObject({
            name: 'one',
            configured: true,
            modelMeta: { workspace: { contextWindow: 8192 } }
        });
        expect(view).not.toHaveProperty('apiKey');
        expect(store.listProviders()[0]).not.toHaveProperty('apiKey');
        expect(store.getProvider('one')?.apiKey).toBe('synthetic-test-key');
        store.setActiveModel('one/vendor/model');
        expect(store.resolveActiveModel()?.modelName).toBe('vendor/model');
        expect(store.resolveModelRef('one/workspace')).toMatchObject({ contextWindow: 8192 });
        for (const ref of ['one', '/workspace', 'one/', 'missing/workspace'])
            expect(store.resolveModelRef(ref)).toBeNull();
        const disk = JSON.parse(fs.readFileSync(process.env.SETTINGS_CONFIG_PATH!, 'utf8'));
        expect(disk.model.activeModel).toBe('one/vendor/model');
        if (process.platform !== 'win32')
            expect(fs.statSync(process.env.SETTINGS_CONFIG_PATH!).mode & 0o777).toBe(0o600);
        expect(store.exportSettings().model?.providers[0].apiKey).toBe('');
        const model = await import('@/config/model');
        expect(model.activeModel()?.modelName).toBe('vendor/model');
        expect(model.modelByRef('one/workspace')?.contextWindow).toBe(8192);
    });

    it('rejects conflicts, preserves keys on empty patches, and updates active references on rename/delete', async () => {
        const store = await load();
        store.addProvider(provider('one'));
        store.addProvider(provider('two', { apiKey: '', modelMeta: {} }));
        expect(() => store.addProvider(provider('one'))).toThrow('DUPLICATE_PROVIDER');
        expect(() => store.updateProvider('missing', {})).toThrow('PROVIDER_NOT_FOUND');
        expect(() => store.updateProvider('one', { name: 'two' })).toThrow('DUPLICATE_PROVIDER');
        for (const ref of ['unknown/model', 'one/', 'one/missing', '/workspace', 'one']) {
            expect(() => store.setActiveModel(ref)).toThrow('INVALID_ACTIVE_MODEL');
        }
        store.setActiveModel('one/workspace');
        store.updateProvider('one', { apiKey: '' });
        expect(store.getProvider('one')?.apiKey).toBe('synthetic-test-key');
        store.updateProvider('one', {
            name: 'renamed',
            kind: 'anthropic',
            baseURL: 'https://other.invalid',
            apiKey: 'new-synthetic',
            models: ['workspace'],
            modelMeta: { workspace: { contextWindow: 1234 } }
        });
        expect(store.getModelSettings().activeModel).toBe('renamed/workspace');
        expect(store.resolveActiveModel()).toMatchObject({
            kind: 'anthropic',
            contextWindow: 1234,
            apiKey: 'new-synthetic'
        });
        expect(store.deleteProvider('missing')).toBe(false);
        expect(store.deleteProvider('two')).toBe(true);
        expect(store.getModelSettings().activeModel).toBe('renamed/workspace');
        expect(store.deleteProvider('renamed')).toBe(true);
        expect(store.resolveActiveModel()).toBeNull();
    });

    it('imports by name, retains local keys and metadata, filters sensitive env and exports sanitized backups', async () => {
        const store = await load();
        store.addProvider(provider('one', { modelMeta: { workspace: { contextWindow: 999 } } }));
        store.setActiveModel('one/workspace');
        store.setEnvVar('FIXTURE_A', 'value');
        store.updateAppSettings({ defaultAgentMode: 'progressive' });
        store.importSettings({
            model: { providers: [provider('one', { apiKey: '' }), provider('new', { apiKey: '' })] },
            env: {
                FIXTURE_B: 'safe',
                API_AUTH_TOKEN: 'blocked',
                ALLOWED_ORIGINS: 'blocked',
                ZHUIXUN_DANGEROUSLY_SKIP_PERMISSIONS: '1'
            },
            app: { autoCompactEnabled: false }
        });
        expect(store.getProvider('one')).toMatchObject({
            apiKey: 'synthetic-test-key',
            modelMeta: { workspace: { contextWindow: 999 } }
        });
        expect(store.getProvider('new')?.apiKey).toBe('');
        // env 按键合并：本机已有的 FIXTURE_A 保留，敏感键被过滤
        expect(store.listEnvKeys()).toEqual(['FIXTURE_A', 'FIXTURE_B']);
        expect(process.env.FIXTURE_B).toBeUndefined();
        expect(store.getAppSettings()).toMatchObject({ defaultAgentMode: 'progressive', autoCompactEnabled: false });
        store.importSettings({});
        expect(store.getModelSettings().activeModel).toBe('one/workspace');
        store.importSettings({
            model: { providers: [provider('one', { apiKey: 'replacement' })], activeModel: 'new/workspace' }
        });
        expect(store.getProvider('one')?.apiKey).toBe('replacement');
        expect(store.getModelSettings().activeModel).toBe('new/workspace');
        expect(JSON.stringify(store.exportSettings())).not.toContain('replacement');
        expect(store.exportSettings().env).toEqual({ FIXTURE_A: '', FIXTURE_B: '' });
    });

    it('round-trips an export without dropping local-only sections or env values', async () => {
        const store = await load({
            env: { FIXTURE_A: 'local-secret' },
            channels: { plugins: ['local-plugin'] },
            skillhub: { apiBase: 'https://hub.example.invalid' },
            memory: { enabled: false },
            web: { blockedHosts: ['blocked.example'] },
            hooks: { enabled: true, trustedHash: 'abc' }
        });
        const exported = store.exportSettings();
        expect(JSON.stringify(exported)).not.toContain('local-secret');
        expect(exported).not.toHaveProperty('channels');
        expect(exported).not.toHaveProperty('skillhub');
        expect(exported).toMatchObject({ memory: { enabled: false }, web: { blockedHosts: ['blocked.example'] } });

        store.importSettings(JSON.parse(JSON.stringify(exported)));
        expect(store.getSettings()).toMatchObject({
            env: { FIXTURE_A: 'local-secret' },
            channels: { plugins: ['local-plugin'] },
            skillhub: { apiBase: 'https://hub.example.invalid' },
            hooks: { enabled: true, trustedHash: 'abc' }
        });
        expect(store.getMemorySettings().enabled).toBe(false);
        expect(store.getWebSettings().blockedHosts).toEqual(['blocked.example']);

        // 新环境缺失的键以空值占位，显式值覆盖本机值；channels / skillhub 不随导入改写
        store.importSettings({
            env: { FIXTURE_A: 'replaced', FIXTURE_C: '' },
            memory: { autoDream: false },
            web: { fetchEnabled: false },
            channels: { plugins: ['evil'] },
            skillhub: { apiBase: 'https://evil.example.invalid' }
        } as never);
        expect(store.getSettings().env).toEqual({ FIXTURE_A: 'replaced', FIXTURE_C: '' });
        expect(store.getMemorySettings()).toMatchObject({ enabled: false, autoDream: false });
        expect(store.getWebSettings()).toMatchObject({ fetchEnabled: false, blockedHosts: ['blocked.example'] });
        expect(store.getChannelsSettings().plugins).toEqual(['local-plugin']);
        expect(store.getSkillhubSettings().apiBase).toBe('https://hub.example.invalid');
        store.applyEnvOverlay(store.getSettings().env);
        expect(process.env.FIXTURE_C).toBeUndefined();
    });
});

describe('Web maxBytes defaults and compatibility', () => {
    it.each([
        ['absent settings file', undefined],
        ['missing web section', {}],
        ['empty web section', { web: {} }],
        ['missing maxBytes', { web: { maxChars: 3000 } }]
    ])('uses 5 MiB for %s without persisting a migration', async (_label, raw) => {
        const store = await load(raw);
        expect(store.WEB_DEFAULTS.maxBytes).toBe(5 * 1024 * 1024);
        expect(store.getWebSettings().maxBytes).toBe(5 * 1024 * 1024);
        if (raw === undefined) {
            expect(fs.existsSync(process.env.SETTINGS_CONFIG_PATH!)).toBe(false);
        } else {
            expect(JSON.parse(fs.readFileSync(process.env.SETTINGS_CONFIG_PATH!, 'utf8'))).toEqual(raw);
        }
    });

    it.each([2 * 1024 * 1024, 3 * 1024 * 1024, 7 * 1024 * 1024])(
        'preserves explicitly saved %s bytes on reads, partial updates and reloads',
        async (maxBytes) => {
            const store = await load({ web: { maxBytes } });
            expect(store.getWebSettings().maxBytes).toBe(maxBytes);
            expect(store.updateWebSettings({ maxChars: 3000 }).maxBytes).toBe(maxBytes);
            expect(store.updateWebSettings({ maxBytes }).maxBytes).toBe(maxBytes);
            expect(JSON.parse(fs.readFileSync(process.env.SETTINGS_CONFIG_PATH!, 'utf8')).web.maxBytes).toBe(maxBytes);
            vi.resetModules();
            const reloaded = await import('@/config/settings-store');
            expect(reloaded.getWebSettings().maxBytes).toBe(maxBytes);
        }
    );

    it.each([2 * 1024 * 1024, 3 * 1024 * 1024, 7 * 1024 * 1024])(
        'imports and round-trips explicit %s bytes without migrating to the default',
        async (maxBytes) => {
            const store = await load();
            store.importSettings({ web: { maxBytes } });
            expect(store.getWebSettings().maxBytes).toBe(maxBytes);
            const exported = store.exportSettings();
            expect(exported.web?.maxBytes).toBe(maxBytes);
            store.updateWebSettings({ maxBytes: 5 * 1024 * 1024 });
            store.importSettings(JSON.parse(JSON.stringify(exported)));
            expect(store.getWebSettings().maxBytes).toBe(maxBytes);
            expect(JSON.parse(fs.readFileSync(process.env.SETTINGS_CONFIG_PATH!, 'utf8')).web.maxBytes).toBe(maxBytes);
            vi.resetModules();
            const reloaded = await import('@/config/settings-store');
            expect(reloaded.getWebSettings().maxBytes).toBe(maxBytes);
        }
    );

    it('uses the default only when maxBytes is missing and partial imports preserve an explicit value', async () => {
        const store = await load();
        store.importSettings({ web: { maxChars: 3000 } });
        expect(store.getWebSettings().maxBytes).toBe(5 * 1024 * 1024);
        expect(store.getSettings().web).not.toHaveProperty('maxBytes');
        store.updateWebSettings({ maxBytes: 2 * 1024 * 1024 });
        store.importSettings({ web: { maxChars: 4000 } });
        store.importSettings({});
        expect(store.getWebSettings()).toMatchObject({ maxBytes: 2 * 1024 * 1024, maxChars: 4000 });
    });

    it.each([
        [64 * 1024 - 1, 64 * 1024],
        [64 * 1024, 64 * 1024],
        [1_234_567, 1_234_567],
        [10 * 1024 * 1024, 10 * 1024 * 1024],
        [10 * 1024 * 1024 + 1, 10 * 1024 * 1024]
    ])('keeps the 64 KiB–10 MiB range: %s bytes resolves to %s', async (input, expected) => {
        const store = await load({ web: { maxBytes: input } });
        expect(store.WEB_LIMITS).toMatchObject({ maxBytesMin: 64 * 1024, maxBytesMax: 10 * 1024 * 1024 });
        expect(store.getWebSettings().maxBytes).toBe(expected);
        expect(store.updateWebSettings({ maxBytes: input }).maxBytes).toBe(expected);
        store.importSettings({ web: { maxBytes: input } });
        expect(store.getWebSettings().maxBytes).toBe(expected);
    });
});

describe('settings preferences and env safety', () => {
    it('overlays only absent non-sensitive env and updates explicit user values', async () => {
        const store = await load({});
        process.env.FIXTURE_A = 'existing';
        store.applyEnvOverlay(undefined);
        store.applyEnvOverlay({ FIXTURE_A: 'ignored', FIXTURE_B: 'new', API_AUTH_TOKEN: 'blocked' });
        expect(process.env.FIXTURE_A).toBe('existing');
        expect(process.env.FIXTURE_B).toBe('new');
        for (const key of ['lower', '1_BAD', 'BAD-KEY', 'A'.repeat(65), ...store.SENSITIVE_ENV_KEYS]) {
            expect(store.isValidUserEnvKey(key)).toBe(false);
            expect(() => store.setEnvVar(key, 'bad')).toThrow();
        }
        expect(store.isValidUserEnvKey('FIXTURE_A')).toBe(true);
        store.setEnvVar('FIXTURE_B', 'second');
        store.setEnvVar('FIXTURE_A', 'explicit');
        expect(store.listEnvKeys()).toEqual(['FIXTURE_A', 'FIXTURE_B']);
        expect(process.env.FIXTURE_A).toBe('explicit');
        store.removeEnvVar('FIXTURE_A');
        store.removeEnvVar('FIXTURE_C');
        expect(process.env.FIXTURE_A).toBeUndefined();
        expect(store.listEnvKeys()).toEqual(['FIXTURE_B']);
    });

    it.each([
        [1, 50],
        [99, 95],
        [73.6, 74],
        [0, 80],
        [NaN, 80],
        [-1, 80]
    ])('clamps compaction preference %s to %s', async (input, expected) => {
        const store = await load();
        expect(store.updateAppSettings({ autoCompactThreshold: input }).autoCompactThreshold).toBe(expected);
        expect(store.updateAppSettings({ defaultAgentMode: 'progressive', autoCompactEnabled: false })).toMatchObject({
            defaultAgentMode: 'progressive',
            autoCompactEnabled: false
        });
    });

    it('bounds loop guard, retry and caching preferences and keeps defaults for invalid values', async () => {
        const store = await load();
        expect(
            store.updateAppSettings({
                maxAgentSteps: 5,
                repeatErrorLimit: 99,
                modelMaxRetries: 2.6,
                promptCaching: false
            })
        ).toMatchObject({ maxAgentSteps: 10, repeatErrorLimit: 10, modelMaxRetries: 3, promptCaching: false });
        expect(
            store.updateAppSettings({
                maxAgentSteps: 500,
                repeatErrorLimit: 1,
                modelMaxRetries: -1,
                promptCaching: 'yes' as unknown as boolean
            })
        ).toMatchObject({ maxAgentSteps: 200, repeatErrorLimit: 2, modelMaxRetries: 0, promptCaching: true });
        expect(
            store.updateAppSettings({ maxAgentSteps: Number.NaN, repeatErrorLimit: null as unknown as number })
        ).toMatchObject({ maxAgentSteps: 40, repeatErrorLimit: 3 });
    });

    it('keeps hooks trust local: defaults off, excluded from export and ignored on import', async () => {
        const store = await load({ hooks: { enabled: 'yes', trustedHash: 7 } });
        expect(store.getHooksSettings()).toEqual({ enabled: false });
        expect(store.updateHooksSettings({ enabled: true, trustedHash: 'abc' })).toEqual({
            enabled: true,
            trustedHash: 'abc'
        });
        expect(store.exportSettings()).not.toHaveProperty('hooks');
        store.importSettings({ hooks: { enabled: false, trustedHash: 'evil' } } as never);
        expect(store.getHooksSettings()).toEqual({ enabled: true, trustedHash: 'abc' });
    });

    it('merges channels, memory and SkillHub with defaults and bounds', async () => {
        const store = await load({ memory: { enabled: 'invalid' }, app: {}, skillhub: {} });
        expect(store.getMemorySettings()).toEqual(store.MEMORY_DEFAULTS);
        expect(store.updateMemorySettings({ enabled: false, autoExtract: false, autoDream: false })).toEqual({
            enabled: false,
            autoExtract: false,
            autoDream: false
        });
        expect(store.updateMemorySettings({ enabled: true }).autoDream).toBe(false);
        expect(store.updateChannelsSettings({ plugins: ['fixture'] })).toEqual({ plugins: ['fixture'] });
        expect(store.updateChannelsSettings({})).toEqual({ plugins: ['fixture'] });
        expect(
            store.updateSkillhubSettings({ apiBase: '  https://hub.invalid  ', maxResults: 120, timeoutMs: 2500 })
        ).toEqual({ apiBase: 'https://hub.invalid', maxResults: 80, timeoutMs: 2500 });
        expect(store.updateSkillhubSettings({})).toEqual(store.getSkillhubSettings());
        expect(store.updateSkillhubSettings({ apiBase: ' ', maxResults: -1, timeoutMs: NaN })).toEqual(
            store.SKILLHUB_DEFAULTS
        );
    });

    it('persists persona config, exports it and preserves it on partial imports', async () => {
        const store = await load();
        const record = {
            id: 'custom_fixture',
            name: '简洁快答',
            description: '快速阅读',
            instruction: '先给结论',
            createdAt: 1,
            updatedAt: 2
        };
        expect(store.setPersonaSettings({ defaultId: record.id, custom: [record] })).toEqual({
            defaultId: record.id,
            custom: [record]
        });
        expect(store.exportSettings().persona).toEqual({ defaultId: record.id, custom: [record] });
        store.importSettings({});
        expect(store.getPersonaSettings()).toMatchObject({ defaultId: record.id, custom: [record] });
        store.importSettings({ persona: { defaultId: 'default', custom: [] } });
        expect(store.getPersonaSettings()).toEqual({ defaultId: 'default', custom: [] });
    });

    it('normalizes hosts, preserves partial Web changes and bounds numeric input', async () => {
        const store = await load();
        const result = store.updateWebSettings({
            enabled: false,
            fetchEnabled: false,
            allowedHosts: [
                ' .EXAMPLE.com ',
                '*.example.com',
                'example.com',
                'https://bad',
                'bad/path',
                'bad host',
                '',
                123
            ] as string[],
            blockedHosts: ['LOCALHOST'],
            requireApproval: 'always',
            timeoutMs: 1,
            maxBytes: 99_999_999,
            maxChars: 1234.6
        });
        expect(result).toMatchObject({
            enabled: false,
            fetchEnabled: false,
            allowedHosts: ['example.com', '*.example.com'],
            blockedHosts: ['localhost'],
            requireApproval: 'always',
            timeoutMs: 1000,
            maxBytes: 10 * 1024 * 1024,
            maxChars: 1235
        });
        expect(store.updateWebSettings({})).toEqual(result);
        const malformed = store.updateWebSettings({
            allowedHosts: Array.from({ length: 210 }, (_, i) => `host${i}.invalid`),
            blockedHosts: undefined,
            timeoutMs: NaN,
            maxChars: Infinity
        });
        expect(malformed.allowedHosts).toHaveLength(200);
        expect(malformed.timeoutMs).toBe(store.WEB_DEFAULTS.timeoutMs);
        expect(malformed.maxChars).toBe(store.WEB_DEFAULTS.maxChars);
        const reset = await load({
            web: { allowedHosts: 'not-array', blockedHosts: null, timeoutMs: '1234', maxBytes: 'bad' }
        });
        expect(reset.getWebSettings()).toMatchObject({
            allowedHosts: [],
            blockedHosts: [],
            timeoutMs: 1234,
            maxBytes: reset.WEB_DEFAULTS.maxBytes
        });
    });

    it('loads all persisted sections and runs bootstrap overlay without importing services', async () => {
        await load({
            env: { FIXTURE_C: 'from-bootstrap' },
            app: { defaultAgentMode: 'routed' },
            channels: { plugins: ['one'] },
            skillhub: { maxResults: 5 },
            memory: { autoExtract: false },
            web: { fetchEnabled: false }
        });
        await import('@/config/bootstrap-settings');
        expect(process.env.FIXTURE_C).toBe('from-bootstrap');
    });
});
