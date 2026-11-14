/**
 * 工具标签契约：把模型侧工具名映射为人话。
 *
 * key 是模型实际调用的工具名（技能工具为原始名，MCP 工具为 `<sanitizedServer>_<sanitizedTool>` 前缀名），
 * 前端活动流 / 审批卡按工具名直接查表，不再自己拼前缀或逐个 server 拉工具列表。
 */
export interface ToolLabelItem {
    /** 展示说明：优先取工具 description，缺省回退工具原名 */
    label: string;
    /** 工具来源：local=技能 tools/ 下声明的工具，mcp=MCP server 暴露的工具 */
    source: 'local' | 'mcp';
    /** 来源名：技能工具为技能名，MCP 工具为 server 名（前端据此还原 `server · tool`） */
    skillName: string;
}
