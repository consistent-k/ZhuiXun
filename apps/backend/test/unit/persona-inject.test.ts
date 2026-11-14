import { beforeEach, describe, expect, it } from 'vitest';

import { setPersonaSettings } from '@/config/settings-store';
import { buildPersonaSection, createPersona } from '@/modules/persona';

beforeEach(() => {
    setPersonaSettings({ defaultId: 'default', custom: [] });
});

describe('persona prompt injection', () => {
    it('does not inject anything for the standard default', () => {
        expect(buildPersonaSection()).toBeNull();
        expect(buildPersonaSection('default')).toBeNull();
    });

    it('injects built-in and custom instructions with an explicit safety boundary', () => {
        const evidence = buildPersonaSection('evidence');
        expect(evidence).toContain('## 表达风格');
        expect(evidence).toContain('不改变事实、安全提示、工具能力与审批规则');
        expect(evidence).toContain('<zhuixun-persona-style>');
        expect(evidence).toContain('不省略风险与需要复核的环节。');

        const config = createPersona({ name: '我的', description: '', instruction: '先给结论' });
        const id = config.items.find((item) => item.kind === 'custom')!.id;
        expect(buildPersonaSection(id)).toContain('先给结论');
    });

    it('falls back to the default for unknown ids', () => {
        expect(buildPersonaSection('missing')).toBeNull();
    });
});
