import { useRequest } from 'ahooks';

import { SUCCESS_CODE } from '@/constant/code';
import { fetchToolLabelsApi } from '@/services';

import type { ToolLabelInfo } from './tool-label-context';

/**
 * 工具名 → 中文说明映射。
 *
 * 映射由后端 `GET /api/tools/labels` 一次合并下发（技能 tools/ 下声明的工具 + 每个已连接 MCP
 * server 暴露的工具）：MCP 工具名按后端 `buildPrefixedToolName` 的 `<server>_<tool>` 规则预先
 * 拼好，前端拿到的 key 就是模型实际调用的工具名，直接查表即可。
 * 此前前端为了同一份映射要发 1 + 1 + N 个请求（skills + mcp/servers + 每个 server 的 tools），
 * 且 server 越多请求越多，故改为后端聚合。
 *
 * 用 useRequest 的缓存能力替代模块级 labelCache：
 * - cacheKey + staleTime:-1 —— 整会话成功拉取一次后即命中缓存，remount 不再请求；
 * - 「就绪与否」以后端返回码为准（503 = 技能注册表未初始化）才抛错重试，而**不再**把
 *   「map 为空」当作未就绪：多数技能未声明 tools/，空 map 是稳态而非临时态，
 *   若拿空当错误会触发注定失败的重试风暴（详见排查）；
 * - 请求本身 hideError，失败静默降级：工具卡兜底显示工具原名。
 */
export function useToolLabels() {
    const { data: labels = {}, refresh } = useRequest(
        async (): Promise<Record<string, ToolLabelInfo>> => {
            const res = await fetchToolLabelsApi();
            // 仅当后端明确报「未就绪」(503) 时抛错触发有限重试且不写缓存；其余一律视为成功
            if (res.code === 503) throw new Error('技能注册表尚未就绪');
            return res.code === SUCCESS_CODE ? (res.data ?? {}) : {};
        },
        {
            cacheKey: 'tool-labels',
            staleTime: -1,
            retryCount: 3,
            retryInterval: 5000
        }
    );

    return { labels, retry: refresh };
}
