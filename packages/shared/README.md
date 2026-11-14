# @zhuixun/shared

前后端共享的 **HTTP 契约类型**（纯 TypeScript 类型，零运行时、零依赖）。

## 定位

本包只收「跨 HTTP 边界、两端本就该一字不差」的 DTO，是这些契约的单一真源：改一处，另一端编译期即报错，杜绝手改漂移。

**不收**后端内部 domain / 落盘类型（如含运行时 `ToolSet` 的 `LoadedSkill`、含 `version`/`workingDir` 落盘字段的 `SavedProject`、含 `apiKey` 的 `ProviderConfig`）——它们在前后端是「形似神不同」，强合反而会把后端内部结构泄露到前端、加深耦合。

## 内容

| 文件 | 类型 |
| --- | --- |
| `response.ts` | `ApiResponse`（统一响应信封 `{ code, data?, message? }`） |
| `task.ts` | `Task` / `TaskStatus` |
| `memory.ts` | `MemoryScope` / `MemoryType` / `MemoryRecord` / `MemoryManifestItem` / `MemoryOverview` / `MemoryProjectSummary` |
| `permission.ts` | `BashRule` / `WriteRule` / `PermissionData` / `RememberScope` / `RememberResult` |
| `skillhub.ts` | SkillHub 技能广场全套 DTO |
| `model.ts` | `ProviderKind` / `ModelMeta` / `ProviderView`（脱敏，无 apiKey） |

## 用法

两端均以 `import type` 引用（纯类型，构建时完全擦除，无运行时解析）：

```ts
import type { ApiResponse, Task } from '@zhuixun/shared';
```

- 后端：domain 文件在定义处改为 `import type { X } from '@zhuixun/shared'` 后 `export type { X }` 再导出，内部 `@/` 引用路径不变。
- 前端：`src/types/*.d.ts` 以 re-export 方式转发本包类型，`@/types/*` 引用路径不变。
