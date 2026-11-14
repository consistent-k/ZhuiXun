import { Hono } from 'hono';

import { notReady, ok } from '@/http/respond';
import type { SkillRegistry } from '@/modules/skills';

/**
 * 调试端点：列出已加载技能及其工具。
 *
 * 从 `app.ts` 内联实现下沉到这里——组合根只做装配，不放业务查询。
 */
export function createDebugRouter(getRegistry: () => Pick<SkillRegistry, 'loadAll'> | undefined): Hono {
    const router = new Hono();

    router.get('/api/debug/tools', async (c) => {
        const registry = getRegistry();
        if (!registry) return notReady(c);

        const allSkills = await registry.loadAll();
        const skills = allSkills.map((skill) => {
            const tools = Object.keys(skill.tools || {});
            return { skillId: skill.id, skillName: skill.name, tools, toolCount: tools.length };
        });

        return ok(c, {
            totalSkills: allSkills.length,
            totalTools: skills.reduce((sum, s) => sum + s.toolCount, 0),
            skills
        });
    });

    return router;
}
