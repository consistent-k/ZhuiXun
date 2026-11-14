import type { PersonaConfigView, PersonaCreateInput, PersonaUpdateInput, PersonaView } from '@zhuixun/shared';

import request, { type BaseResponse } from '@/utils/request';

export type { PersonaConfigView, PersonaCreateInput, PersonaUpdateInput, PersonaView };

/** 导出/导入配置里的自定义风格落盘形态。 */
export interface PersonaSettingsPayload {
    defaultId?: string;
    custom?: Array<{
        id: string;
        name: string;
        description: string;
        instruction: string;
        createdAt: number;
        updatedAt: number;
    }>;
}

/** 拉取内置 + 自定义风格与当前默认选择。 */
export function fetchPersonasApi(): Promise<BaseResponse<PersonaConfigView>> {
    return request.get('/api/personas');
}

/** 新建自定义风格。 */
export function createPersonaApi(data: PersonaCreateInput): Promise<BaseResponse<PersonaConfigView>> {
    return request.post('/api/personas', { data });
}

/** 更新自定义风格。 */
export function updatePersonaApi(id: string, data: PersonaUpdateInput): Promise<BaseResponse<PersonaConfigView>> {
    return request.put(`/api/personas/${encodeURIComponent(id)}`, { data });
}

/** 删除自定义风格。 */
export function deletePersonaApi(id: string): Promise<BaseResponse<PersonaConfigView>> {
    return request.delete(`/api/personas/${encodeURIComponent(id)}`);
}

/** 设置默认风格。 */
export function setDefaultPersonaApi(defaultId: string): Promise<BaseResponse<PersonaConfigView>> {
    return request.put('/api/personas/default', { data: { defaultId } });
}
