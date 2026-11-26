// 只引入模块命名空间类型（类型擦除，无运行时依赖），避免 vi.mock 工厂里使用 import() 类型注解。
import type * as childProcessType from 'node:child_process';
import type * as dnsType from 'node:dns';
import type * as dnsPromisesType from 'node:dns/promises';
import fs from 'node:fs';
import type * as httpType from 'node:http';
import type * as httpsType from 'node:https';
import type * as netType from 'node:net';
import os from 'node:os';
import type * as osType from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, vi } from 'vitest';

// 所有默认测试先隔离 home；audit 没有 env 覆盖，不能为测试削弱生产路径保护。
vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof osType>();
    const homedir = () => process.env.ZHUIXUN_TEST_HOME!;
    const tmpdir = () => process.env.ZHUIXUN_TEST_HOME || actual.tmpdir();
    return { ...actual, homedir, tmpdir, default: { ...actual, homedir, tmpdir } };
});

// 防止漏配 fake 时访问公网、启动真实命令；替身只放在最底层，不替换被测业务逻辑。
vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof childProcessType>();
    const blocked = () => {
        throw new Error('默认测试禁止执行真实进程，请安装 process fake');
    };
    const overrides = {
        spawn: vi.fn(blocked),
        spawnSync: vi.fn(blocked),
        exec: vi.fn(blocked),
        execSync: vi.fn(blocked),
        execFile: vi.fn(blocked),
        execFileSync: vi.fn(blocked),
        fork: vi.fn(blocked)
    };
    return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

vi.mock('node:http', async (importOriginal) => {
    const actual = await importOriginal<typeof httpType>();
    const blocked = () => {
        throw new Error('默认测试禁止真实 HTTP，请安装 transport fake');
    };
    const overrides = { request: vi.fn(blocked), get: vi.fn(blocked), createServer: vi.fn(blocked) };
    return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

vi.mock('node:https', async (importOriginal) => {
    const actual = await importOriginal<typeof httpsType>();
    const blocked = () => {
        throw new Error('默认测试禁止真实 HTTPS，请安装 transport fake');
    };
    const overrides = { request: vi.fn(blocked), get: vi.fn(blocked), createServer: vi.fn(blocked) };
    return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

vi.mock('node:net', async (importOriginal) => {
    const actual = await importOriginal<typeof netType>();
    const blocked = () => {
        throw new Error('默认测试禁止真实 TCP/监听，请安装 net fake');
    };
    const overrides = {
        connect: vi.fn(blocked),
        createConnection: vi.fn(blocked),
        createServer: vi.fn(blocked)
    };
    return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

vi.mock('node:dns', async (importOriginal) => {
    const actual = await importOriginal<typeof dnsType>();
    const blocked = () => {
        throw new Error('默认测试禁止真实 DNS，请安装 resolver fake');
    };
    const overrides = {
        lookup: vi.fn(blocked),
        resolve: vi.fn(blocked),
        resolve4: vi.fn(blocked),
        resolve6: vi.fn(blocked)
    };
    return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

vi.mock('node:dns/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof dnsPromisesType>();
    const blocked = () => {
        throw new Error('默认测试禁止真实 DNS，请安装 resolver fake');
    };
    const overrides = {
        lookup: vi.fn(blocked),
        resolve: vi.fn(blocked),
        resolve4: vi.fn(blocked),
        resolve6: vi.fn(blocked)
    };
    return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zhuixun-suite-'));
const overrides: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    HOME: sandbox,
    USERPROFILE: sandbox,
    PORT: undefined,
    API_AUTH_TOKEN: undefined,
    ALLOWED_ORIGINS: undefined,
    LOG_TO_FILE: 'false',
    ZHUIXUN_TEST_HOME: sandbox,
    SETTINGS_CONFIG_PATH: path.join(sandbox, 'settings.json'),
    MCP_CONFIG_PATH: path.join(sandbox, '.mcp.json'),
    CONNECTORS_USER_DIR: path.join(sandbox, 'connectors'),
    MCP_OAUTH_PATH: path.join(sandbox, 'mcp-oauth.json'),
    SESSIONS_USER_DIR: path.join(sandbox, 'sessions'),
    PROJECTS_USER_DIR: path.join(sandbox, 'projects'),
    TASKS_USER_DIR: path.join(sandbox, 'tasks'),
    AUTOMATIONS_USER_DIR: path.join(sandbox, 'automations'),
    JOBS_USER_DIR: path.join(sandbox, 'jobs'),
    MEMORY_USER_DIR: path.join(sandbox, 'memory'),
    PERMISSION_USER_DIR: sandbox,
    STREAMS_USER_DIR: path.join(sandbox, 'streams'),
    SKILLS_USER_DIR: path.join(sandbox, 'skills'),
    SKILLS_EXTERNAL_DIRS: path.join(sandbox, 'external-skills'),
    LOG_DIR: path.join(sandbox, 'logs'),
    CHANNELS_USER_DIR: path.join(sandbox, 'channels'),
    COMMANDS_USER_DIR: path.join(sandbox, 'commands'),
    ZHUIXUN_DANGEROUSLY_SKIP_PERMISSIONS: '0'
};
const originals = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

const originalFetch = globalThis.fetch;
const blockedFetch: typeof fetch = () => Promise.reject(new Error('默认测试禁止真实 fetch，请安装 fetch fake'));
globalThis.fetch = blockedFetch;
beforeEach(() => {
    globalThis.fetch = blockedFetch;
});

afterAll(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of originals) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    await fs.promises.rm(sandbox, { recursive: true, force: true });
});
