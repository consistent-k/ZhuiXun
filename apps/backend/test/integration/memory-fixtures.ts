import path from 'node:path';

import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';

import type { ResolvedModel } from '@/config/types';

import { setEnv } from '../helpers/env';
import { createTempData } from '../helpers/temp-data';

export const resolvedModel: ResolvedModel = {
    kind: 'openai-compatible',
    baseURL: 'https://model.invalid/v1',
    apiKey: 'test-only',
    modelName: 'memory-test'
};

export function generated(text: string): LanguageModelV4GenerateResult {
    return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined }
        },
        warnings: []
    };
}

export function textModel(text: string) {
    return new MockLanguageModelV4({ doGenerate: generated(text) });
}

export async function memoryFixture() {
    const temp = await createTempData('zhuixun-memory-');
    const restore = setEnv({
        MEMORY_USER_DIR: temp.memory,
        PROJECTS_USER_DIR: temp.projects,
        SETTINGS_CONFIG_PATH: path.join(temp.root, 'settings.json')
    });
    return {
        ...temp,
        async cleanup() {
            restore();
            await temp.cleanup();
        }
    };
}

export function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
