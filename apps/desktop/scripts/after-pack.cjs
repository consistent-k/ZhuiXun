/**
 * electron-builder afterPack 钩子：把 ripgrep 二进制随包拷进 resources/rg/。
 *
 * 为什么需要：后端被 tsup 打成单文件 dist/server.js（运行时无 node_modules），且 `@vscode/ripgrep`
 * 在 tsup 里保持 external（见 apps/backend/tsup.config.ts）——打包形态下它无法从 node_modules 解析到
 * 平台二进制。故在此把宿主平台的 rg 拷进 Electron resources，运行时由主进程经 `ZHUIXUN_RG_PATH`
 * 指定（见 electron/main.ts），后端 `resolveRgPath` 优先用它（见 core/tools/edit-search-tools.ts）。
 *
 * 跨平台出包走 CI matrix（每个平台在对应 runner 上构建，宿主即目标），故这里直接用宿主 rgPath 即正确。
 * 解析失败/二进制缺失时只告警跳过，运行时会回退系统 PATH 上的 rg。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

exports.default = async function afterPack(context) {
    const { appOutDir, electronPlatformName, packager } = context;
    // @vscode/ripgrep 是后端(apps/backend)的依赖，从其 package.json 锚定 require 解析
    const backendRequire = createRequire(path.join(__dirname, '..', '..', 'backend', 'package.json'));
    let rgSrc;
    try {
        rgSrc = backendRequire('@vscode/ripgrep').rgPath;
    } catch (err) {
        console.warn('[afterPack] 无法解析 @vscode/ripgrep，跳过 rg 随包：', err && err.message);
        return;
    }
    if (!rgSrc || !fs.existsSync(rgSrc)) {
        console.warn('[afterPack] rg 二进制不存在，跳过随包：', rgSrc);
        return;
    }
    const resourcesDir = packager.getResourcesDir(appOutDir);
    const binName = electronPlatformName === 'win32' ? 'rg.exe' : 'rg';
    const destDir = path.join(resourcesDir, 'rg');
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, binName);
    fs.copyFileSync(rgSrc, dest);
    if (electronPlatformName !== 'win32') fs.chmodSync(dest, 0o755);
    console.log('[afterPack] 已随包 ripgrep ->', dest);
};
