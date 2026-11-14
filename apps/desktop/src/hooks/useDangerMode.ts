import { useRequest } from 'ahooks';

import { fetchHealthApi } from '@/services';

/**
 * 是否处于危险跳过审批模式（后端以 --dangerously-skip-permissions 启动）。
 *
 * 旗标是后端启动事实、运行时不变，故挂载时拉一次 /health 即可，不做轮询。
 * 拉取失败（fetchHealthApi 返回 null）时按 false 处理——宁可不显示提示，也不误报安全状态。
 */
export function useDangerMode(): boolean {
    const { data } = useRequest(fetchHealthApi);
    return data?.dangerSkipPermissions ?? false;
}
