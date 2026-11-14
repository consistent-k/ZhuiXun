import { readdir } from 'node:fs/promises';
import path from 'node:path';

export const commands = {
    help: '查看帮助',
    status: '查看当前会话和工作目录',
    sessions: '选择历史会话',
    resume: '恢复指定会话',
    new: '开始新会话',
    clear: '开始新会话',
    model: '选择模型',
    project: '选择项目',
    config: '配置模型',
    compact: '压缩会话',
    channel: '管理 Telegram 和微信',
    cancel: '停止生成',
    exit: '退出终端',
    approvals: '查看或删除记住的审批规则',
    tools: '查看技能与连接器工具',
    reload: '刷新文件与命令索引',
    theme: '切换终端配色',
    locale: '切换终端语言',
    update: '查看 CLI 更新方式',
    agents: '查看后端子任务能力'
};

export interface Choice {
    label: string;
    description?: string;
    value: string;
    requiresArguments?: boolean;
}

export async function indexFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    const queue = [''];
    for (let i = 0; i < queue.length && i < 5000 && files.length < 5000; i++) {
        const dir = queue[i];
        const entries = await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.name.startsWith('.') || ['node_modules', 'dist', 'coverage'].includes(entry.name)) continue;
            const relative = dir ? dir + '/' + entry.name : entry.name;
            if (entry.isDirectory() && queue.length < 5000) queue.push(relative);
            else if (entry.isFile()) files.push(relative);
            if (files.length >= 5000) break;
        }
    }
    return files.sort();
}

export function choicesFor(input: string, custom: Choice[], files: string[]): Choice[] | undefined {
    if (/^\/[^\s]*$/.test(input)) {
        const local = Object.entries(commands).map(([name, description]) => ({
            label: '/' + name,
            description,
            value: '/' + name,
            requiresArguments: name === 'resume'
        }));
        return [...local, ...custom.filter((item) => !local.some((command) => command.value === item.value))].filter(
            (item) => item.value.startsWith(input.toLowerCase())
        );
    }
    const mention = /(?:^|\s)@([^\s]*)$/.exec(input);
    if (!mention) return undefined;
    return files
        .filter((file) => file.toLowerCase().includes(mention[1].toLowerCase()))
        .slice(0, 20)
        .map((file) => ({ label: file, value: file }));
}
