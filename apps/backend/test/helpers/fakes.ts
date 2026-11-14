import type { RuntimeStatus } from '@/platform/runtime-status';

export function runtime(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
    return {
        ready: true,
        mcp: 'ok',
        skills: 0,
        dangerSkipPermissions: false,
        startedAt: new Date().toISOString(),
        ...overrides
    };
}
