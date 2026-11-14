import { describe, expect, it } from 'vitest';

import { parseMemoryOps } from '@/modules/memory/ops';

describe('memory operation parsing', () => {
    it('extracts a JSON array surrounded by model commentary', () => {
        expect(
            parseMemoryOps(
                '我建议更新记忆：[{"name":"prefs","type":"user","description":"d","content":"c"}]，完成。',
                true
            )
        ).toEqual([{ action: 'write', scope: 'global', name: 'prefs', type: 'user', description: 'd', content: 'c' }]);
    });

    it('downgrades project scope when no project exists', () => {
        expect(parseMemoryOps('[{"action":"delete","scope":"project","name":"facts"}]', false)).toEqual([
            { action: 'delete', scope: 'global', name: 'facts' }
        ]);
    });

    it('skips malformed entries and invalid JSON', () => {
        expect(parseMemoryOps('[{"name":"missing-type"},{"name":"ok","type":"reference"},null]', true)).toEqual([
            { action: 'write', scope: 'global', name: 'ok', type: 'reference', description: '', content: '' }
        ]);
        expect(parseMemoryOps('not json', true)).toEqual([]);
    });
});
