import { describe, expect, it } from 'vitest';

import { formatSkillCatalog, parseSkillMarkdownString, serializeSkillMarkdown } from '@/modules/skills/loader';
import type { SkillMetadata } from '@/modules/skills/loader';

const metadata = (overrides: Partial<SkillMetadata> = {}): SkillMetadata => ({
    id: 'sample',
    name: '示例',
    description: '示例描述',
    dirPath: '/unused',
    loaded: false,
    source: 'user',
    editable: true,
    disabled: false,
    ...overrides
});

describe('skills loader YAML', () => {
    it('round-trips quoted punctuation, multiline inputs, tool rules and provenance', () => {
        const markdown = serializeSkillMarkdown({
            name: ' sample\n ',
            displayName: '中文: 示例\r\n第二行',
            description: '核对: 检查, 建议 # 注释\n续行',
            systemPrompt: '\n  ## 正文\n\n保留: 原文\n ',
            triggers: ['  症状\n分析 ', '', '  '],
            allowedTools: [' Bash(git log:*) ', 'Read', ''],
            disallowedTools: [' Bash(rm:*) ', ''],
            extraMetadata: {
                display_name: '不能覆盖展示名',
                source_canonical: '@demo/sample',
                preferred_model: 'provider/model',
                empty: '  ',
                note: 'one\ntwo'
            }
        });
        const { frontmatter, body } = parseSkillMarkdownString(markdown);
        expect(frontmatter).toEqual({
            name: 'sample',
            description: '核对: 检查, 建议 # 注释 续行',
            license: 'Internal',
            compatibility: 'zhuixun 2.x',
            metadata: {
                display_name: '中文: 示例 第二行',
                source_canonical: '@demo/sample',
                preferred_model: 'provider/model',
                note: 'one two'
            },
            triggers: ['症状 分析'],
            'allowed-tools': 'Bash(git log:*), Read',
            'disallowed-tools': 'Bash(rm:*)'
        });
        expect(body).toBe('## 正文\n\n保留: 原文');
        expect(markdown).toContain('allowed-tools: Bash(git log:*), Read');
        expect(markdown.endsWith('\n')).toBe(true);
    });

    it('omits absent or empty optional fields instead of serializing YAML arrays for tools', () => {
        const { frontmatter, body } = parseSkillMarkdownString(
            serializeSkillMarkdown({ name: 'minimal', description: '', systemPrompt: ' ', extraMetadata: {} })
        );
        expect(frontmatter).toEqual({
            name: 'minimal',
            description: '',
            license: 'Internal',
            compatibility: 'zhuixun 2.x'
        });
        expect(body).toBe('');
    });

    it('normalizes BOM and CRLF, numeric metadata and null metadata values', () => {
        const parsed = parseSkillMarkdownString(
            '﻿---\r\nname: sample\r\nmetadata:\r\n  version: 2.0\r\n  enabled: true\r\n  missing: null\r\n  label: "  literal  "\r\n---\r\n\r\n正文\r\n'
        );
        expect(parsed.frontmatter.metadata).toEqual({ version: '2', enabled: 'true', label: '  literal  ' });
        expect(parsed.body).toBe('正文');
    });

    it('accepts an empty YAML mapping without inventing required application fields', () => {
        expect(parseSkillMarkdownString('---\n\n---\nbody')).toEqual({ frontmatter: {}, body: 'body' });
    });

    it.each([
        ['missing delimiters', 'name: sample\nbody', 'missing frontmatter'],
        ['unterminated frontmatter', '---\nname: sample\n', 'missing frontmatter'],
        ['scalar', '---\n42\n---\nbody', 'frontmatter 必须是键值映射'],
        ['array', '---\n- one\n- two\n---\nbody', 'frontmatter 必须是键值映射'],
        ['invalid YAML', '---\nname: [unterminated\n---\nbody', 'Flow sequence'],
        ['duplicate keys', '---\nname: one\nname: two\n---\nbody', 'Map keys must be unique']
    ])('rejects %s with an actionable parsing error', (_label, input, message) => {
        expect(() => parseSkillMarkdownString(input)).toThrow(message);
    });
});

describe('skills loader catalog', () => {
    it('formats empty catalogs and includes only nonempty trigger lists', () => {
        expect(formatSkillCatalog([])).toBe('## 可用技能\n暂无可用技能');
        expect(
            formatSkillCatalog([
                metadata({ triggers: ['核对', '归档'] }),
                metadata({ id: 'empty', triggers: [] }),
                metadata({ id: 'absent' })
            ])
        ).toBe('## 可用技能\n- sample: 示例描述（触发词：核对、归档）\n- empty: 示例描述\n- absent: 示例描述');
    });
});
