import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

await build({
    entryPoints: {
        cli: 'src/cli.tsx',
        'plugins/telegram': '../../packages/channel-telegram/src/index.ts',
        'plugins/weixin': '../../packages/channel-weixin/src/index.ts'
    },
    outdir: 'dist',
    bundle: true,
    packages: 'external',
    // 私有工作区包随 CLI 打包，npm 安装时无需单独解析它。
    alias: { '@zhuixun/i18n': fileURLToPath(new URL('../../packages/i18n/src/index.ts', import.meta.url)) },
    format: 'esm',
    platform: 'node',
    target: 'node24'
});

await copyFile(new URL('../backend/dist/server.js', import.meta.url), new URL('./dist/server.js', import.meta.url));
