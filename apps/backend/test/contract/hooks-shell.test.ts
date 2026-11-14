import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type * as SettingsStore from '@/config/settings-store';
import type * as HooksModule from '@/modules/hooks';

/**
 * Hooks 真实 shell 契约（opt-in，`pnpm test:contract`）：用本机 shell 执行真实 hook 脚本，
 * 验证 stdin 载荷、退出码 2 阻断、JSON 决策、超时整组 kill。仅 POSIX；HOME 指向临时目录，不碰真实 ~/.zhuixun。
 */
const posix = process.platform !== 'win32';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zhuixun-hooks-contract-'));
const originalHome = process.env.HOME;

let hooks: typeof HooksModule;
let settings: typeof SettingsStore;

function writeConfig(config: unknown) {
    const dir = path.join(home, '.zhuixun');
    fs.mkdirSync(dir, { recursive: true });
    const content = JSON.stringify(config);
    fs.writeFileSync(path.join(dir, 'hooks.json'), content);
    hooks.resetHooksCache();
    const view = hooks.hooksView();
    hooks.updateHooksTrust({ hash: view.hash, enabled: true });
}

beforeAll(async () => {
    // 必须在 import 前改 HOME：ZHUIXUN_HOME 在模块加载时求值
    process.env.HOME = home;
    process.env.SETTINGS_CONFIG_PATH = path.join(home, '.zhuixun', 'settings.json');
    process.env.ZHUIXUN_SHELL = '/bin/sh';
    settings = await import('@/config/settings-store');
    hooks = await import('@/modules/hooks');
    expect(settings.getHooksSettings().enabled).toBe(false);
});

afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
});

describe.runIf(posix)('hooks with a real POSIX shell', () => {
    it('passes stdin JSON + env and honours exit 2 / JSON decisions', async () => {
        writeConfig({
            PreToolUse: [
                {
                    matcher: 'Edit',
                    hooks: [
                        {
                            type: 'command',
                            command:
                                'read -r line; case "$line" in *main.ts*) echo "protected $ZHUIXUN_TOOL_NAME" >&2; exit 2;; esac; echo \'{"decision":"allow"}\''
                        }
                    ]
                }
            ]
        });
        const runner = hooks.createHookRunner({ cwd: home });
        await expect(runner.pre({ toolName: 'Edit', input: { file_path: 'main.ts' } })).resolves.toEqual({
            decision: 'deny',
            reason: 'protected Edit'
        });
        await expect(runner.pre({ toolName: 'Edit', input: { file_path: 'other.ts' } })).resolves.toEqual({
            decision: 'allow'
        });
    });

    it('kills a hung hook after its timeout and degrades to ask', async () => {
        writeConfig({ PreToolUse: [{ hooks: [{ type: 'command', command: 'sleep 30 & wait', timeout: 1 }] }] });
        const started = Date.now();
        const verdict = await hooks.createHookRunner({ cwd: home }).pre({ toolName: 'Bash', input: {} });
        expect(verdict).toMatchObject({ decision: 'ask', failed: true, reason: 'hook 执行超时' });
        expect(Date.now() - started).toBeLessThan(5000);
    });
});
