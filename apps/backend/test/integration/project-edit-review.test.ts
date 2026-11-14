import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { inspectProjectEdit } from '@/modules/permission';

it('仅自动审查可核验的普通项目路径，并检测目标替换', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-')));
    await fs.mkdir(path.join(root, 'src'));
    const target = path.join(root, 'src', 'index.ts');
    await fs.writeFile(target, 'const x = 1;');
    const original = await inspectProjectEdit(root, 'src/index.ts');
    expect(original).toBeTypeOf('string');
    expect(await inspectProjectEdit(root, 'src/new.ts')).toBeTypeOf('string');

    await fs.rename(target, path.join(root, 'src', 'previous.ts'));
    await fs.writeFile(target, 'const x = 2;');
    expect(await inspectProjectEdit(root, 'src/index.ts')).not.toBe(original);
    await fs.symlink(target, path.join(root, 'src', 'alias.ts'));
    await fs.link(target, path.join(root, 'src', 'hardlink.ts'));

    for (const denied of [
        target,
        '../outside.ts',
        'src/.env',
        'src/deploy.key',
        'missing/new.ts',
        'src/alias.ts',
        'src/hardlink.ts'
    ]) {
        expect(await inspectProjectEdit(root, denied), denied).toBeUndefined();
    }
});
