import type { ConnectorApp } from '@zhuixun/shared';

import type { MCPServerConfig } from '@/modules/mcp';

export interface CliDefinition {
    package: { name: string; version: string; bin: string };
    versionArgs: string[];
    statusArgs: string[];
    loginArgs: string[];
    logoutArgs: string[];
    statusSuccess: RegExp;
    statusFailure: RegExp;
    authHosts: string[];
    allowedCommands: string[][];
    instructions: string;
}

export interface ConnectorDefinition {
    app: ConnectorApp;
    mcp?: Omit<MCPServerConfig, 'name' | 'connectorId'>;
    cli?: CliDefinition;
}

/** 只有随源码发布的声明能指定命令或端点，HTTP 客户端不能注入安装脚本。 */
export const connectorDefinitions: ConnectorDefinition[] = [
    {
        app: {
            id: 'baidu-netdisk',
            name: '百度网盘',
            kind: 'mcp',
            category: '文件存储',
            auth: 'token',
            description: '搜索、整理网盘文件，创建文件夹与分享链接。',
            website: 'https://pan.baidu.com/union/doc/mcp-server/操作指南/在-agent-中自定义使用/',
            credentialUrl:
                'https://openapi.baidu.com/oauth/2.0/authorize?response_type=token&client_id=QHOuRXiepJBMjtk0esLhrPoNlQyYd0mF&redirect_uri=oob&scope=basic,netdisk&qrcode=1',
            fields: [
                {
                    key: 'token',
                    label: 'Access Token',
                    type: 'password',
                    required: true,
                    format: 'token',
                    tokenFromUrl: {
                        host: 'openapi.baidu.com',
                        path: '/oauth/2.0/login_success',
                        param: 'access_token',
                        source: 'hash'
                    },
                    placeholder: '粘贴 Token 或完整授权结果地址'
                }
            ],
            permissions: ['访问账号与网盘文件信息', '搜索、移动文件及创建分享链接'],
            examples: ['查询网盘剩余容量', '查找最近的项目资料'],
            notice: '个人连接可通过官方授权获取 Token，无需创建应用。平台级 OAuth 接入需另行申请。'
        },
        mcp: {
            transport: 'sse',
            authType: 'none',
            url: 'https://mcp-pan.baidu.com/sse',
            headers: { Authorization: 'Bearer ${token}' }
        }
    },
    {
        app: {
            id: 'linear',
            name: 'Linear',
            kind: 'mcp',
            category: '项目管理',
            auth: 'oauth',
            description: '查找项目与工单，更新进度，整理团队待办。',
            website: 'https://linear.app/docs/mcp',
            fields: [],
            permissions: ['访问授权工作区中的项目、工单及评论', '创建和更新工单、项目及评论'],
            examples: ['列出我本周需要处理的工单', '把讨论整理成工单']
        },
        mcp: { transport: 'streamableHttp', authType: 'oauth', url: 'https://mcp.linear.app/mcp' }
    },
    {
        app: {
            id: 'tencent-meeting',
            name: '腾讯会议',
            kind: 'cli',
            category: '会议协作',
            auth: 'cli',
            fields: [],
            description: '查询会议安排，创建和管理腾讯会议。',
            website: 'https://meeting.tencent.com/meeting-cli/index.html',
            permissions: ['通过官方 CLI 访问已授权的会议账号', '查询、创建、更新或取消会议'],
            examples: ['查看今天的会议安排', '创建一个项目评审会议'],
            notice: '安装官方 CLI 到追寻专用目录后登录，登录凭证由官方 CLI 管理。'
        },
        cli: {
            package: { name: '@tencentcloud/tmeet', version: '1.1.1', bin: 'tmeet' },
            versionArgs: ['--version'],
            statusArgs: ['auth', 'status'],
            loginArgs: ['auth', 'login', '--no-browser'],
            logoutArgs: ['auth', 'logout'],
            statusSuccess: /已登录|Logged in/i,
            statusFailure: /未登录|Not logged in|已过期|expired/i,
            authHosts: ['meeting.tencent.com'],
            allowedCommands: [
                ['meeting', 'list'],
                ['meeting', 'get'],
                ['meeting', 'create'],
                ['meeting', 'update'],
                ['meeting', 'cancel']
            ],
            instructions:
                '腾讯会议已通过官方 CLI 连接。使用 args 字符串数组调用工具，不传程序名。先查询后修改；命令参数用 --help 核实。可用 meeting list/get/create/update/cancel。创建会议使用 --subject、--start、--end（ISO 8601）；查询单个会议使用 --meeting-id。不要安装、登录、退出或读取凭证；需要重新授权时请用户在连接器页面操作。'
        }
    }
];

export const connectorCatalog = connectorDefinitions.map(({ app }) => app);

/** 校验字段并归一用户输入；密码字段不通过列表回显。 */
export function validateConnectorValues(app: ConnectorApp, values: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const field of app.fields) {
        let value = (values[field.key] ?? field.defaultValue ?? '').trim();
        if (field.tokenFromUrl && /^https:\/\//i.test(value)) {
            const url = new URL(value);
            if (url.hostname !== field.tokenFromUrl.host || url.pathname !== field.tokenFromUrl.path)
                throw new Error('请填写官方授权结果中的 Token');
            value =
                new URLSearchParams(field.tokenFromUrl.source === 'hash' ? url.hash.slice(1) : url.search).get(
                    field.tokenFromUrl.param
                ) ?? '';
        }
        if (!value && field.required) throw new Error(`请填写${field.label}`);
        if (value.length > 8192 || /[\r\n\0]/.test(value) || (field.format === 'token' && /\s/.test(value)))
            throw new Error(`${field.label}格式不正确`);
        if (value && field.format === 'url' && new URL(value).protocol !== 'https:')
            throw new Error(`${field.label}需使用 HTTPS`);
        if (value) result[field.key] = value;
    }
    return result;
}

/** 根据声明生成 MCP 配置：Header / URL / stdio 参数与环境变量均可引用字段。 */
export function createConnectorConfig(id: string, input?: string | Record<string, string>): MCPServerConfig {
    const definition = connectorDefinitions.find(({ app }) => app.id === id);
    if (!definition?.mcp) throw new Error('应用不是 MCP 连接器');
    const values = validateConnectorValues(
        definition.app,
        typeof input === 'string' ? { token: input } : (input ?? {})
    );
    const fill = (value: string, url = false) =>
        value.replace(/\$\{([a-zA-Z_][\w]*)\}/g, (_, key: string) => {
            if (!(key in values) && !definition.app.fields.some((field) => field.key === key && !field.required))
                throw new Error(`缺少连接字段：${key}`);
            const value = values[key] ?? '';
            return url && !definition.app.fields.some((field) => field.key === key && field.format === 'url')
                ? encodeURIComponent(value)
                : value;
        });
    const record = (value?: Record<string, string>) =>
        value
            ? Object.fromEntries(
                  Object.entries(value)
                      .filter(([, item]) => typeof item === 'string')
                      .map(([key, item]) => [key, fill(item)])
              )
            : undefined;
    return {
        ...definition.mcp,
        name: `app-${id}`,
        connectorId: id,
        url: definition.mcp.url ? fill(definition.mcp.url, true) : undefined,
        oauth: definition.mcp.oauth ? record(definition.mcp.oauth as Record<string, string>) : undefined,
        headers: record(definition.mcp.headers),
        env: record(definition.mcp.env),
        args: definition.mcp.args?.map((arg) => fill(arg))
    };
}
