import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { generateText } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createModel } from '@/agent/model/provider';

/**
 * Provider 重试契约（opt-in，`pnpm test:contract`）：本地 127.0.0.1 端口起一个 OpenAI 兼容 mock，
 * 首次返回 429 + retry-after，第二次返回正常结果，验证 maxRetries 走真实 HTTP 且遵守 retry-after。
 */
let server: http.Server;
let baseURL: string;
const hits: number[] = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        hits.push(Date.now());
        req.resume();
        req.on('end', () => {
            if (hits.length === 1) {
                res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
                res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }));
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    id: 'cmpl-1',
                    object: 'chat.completion',
                    created: 0,
                    model: 'mock',
                    choices: [{ index: 0, message: { role: 'assistant', content: '重试成功' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
                })
            );
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('provider retry over real HTTP', () => {
    it('retries a 429 honouring retry-after and then succeeds', async () => {
        const model = createModel({ kind: 'openai-compatible', baseURL, apiKey: 'contract-only', modelName: 'mock' });
        const { text } = await generateText({ model, prompt: 'hi', maxRetries: 2 });
        expect(text).toBe('重试成功');
        expect(hits).toHaveLength(2);
        expect(hits[1] - hits[0]).toBeGreaterThanOrEqual(900);
    });
});
