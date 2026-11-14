import fs from 'node:fs';
import os from 'node:os';

/**
 * 宿主机操作系统描述，拼进 Bash 工具说明。
 *
 * 模型在未知宿主系统时会按 Linux 假设（mac 实测：先 `free -h`、再 `cat /proc/meminfo`，
 * 两次失败后才换 `sysctl`），额外产生多次工具调用与审批弹窗。这里只用纯 fs / os 读取，不起子进程。
 */
export type OsFamily = 'macos' | 'linux' | 'windows' | 'other';

export interface HostOs {
    family: OsFamily;
    /** 给模型看的一行描述，如 `macOS 15.5（Apple Silicon, arm64）`。 */
    label: string;
}

/** 读文件并按正则取第一个分组；任何失败返回 undefined（描述信息缺失不影响工具可用）。 */
function readMatch(file: string, re: RegExp): string | undefined {
    try {
        return re.exec(fs.readFileSync(file, 'utf8'))?.[1]?.trim();
    } catch {
        return undefined;
    }
}

/** CPU 架构说明。用 CPU 型号判断 Apple Silicon：x64 构建经 Rosetta 运行时 os.arch() 是 x64，但型号仍是 Apple M*。 */
function archLabel(): string {
    const arch = os.arch();
    const model = os.cpus()[0]?.model ?? '';
    if (process.platform === 'darwin') {
        return /apple/i.test(model)
            ? `Apple Silicon, ${arch === 'arm64' ? 'arm64' : `${arch}（Rosetta 转译）`}`
            : `Intel, ${arch}`;
    }
    return arch;
}

function detectHostOs(): HostOs {
    const arch = archLabel();
    switch (process.platform) {
        case 'darwin': {
            const version = readMatch(
                '/System/Library/CoreServices/SystemVersion.plist',
                /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/
            );
            return { family: 'macos', label: `macOS ${version ?? `（Darwin ${os.release()}）`}（${arch}）` };
        }
        case 'linux': {
            const name = readMatch('/etc/os-release', /^PRETTY_NAME="?([^"\n]+)"?/m) ?? `Linux ${os.release()}`;
            return { family: 'linux', label: `${name}（${arch}）` };
        }
        case 'win32': {
            // os.version() 在 Win11 上仍可能返回 "Windows 10 ..."（注册表 ProductName 未更新），按内部版本号判断：≥22000 为 Windows 11
            const build = Number(os.release().split('.')[2]);
            const name = Number.isFinite(build) && build >= 22000 ? 'Windows 11' : 'Windows 10';
            return { family: 'windows', label: `${name}（build ${os.release()}，${arch}）` };
        }
        default:
            return { family: 'other', label: `${process.platform} ${os.release()}（${arch}）` };
    }
}

let cache: HostOs | undefined;

/** 宿主机系统描述（进程级缓存：系统信息在进程生命周期内不变）。 */
export function hostOs(): HostOs {
    cache ??= detectHostOs();
    return cache;
}
