import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const desktopDir = fileURLToPath(new URL('../', import.meta.url));
const appName = '追寻';
const bundleId = 'com.zhuixun.app.dev';

export async function resolveMacDevLauncher(): Promise<string> {
    const electron = require('electron') as string;
    const sourceBundle = path.resolve(electron, '../../..');
    const sourcePlist = path.join(sourceBundle, 'Contents/Info.plist');
    const iconPath = path.join(desktopDir, 'build/icon.icns');
    const [plist, icon] = await Promise.all([readFile(sourcePlist), readFile(iconPath)]);
    const cacheKey = createHash('sha256').update(plist).update(icon).update(appName).update(bundleId).digest('hex');
    const cache = path.join(desktopDir, 'node_modules/.cache/zhuixun-electron');
    const target = path.join(cache, cacheKey);
    const launcher = path.join(target, 'launcher.cjs');
    if (
        await access(launcher).then(
            () => true,
            () => false
        )
    )
        return launcher;

    await mkdir(cache, { recursive: true });
    const staging = await mkdtemp(path.join(cache, 'staging-'));
    try {
        const bundle = path.join(staging, `${appName}.app`);
        // Dock 和系统菜单读取 .app 元数据，不能靠 app.setName 改掉 Electron 的系统显示名。
        // 复制开发运行时，保留 pnpm 缓存中的原包与生产打包输入。
        await run('/usr/bin/ditto', [sourceBundle, bundle]);
        const contents = path.join(bundle, 'Contents');
        for (const [key, value] of [
            ['CFBundleName', appName],
            ['CFBundleDisplayName', appName],
            ['CFBundleIdentifier', bundleId]
        ]) {
            await run('/usr/bin/plutil', ['-replace', key, '-string', value, path.join(contents, 'Info.plist')]);
        }
        await copyFile(iconPath, path.join(contents, 'Resources/electron.icns'));
        await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);

        // 保留 Electron 可执行文件名，使默认应用仍按开发态加载传入的工作目录。
        const executable = path.join(target, `${appName}.app/Contents/MacOS`, path.basename(electron));
        await writeFile(path.join(staging, 'launcher.cjs'), `module.exports = ${JSON.stringify(executable)};\n`);
        try {
            await rename(staging, target);
        } catch (error) {
            // 并发启动时只发布完整签名的副本，后完成的进程复用先发布的版本。
            if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
            await access(launcher);
        }
        return launcher;
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}
