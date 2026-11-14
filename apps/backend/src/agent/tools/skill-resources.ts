/**
 * 技能资源（相对技能目录的 posix 路径）是否随技能副本放进 workspace。
 *
 * 顶层 `tools/` 是技能代码工具（加载时 `import()` 执行），已作为工具挂载，不放进工作区供 shell 运行；
 * node_modules / .git 与 bash-tool 的 .md seed 保持一致地忽略。
 */
export function isSeedableSkillResource(relativePath: string): boolean {
    const segs = relativePath.split('/');
    return segs[0] !== 'tools' && !segs.includes('node_modules') && !segs.includes('.git');
}
