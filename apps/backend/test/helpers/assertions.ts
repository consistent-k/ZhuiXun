import { expect } from 'vitest';

export async function expectJson(response: Response, status: number, body: unknown): Promise<void> {
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(body);
}
