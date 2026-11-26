# 通用连接器

`catalog.ts` 中的 `connectorDefinitions` 是应用目录和后端连接方式的唯一真源。它只随源码发布，不从 HTTP 加载安装命令。共享 DTO 在 `packages/shared/src/connector.ts`，不包含启动命令或凭证。旧 `/api/mcp/apps` 接口只保留 MCP 应用兼容入口，新页面统一使用 `/api/connectors/*`。

## 添加 MCP 应用

声明 `app`（名称、分类、认证方式、字段和授权入口）以及 `mcp`（SDK 传输配置）。每个表单字段有稳定 `key`、标签、`text/password` 类型、必填项、默认值和可选格式校验。配置中的 `${key}` 引用提交值，可用于 Header、URL、stdio 参数/环境变量、预注册 OAuth 的 client 信息；URL 中普通字段按值编码，`format: 'url'` 字段允许作为完整 HTTPS 服务地址。可选字段为空时引用替换为空串，未声明的变量拒绝连接。

OAuth 复用已有 SDK discovery / DCR / PKCE / token exchange、回调与 token store；不另写 OAuth 客户端。远程连接直接使用官方 MCP SDK transport 的 `requestInit.headers`，SSE 的 GET 与 POST 都由 SDK 统一携带请求头。自定义 MCP 也支持 Header；列表只返回 Header 名称，编辑留空保留已存值，删除条目则移除对应 Header。OAuth client secret 不回传，编辑留空保留原值。

百度网盘支持 Token 或官方完整授权结果地址；新配置使用 Header，已存 URL Token 配置不会在无凭证重连时被重写。平台正式 OAuth 接入与个人 Token 连接是两种流程，不能共用他人的客户端凭证。

## 添加 CLI 应用

声明 `cli`，包含固定 npm 包/版本/bin 名称、version/status/login/logout 参数数组、状态匹配、授权域名白名单、开放命令前缀及 `instructions` 使用说明。当前实现托管 Node/npm CLI；Python、任意远程脚本及 WorkBuddy 私有云端授权不在此实现中。

安装是用户点击后发起的异步作业：使用随应用分发或宿主的 npm，安装到 `CONNECTORS_USER_DIR/runtime/<id>`（默认 `~/.zhuixun/connectors`），固定版本并禁用安装脚本，不改全局 npm 或 shell 配置。安装后校验包版本、入口路径和可执行性。官方 CLI 自行保存、刷新、清理登录态，追寻只保存 `enabled/configured` 状态（0600 原子串行写入），不解析或转存 CLI 的凭证文件。

同一个应用的安装/授权作业互斥。进程通过参数数组直接启动，过滤后端密钥环境变量，限制输出大小；取消、超时、停机时结束进程组。只把白名单 HTTPS 授权 URL 提供给前端，不返回原始认证输出。暂停会取消在途作业但保留登录态，断开会执行官方 logout，退出失败不伪造成功。

`tools.ts` 使用 AI SDK `tool` 和 Zod schema 生成工具，`instructions` 作为配套使用说明进入工具描述。主对话 routed / progressive 都走现有 `ToolLoopAgent`，调用经过统一 `toolApproval`、策略和 Hooks；不使用已弃用的 `needsApproval`，不自建 Agent 循环。CLI 调用默认要求审批，无 UI 场景拒绝需确认调用，服务执行时还会复查启用状态与命令前缀。连接变化从新对话开始使用；退出后旧工具闭包也不能继续执行。

## 验证

默认测试使用临时目录、模拟 SDK 边界或进程端口，不连接真实账号、不访问网络、不安装软件。`test/integration/connectors.test.ts` 验证生命周期与真实 SDK tool，`test/http/connectors.test.ts` 验证统一 HTTP 契约，`test/unit/connector-command.test.ts` 验证进程环境与取消。真实账号的安装/授权仍须分别验收。
