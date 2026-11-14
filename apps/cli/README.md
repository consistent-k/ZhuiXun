# 追寻 CLI 2.0

开发运行：在仓库根执行 `pnpm dev:cli`。构建后的入口位于 `apps/cli/dist/cli.js`。

发布后可通过 `npm install -g @zhuixun/cli` 安装，执行 `zhuixun` 启动。CLI 自动连接当前追寻后端，找不到运行实例时启动随包后端。使用 `zhuixun --url http://127.0.0.1:31001` 可显式连接本机后端。后端启用 API 鉴权时，通过本机环境传入 `API_AUTH_TOKEN`。

- 输入 `/` 浏览内置与自定义命令。↑/↓ 选择，Tab 补全，Enter 提交。输入 `@` 选择当前工作目录中的文件，发送时上传为会话附件。`/reload` 刷新索引，Ctrl+U 清空输入和待发附件。
- `/help` 查看命令和快捷键，`/config` 查看供应商或添加、更新模型，`/model` 选择已有模型。
- `/approvals` 查看放行规则，`/tools` 查看后端提供的技能与 MCP 工具标签。审批时可单次批准或拒绝，Bash、Write、Edit 可通过后端规则记住授权。
- `/theme` 切换并保存旧版的 dark、light、mayday 配色，`/locale` 切换终端渲染组件的语言。`zhuixun update` 检查 npm 版本，`zhuixun update --install` 安装可用更新。
- `/sessions` 列出会话，`/resume <id>` 打开会话，`/project <id>` 在已有项目中开启会话。
- `/channel status` 查看渠道，`/channel login telegram` 隐藏输入 Bot Token，`/channel login weixin` 显示微信二维码。
- `/channel start <id>` 启动监听，`/channel stop <id>` 停止监听，`/channel logout <id>` 解绑。
- `/exit` 退出终端。独立运行时会关闭随 CLI 启动的后端与渠道。连接已有后端时，后端和渠道继续运行。

CLI 与桌面版共用 `~/.zhuixun` 中的配置和会话。随 CLI 提供的 Telegram 和微信适配器在独立后端中加载。连接桌面后端时，终端展示该实例已注册的渠道。

异常退出后，下一次启动会回收已确认退出进程的后端锁。
