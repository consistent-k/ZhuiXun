/** Agent 活动流展示用的纯格式化工具。 */

/** 压成单行并截断，避免组头/摘要行被长命令撑破 */
export function truncateSingleLine(text: string, max = 120): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, max - 1)}…`;
}

/** 取路径最后一段，兼容 POSIX 与 Windows 分隔符 */
export function basename(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
    const index = normalized.lastIndexOf('/');
    return index >= 0 ? normalized.slice(index + 1) || normalized : normalized;
}

/** 取绝对路径所在目录；非绝对路径返回空串（不可记忆） */
export function dirnameOf(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const isAbsolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
    if (!isAbsolute) return '';
    const index = normalized.lastIndexOf('/');
    return index > 0 ? normalized.slice(0, index) : index === 0 ? '/' : '';
}

/** 文件扩展名 → Prism 语言名；未知按纯文本处理 */
export function langFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
        ts: 'typescript',
        tsx: 'tsx',
        js: 'javascript',
        jsx: 'jsx',
        mjs: 'javascript',
        cjs: 'javascript',
        json: 'json',
        jsonc: 'json',
        md: 'markdown',
        markdown: 'markdown',
        css: 'css',
        scss: 'scss',
        less: 'less',
        html: 'xml',
        htm: 'xml',
        xml: 'xml',
        svg: 'xml',
        py: 'python',
        sh: 'bash',
        bash: 'bash',
        zsh: 'bash',
        yml: 'yaml',
        yaml: 'yaml',
        sql: 'sql',
        go: 'go',
        rs: 'rust',
        java: 'java',
        kt: 'kotlin',
        kts: 'kotlin',
        swift: 'swift',
        c: 'c',
        h: 'c',
        cc: 'cpp',
        cpp: 'cpp',
        hpp: 'cpp',
        cs: 'csharp',
        rb: 'ruby',
        php: 'php',
        toml: 'toml',
        ini: 'ini'
    };
    return map[ext] ?? 'text';
}

/** 秒级耗时：不足 1s 按 1s 显示，避免出现 0s */
export function formatDuration(ms: number): string {
    return `${Math.max(1, Math.round(ms / 1000))}s`;
}

/** 从 URL 取主机名，解析失败返回原串 */
export function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/** MCP 工具名统一为 `mcp__<server>__<tool>`；解析失败返回 null */
export function parseMcpName(toolName: string): { server: string; tool: string } | null {
    const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
    return match ? { server: match[1], tool: match[2] } : null;
}

export function lineCount(text: string): number {
    if (!text) return 0;
    return text.split('\n').length;
}

/** 取第一行非空文本（思考完成后摘要） */
export function firstLine(text: string): string {
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) return trimmed;
    }
    return '';
}

/** 取最后一行非空文本（思考流式中的滚动摘要） */
export function lastLine(text: string): string {
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (trimmed) return trimmed;
    }
    return '';
}

/** JSON 展示统一截断，避免大对象进 DOM */
export function formatJson(value: unknown, max = 2000): string {
    if (value == null) return '';
    try {
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return text.length > max ? `${text.slice(0, max)}\n...（已截断）` : text;
    } catch {
        return String(value);
    }
}

/** MCP server/tool 名清洗规则：与后端 buildPrefixedToolName 保持一致 */
export function sanitizeMcpNamePart(value: string): string {
    return value.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** 从模型工具名里剥掉 server 前缀，得到原始 tool 名用于展示 */
export function stripMcpServerPrefix(toolName: string, serverName: string): string {
    const prefix = `${sanitizeMcpNamePart(serverName)}_`;
    return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}
