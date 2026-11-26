import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { createLogger } from '@/platform/logging/index';

import { connectorDefinitions } from './catalog';
import { getCliConnectorService, type CliConnectorService } from './cli-service';

/** 使用 AI SDK 原生 tool，审批与 hooks 由现有 Agent 装配管线负责。 */
export async function createCliConnectorTools(service?: CliConnectorService): Promise<ToolSet> {
    let instance: CliConnectorService;
    let states;
    try {
        instance = service ?? getCliConnectorService();
        states = await instance.list();
    } catch {
        createLogger('Connectors').warn('CLI 连接状态不可用，本轮不挂载 CLI 工具');
        return {};
    }
    const tools: ToolSet = {};
    for (const { app, cli } of connectorDefinitions) {
        if (!cli || !states.some((state) => state.id === app.id && state.status === 'connected' && state.enabled))
            continue;
        tools[`connector_cli_${app.id.replaceAll('-', '_')}`] = tool({
            description: `${app.name}：${app.description}\n${cli.instructions}`,
            inputSchema: z.object({
                args: z
                    .array(z.string().max(4096))
                    .min(1)
                    .max(80)
                    .describe('CLI 参数数组，不包含程序名；不使用 shell 语法。')
            }),
            execute: ({ args }, { abortSignal }) => instance.execute(app.id, args, abortSignal)
        });
    }
    return tools;
}
