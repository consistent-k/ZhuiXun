import { describe, expect, it } from 'vitest';

import {
    parseMemoryRecord,
    readManifestFields,
    serializeMemoryRecord,
    splitFrontmatter
} from '@/modules/memory/frontmatter';

describe('memory frontmatter', () => {
    it('splits BOM-prefixed frontmatter and trims the body', () => {
        expect(splitFrontmatter('﻿---\nname: profile\n---\n\n facts \n')).toEqual({
            data: { name: 'profile' },
            body: 'facts'
        });
    });

    it('parses record fields with safe fallbacks', () => {
        expect(parseMemoryRecord('---\ntype: feedback\ndescription: useful\n---\ncontent', 'fallback')).toEqual({
            name: 'fallback',
            type: 'feedback',
            description: 'useful',
            content: 'content',
            updatedAt: '1970-01-01T00:00:00.000Z',
            originSessionId: undefined
        });
    });

    it('round trips metadata values through YAML serialization', () => {
        const source = {
            name: 'user-preference',
            type: 'user' as const,
            description: '值: 含逗号, 需要保留',
            content: '正文内容',
            updatedAt: '2026-10-26T00:00:00.000Z',
            originSessionId: 'session-1'
        };
        expect(parseMemoryRecord(serializeMemoryRecord(source), 'fallback')).toEqual(source);
    });

    it('reads lightweight manifest fields without parsing the body', () => {
        expect(
            readManifestFields('---\ntype: project\ndescription: demo\nmetadata:\n  updatedAt: now\n---\nbody')
        ).toEqual({
            type: 'project',
            description: 'demo',
            updatedAt: 'now'
        });
    });
});
