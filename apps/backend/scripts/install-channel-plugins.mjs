/**
 * 把内置渠道包（channel-telegram / channel-weixin）以「第三方插件」形态安装到用户可写目录
 * ~/.zhuixun/channels/plugins/<id>/，用于 dogfood 动态插件加载路径（打包态同样适用）。
 *
 * 每个包只用 node 内建 + `import type '@zhuixun/channels-core'`（编译期擦除），
 * 故 esbuild bundle 后是**自包含 ESM**：运行时零依赖本仓任何包、无需 node_modules。
 *
 * 用法：pnpm channels:install-plugins
 * 安装后在 settings.json 里登记：{ "channels": { "plugins": ["telegram", "weixin"] } }
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..'); // apps/backend/scripts → 仓库根

const PLUGINS = [
    { id: 'telegram', name: 'Telegram', src: 'packages/channel-telegram/src/index.ts' },
    { id: 'weixin', name: '微信', src: 'packages/channel-weixin/src/index.ts' }
];

/** 插件根目录：~/.zhuixun/channels/plugins（CHANNELS_USER_DIR 可覆盖，与后端 paths 一致）。 */
function pluginsBaseDir() {
    const override = process.env.CHANNELS_USER_DIR?.trim();
    const channelsDir = override ? override : path.join(os.homedir(), '.zhuixun', 'channels');
    return path.join(channelsDir, 'plugins');
}

async function main() {
    const base = pluginsBaseDir();
    for (const p of PLUGINS) {
        const dir = path.join(base, p.id);
        fs.mkdirSync(dir, { recursive: true });
        await build({
            entryPoints: [path.join(repoRoot, p.src)],
            outfile: path.join(dir, 'index.mjs'),
            bundle: true,
            format: 'esm',
            platform: 'node',
            target: 'node20',
            // node 内建保持 external；本包无其它运行时依赖（channels-core 仅 import type，已擦除）
            logLevel: 'warning'
        });
        fs.writeFileSync(
            path.join(dir, 'plugin.json'),
            JSON.stringify({ name: p.name, entry: 'index.mjs' }, null, 2) + '\n',
            'utf-8'
        );
        console.log(`[channels] ✓ 已安装插件 ${p.id} -> ${dir}`);
    }
    console.log('[channels] 完成。请在 settings.json 的 channels.plugins 里登记要启用的插件 id。');
}

main().catch((err) => {
    console.error('[channels] 安装失败:', err);
    process.exit(1);
});
