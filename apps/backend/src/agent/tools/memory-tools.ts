import { tool } from 'ai';
import { z } from 'zod';

import type {
    MemoryManifestItem,
    MemoryRecord,
    MemoryScope,
    MemoryType,
    WriteMemoryInput,
    WriteMemoryResult
} from '@/modules/memory';

/**
 * 记忆工具所需的最小存储端口（由调用方注入；agent 层不直接取模块单例/路径）。
 * 由 modules/memory 的 MemoryStore + resolveMemoryRoot 组合满足。
 */
export interface MemoryToolStore {
    list(): Promise<MemoryManifestItem[]>;
    read(name: string): Promise<MemoryRecord | null>;
    write(input: WriteMemoryInput): Promise<WriteMemoryResult>;
    delete(name: string): Promise<boolean>;
}

export interface MemoryToolDeps {
    /** 按作用域取存储（模块内已解析好根目录）。 */
    storeOf(scope: MemoryScope): MemoryToolStore;
}

/**
 * 记忆工具（结构化多文件版）：让模型维护该用户的长期记忆知识库。
 *
 * 三个工具：`read_memory` 按 name 读一条正文；`write_memory` 新建/按 name 覆盖一条；
 * `delete_memory` 删一条。均免确认，仅在记忆开启时由 agent 挂载。写入落「一个事实一文件」+
 * 自动重建 MEMORY.md 索引。
 * 作用域双层：user/feedback 默认落全局，project/reference 在有项目时落项目层；模型也可显式指定 scope。
 *
 * 注意：记忆文件在记忆根（~/.zhuixun/memory 或 projects/<id>/memory），不在 shell 工作区，
 * 因此 Read/Bash 工具按文件名无法访问；要读记忆正文一律用 `read_memory`，不要用 Read 或文件路径。
 */

export interface MemoryToolContext {
    projectId?: string;
    sessionId?: string;
}

/** 按类型 + 是否有项目推断默认落层。 */
function inferScope(type: MemoryType, hasProject: boolean): MemoryScope {
    if (!hasProject) return 'global';
    return type === 'project' || type === 'reference' ? 'project' : 'global';
}

export function createMemoryTools(deps: MemoryToolDeps, ctx: MemoryToolContext = {}) {
    const hasProject = !!ctx.projectId;
    const storeOf = (scope: MemoryScope) => deps.storeOf(scope);

    return {
        read_memory: tool({
            description: [
                '【读取】按 name 读一条长期记忆的正文。当记忆索引里列出了某条、但「本轮相关记忆」未附其正文，',
                '而你需要它来回答时调用。name 为记忆标识（文件名去掉 .md，如索引链接 [preferred-name](preferred-name.md) 的 preferred-name）。',
                '\n\n记忆文件不在 shell 工作区，用 Read 或文件路径读不到——读记忆正文只用本工具。',
                '\n\nscope：缺省时有项目先查项目层、未命中再查全局。'
            ].join(''),
            inputSchema: z.object({
                name: z.string().describe('记忆标识（文件名去掉 .md）'),
                scope: z.enum(['global', 'project']).optional().describe('作用域；缺省先项目层后全局')
            }),
            execute: async ({ name, scope }) => {
                const tryScopes: MemoryScope[] = scope
                    ? [scope === 'project' && !hasProject ? 'global' : scope]
                    : hasProject
                      ? ['project', 'global']
                      : ['global'];
                for (const s of tryScopes) {
                    const record = await storeOf(s).read(name);
                    if (record) {
                        return {
                            success: true,
                            scope: s,
                            name: record.name,
                            type: record.type,
                            description: record.description,
                            content: record.content
                        };
                    }
                }
                return { success: false, message: `未找到记忆 ${name}` };
            }
        }),
        write_memory: tool({
            description: [
                '【写入/更新】该用户的一条长期记忆（一个事实一文件）。当用户表达出可长期复用的偏好、习惯、',
                '背景或明确要求，或明确说「记住…」时调用；按既有同名条目覆盖、新信息则新建。',
                '\n\n写入前先确认条目真实存在：索引里没有的名字不要当作「覆盖」来写；若用户是在否定/纠正某条记忆，',
                '先 read_memory 核实，若该条目并不存在，照实说明没有这条记忆，不要用 write_memory 新建一条来「记录否认」。',
                '\n\nname：kebab-case 英文短标识（如 call-me-by-name），同名即覆盖，用于去重。',
                'type：user=用户是谁或其稳定个人特征(身份/角色/专长/称呼/长期偏好·兴趣·习惯)；feedback=对你工作方式的纠正或确认(建议带「为什么」与「如何应用」)；',
                'project=在做的事/关注领域等不可从历史推导的事项；reference=常用文档链接/内部系统等外部指针。',
                '\n\nscope：global=个人画像(跨项目通用)；project=仅当前项目相关。缺省按 type 与当前是否在项目中自动推断。',
                '\n\n返回的 created=true 表示本次是「新建」而非覆盖既有条目，请据此自查是否符合预期。',
                '\n\n不要记录：仅本轮临时上下文、第三方可识别隐私、敏感凭据。'
            ].join(''),
            inputSchema: z.object({
                name: z.string().describe('kebab-case 英文短标识，作文件名与去重键'),
                type: z.enum(['user', 'feedback', 'project', 'reference']).describe('记忆类型'),
                description: z.string().describe('一行摘要，用于召回时判断相关性'),
                content: z.string().describe('记忆正文，简洁要点'),
                scope: z.enum(['global', 'project']).optional().describe('作用域；缺省按 type 与当前项目推断')
            }),
            execute: async ({ name, type, description, content, scope }) => {
                const resolved: MemoryScope =
                    scope === 'project' && !hasProject ? 'global' : (scope ?? inferScope(type, hasProject));
                const { record, created } = await storeOf(resolved).write({
                    name,
                    type,
                    description,
                    content,
                    originSessionId: ctx.sessionId
                });
                if (!created) return { success: true, scope: resolved, name: record.name, created: false };
                // 新建时给模型一个自查信号：用户若在纠正一条记忆、这里却 created=true，
                // 说明该条目本就不存在，应 read_memory 核实后按需 delete_memory，而不是留下这条派生记忆。
                return {
                    success: true,
                    scope: resolved,
                    name: record.name,
                    created: true,
                    hint: '此前没有这条记忆，本次是新建而非覆盖。若你本意是纠正一条已有的错误记忆，请先 read_memory 核实；若确认这条本不该存在，用 delete_memory 删除。'
                };
            }
        }),
        delete_memory: tool({
            description: [
                '【删除】一条已有长期记忆。用户要求「忘掉…」、否定/纠正某条记忆（说它不对、过时、不是这样），',
                '或该记忆已过时/错误时优先调用本工具；不确定条目是否存在时先用 read_memory 核实，避免按幻觉出的名字误操作。',
                'name 为记忆标识（文件名去掉 .md）。缺省 scope 时：有项目先查项目层、未命中再查全局。'
            ].join(''),
            inputSchema: z.object({
                name: z.string().describe('要删除的记忆名称'),
                scope: z.enum(['global', 'project']).optional().describe('作用域；缺省先项目层后全局')
            }),
            execute: async ({ name, scope }) => {
                if (scope) {
                    const ok = await storeOf(scope === 'project' && !hasProject ? 'global' : scope).delete(name);
                    return { success: ok, scope };
                }
                if (hasProject && (await storeOf('project').delete(name))) {
                    return { success: true, scope: 'project' as const };
                }
                const ok = await storeOf('global').delete(name);
                return { success: ok, scope: 'global' as const };
            }
        })
    };
}
