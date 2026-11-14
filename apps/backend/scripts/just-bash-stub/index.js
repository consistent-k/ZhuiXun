/**
 * just-bash 的空替身（fail-fast）。
 *
 * 为什么需要它
 * ------------
 * `bash-tool` 有两处引用 just-bash：
 *   1. `dist/tools/bash.js` 顶部 —— **静态** `import { BashTransformPipeline, TeePlugin } from "just-bash"`
 *   2. `dist/sandbox/just-bash.js` —— **动态** `await import("just-bash")`
 *
 * 第 1 处是静态导入，只要 `import "bash-tool"` 就会求值，因此即使我们从不使用 just-bash，
 * 它也必须是可解析的，否则整个 bash-tool 在加载期就 `ERR_MODULE_NOT_FOUND`。
 *
 * 而 `just-bash` 在 bash-tool 里同时是 `dependencies` 和 `peerDependenciesMeta.optional` 的
 * optional peer —— pnpm 对这种重叠声明的处理是**不自动安装**（上游 README 也写的是
 * `npm install bash-tool just-bash`，要求使用方自行安装）。于是它默认缺席，bash-tool 直接加载失败。
 *
 * 这两处引用对我们都不可达：
 *   - `BashTransformPipeline`/`TeePlugin` 只在 `experimentalTeeTransform: true` 时才被 new（我们从不开启）
 *   - `Bash`/`OverlayFs` 只在**不传** `sandbox` 时才会被取用（我们始终传 `LocalShellSandbox`）
 *
 * 所以不安装 25MB + 两个可选原生模块（@mongodb-js/zstd、node-liblzma）的真正 just-bash，
 * 而是用这个替身满足解析。注意这也意味着：**本项目的 shell 是真实 shell，不是 just-bash 的模拟
 * 环境**；just-bash 这条路径不是「暂时未用到」而是「有意不用」——它会降级为模拟的 grep/node。
 *
 * 这里每一个类都是构造即抛，而不是静默返回空实现：一旦将来有人误开
 * `experimentalTeeTransform` 或漏传 `sandbox`，应该立刻拿到一个说明原因的报错，
 * 而不是进入一个行为异常的模拟沙箱。
 *
 * 版本号刻意写成 3.4.2（与 npm 上 just-bash 当前版本一致），只是为了让 pnpm 的
 * peer range 校验（`^2.9.3 || ^3.0.0`）安静通过——它不代表这里真的实现了那个版本的 API。
 */

const HOW_TO_FIX = [
    '本项目有意不使用 just-bash：真实的 shell 能力由 apps/backend/src/ai/tools/shell-tools.ts',
    '里的 LocalShellSandbox（spawn + 超时 + 审计）提供。',
    '',
    '如果你是通过 createBashTool 走到这里的，请确认：',
    '  1. 传了 `sandbox: new LocalShellSandbox()`（漏传会回落到 just-bash 沙箱）',
    '  2. 没有开启 `experimentalTeeTransform`（开启会用到 BashTransformPipeline/TeePlugin）',
    '',
    '若确实需要 just-bash 的模拟环境（会失去真实 grep/node 能力），请把',
    'apps/backend/package.json 里的 "just-bash" 从本地替身改回 ^3.0.1 并重新安装。'
].join('\n');

function unreachable(name) {
    return class {
        constructor() {
            throw new Error(`[just-bash 替身] 不应被实例化：${name}\n\n${HOW_TO_FIX}`);
        }
    };
}

/** 对应 just-bash 的虚拟 Bash 环境。只在未传自定义 sandbox 时才会被 new。 */
export const Bash = unreachable('Bash');
/** 对应 just-bash 的写时复制文件系统。只在 uploadDirectory 且未传 sandbox 时才会被 new。 */
export const OverlayFs = unreachable('OverlayFs');
/** 对应 just-bash 的命令改写管线。只在 experimentalTeeTransform 开启时才会被 new。 */
export const BashTransformPipeline = unreachable('BashTransformPipeline');
/** 对应 just-bash 的中间输出捕获插件。只在 experimentalTeeTransform 开启时才会被 new。 */
export const TeePlugin = unreachable('TeePlugin');

/** 兜底：万一上游将来新增了导入名，构造时给出同一份说明而不是 "is not a constructor"。 */
export default new Proxy(
    { Bash, OverlayFs, BashTransformPipeline, TeePlugin },
    {
        get(target, prop) {
            if (prop in target) return target[prop];
            if (typeof prop === 'symbol') return undefined;
            return unreachable(String(prop));
        }
    }
);
