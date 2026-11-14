import { defineConfig } from 'vitest/config';

import baseConfig from './vitest.config';

const baseTest = baseConfig.test ?? {};

export default defineConfig({
    ...baseConfig,
    test: {
        ...baseTest,
        // 真实契约测试显式 opt-in；不能继承默认套件的外部 I/O 阻断或全局覆盖率门禁。
        setupFiles: [],
        include: ['test/contract/**/*.test.ts'],
        exclude: ['**/node_modules/**', '**/dist/**'],
        coverage: {
            ...baseTest.coverage,
            reportsDirectory: 'coverage/contract',
            thresholds: undefined
        },
        passWithNoTests: true
    }
});
