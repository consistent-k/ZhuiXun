import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import type { ConnectorConnection } from '@zhuixun/shared';

import { writeFileAtomic } from '@/config/atomic-json';
import { paths } from '@/config/paths';

import { connectorDefinitions, type ConnectorDefinition } from './catalog';
import { runConnectorCommand, type CommandRunner } from './command';

interface Entry {
    enabled: boolean;
    configured: boolean;
}
interface Job {
    action: 'install' | 'auth';
    controller: AbortController;
    done: Promise<void>;
    url?: string;
    error?: string;
}

/** CLI 生命周期真源：同应用操作互斥；关闭/禁用先取消在途进程；凭证由官方 CLI 管理。 */
export class CliConnectorService {
    private entries: Record<string, Entry> = {};
    private jobs = new Map<string, Job>();
    private installationFailures = new Set<string>();
    private errors = new Map<string, string>();
    private checks = new Map<string, Promise<ConnectorConnection>>();
    private queue: Promise<unknown> = Promise.resolve();
    constructor(
        private root = paths.connectorsDir(),
        private definitions = connectorDefinitions,
        private run: CommandRunner = runConnectorCommand
    ) {
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, Entry>;
            for (const [id, entry] of Object.entries(data))
                if (entry && typeof entry.enabled === 'boolean' && typeof entry.configured === 'boolean')
                    this.entries[id] = entry;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw new Error('连接器状态文件损坏，请检查本地配置', { cause: error });
        }
    }
    private get file() {
        return path.join(this.root, 'cli-state.json');
    }
    private definition(id: string) {
        const definition = this.definitions.find((item) => item.app.id === id && item.cli);
        if (!definition?.cli) throw new Error('CLI 连接器不存在');
        return definition as ConnectorDefinition & { cli: NonNullable<ConnectorDefinition['cli']> };
    }
    private installDir(id: string) {
        return path.join(this.root, 'runtime', id);
    }
    private executable(id: string): { command: string; args: string[] } | undefined {
        const { cli } = this.definition(id);
        const packageDir = path.join(this.installDir(id), 'node_modules', cli.package.name);
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
                version?: string;
                bin?: Record<string, string>;
            };
            const bin = manifest.bin?.[cli.package.bin];
            if (manifest.version !== cli.package.version || !bin) return;
            const entry = path.resolve(packageDir, bin);
            if (!entry.startsWith(packageDir + path.sep) || !fs.existsSync(entry)) return;
            return /\.[cm]?js$/i.test(entry) ? { command: 'node', args: [entry] } : { command: entry, args: [] };
        } catch {
            return;
        }
    }
    private save() {
        const snapshot = JSON.stringify(this.entries, null, 2) + '\n';
        const next = this.queue.then(() => writeFileAtomic(this.file, snapshot, { mode: 0o600 }));
        this.queue = next.catch(() => undefined);
        return next;
    }
    view(id: string): ConnectorConnection {
        this.definition(id);
        const entry = this.entries[id],
            job = this.jobs.get(id),
            error = this.errors.get(id);
        const installed = !!this.executable(id) && !this.installationFailures.has(id);
        return {
            id,
            installed,
            enabled: entry?.enabled ?? false,
            configured: entry?.configured ?? false,
            toolCount: entry?.configured && entry.enabled ? 1 : 0,
            status: job
                ? job.action === 'install'
                    ? 'installing'
                    : 'authorizing'
                : error
                  ? 'failed'
                  : !installed
                    ? 'not-installed'
                    : entry?.enabled === false && entry.configured
                      ? 'disabled'
                      : entry?.configured
                        ? 'connected'
                        : 'disconnected',
            authorizationUrl: job?.url,
            error
        };
    }
    async refresh(id: string): Promise<ConnectorConnection> {
        if (this.jobs.has(id)) return this.view(id);
        const current = this.checks.get(id);
        if (current) return current;
        const promise = this.check(id).finally(() => this.checks.delete(id));
        this.checks.set(id, promise);
        return promise;
    }
    private async check(id: string) {
        const { cli } = this.definition(id),
            executable = this.executable(id),
            entry = this.entries[id];
        if (!executable || !entry?.enabled || this.installationFailures.has(id)) return this.view(id);
        const result = await this.run(executable.command, [...executable.args, ...cli.statusArgs], {
            timeoutMs: 15_000
        });
        const output = result.stdout + result.stderr;
        const configured = result.code === 0 && cli.statusSuccess.test(output) && !cli.statusFailure.test(output);
        this.entries[id] = { enabled: entry.enabled, configured };
        if (!configured) this.errors.delete(id);
        if (entry.configured !== configured) await this.save();
        return this.view(id);
    }
    async list() {
        return Promise.all(this.definitions.filter((item) => item.cli).map((item) => this.refresh(item.app.id)));
    }
    async start(id: string, action: 'install' | 'auth'): Promise<ConnectorConnection> {
        const { cli } = this.definition(id);
        if (this.jobs.has(id) || this.checks.has(id)) throw new Error('连接器正在操作中，请稍后再试');
        const executable = this.executable(id);
        if (action === 'auth' && (!executable || this.installationFailures.has(id)))
            throw new Error('请先安装应用组件');
        this.errors.delete(id);
        if (action === 'install') this.installationFailures.delete(id);
        this.entries[id] = { enabled: true, configured: this.entries[id]?.configured ?? false };
        const job: Job = { action, controller: new AbortController(), done: Promise.resolve() };
        this.jobs.set(id, job);
        job.done = (async () => {
            try {
                await this.save();
                const result =
                    action === 'install'
                        ? await this.run(
                              'npm',
                              [
                                  'install',
                                  '--prefix',
                                  this.installDir(id),
                                  '--omit=dev',
                                  '--no-audit',
                                  '--no-fund',
                                  '--ignore-scripts',
                                  `${cli.package.name}@${cli.package.version}`
                              ],
                              { signal: job.controller.signal, timeoutMs: 180_000 }
                          )
                        : await this.run(executable!.command, [...executable!.args, ...cli.loginArgs], {
                              signal: job.controller.signal,
                              timeoutMs: 300_000,
                              onOutput: (output) => {
                                  for (const match of stripVTControlCharacters(output).matchAll(
                                      /https:\/\/[^\s<>"']+/g
                                  )) {
                                      try {
                                          const url = new URL(match[0]);
                                          if (!url.username && !url.password && cli.authHosts.includes(url.hostname))
                                              job.url = url.toString();
                                      } catch {
                                          /* CLI 输出中非 URL 片段不参与授权。 */
                                      }
                                  }
                              }
                          });
                if (job.controller.signal.aborted) return;
                if (result.code !== 0)
                    throw new Error(action === 'install' ? '安装失败，请检查网络后重试' : '授权未完成，请重新连接');
                const installed = this.executable(id);
                if (!installed) throw new Error('未找到应用组件，请重新安装');
                if (action === 'install') {
                    const version = await this.run(installed.command, [...installed.args, ...cli.versionArgs], {
                        timeoutMs: 15_000,
                        signal: job.controller.signal
                    });
                    if (version.code !== 0) throw new Error('应用组件无法运行，请重新安装');
                }
                this.jobs.delete(id);
                await this.refresh(id);
            } catch (error) {
                if (!job.controller.signal.aborted) {
                    // 安装或版本校验失败时仍可能留下入口文件，不能据此误显示为可授权。
                    if (action === 'install') this.installationFailures.add(id);
                    this.errors.set(id, error instanceof Error ? error.message : '连接失败，请重试');
                }
            } finally {
                if (this.jobs.get(id) === job) this.jobs.delete(id);
            }
        })();
        return this.view(id);
    }
    private async cancel(id: string) {
        const job = this.jobs.get(id);
        if (job) {
            job.controller.abort();
            await job.done;
        }
        await this.checks.get(id);
    }
    async setEnabled(id: string, enabled: boolean) {
        this.definition(id);
        await this.cancel(id);
        this.entries[id] = { enabled, configured: this.entries[id]?.configured ?? false };
        this.errors.delete(id);
        await this.save();
        return enabled ? this.refresh(id) : this.view(id);
    }
    async disconnect(id: string) {
        const { cli } = this.definition(id);
        await this.cancel(id);
        const executable = this.executable(id);
        if (executable) {
            const result = await this.run(executable.command, [...executable.args, ...cli.logoutArgs], {
                timeoutMs: 15_000
            });
            if (result.code !== 0) throw new Error('退出授权失败，请重试');
        }
        delete this.entries[id];
        this.errors.delete(id);
        await this.save();
        return this.view(id);
    }
    async execute(id: string, args: string[], signal?: AbortSignal) {
        const { cli } = this.definition(id);
        // 工具闭包可能早于授权失效创建，执行前复查官方登录态，防止继续使用过期连接。
        if ((await this.refresh(id)).status !== 'connected')
            throw new Error('应用未连接或已停用，请在连接器页面重新连接');
        if (!cli.allowedCommands.some((prefix) => prefix.every((word, index) => args[index] === word)))
            throw new Error('该命令不属于此连接器开放的操作');
        const executable = this.executable(id);
        if (!executable) throw new Error('应用组件不可用，请重新安装');
        const result = await this.run(executable.command, [...executable.args, ...args], { timeoutMs: 60_000, signal });
        return {
            exitCode: result.code,
            output: result.stdout,
            ...(result.code !== 0 ? { error: '应用操作失败，请检查参数或重新授权' } : {})
        };
    }
    async dispose() {
        await Promise.all([...this.jobs.keys()].map((id) => this.cancel(id)));
        await this.queue;
    }
}

let singleton: CliConnectorService | undefined;
export function getCliConnectorService() {
    return (singleton ??= new CliConnectorService());
}
export async function disposeCliConnectors() {
    await singleton?.dispose();
    singleton = undefined;
}
