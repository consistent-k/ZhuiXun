import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    createDenyPermissionBroker,
    createPermissionBroker,
    createPermissionStore,
    rememberPermission
} from '@/modules/permission';

import type { TempData } from '../helpers/temp-data';
import { createTempData } from '../helpers/temp-data';

let temp: TempData;
let file: string;
let store: ReturnType<typeof createPermissionStore>;
beforeEach(async () => {
    temp = await createTempData('zhuixun-permission-');
    file = path.join(temp.permissions, 'permissions.json');
    store = createPermissionStore(file);
});
afterEach(async () => {
    await temp.cleanup();
});

const safeFile = () => path.join(temp.root, 'workspace', 'note.md');

describe('permission module store', () => {
    it('loads empty defaults and filters invalid rule shapes', async () => {
        await expect(store.get()).resolves.toEqual({
            version: 3,
            autoApprovalEnabled: true,
            bash: { allow: [] },
            write: { allow: [] },
            rules: { deny: [], ask: [], allow: [] }
        });
        await fs.mkdir(temp.permissions, { recursive: true });
        await fs.writeFile(
            file,
            JSON.stringify({
                version: 2,
                bash: { allow: [null, {}, { id: 1, head: 'git' }, { id: 'valid', head: 'git status' }] },
                write: { allow: [null, {}, { id: 'w', dir: path.dirname(safeFile()) }] }
            })
        );
        const loaded = createPermissionStore(file);
        await expect(loaded.get()).resolves.toMatchObject({
            version: 2,
            autoApprovalEnabled: true,
            bash: { allow: [{ id: 'valid', head: 'git status' }] },
            write: { allow: [{ id: 'w' }] },
            // v2 文件读时补空 rules，不改动既有记忆
            rules: { deny: [], ask: [], allow: [] }
        });
        await fs.writeFile(file, JSON.stringify({ version: 3, autoApprovalEnabled: false }));
        await expect(createPermissionStore(file).get()).resolves.toMatchObject({
            version: 3,
            autoApprovalEnabled: false,
            bash: { allow: [] },
            write: { allow: [] }
        });
    });

    it.each(['{bad', 'null', '{}', '{"bash":{"allow":{}},"write":{"allow":42}}'])(
        'fails closed for corrupt permission file %s',
        async (raw) => {
            await fs.mkdir(temp.permissions, { recursive: true });
            await fs.writeFile(file, raw);
            const loaded = createPermissionStore(file);
            await expect(loaded.resolveBashApproval('git status')).resolves.toBe('user-approval');
            await expect(loaded.resolveWriteApproval(safeFile())).resolves.toBe('user-approval');
        }
    );

    it('serializes persistent rules, deduplicates them and keeps session rules ephemeral', async () => {
        const results = await Promise.all([
            store.remember({ command: 'git status --short', scope: 'permanent' }),
            store.remember({ command: 'git status --branch', scope: 'permanent' }),
            store.remember({ command: 'git log --oneline', scope: 'permanent' }),
            store.remember({ tool: 'Write', filePath: safeFile(), scope: 'permanent' }),
            store.remember({
                tool: 'Write',
                filePath: path.join(path.dirname(safeFile()), 'other.md'),
                scope: 'permanent'
            })
        ]);
        expect(results[0].rule?.id).toBe(results[1].rule?.id);
        expect(results[3].rule?.id).toBe(results[4].rule?.id);
        const data = await store.get();
        expect(data.bash.allow).toHaveLength(2);
        expect(data.write.allow).toHaveLength(1);
        data.bash.allow.length = 0;
        data.write.allow.length = 0;
        await expect(store.get()).resolves.toMatchObject({ bash: { allow: expect.any(Array) } });
        expect((await store.get()).bash.allow).toHaveLength(2);
        await store.remember({ command: 'npm test', scope: 'session', sessionId: 'one' });
        await store.remember({
            tool: 'Write',
            filePath: path.join(temp.root, 'session-work', 'file'),
            scope: 'session',
            sessionId: 'one'
        });
        await expect(store.resolveBashApproval('npm test', 'one')).resolves.toBe('approved');
        await expect(store.resolveBashApproval('npm test', 'other')).resolves.toBe('user-approval');
        await expect(
            store.resolveWriteApproval(path.join(temp.root, 'session-work', 'sub', 'file'), 'one')
        ).resolves.toBe('approved');
        await expect(store.resolveWriteApproval(path.join(temp.root, 'session-work', 'file'), 'other')).resolves.toBe(
            'user-approval'
        );
        const reloaded = createPermissionStore(file);
        await expect(reloaded.resolveBashApproval('git status')).resolves.toBe('approved');
        await expect(reloaded.resolveWriteApproval(safeFile())).resolves.toBe('approved');
        await expect(reloaded.resolveBashApproval('npm test', 'one')).resolves.toBe('user-approval');
        await expect(reloaded.resolveWriteApproval(path.join(temp.root, 'session-work', 'file'), 'one')).resolves.toBe(
            'user-approval'
        );
        await store.deleteRule(results[0].rule!.id);
        await store.deleteRule(results[3].rule!.id);
        await store.deleteRule('missing');
        await expect(store.resolveBashApproval('git status')).resolves.toBe('user-approval');
        await expect(store.resolveWriteApproval(safeFile())).resolves.toBe('user-approval');
    });

    it('rejects unsafe memories and session rules with no session', async () => {
        for (const [command, reason] of [
            ['', 'unsafe'],
            ['git status && echo hi', 'compound'],
            ['rm -rf folder', 'denylisted']
        ]) {
            await expect(store.remember({ command, scope: 'permanent' })).resolves.toEqual({
                rule: null,
                skipped: reason
            });
        }
        await expect(store.remember({ scope: 'permanent' })).resolves.toMatchObject({ skipped: 'unsafe' });
        await expect(store.remember({ command: 'git status', scope: 'session' })).resolves.toMatchObject({
            skipped: 'no-session'
        });
        await expect(store.remember({ tool: 'Write', scope: 'permanent' })).resolves.toMatchObject({
            skipped: 'relative'
        });
        await expect(store.remember({ tool: 'Write', filePath: './file', scope: 'permanent' })).resolves.toMatchObject({
            skipped: 'relative'
        });
        await expect(store.remember({ tool: 'Write', filePath: safeFile(), scope: 'session' })).resolves.toMatchObject({
            skipped: 'no-session'
        });
        for (const dir of [
            '/',
            '/etc',
            '/usr',
            os.homedir(),
            path.join(os.homedir(), '.ssh'),
            path.join(os.homedir(), '.zhuixun')
        ]) {
            await expect(
                store.remember({ tool: 'Write', filePath: path.join(dir, 'file'), scope: 'permanent' })
            ).resolves.toMatchObject({ skipped: 'denylisted' });
            await expect(store.resolveWriteApproval(path.join(dir, 'file'), undefined, { roots: [dir] })).resolves.toBe(
                'user-approval'
            );
        }
    });

    it('enforces the auto-approval toggle but explicit project trust still honors safety boundaries', async () => {
        await store.remember({ command: 'git status', scope: 'permanent' });
        await store.remember({ tool: 'Write', filePath: safeFile(), scope: 'permanent' });
        await store.setAutoApproval(false);
        await expect(store.resolveBashApproval('git status')).resolves.toBe('user-approval');
        await expect(store.resolveWriteApproval(safeFile())).resolves.toBe('user-approval');
        const trust = { roots: [path.dirname(safeFile())] };
        await expect(store.resolveBashApproval('git diff', undefined, trust)).resolves.toBe('approved');
        await expect(store.resolveBashApproval('git diff', undefined, { roots: [] })).resolves.toBe('user-approval');
        for (const cmd of ['rm -rf x', 'git status; echo x', ''])
            await expect(store.resolveBashApproval(cmd, undefined, trust)).resolves.toBe('user-approval');
        await expect(store.resolveWriteApproval(safeFile(), undefined, trust)).resolves.toBe('approved');
        await expect(store.resolveWriteApproval(trust.roots[0], undefined, trust)).resolves.toBe('approved');
        await expect(
            store.resolveWriteApproval(path.join(temp.root, 'workspace-other', 'file'), undefined, trust)
        ).resolves.toBe('user-approval');
        await expect(
            store.resolveWriteApproval(path.join(trust.roots[0], '..', 'outside', 'file'), undefined, trust)
        ).resolves.toBe('user-approval');
        await expect(store.resolveWriteApproval('relative/file', undefined, trust)).resolves.toBe('user-approval');
        await store.setAutoApproval(true);
        await expect(store.resolveBashApproval('git status')).resolves.toBe('approved');
        await expect(store.resolveWriteApproval(safeFile())).resolves.toBe('approved');
    });

    it('does not publish failed persistent changes and recovers subsequent writes', async () => {
        await store.remember({ command: 'git status', scope: 'permanent' });
        const original = await store.get();
        await fs.rm(file);
        await fs.mkdir(file);
        await expect(store.remember({ command: 'git log', scope: 'permanent' })).rejects.toThrow();
        await expect(store.setAutoApproval(false)).rejects.toThrow();
        await expect(store.get()).resolves.toEqual(original);
        await expect(store.resolveBashApproval('git log')).resolves.toBe('user-approval');
        await fs.rm(file, { recursive: true });
        await store.remember({ command: 'git diff', scope: 'permanent' });
        await expect(createPermissionStore(file).resolveBashApproval('git diff')).resolves.toBe('approved');
    });

    it('fails safe on malformed runtime trust and malformed input without masking store persistence errors', async () => {
        const trust = { roots: null } as unknown as { roots: string[] };
        await expect(store.resolveBashApproval('git status', undefined, trust)).resolves.toBe('user-approval');
        await expect(store.resolveWriteApproval(safeFile(), undefined, trust)).resolves.toBe('user-approval');
        await expect(store.resolveBashApproval(null as unknown as string)).resolves.toBe('user-approval');
        await expect(store.resolveWriteApproval(42 as unknown as string)).resolves.toBe('user-approval');
    });
});

describe('permission brokers', () => {
    it('normal mode delegates to the real isolated store with session and project context', async () => {
        await store.remember({ command: 'git status', scope: 'session', sessionId: 's' });
        await store.remember({ tool: 'Write', filePath: safeFile(), scope: 'session', sessionId: 's' });
        const broker = createPermissionBroker({ dangerMode: false, store });
        await expect(broker.resolveBash('git status', { sessionId: 's' })).resolves.toBe('approved');
        await expect(broker.resolveBash('git status', {})).resolves.toBe('user-approval');
        await expect(broker.resolveWrite(safeFile(), { sessionId: 's' })).resolves.toBe('approved');
        await expect(broker.resolveWrite(safeFile(), {})).resolves.toBe('user-approval');
        await expect(broker.resolveBash('git diff', { trust: { roots: [temp.root] } })).resolves.toBe('approved');
        await expect(broker.resolveWrite(safeFile(), { trust: { roots: [temp.root] } })).resolves.toBe('approved');
    });

    it('danger mode deliberately approves unsafe commands while deny mode never approves', async () => {
        const danger = createPermissionBroker({ dangerMode: true });
        const deny = createDenyPermissionBroker();
        for (const broker of [danger, deny]) {
            const expected = broker === danger ? 'approved' : 'user-approval';
            await expect(broker.resolveBash('rm -rf file; echo done', {})).resolves.toBe(expected);
            await expect(broker.resolveWrite('/etc/config', {})).resolves.toBe(expected);
        }
    });

    it('default broker and remember entry point share the safely sandboxed singleton', async () => {
        const broker = createPermissionBroker();
        await rememberPermission({ command: 'git status', scope: 'session', sessionId: 'broker-singleton' });
        await expect(broker.resolveBash('git status', { sessionId: 'broker-singleton' })).resolves.toBe('approved');
    });
});
