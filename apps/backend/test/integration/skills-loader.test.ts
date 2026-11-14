import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MCPClientManager, MCPToolAdapter } from '@/modules/mcp';
import {
    loadSkillFromDirectory,
    parseSkillFrontmatter,
    readSkillSource,
    serializeSkillMarkdown
} from '@/modules/skills/loader';

import { createTempData } from '../helpers/temp-data';
import type { TempData } from '../helpers/temp-data';

let temp: TempData;
let skillDir: string;
const adapter = new MCPToolAdapter(new MCPClientManager([]));

beforeEach(async () => {
    temp = await createTempData('skills-loader-');
    skillDir = path.join(temp.skills, 'sample');
    await fs.mkdir(skillDir, { recursive: true });
});
afterEach(async () => temp.cleanup());

const writeMarkdown = (markdown: string) => fs.writeFile(path.join(skillDir, 'SKILL.md'), markdown);

describe('skills loader filesystem', () => {
    it('reads editable source and runtime views without losing extra metadata or tool rules', async () => {
        await writeMarkdown(
            serializeSkillMarkdown({
                name: 'sample',
                displayName: '中文展示',
                description: '描述: 包含冒号',
                systemPrompt: '正文\n\n第二段',
                triggers: ['核对'],
                allowedTools: ['Bash', 'Read'],
                disallowedTools: ['Bash(rm:*)'],
                extraMetadata: { source_canonical: '@demo/sample', preferred_model: 'test/model' }
            })
        );
        expect(await readSkillSource(skillDir)).toEqual({
            name: 'sample',
            displayName: '中文展示',
            description: '描述: 包含冒号',
            systemPrompt: '正文\n\n第二段',
            triggers: ['核对'],
            allowedTools: ['Bash', 'Read'],
            disallowedTools: ['Bash(rm:*)'],
            extraMetadata: { source_canonical: '@demo/sample', preferred_model: 'test/model' }
        });
        expect(await loadSkillFromDirectory(skillDir, adapter)).toEqual({
            id: 'sample',
            name: '中文展示',
            description: '描述: 包含冒号',
            systemPrompt: '正文\n\n第二段',
            tools: {},
            toolInfo: [],
            preferredModel: 'test/model',
            allowedTools: ['Bash', 'Read'],
            disallowedTools: ['Bash(rm:*)']
        });
        expect(await parseSkillFrontmatter(skillDir)).toMatchObject({ name: 'sample', triggers: ['核对'] });
    });

    it('ignores legacy array rules, empty scalar rules and non-array triggers; trims metadata', async () => {
        await writeMarkdown(`---
name: sample
triggers: invalid
allowed-tools: [Bash, Read]
disallowed-tools: ' , , '
metadata:
  source_canonical: ' @demo/sample '
  blank: '  '
  omitted: null
  version: 2
---
body`);
        const source = await readSkillSource(skillDir);
        expect(source).toEqual({
            name: 'sample',
            displayName: undefined,
            description: '',
            systemPrompt: 'body',
            triggers: undefined,
            allowedTools: undefined,
            disallowedTools: undefined,
            extraMetadata: { source_canonical: '@demo/sample', version: '2' }
        });
        expect(await loadSkillFromDirectory(skillDir, adapter)).toMatchObject({
            name: 'sample',
            allowedTools: undefined,
            disallowedTools: undefined
        });
        await writeMarkdown('---\nname: sample\nmetadata:\n  display_name: Only display\n---\nbody');
        expect(await readSkillSource(skillDir)).toMatchObject({
            displayName: 'Only display',
            extraMetadata: undefined
        });
        await writeMarkdown('---\nname: sample\n---\nbody');
        expect(await readSkillSource(skillDir)).toMatchObject({ extraMetadata: undefined });
    });

    it('discovers trusted local single and grouped tools once, ignoring other export shapes', async () => {
        await writeMarkdown('---\nname: sample\ndescription: trusted tools fixture\n---\nbody');
        await fs.mkdir(path.join(skillDir, 'tools'));
        // 仅执行本测试自己生成的可信 JS；不下载脚本，也不从用户技能根加载代码。
        await fs.writeFile(
            path.join(skillDir, 'tools/index.js'),
            `export const single = { description: 'single tool', execute: async () => 'single-result' };
export const unnamed = { execute: async () => 'unnamed-result' };
export const collection = {
    grouped: { description: 'grouped tool', execute: async () => 'grouped-result' },
    noDescription: { execute: async () => 7 },
    ignored: { description: 'not a tool' },
    nil: null
};
export const scalar = 42;
export const nil = null;
export const callable = () => 'not a tool';`
        );
        const skill = await loadSkillFromDirectory(skillDir, adapter);
        expect(Object.keys(skill.tools).sort()).toEqual(['grouped', 'noDescription', 'single', 'unnamed']);
        expect(skill.toolInfo).toEqual(
            expect.arrayContaining([
                { name: 'single', description: 'single tool' },
                { name: 'unnamed', description: '' },
                { name: 'grouped', description: 'grouped tool' },
                { name: 'noDescription', description: '' }
            ])
        );
        expect(skill.toolInfo).toHaveLength(4);
        await expect(
            skill.tools.single.execute!(undefined, { toolCallId: 'single', messages: [], context: undefined })
        ).resolves.toBe('single-result');
        await expect(
            skill.tools.grouped.execute!(undefined, { toolCallId: 'grouped', messages: [], context: undefined })
        ).resolves.toBe('grouped-result');
    });

    it('degrades a broken trusted tool module to no tools without losing the prompt', async () => {
        await writeMarkdown('---\nname: sample\ndescription: tool failure\n---\nretained body');
        await fs.mkdir(path.join(skillDir, 'tools'));
        await fs.writeFile(path.join(skillDir, 'tools/index.js'), "throw new Error('fixture load failure');");
        expect(await loadSkillFromDirectory(skillDir, adapter)).toMatchObject({
            systemPrompt: 'retained body',
            tools: {},
            toolInfo: []
        });
    });

    it('skips malformed skills but preserves the parsing cause and file path for explicit loads', async () => {
        await writeMarkdown('---\nname: [unterminated\n---\nbody');
        await expect(parseSkillFrontmatter(skillDir)).resolves.toBeNull();
        await expect(readSkillSource(skillDir)).rejects.toMatchObject({
            message: expect.stringContaining(path.join(skillDir, 'SKILL.md')),
            cause: expect.any(Error)
        });
        await fs.rm(path.join(skillDir, 'SKILL.md'));
        await expect(parseSkillFrontmatter(skillDir)).resolves.toBeNull();
        await expect(loadSkillFromDirectory(skillDir, adapter)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
