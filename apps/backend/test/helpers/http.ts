import type { Hono } from 'hono';

export function appWith<T extends Hono>(router: T): T {
    return router;
}

export async function json<T>(response: Response): Promise<T> {
    return (await response.json()) as T;
}

export function jsonRequest(body: unknown): RequestInit {
    return {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    };
}
