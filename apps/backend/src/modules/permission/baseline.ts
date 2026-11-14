import type { PermissionRuleSet } from '@zhuixun/shared';

/**
 * 内置默认团队基线（随应用发布，2026-10-27 确认三类）。
 *
 * - 危险命令 ask：命令头粒度，无法单独匹配 `git push --force`，故整条 `git push` 需确认；危险模式下放行。
 * - 嵌套 shell ask：堵 `bash -c "git push ..."` 绕过命令头匹配；危险模式下放行。
 * - 密钥文件读 deny：含本应用的 settings.json（apiKey）与 mcp-oauth.json（token）；**危险模式下仍拒绝**，
 *   同时作用于 Grep / Glob / LS。注意 Bash 里 `cat .env` 不受 Read 规则约束（纵深防御而非沙箱）。
 *
 * 外部基线 `~/.zhuixun/policy/permissions.json` 存在且合法时**整体替换**本常量（见 policy.ts）。
 */
export const BUILTIN_BASELINE: Readonly<PermissionRuleSet> = Object.freeze({
    deny: [
        'Read(**/.env)',
        'Read(**/.env.local)',
        'Read(**/.env.*.local)',
        'Read(**/*.pem)',
        'Read(**/*.key)',
        'Read(~/.ssh/**)',
        'Read(~/.aws/**)',
        'Read(~/.zhuixun/settings.json)',
        'Read(~/.zhuixun/mcp-oauth.json)'
    ],
    ask: [
        'Bash(rm:*)',
        'Bash(git push:*)',
        'Bash(git reset:*)',
        'Bash(git clean:*)',
        'Bash(bash:*)',
        'Bash(sh:*)',
        'Bash(zsh:*)',
        'Bash(eval:*)',
        'Bash(pwsh:*)',
        'Bash(powershell:*)',
        'Bash(cmd:*)'
    ],
    allow: []
});
