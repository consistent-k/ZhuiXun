import path from 'node:path';

import { paths } from '@/config/paths';

import type { MemoryScope } from './types';

/**
 * 记忆名称合法化：转小写、去 .md 扩展、仅保留 [a-z0-9._-]，防路径穿越。
 * 非法/空返回 ''，由调用方拒绝写入。
 */
export function sanitizeMemoryName(raw: string): string {
    const input = (raw ?? '').trim();
    // 先拒绝路径分隔符，再做展示名归一化，避免 `../name` 被转换成看似合法的 `name`。
    if (/[\\/]/u.test(input)) return '';
    let slug = input.toLowerCase();
    slug = slug.replace(/\.md$/u, '');
    slug = slug
        .replace(/[^a-z0-9._-]+/gu, '-')
        .replace(/^[-.]+|[-.]+$/gu, '')
        .slice(0, 64);
    // 拒绝纯点等退化值
    return /[a-z0-9]/u.test(slug) ? slug : '';
}

/** projectId 作目录名的合法化（projectId 本身受控，仍兜底防穿越）。 */
function sanitizeProjectId(projectId: string): string {
    return (projectId ?? '')
        .replace(/[^a-zA-Z0-9._-]+/gu, '-')
        .replace(/^[-.]+|[-.]+$/gu, '')
        .slice(0, 80);
}

/** 全局层记忆根：<memoryDir> 本身（memory 目录默认即全局记忆）。 */
export function globalMemoryRoot(): string {
    return paths.memoryDir();
}

/** 项目层记忆根：<projectsDir>/<projectId>/memory（随项目目录存放，删项目即连带删除）。 */
export function projectMemoryRoot(projectId: string): string {
    return path.join(paths.projectsDir(), sanitizeProjectId(projectId), 'memory');
}

/** 所有项目目录的父目录（<projectsDir>），供列举有记忆的项目用。 */
export function projectsMemoryParent(): string {
    return paths.projectsDir();
}

/** 按作用域解析记忆根；project 缺 projectId 时回落全局。 */
export function resolveMemoryRoot(scope: MemoryScope, projectId?: string): string {
    if (scope === 'project' && projectId) return projectMemoryRoot(projectId);
    return globalMemoryRoot();
}
