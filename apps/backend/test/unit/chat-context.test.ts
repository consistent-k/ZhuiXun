import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentContext } from '@/agent/context/builder';
import type { ResolvedModel } from '@/config/types';
import { createChatSections } from '@/modules/chat/context';

const boundaries = vi.hoisted(() => ({
    projectGet: vi.fn(),
    getProjectStore: vi.fn(),
    buildInjectedProject: vi.fn(),
    getMemorySettings: vi.fn(),
    activeModel: vi.fn(),
    recallMemories: vi.fn(),
    buildMemorySection: vi.fn(),
    buildPersonaSection: vi.fn(),
    buildRuntimeContext: vi.fn(),
    taskList: vi.fn(),
    getTaskStore: vi.fn(),
    buildInjectedTasks: vi.fn(),
    logError: vi.fn()
}));

vi.mock('@/agent/context/prompts', () => ({ buildRuntimeContext: boundaries.buildRuntimeContext }));
vi.mock('@/config/model', () => ({ activeModel: boundaries.activeModel }));
vi.mock('@/config/settings-store', () => ({ getMemorySettings: boundaries.getMemorySettings }));
vi.mock('@/modules/memory', () => ({
    buildMemorySection: boundaries.buildMemorySection,
    recallMemories: boundaries.recallMemories
}));
vi.mock('@/modules/persona', () => ({ buildPersonaSection: boundaries.buildPersonaSection }));
vi.mock('@/modules/projects', () => ({
    getProjectStore: boundaries.getProjectStore,
    buildInjectedProject: boundaries.buildInjectedProject
}));
vi.mock('@/modules/tasks', () => ({
    getTaskStore: boundaries.getTaskStore,
    buildInjectedTasks: boundaries.buildInjectedTasks
}));
vi.mock('@/platform/logging/index', () => ({ createLogger: () => ({ error: boundaries.logError }) }));

const model: ResolvedModel = {
    kind: 'openai-compatible',
    baseURL: 'https://model.invalid/v1',
    apiKey: 'test-only',
    modelName: 'fake-model'
};

function buildSection(id: string, ctx: AgentContext = {}) {
    const section = createChatSections().find((entry) => entry.id === id);
    if (!section) throw new Error(`Missing test section: ${id}`);
    return section.build(ctx);
}

beforeEach(() => {
    vi.resetAllMocks();
    boundaries.getProjectStore.mockReturnValue({ get: boundaries.projectGet });
    boundaries.getTaskStore.mockReturnValue({ list: boundaries.taskList });
    boundaries.getMemorySettings.mockReturnValue({ enabled: true });
    boundaries.activeModel.mockReturnValue(model);
    boundaries.recallMemories.mockResolvedValue('recalled records');
    boundaries.buildMemorySection.mockResolvedValue('memory section');
    boundaries.buildPersonaSection.mockReturnValue(null);
});

describe('createChatSections', () => {
    it('provides independently created project/memory/runtime/tasks sections in cache-friendly order', () => {
        const sections = createChatSections();
        expect(sections.map(({ id, order }) => ({ id, order }))).toEqual([
            { id: 'persona', order: 15 },
            { id: 'project', order: 20 },
            { id: 'memory', order: 30 },
            { id: 'runtime', order: 40 },
            { id: 'tasks', order: 50 }
        ]);
        const another = createChatSections();
        expect(another).not.toBe(sections);
        expect(another[0]).not.toBe(sections[0]);
    });

    it('delegates the persona section with the context id and supports the default null result', async () => {
        boundaries.buildPersonaSection.mockReturnValueOnce('persona section').mockReturnValueOnce(null);
        await expect(buildSection('persona', { personaId: 'teaching' })).resolves.toBe('persona section');
        expect(boundaries.buildPersonaSection).toHaveBeenCalledExactlyOnceWith('teaching');
        expect(await buildSection('persona', {})).toBeNull();
    });

    it('skips project lookup when no project is selected', async () => {
        await expect(buildSection('project')).resolves.toBeNull();
        expect(boundaries.getProjectStore).not.toHaveBeenCalled();
        expect(boundaries.buildInjectedProject).not.toHaveBeenCalled();
    });

    it.each([null, { id: 'project-1', name: 'Fixture project' }])(
        'delegates project injection with the store result %j',
        async (project) => {
            boundaries.projectGet.mockResolvedValue(project);
            boundaries.buildInjectedProject.mockReturnValue(project ? 'project context' : null);
            await expect(buildSection('project', { projectId: 'project-1' })).resolves.toBe(
                project ? 'project context' : null
            );
            expect(boundaries.projectGet).toHaveBeenCalledExactlyOnceWith('project-1');
            expect(boundaries.buildInjectedProject).toHaveBeenCalledExactlyOnceWith(project);
        }
    );

    it('leaves project failures to the instruction builder rather than hiding them', async () => {
        const failure = new Error('project index unreadable');
        boundaries.projectGet.mockRejectedValue(failure);
        await expect(buildSection('project', { projectId: 'project-1' })).rejects.toBe(failure);
        expect(boundaries.buildInjectedProject).not.toHaveBeenCalled();
    });

    it('does not read memory or resolve a model when the memory feature is disabled', async () => {
        boundaries.getMemorySettings.mockReturnValue({ enabled: false });
        await expect(
            buildSection('memory', { projectId: 'project-1', latestUserText: 'question' })
        ).resolves.toBeNull();
        expect(boundaries.activeModel).not.toHaveBeenCalled();
        expect(boundaries.recallMemories).not.toHaveBeenCalled();
        expect(boundaries.buildMemorySection).not.toHaveBeenCalled();
    });

    it.each([
        [{ latestUserText: 'question' }, [{ scope: 'global' }]],
        [
            { projectId: 'project-1', latestUserText: 'question' },
            [{ scope: 'global' }, { scope: 'project', projectId: 'project-1' }]
        ]
    ] as const)('recalls the latest question with the appropriate memory layers: %j', async (ctx, layers) => {
        await expect(buildSection('memory', ctx)).resolves.toBe('memory section');
        expect(boundaries.recallMemories).toHaveBeenCalledExactlyOnceWith({ query: 'question', layers, model });
        expect(boundaries.buildMemorySection).toHaveBeenCalledExactlyOnceWith({ layers, recalled: 'recalled records' });
        expect(boundaries.recallMemories.mock.invocationCallOrder[0]).toBeLessThan(
            boundaries.buildMemorySection.mock.invocationCallOrder[0]
        );
    });

    it.each([undefined, ''])('injects indices only when latestUserText is %j', async (latestUserText) => {
        await expect(buildSection('memory', { latestUserText })).resolves.toBe('memory section');
        expect(boundaries.recallMemories).not.toHaveBeenCalled();
        expect(boundaries.buildMemorySection).toHaveBeenCalledExactlyOnceWith({
            layers: [{ scope: 'global' }],
            recalled: ''
        });
    });

    it('injects indices only when there is no active model', async () => {
        boundaries.activeModel.mockReturnValue(null);
        await expect(buildSection('memory', { projectId: 'project-1', latestUserText: 'question' })).resolves.toBe(
            'memory section'
        );
        expect(boundaries.recallMemories).not.toHaveBeenCalled();
        expect(boundaries.buildMemorySection).toHaveBeenCalledExactlyOnceWith({
            layers: [{ scope: 'global' }, { scope: 'project', projectId: 'project-1' }],
            recalled: ''
        });
    });

    it('logs a failed recall and still injects the index for both layers', async () => {
        const failure = new Error('recall unavailable');
        boundaries.recallMemories.mockRejectedValue(failure);
        await expect(buildSection('memory', { projectId: 'project-1', latestUserText: 'question' })).resolves.toBe(
            'memory section'
        );
        expect(boundaries.logError).toHaveBeenCalledExactlyOnceWith('记忆召回失败，本轮仅注入索引', { err: failure });
        expect(boundaries.buildMemorySection).toHaveBeenCalledExactlyOnceWith({
            layers: [{ scope: 'global' }, { scope: 'project', projectId: 'project-1' }],
            recalled: ''
        });
    });

    it('does not hide index-building errors inside the recall fallback', async () => {
        const failure = new Error('index unreadable');
        boundaries.buildMemorySection.mockRejectedValue(failure);
        await expect(buildSection('memory')).rejects.toBe(failure);
        expect(boundaries.logError).not.toHaveBeenCalled();
    });

    it('builds the runtime section at request time', async () => {
        boundaries.buildRuntimeContext
            .mockReturnValueOnce('runtime snapshot 1')
            .mockReturnValueOnce('runtime snapshot 2');
        await expect(buildSection('runtime')).resolves.toBe('runtime snapshot 1');
        await expect(buildSection('runtime')).resolves.toBe('runtime snapshot 2');
        expect(boundaries.buildRuntimeContext).toHaveBeenCalledTimes(2);
    });

    it.each([undefined, 'conversation-1'])(
        'lists tasks for session %j before formatting the result',
        async (sessionId) => {
            const tasks = [{ id: 'task-1', title: 'Review results', status: 'pending' }];
            boundaries.taskList.mockResolvedValue(tasks);
            boundaries.buildInjectedTasks.mockReturnValue('task section');
            await expect(buildSection('tasks', { sessionId })).resolves.toBe('task section');
            expect(boundaries.taskList).toHaveBeenCalledExactlyOnceWith(sessionId);
            expect(boundaries.buildInjectedTasks).toHaveBeenCalledExactlyOnceWith(tasks);
        }
    );

    it('leaves task store errors visible to the instruction builder', async () => {
        const failure = new Error('tasks unreadable');
        boundaries.taskList.mockRejectedValue(failure);
        await expect(buildSection('tasks', { sessionId: 'conversation-1' })).rejects.toBe(failure);
        expect(boundaries.buildInjectedTasks).not.toHaveBeenCalled();
    });
});
