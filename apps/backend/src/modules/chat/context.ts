import { SECTION_ORDER, type AgentContext, type ContextSection } from '@/agent/context/builder';
import { buildRuntimeContext } from '@/agent/context/prompts';
import { activeModel } from '@/config/model';
import { getMemorySettings } from '@/config/settings-store';
import type { RecallLayer } from '@/modules/memory';
import { buildMemorySection, recallMemories } from '@/modules/memory';
import { buildPersonaSection } from '@/modules/persona';
import { buildInjectedProject, getProjectStore } from '@/modules/projects';
import { buildInjectedTasks, getTaskStore } from '@/modules/tasks';
import { createLogger } from '@/platform/logging/index';

const log = createLogger('ChatContext');

/**
 * chat 用例的系统提示词段。
 *
 * 顺序：项目(20) → 记忆(30) → 运行时(40) → 任务清单(50)；基础指令由调用方作为 base 传入。
 * 越易变的段越靠后，尽量保住前面静态部分的 provider 前缀缓存。
 */
export function createChatSections(): ContextSection[] {
    return [
        {
            id: 'persona',
            order: SECTION_ORDER.persona,
            async build(ctx: AgentContext) {
                return buildPersonaSection(ctx.personaId);
            }
        },
        {
            id: 'project',
            order: SECTION_ORDER.project,
            async build(ctx: AgentContext) {
                if (!ctx.projectId) return null;
                const project = await getProjectStore().get(ctx.projectId);
                return buildInjectedProject(project);
            }
        },
        {
            id: 'memory',
            order: SECTION_ORDER.memory,
            async build(ctx: AgentContext) {
                if (!getMemorySettings().enabled) return null;
                const layers: RecallLayer[] = [{ scope: 'global' }];
                if (ctx.projectId) layers.push({ scope: 'project', projectId: ctx.projectId });

                let recalled = '';
                const model = activeModel();
                if (model && ctx.latestUserText) {
                    try {
                        recalled = await recallMemories({
                            query: ctx.latestUserText,
                            layers,
                            model
                        });
                    } catch (error) {
                        log.error('记忆召回失败，本轮仅注入索引', { err: error });
                    }
                }
                return buildMemorySection({ layers, recalled });
            }
        },
        {
            id: 'runtime',
            order: SECTION_ORDER.runtime,
            async build() {
                return buildRuntimeContext();
            }
        },
        {
            id: 'tasks',
            order: SECTION_ORDER.tasks,
            async build(ctx: AgentContext) {
                return buildInjectedTasks(await getTaskStore().list(ctx.sessionId));
            }
        }
    ];
}
