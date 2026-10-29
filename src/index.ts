/**
 * SDK 统一出口（barrel）：一句 `import { EvmClmmSdk } from '@byreal-io/byreal-evm-clmm-sdk'` 即可。
 * 导出门面与子客户端、类型契约、常量、本地数学纯函数（0 RPC）与通用工具。
 * 入口划分与依赖方向见 docs/core.md。
 */

// ---- 门面 ----
export { EvmClmmSdk } from './client.js'

// ---- 子客户端 ----
export { Chain } from './chain/index.js'
export { CLMMClient } from './liquidity/clmm.js'
export { AbstractLiquidityClient, type ICreatePositionMeta } from './liquidity/abstract.js'
export { RewardClient } from './reward/index.js'

// ---- 类型契约（全部是 interface / type，编译期擦除）----
export * from './types.js'

// ---- 常量与链注册表 ----
export * from './constants.js'

// ---- 本地数学纯函数（0 RPC）----
export * from './calculate.js'

// ---- SDK 内部通用工具（deadline / 百分比，0 RPC）----
export * from './utils/index.js'

// ---- 精简 ABI（前端若要自己拼 calldata 或解事件，可直接复用）----
export * from './abis.js'

// ---- 回执解析：mint 上链后取新仓位 tokenId ----
export * from './receipt.js'
