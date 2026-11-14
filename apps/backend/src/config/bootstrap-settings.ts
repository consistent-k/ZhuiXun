/**
 * 启动引导：须在 `index.ts` **首行**导入，早于任何 config 访问器（如模块顶层的 `port()`）求值。
 * 同步加载 settings.json 并把 `env` 段注入 process.env（denylist + 已存在键不覆盖），
 * 下游所有 config/* 访问器零改动即可从 settings.json 取值。
 *
 * 只依赖 config 叶子模块（settings-store / paths / env），不触碰 logging，
 * 保证「env 先注入、logging 后加载」的时序不被打破。
 */
import { applyEnvOverlay, getSettings } from './settings-store';

applyEnvOverlay(getSettings().env);
