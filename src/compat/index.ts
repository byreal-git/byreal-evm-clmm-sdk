/**
 * `@byreal-io/byreal-evm-clmm-sdk/compat` 统一出口。
 *
 * 迁移期的前端**只 import 这一个入口就够**：兼容层的门面/类/类型在这里，
 * 末尾再把核心 SDK 整包透出（`export * from '../index.js'`），所以
 * `import { ByrealClmmSdk, EvmClmmSdk, getPositionView, NPM_ABI } from '@byreal-io/byreal-evm-clmm-sdk/compat'`
 * 一句话全都有。
 *
 * ⚠️ 方向是单向的：**核心 barrel（`src/index.ts`）不会、也不许导出 compat**。
 * compat 是 opt-in 的独立入口 —— 直接用核心 SDK 的新代码不该被兼容层的旧概念
 * （nftMint、slippage 小数口径、instructions 别名）污染，也不该为它多打一份包。
 *
 * 两个入口的**默认值不同**是有意为之（见 docs/compat.md）：核心 `EvmClmmSdk` 默认滑点
 * 50 bps，compat 走 {@link COMPAT_DEFAULT_SLIPPAGE_BPS}。新代码请显式传 `slippageBps`。
 */

// ---- 宽进转换原语（Numericish / BaseSideish / toBigInt / toAddress / 滑点与 deadline 归一化）----
export * from './coerce.js'

// ---- 快照归一化（后端接口 / 扁平 JSON / 核心 raw 三种形状 → IPoolStateRaw / IPositionStateRaw）----
export * from './state.js'

// ---- 兼容层对外类型 + 返回值组装帮手 ----
export * from './models.js'

// ---- 静态数学类（TickMath / SqrtPriceMath / LiquidityMath，X64 旧方法一律抛）----
export * from './math.js'

// ---- 写操作：读链版 / 快照注入版（0 RPC）----
export * from './liquidity.js'
export * from './offchain.js'

// ---- 读操作层与门面 ----
export * from './chain.js'
export * from './client.js'

// ---- 核心 SDK 一并透出，前端不用再开第二个 import 源 ----
export * from '../index.js'

// ⚠️ `./internal`（liquidity 与 offchain 共用的入参归一化 / meta 组装）**刻意不在这里导出**：
// 那是实现细节，透出去就变成了必须维护的公开契约，将来重构会被外部调用点绑死。
// 它里面唯一需要对外可见的类型 `IPendingFeesish` 由 `./offchain` 再导出一次。
//
// ⚠️ `./test-fixtures`（`*.test.ts` 用的链上夹具与 publicClient 替身）同理**不导出**：
// 它是测试脚手架，不是兼容层契约的一部分；导出去等于承诺「我们的 mock 也是公开 API」。
