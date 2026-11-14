import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const packageName = '@zhuixun/cli';

export async function updateCli(current: string, install: boolean): Promise<string> {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const options = { timeout: 60_000, shell: process.platform === 'win32' };
    const { stdout } = await run(npm, ['view', packageName, 'version', '--json'], options);
    const version: unknown = JSON.parse(stdout);
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('无法识别 npm 发布版本');
    const available = version.split('.').map(Number);
    const installed = current.split('.').map(Number);
    const difference = available.map((value, index) => value - installed[index]).find((value) => value !== 0) ?? 0;
    if (difference <= 0) return `当前 ${current}，npm 最新 ${version}`;
    if (!install) return `发现 ${version}。运行 /update install 或 zhuixun update --install 安装。`;
    await run(npm, ['install', '-g', `${packageName}@${version}`], options);
    return `已安装 ${version}，请退出并重新启动 zhuixun。`;
}
