import { defineConfig } from 'tsup';

/**
 * 后端编译配置：把后端及其**全部依赖**打成单一 ESM 文件 dist/server.js（运行时无 node_modules），
 * 供 Electron 主进程 import 后在**进程内**起后端（startServer()，不自跑）。
 *
 * 产物只负责「编译」；打包装配（拷进 Electron resources）由 electron-builder 的 extraResources 完成。
 */
export default defineConfig({
    entry: { server: 'src/server.ts' }, // → dist/server.js（库形态，导出 startServer）
    outDir: 'dist',
    format: 'esm',
    platform: 'node',
    target: 'node20',
    bundle: true,
    noExternal: [/.*/],
    external: ['@vscode/ripgrep'],
    splitting: false,
    dts: false,
    sourcemap: false,
    clean: true,
    banner: {
        js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);'
    }
});
