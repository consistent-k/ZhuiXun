import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron/simple';

import { resolveMacDevLauncher } from './electron/dev-mac-app.ts';

// vite 统一管理三端：renderer(React) + Electron main + preload。
// dev 下 vite-plugin-electron 自动构建 main/preload 并拉起 Electron、改动即重启；
// build 下产出 dist/(renderer) 与 dist-electron/(main.mjs + preload.cjs)。
//
// WEB_ONLY=1 时不挂 electron 插件：仅跑纯 web(浏览器)渲染进程，不拉起 Electron 窗口。
// 配合独立后端(pnpm dev:backend 的 127.0.0.1:3001)，用浏览器打开 http://localhost:8080 调试。
const webOnly = !!process.env.WEB_ONLY;

export default defineConfig({
    plugins: [
        react(),
        ...(webOnly
            ? []
            : [
                  electron({
                      main: {
                          entry: 'electron/main.ts',
                          ...(process.platform === 'darwin'
                              ? {
                                    onstart: async ({ startup }) => {
                                        await startup(undefined, undefined, await resolveMacDevLauncher());
                                    }
                                }
                              : {}),
                          vite: {
                              build: {
                                  rolldownOptions: {
                                      // ESM 主进程：main.ts 用 import.meta.url 并 dynamic import 后端 ESM 产物。
                                      // 产物名由插件定为 dist-electron/main.js（type:module 下即 ESM）。
                                      output: { format: 'es' }
                                  }
                              }
                          }
                      },
                      preload: {
                          input: 'electron/preload.ts',
                          vite: {
                              build: {
                                  rolldownOptions: {
                                      // sandbox:true 下 preload 必须是 CJS。
                                      output: { format: 'cjs', entryFileNames: 'preload.cjs' }
                                  }
                              }
                          }
                      }
                  })
              ])
    ],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url))
        }
    },
    server: {
        port: 8080,
        strictPort: true
    }
});
