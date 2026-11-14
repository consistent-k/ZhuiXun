import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            '@': path.join(rootDir, 'src')
        }
    },
    test: {
        environment: 'node',
        setupFiles: ['test/setup.ts'],
        include: ['test/**/*.test.ts'],
        exclude: ['test/contract/**', '**/node_modules/**', '**/dist/**'],
        fileParallelism: false,
        testTimeout: 10_000,
        hookTimeout: 10_000,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json-summary', 'json', 'html'],
            reportOnFailure: true,
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.d.ts', 'src/index.ts', 'src/server.ts'],
            // 全后端四项全局门禁：不缩小分母（见 docs/fe-workflow/backend-unit-testing/tech-design.md）。
            thresholds: {
                statements: 80,
                branches: 80,
                functions: 80,
                lines: 80,
                perFile: false,
                autoUpdate: false
            }
        }
    }
});
