import fs from 'node:fs/promises';
import path from 'node:path';

import type { ProjectRoot } from '@/modules/projects';

/**
 * 项目根目录（工作目录集合）的校验与「发起会话时」的探活。
 *
 * - `validateDir`：保存项目时的边界校验（绝对路径 + 已存在目录），供 routes 复用。
 * - `resolveEffectiveRoots`：发起会话时对一组根**逐个探活**——主根缺失则回落临时工作区，
 *   附加根缺失则丢弃并记 warning。目录可能在保存后被用户删除/移动，故运行时必须再查一次。
 */

/** 校验单个目录：必须是绝对路径且指向一个已存在的目录。 */
export async function validateDir(dir: string): Promise<{ ok: boolean; reason?: string }> {
    if (!path.isAbsolute(dir)) return { ok: false, reason: '请填写绝对路径' };
    try {
        const stat = await fs.stat(dir);
        if (!stat.isDirectory()) return { ok: false, reason: '该路径不是文件夹' };
        return { ok: true };
    } catch {
        return { ok: false, reason: '目录不存在或无访问权限' };
    }
}

/** 探活结果：主根（会话 shell cwd）、存活的附加根、以及给模型/用户看的提示。 */
export interface ResolvedRoots {
    /** 主根绝对路径；缺失（未配置或已失效）时为 undefined，调用方回落临时工作区 */
    primaryDir?: string;
    /** 存活的附加根（primary 之外、探活通过的） */
    additionalDirs: string[];
    /** 失效根提示（主根失效 / 附加根被丢弃） */
    warnings: string[];
}

async function dirExists(dir: string): Promise<boolean> {
    return (await validateDir(dir)).ok;
}

/**
 * 对一组（已归一的）项目根逐个探活。
 * primary 根失效 → primaryDir=undefined + warning（会话回落临时工作区）；
 * 附加根失效 → 丢弃该根 + warning。
 */
export async function resolveEffectiveRoots(roots: ProjectRoot[] | undefined): Promise<ResolvedRoots> {
    const result: ResolvedRoots = { additionalDirs: [], warnings: [] };
    if (!roots || roots.length === 0) return result;

    const primary = roots.find((r) => r.primary) ?? roots[0];
    const additionals = roots.filter((r) => r !== primary);

    if (await dirExists(primary.path)) {
        result.primaryDir = primary.path;
    } else {
        result.warnings.push(`项目主工作目录「${primary.path}」不存在或不可访问，本轮回落到临时工作区。`);
    }

    for (const r of additionals) {
        if (await dirExists(r.path)) {
            result.additionalDirs.push(r.path);
        } else {
            result.warnings.push(`项目附加目录「${r.path}」不存在或不可访问，本轮已忽略。`);
        }
    }
    return result;
}
