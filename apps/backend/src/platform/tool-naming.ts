/**
 * MCP 工具名前缀拼接的唯一实现。
 *
 * 服务器名中的 `-` 换成 `_`，工具名本身也做同样的清洗，
 * 避免 MCP 工具名里的非法标识符字符（`.`、空格等）进入模型的 tool schema。
 * runner.ts（渐进模式 search 回调）和 adapter.ts 必须共用这一处逻辑，否则同一个工具在
 * "自动加载"和"渐进式发现"两种模式下会得到不同的最终名字。
 *
 * 首字符必须是字母或下划线：MCP server 名可能以数字开头（如 `01db`），拼出的
 * `01db_xxx` 在 OpenAI/Anthropic 可用，但 Google Gemini 会拒绝
 * （GenerateContentRequest.tools[].function_declarations[].name: Invalid function name
 * ，要求以字母或下划线开头），故统一补前导下划线。
 */
export function buildPrefixedToolName(serverName: string, toolName: string): string {
    const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_');
    const name = `${sanitize(serverName)}_${sanitize(toolName)}`;
    return /^[a-zA-Z_]/.test(name) ? name : `_${name}`;
}
