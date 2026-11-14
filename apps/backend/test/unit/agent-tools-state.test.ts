import type { MemoryRecord, MemoryScope, MemoryType, Task } from '@zhuixun/shared';
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { createInteractionTools } from '@/agent/tools/interaction-tools';
import { createMemoryTools, type MemoryToolStore } from '@/agent/tools/memory-tools';
import { createTaskTools, type TaskToolStore } from '@/agent/tools/task-tools';

const options = { toolCallId: 'unit-call', messages: [], context: {} };
const record: MemoryRecord = {
    name: 'preference',
    type: 'user',
    description: 'test preference',
    content: 'synthetic content',
    updatedAt: '2026-01-01T00:00:00.000Z'
};

function memoryStore() {
    return {
        list: vi.fn<MemoryToolStore['list']>().mockResolvedValue([]),
        read: vi.fn<MemoryToolStore['read']>().mockResolvedValue(null),
        write: vi.fn<MemoryToolStore['write']>().mockResolvedValue({ record, created: true }),
        delete: vi.fn<MemoryToolStore['delete']>().mockResolvedValue(false)
    };
}

function memoryFixture(projectId?: string) {
    const global = memoryStore();
    const project = memoryStore();
    const storeOf = vi.fn((scope: MemoryScope) => (scope === 'project' ? project : global));
    return {
        global,
        project,
        storeOf,
        tools: createMemoryTools({ storeOf }, { projectId, sessionId: 'unit-session' })
    };
}

describe('agent memory tools execute', () => {
    it('reads project first, then global, stopping on the first hit and hiding storage-only fields', async () => {
        const f = memoryFixture('project');
        f.project.read.mockResolvedValue(record);
        expect(await f.tools.read_memory.execute!({ name: record.name }, options)).toEqual({
            success: true,
            scope: 'project',
            name: record.name,
            type: record.type,
            description: record.description,
            content: record.content
        });
        expect(f.global.read).not.toHaveBeenCalled();
        f.project.read.mockResolvedValue(null);
        f.global.read.mockResolvedValue(record);
        expect(await f.tools.read_memory.execute!({ name: record.name }, options)).toMatchObject({ scope: 'global' });
        expect(f.storeOf.mock.calls.map(([scope]) => scope)).toEqual(['project', 'project', 'global']);
    });

    it.each([undefined, 'global', 'project'] as const)('resolves read scope %s without a project', async (scope) => {
        const f = memoryFixture();
        expect(await f.tools.read_memory.execute!({ name: 'missing', scope }, options)).toEqual({
            success: false,
            message: '未找到记忆 missing'
        });
        expect(f.global.read).toHaveBeenCalledWith('missing');
        expect(f.project.read).not.toHaveBeenCalled();
    });

    it('explicit project read does not fall through to global', async () => {
        const f = memoryFixture('project');
        f.global.read.mockResolvedValue(record);
        expect(await f.tools.read_memory.execute!({ name: record.name, scope: 'project' }, options)).toMatchObject({
            success: false
        });
        expect(f.global.read).not.toHaveBeenCalled();
        await f.tools.read_memory.execute!({ name: record.name, scope: 'global' }, options);
        expect(f.global.read).toHaveBeenCalledOnce();
    });

    it.each([
        ['user', 'project', undefined, 'global'],
        ['feedback', 'project', undefined, 'global'],
        ['project', 'project', undefined, 'project'],
        ['reference', 'project', undefined, 'project'],
        ['reference', undefined, undefined, 'global'],
        ['user', undefined, 'project', 'global'],
        ['user', 'project', 'project', 'project'],
        ['project', 'project', 'global', 'global']
    ] satisfies [MemoryType, string | undefined, MemoryScope | undefined, MemoryScope][])(
        'writes %s with project=%s scope=%s into %s',
        async (type, projectId, scope, expectedScope) => {
            const f = memoryFixture(projectId);
            const input = { name: record.name, type, description: record.description, content: record.content };
            expect(await f.tools.write_memory.execute!({ ...input, scope }, options)).toMatchObject({
                success: true,
                created: true,
                scope: expectedScope,
                hint: expect.stringContaining('新建')
            });
            expect(f[expectedScope].write).toHaveBeenCalledWith({ ...input, originSessionId: 'unit-session' });
        }
    );

    it('overwrite omits the new-memory warning, default context omits session provenance', async () => {
        const store = memoryStore();
        store.write.mockResolvedValue({ record, created: false });
        const tools = createMemoryTools({ storeOf: () => store });
        const input = {
            name: record.name,
            type: record.type,
            description: record.description,
            content: record.content
        };
        expect(await tools.write_memory.execute!(input, options)).toEqual({
            success: true,
            scope: 'global',
            name: record.name,
            created: false
        });
        expect(store.write).toHaveBeenCalledWith({ ...input, originSessionId: undefined });
    });

    it('deletes project first and only falls through when absent', async () => {
        const f = memoryFixture('project');
        f.project.delete.mockResolvedValueOnce(true);
        expect(await f.tools.delete_memory.execute!({ name: record.name }, options)).toEqual({
            success: true,
            scope: 'project'
        });
        expect(f.global.delete).not.toHaveBeenCalled();
        f.global.delete.mockResolvedValueOnce(true);
        expect(await f.tools.delete_memory.execute!({ name: record.name }, options)).toEqual({
            success: true,
            scope: 'global'
        });
    });

    it.each([undefined, 'global', 'project'] as const)(
        'deletes explicit/default scope %s without a project',
        async (scope) => {
            const f = memoryFixture();
            expect(await f.tools.delete_memory.execute!({ name: record.name, scope }, options)).toEqual({
                success: false,
                scope: scope ?? 'global'
            });
            expect(f.global.delete).toHaveBeenCalledWith(record.name);
            expect(f.project.delete).not.toHaveBeenCalled();
        }
    );

    it('explicit project deletion stays project-only and propagates store failures', async () => {
        const f = memoryFixture('project');
        expect(await f.tools.delete_memory.execute!({ name: record.name, scope: 'project' }, options)).toEqual({
            success: false,
            scope: 'project'
        });
        expect(f.global.delete).not.toHaveBeenCalled();
        f.project.read.mockRejectedValue(new Error('read failed'));
        await expect(f.tools.read_memory.execute!({ name: record.name }, options)).rejects.toThrow('read failed');
        f.project.write.mockRejectedValue(new Error('write failed'));
        await expect(f.tools.write_memory.execute!({ ...record, type: 'project' }, options)).rejects.toThrow(
            'write failed'
        );
        f.project.delete.mockRejectedValue(new Error('delete failed'));
        await expect(f.tools.delete_memory.execute!({ name: record.name }, options)).rejects.toThrow('delete failed');
    });
});

describe('agent task tools execute', () => {
    it.each(['session', undefined])(
        'passes session %s and returns authoritative full lists/batch failures',
        async (sessionId) => {
            const tasks: Task[] = [];
            const batch = { ok: true as const, tasks, failed: [{ taskId: '2', message: 'blocked' }] };
            const store = {
                list: vi.fn<TaskToolStore['list']>().mockResolvedValue(tasks),
                create: vi.fn<TaskToolStore['create']>().mockResolvedValue(tasks),
                updateMany: vi.fn<TaskToolStore['updateMany']>().mockResolvedValue(batch)
            };
            const tools = createTaskTools(store, sessionId);
            const input = [{ subject: 'Investigate', description: 'synthetic', activeForm: 'Investigating' }];
            expect(await tools.TaskCreate.execute!({ tasks: input }, options)).toEqual({ ok: true, tasks });
            expect(store.create).toHaveBeenCalledWith(sessionId, input);
            const updates = [
                { taskId: '1', status: 'completed' as const },
                { taskId: '2', addBlockedBy: ['1'] }
            ];
            expect(await tools.TaskUpdate.execute!({ updates }, options)).toBe(batch);
            expect(store.updateMany).toHaveBeenCalledWith(sessionId, updates);
            expect(await tools.TaskList.execute!({}, options)).toEqual({ ok: true, tasks });
            expect(store.list).toHaveBeenCalledWith(sessionId);
            store.create.mockRejectedValueOnce(new Error('store unavailable'));
            await expect(tools.TaskCreate.execute!({ tasks: input }, options)).rejects.toThrow('store unavailable');
            const schema = tools.TaskUpdate.inputSchema as z.ZodType;
            expect(schema.parse({ updates: [{ taskId: 2, addBlocks: [3] }] })).toEqual({
                updates: [{ taskId: '2', addBlocks: ['3'] }]
            });
            expect(schema.safeParse({ updates: [] }).success).toBe(false);
            expect(schema.safeParse({ updates: [{ taskId: '1', status: 'unknown' }] }).success).toBe(false);
        }
    );
});

describe('agent interaction client tool', () => {
    it('validates a question with at least two choices, deliberately without server execute or approval', () => {
        const { askUserQuestion } = createInteractionTools();
        expect(askUserQuestion).not.toHaveProperty('execute');
        expect(askUserQuestion).not.toHaveProperty('needsApproval');
        const schema = askUserQuestion.inputSchema as z.ZodType;
        const question = {
            question: 'Choose a direction',
            options: [
                { label: 'A', description: 'first' },
                { label: 'B', description: 'second' }
            ],
            header: 'Direction'
        };
        const input = { questions: [question] };
        expect(schema.parse(input)).toEqual(input);
        expect(schema.safeParse({ questions: [{ ...question, options: [question.options[0]] }] }).success).toBe(false);
        expect(schema.safeParse({ questions: [{ ...question, question: 42 }] }).success).toBe(false);
        expect(askUserQuestion.outputSchema).toBeDefined();
    });
});
