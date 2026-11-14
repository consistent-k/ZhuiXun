import js from '@eslint/js';
import compat from 'eslint-plugin-compat';
import importPlugin from 'eslint-plugin-import-x';
import prettier from 'eslint-plugin-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import unusedImports from 'eslint-plugin-unused-imports';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// 前后端共用的规则,避免在两个 block 里重复维护
const sharedRules = {
    'prettier/prettier': 'warn',
    // timer/graceTimer 等变量在闭包里先被读取、后赋值,这类模式保留 let
    'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    '@typescript-eslint/no-unused-vars': [
        'warn',
        {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_'
        }
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/ban-ts-comment': 'off',
    '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
    'unused-imports/no-unused-imports': 'warn',
    'import-x/order': [
        'warn',
        {
            groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
            pathGroups: [
                { pattern: '@/**', group: 'internal' }
            ],
            pathGroupsExcludedImportTypes: [],
            'newlines-between': 'always',
            alphabetize: { order: 'asc', caseInsensitive: true }
        }
    ]
};

export default defineConfig([
    globalIgnores(['**/dist', '**/dist-electron', '**/build', '**/release', '**/coverage', '**/node_modules']),
    // 前端:React 19 渲染进程,运行在 Electron(Chromium) 的 webview 环境
    {
        files: ['apps/desktop/**/*.{ts,tsx}'],
        extends: [
            js.configs.recommended,
            tseslint.configs.recommended,
            reactHooks.configs.flat.recommended,
            reactRefresh.configs.vite
        ],
        languageOptions: {
            globals: globals.browser
        },
        plugins: {
            prettier,
            'unused-imports': unusedImports,
            'import-x': importPlugin,
            compat
        },
        rules: {
            ...sharedRules,
            'compat/compat': 'warn'
        },
        settings: {
            // 渲染进程跑在 Electron(Chromium) 的 webview，不面对浏览器市场：
            // 固定 Electron 版本为 compat targets，避免 browserslist 默认 `defaults`（含 op_mini
            // 等不支持 fetch/Promise 的老浏览器）对 Chromium 环境误报。
            // 版本须写「主版本.0」：electron-to-chromium 数据键带 patch（如 '45.0'），裸 45 会报 Unknown version。
            targets: ['electron 45.0']
        }
    },
    // 后端:Node.js + Hono,运行在 Node 环境(无 React / 浏览器兼容检查)。含后端内部渠道包 packages/*（Node 侧）。
    {
        files: ['apps/backend/**/*.ts', 'apps/cli/**/*.{ts,tsx}', 'packages/**/*.ts'],
        extends: [js.configs.recommended, tseslint.configs.recommended],
        languageOptions: {
            globals: globals.node
        },
        plugins: {
            prettier,
            'unused-imports': unusedImports,
            'import-x': importPlugin
        },
        rules: sharedRules
    },
    // Electron 壳(主进程/preload):运行在 Node 环境,需 Node 全局(process 等)。
    // 置于前端 block 之后,为这些文件叠加 Node 全局并关掉浏览器兼容检查(compat 面向老浏览器,
    // 对 Node 侧的 URL/fetch 等是误报)。
    {
        files: ['apps/desktop/electron/**/*.ts'],
        languageOptions: {
            globals: globals.node
        },
        rules: {
            'compat/compat': 'off'
        }
    }
]);
