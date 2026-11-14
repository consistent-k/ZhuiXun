import fs from 'node:fs/promises';
import path from 'node:path';

import { isWriteDenylisted } from './store';

/** 仅接受可直接核验的普通项目路径。现有父目录须完整存在。 */
export async function inspectProjectEdit(root: string, target: string): Promise<string | undefined> {
    if (
        path.isAbsolute(target) ||
        path.win32.isAbsolute(target) ||
        target.includes(String.fromCharCode(0)) ||
        /[\\:]/.test(target)
    )
        return;
    const segments = target.split('/');
    if (
        segments.some(
            (name) =>
                !name ||
                name.startsWith('.') ||
                /[. ]$/.test(name) ||
                /[<>|?*"]/.test(name) ||
                /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
                /(?:^|[._-])(?:env|secrets?|credentials?)(?:[._-]|$)|\.(?:pem|key|p12|pfx)$/i.test(name)
        )
    )
        return;
    const destination = path.resolve(root, target);
    if (isWriteDenylisted(destination)) return;

    try {
        // realpath 检查根的祖先，lstat 检查目标路径的每一级，防止通过链接写到项目外。
        if ((await fs.realpath(root)) !== root || !(await fs.lstat(root)).isDirectory()) return;
        let current = root;
        const rootStat = await fs.lstat(root, { bigint: true });
        const identity = [`${rootStat.dev}:${rootStat.ino}`];
        for (const [index, segment] of segments.entries()) {
            current = path.join(current, segment);
            const leaf = index === segments.length - 1;
            const stat = await fs.lstat(current, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
                if (leaf && error.code === 'ENOENT') return undefined;
                throw error;
            });
            if (!stat) {
                identity.push('missing');
                continue;
            }
            if (leaf ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory()) return;
            identity.push(`${stat.dev}:${stat.ino}`);
        }
        return JSON.stringify([destination, identity]);
    } catch {
        return;
    }
}
