#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { render } from 'ink';

import manifest from '../package.json';

import { connect } from './client';
import type { Backend } from './client';
import { createSession, Terminal } from './terminal';
import { updateCli } from './update';

async function main(): Promise<void> {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            help: { type: 'boolean', short: 'h' },
            version: { type: 'boolean', short: 'v' },
            url: { type: 'string' },
            install: { type: 'boolean' }
        }
    });
    if (values.version) {
        console.log(manifest.version);
        return;
    }
    if (values.help) {
        console.log('Usage: zhuixun [--url http://127.0.0.1:31001] [--version] | zhuixun update [--install]');
        return;
    }
    if (positionals.length === 1 && positionals[0] === 'update') {
        console.log(await updateCli(manifest.version, values.install ?? false));
        return;
    }
    if (positionals.length || values.install) throw new Error('请使用 zhuixun --help 查看用法');
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('zhuixun 需要交互式终端');

    let owned: Backend | undefined;
    let app: ReturnType<typeof render> | undefined;
    let interrupted = false;
    const stop = () => {
        interrupted = true;
        app?.unmount();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
        const connection = await connect(values.url);
        owned = connection.owned;
        if (!interrupted) {
            const session = await createSession(connection.api);
            if (!interrupted) {
                app = render(<Terminal session={session} version={manifest.version} />, { exitOnCtrlC: false });
                await app.waitUntilExit();
            }
        }
    } finally {
        await owned?.close();
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
    }
    process.exit(0);
}

void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
