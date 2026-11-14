// 必须在其他模块之前加载：加载 settings.json、把 env 段注入 process.env，
// 确保后续 config 访问器（含调用时求值的 port()）读到就绪的配置。
// 这里是整个后端唯一强制「第一行」的副作用导入——无论从 index.ts(standalone/tsx) 还是从
// Electron 主进程 import 本模块，bootstrap 都会先于任何 config 读取执行。
import './config/bootstrap-settings';

// 启动/监听/停机逻辑在 bootstrap/lifecycle；本文件保持为打包入口（tsup entry）与薄转发层。
export type { RunningBackend } from './bootstrap/lifecycle';
export { startServer } from './bootstrap/lifecycle';
