import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    CliConnectorService,
    connectorDefinitions,
    createConnectorConfig,
    validateConnectorValues
} from '@/modules/connectors';
import type { CommandRunner } from '@/modules/connectors/command';
import { createCliConnectorTools } from '@/modules/connectors/tools';

import { createTempData } from '../helpers/temp-data';

const definition = connectorDefinitions.find((item) => item.cli)!;
const id = definition.app.id;

describe('声明式连接器与 CLI 生命周期', () => {
    let temp: Awaited<ReturnType<typeof createTempData>>;
    let service: CliConnectorService;
    let installed: () => Promise<void>;
    let loggedIn: boolean;
    let run: ReturnType<typeof vi.fn<CommandRunner>>;
    beforeEach(async () => {
        temp = await createTempData('connectors-');
        loggedIn = false;
        installed = async () => {
            const dir = path.join(temp.root, 'runtime', id, 'node_modules', definition.cli!.package.name);
            await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
            await fs.writeFile(path.join(dir, 'scripts/tmeet.js'), '// offline fixture');
            await fs.writeFile(
                path.join(dir, 'package.json'),
                JSON.stringify({ version: definition.cli!.package.version, bin: { tmeet: 'scripts/tmeet.js' } })
            );
        };
        run = vi.fn(async (command, args) => {
            if (command === 'npm') await installed();
            if (args.includes('login')) loggedIn = true;
            if (args.includes('logout')) loggedIn = false;
            return {
                code: 0,
                stdout: args.includes('status')
                    ? loggedIn
                        ? 'Logged in as fixture'
                        : 'Not logged in'
                    : 'fixture result',
                stderr: ''
            };
        });
        service = new CliConnectorService(temp.root, connectorDefinitions, run);
    });
    afterEach(async () => {
        await service.dispose();
        await temp.cleanup();
    });

    it('从字段声明生成 Header，不把令牌放进 URL，接受官方回调地址', () => {
        const config = createConnectorConfig('baidu-netdisk', {
            token: 'https://openapi.baidu.com/oauth/2.0/login_success#access_token=fixture-token&expires_in=1'
        });
        expect(config.url).toBe('https://mcp-pan.baidu.com/sse');
        expect(config.headers).toEqual({ Authorization: 'Bearer fixture-token' });
        expect(() =>
            createConnectorConfig('baidu-netdisk', {
                token: 'https://untrusted.invalid/oauth/2.0/login_success#access_token=x'
            })
        ).toThrow();
        expect(() => createConnectorConfig('baidu-netdisk', { token: 'abc\r\nHeader: bad' })).toThrow();
        const app = {
            ...definition.app,
            fields: [
                { key: 'workspace', label: '工作区', type: 'text' as const, required: true },
                { key: 'apiKey', label: '密钥', type: 'password' as const, required: true }
            ]
        };
        expect(validateConnectorValues(app, { workspace: ' team ', apiKey: 'fixture-key', ignored: 'x' })).toEqual({
            workspace: 'team',
            apiKey: 'fixture-key'
        });
        expect(() => validateConnectorValues(app, { workspace: 'team' })).toThrow('密钥');
    });

    it('安装到独立目录，校验组件；未登录时不挂 SDK 工具', async () => {
        expect(service.view(id).status).toBe('not-installed');
        await expect(service.start(id, 'auth')).rejects.toThrow('先安装');
        expect((await service.start(id, 'install')).status).toBe('installing');
        await expect(service.start(id, 'install')).rejects.toThrow('操作中');
        await vi.waitFor(() => expect(service.view(id).status).toBe('disconnected'));
        expect(run).toHaveBeenCalledWith(
            'npm',
            expect.arrayContaining([
                '--prefix',
                path.join(temp.root, 'runtime', id),
                '--ignore-scripts',
                '@tencentcloud/tmeet@1.1.1'
            ]),
            expect.any(Object)
        );
        expect(await createCliConnectorTools(service)).toEqual({});
        expect((await fs.stat(path.join(temp.root, 'cli-state.json'))).mode & 0o777).toBe(0o600);
    });

    it('登录后 SDK tool 可执行，暂停/过期/断开后不可执行，重启后检查实际登录状态', async () => {
        await installed();
        await service.start(id, 'auth');
        await vi.waitFor(() => expect(service.view(id).status).toBe('connected'));
        const tools = await createCliConnectorTools(service);
        expect(Object.keys(tools)).toEqual(['connector_cli_tencent_meeting']);
        const tool = tools.connector_cli_tencent_meeting!;
        expect(
            await tool.execute!(
                { args: ['meeting', 'list'] },
                { toolCallId: 'fixture', messages: [], context: undefined }
            )
        ).toMatchObject({ exitCode: 0 });
        await expect(service.execute(id, ['auth', 'status'])).rejects.toThrow('不属于');
        await service.setEnabled(id, false);
        expect(service.view(id).status).toBe('disabled');
        await expect(service.execute(id, ['meeting', 'list'])).rejects.toThrow('停用');
        await service.setEnabled(id, true);
        expect(service.view(id).status).toBe('connected');
        loggedIn = false;
        await expect(service.execute(id, ['meeting', 'list'])).rejects.toThrow('停用');
        const restarted = new CliConnectorService(temp.root, connectorDefinitions, run);
        expect((await restarted.refresh(id)).status).toBe('disconnected');
        await restarted.dispose();
        await service.disconnect(id);
        expect(service.view(id).configured).toBe(false);
        expect(run.mock.calls.some(([, args]) => args.includes('logout'))).toBe(true);
    });

    it('授权进程只暴露白名单 URL；取消会终止进程且不标为已连接', async () => {
        await installed();
        let aborted = false;
        run.mockImplementationOnce(async (_command, _args, options) => {
            options?.onOutput?.('https://evil.invalid/auth https://meeting.tencent.com/authorize?code=fixture');
            return new Promise((resolve) =>
                options?.signal?.addEventListener(
                    'abort',
                    () => {
                        aborted = true;
                        resolve({ code: -1, stdout: '', stderr: '' });
                    },
                    { once: true }
                )
            );
        });
        await service.start(id, 'auth');
        await vi.waitFor(() => expect(service.view(id).authorizationUrl).toContain('https://meeting.tencent.com/'));
        expect(JSON.stringify(service.view(id))).not.toContain('evil.invalid');
        await service.setEnabled(id, false);
        expect(aborted).toBe(true);
        expect(service.view(id).configured).toBe(false);
        expect(service.view(id).authorizationUrl).toBeUndefined();
    });

    it('安装失败和退出失败如实报告，不伪造成功', async () => {
        run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'fixture-secret' });
        await service.start(id, 'install');
        await vi.waitFor(() => expect(service.view(id).status).toBe('failed'));
        expect(JSON.stringify(service.view(id))).not.toContain('fixture-secret');
        expect(service.view(id).installed).toBe(false);
        await service.start(id, 'install');
        await vi.waitFor(() => expect(service.view(id).status).toBe('disconnected'));
        expect(service.view(id).installed).toBe(true);
        await installed();
        run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'logout failure' });
        await expect(service.disconnect(id)).rejects.toThrow('退出授权失败');
    });
});
