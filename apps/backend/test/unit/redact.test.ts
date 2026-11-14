import { describe, expect, it } from 'vitest';

import { redact } from '@/platform/logging/redact';

describe('log redaction', () => {
    it('redacts sensitive keys recursively and preserves safe fields', () => {
        const circular: Record<string, unknown> = { password: 'secret', nested: { token: 'value', ok: true } };
        circular.self = circular;
        expect(redact(circular)).toEqual({
            password: '***REDACTED***',
            nested: { token: '***REDACTED***', ok: true },
            self: '[Circular]'
        });
    });

    it('sanitizes Error objects', () => {
        const output = redact(new Error('boom')) as { name: string; message: string };
        expect(output.name).toBe('Error');
        expect(output.message).toBe('boom');
    });
});
