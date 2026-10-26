/**
 * compat 层的快照归一化：把前端手上**三种来源**的池子/仓位快照统一成
 * 核心 SDK 的 `IPoolStateRaw` / `IPositionStateRaw`，好让 0 RPC 的本地数学与
 * 「自带快照」写操作能直接吃。
 *
 * 三种来源：
 * 1. 核心 SDK 的 `IPoolStateRaw` / `IPositionStateRaw`（大整数是 bigint，字段全扁平）；
 * 2. 后端接口的 `PoolDetail` / `PositionSummary` / `PositionDetail`
 *    （大整数是 **string**，链上字段嵌在 `onchainState` 里，费率字段叫 `feeTier`）；
 * 3. 后端将来直接下发的扁平 JSON（字段名同 EVM 合约，值是 string）。
 *
 * ⚠️ 依赖边界：本 SDK 不依赖任何后端客户端。
 * 需要接住后端接口的形状时，一律在本文件里用**结构化鸭子类型**声明 ——
 * 换来的是后端接口演进时 SDK 不用跟着改类型依赖。
 *
 * ⚠️ 本文件**不做自洽性校验**（`sqrtPriceX96` 与 `tick` 是否同块）：
 * 核心 `toUniPool` 里已经有一份，且报错信息更准确；这里再来一遍只会让错误信息变差。
 */
import type { Address } from 'viem'

import type { IPoolStateRaw, IPositionStateRaw, ITokenInfo } from '../types.js'

import { COMPAT_ERR_PREFIX, toAddress, toBigInt, toSmallInt, type Numericish } from './coerce.js'

// ---------------------------------------------------------------------------
// 鸭子类型声明（对应后端接口的形状，但**不 import** 它）
// ---------------------------------------------------------------------------

/**
 * 代币元数据的宽松形状：后端接口的 `TokenInfo`（无 `chainId`、`decimals` 可能是 string）
 * 与核心 `ITokenInfo` 的公共子集。
 */
export interface TokenInfoLikeShape {
  address: string
  decimals: number | string
  symbol?: string
  name?: string
  /** 后端接口的 TokenInfo 没有这个字段，由调用方注入（见 {@link toTokenInfo}） */
  chainId?: number
}

/** `toTokenInfo` 的入参：核心 `ITokenInfo` 或任意带 address + decimals 的对象 */
export type TokenInfoish = ITokenInfo | TokenInfoLikeShape

/** 池子快照里「token0 / token1」这一位可能的两种写法：裸地址串，或带元数据的对象 */
export type TokenRefish = string | TokenInfoLikeShape

/** 后端接口 `PoolDetail.onchainState` 的鸭子类型（大整数是 string） */
export interface ApiPoolOnchainStateShape {
  sqrtPriceX96: Numericish
  tick: number | string
  liquidity: Numericish
  feeGrowthGlobal0X128: Numericish
  feeGrowthGlobal1X128: Numericish
  /** Byreal 定制合约的可变参数（新版后端接口 会带；旧快照没有时按安全缺省处理） */
  tradeFeeRate?: number | string
  protocolFeeRate?: number | string
  pauseFlags?: number | string
  swapOpenTime?: number | string
  alphaExtraTradeFeeRate?: number | string
  dexExtraTradeFeeRate?: number | string
  dynamicFeeEnabled?: boolean | string
}

/**
 * 后端接口 `PoolDetail` 的鸭子类型：费率叫 `feeTier`，链上动态字段嵌在 `onchainState` 里，
 * `token0` / `token1` 是带 decimals 的对象。
 */
export interface ApiPoolDetailShape {
  poolAddress: string
  chainId?: number
  token0: TokenRefish
  token1: TokenRefish
  feeTier: number | string
  tickSpacing: number | string
  onchainState: ApiPoolOnchainStateShape
}

/** 后端下发的扁平池子 JSON：字段名同 EVM 合约，值可能是 string */
export interface FlatPoolShape {
  poolAddress?: string
  /** 旧代码里的别名写法，一并认（Solana 版叫 poolId / id） */
  address?: string
  poolId?: string
  id?: string
  token0: TokenRefish
  token1: TokenRefish
  /** 基础费率（ppm）。定制合约叫 tradeFeeRate；旧名 fee / feeTier 同单位，一并认 */
  tradeFeeRate?: number | string
  fee?: number | string
  feeTier?: number | string
  tickSpacing: number | string
  sqrtPriceX96: Numericish
  tick: number | string
  liquidity: Numericish
  feeGrowthGlobal0X128: Numericish
  feeGrowthGlobal1X128: Numericish
  protocolFeeRate?: number | string
  pauseFlags?: number | string
  swapOpenTime?: number | string
  alphaExtraTradeFeeRate?: number | string
  dexExtraTradeFeeRate?: number | string
  dynamicFeeEnabled?: boolean | string
}

/** {@link toPoolStateRaw} 能吃的三种池子快照 */
export type PoolSnapshotish = IPoolStateRaw | ApiPoolDetailShape | FlatPoolShape

/**
 * 后端接口 `PositionSummary` / `PositionDetail` 的鸭子类型。
 *
 * 注意 `PositionSummary` **不带** token0/token1/fee（它只有 poolAddress），
 * 所以这里额外认一个 `pool` 字段（`PositionDetail` 自带）；只有 summary 时，
 * 调用方需要自己把 `poolMap[poolAddress]` 合并进来 —— 具体见 {@link toPositionStateRaw} 的报错提示。
 */
export interface ApiPositionShape {
  tokenId: Numericish
  poolAddress?: string
  tickLower: number | string
  tickUpper: number | string
  liquidity: Numericish
  feeGrowthInside0LastX128?: Numericish
  feeGrowthInside1LastX128?: Numericish
  tokensOwed0?: Numericish
  tokensOwed1?: Numericish
  /** `PositionDetail.pool`：仓位所属池子的详情，token0/token1/tickSpacing 从这里派生 */
  pool?: PoolSnapshotish
  nonce?: Numericish
  operator?: string
  token0?: TokenRefish
  token1?: TokenRefish
  /** 定制合约的仓位第 5 项：tickSpacing（池身份键，原生 V3 此处是 fee） */
  tickSpacing?: number | string
  /** @deprecated 旧字段。fee 与 tickSpacing 是不同量纲，**不能**互相推导，仅保留声明防止旧代码编译报错 */
  fee?: number | string
  /** @deprecated 同上 */
  feeTier?: number | string
}

/** 后端下发的扁平仓位 JSON：字段名同 `NonfungiblePositionManager.positions()` */
export interface FlatPositionShape {
  tokenId: Numericish
  nonce?: Numericish
  operator?: string
  token0?: TokenRefish
  token1?: TokenRefish
  /** 定制合约的仓位第 5 项：tickSpacing（池身份键，原生 V3 此处是 fee） */
  tickSpacing?: number | string
  /** @deprecated 旧字段。fee 与 tickSpacing 是不同量纲，**不能**互相推导，仅保留声明防止旧代码编译报错 */
  fee?: number | string
  /** @deprecated 同上 */
  feeTier?: number | string
  tickLower: number | string
  tickUpper: number | string
  liquidity: Numericish
  feeGrowthInside0LastX128?: Numericish
  feeGrowthInside1LastX128?: Numericish
  tokensOwed0?: Numericish
  tokensOwed1?: Numericish
  pool?: PoolSnapshotish
}

/** {@link toPositionStateRaw} 能吃的三种仓位快照 */
export type PositionSnapshotish = IPositionStateRaw | ApiPositionShape | FlatPositionShape

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 零地址：仓位快照里缺 `operator` 时的填充值。
 * `operator` 是 NPM 的授权字段，**不参与任何 CLMM 数学、也不进 calldata**，
 * 后端下发的形状里普遍没有它，缺省成零地址（= 未授权任何人）是链上语义下最保守的取值。
 */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

/** 报错时附上的「兼容层认哪三种形状」说明 —— 只说 "invalid input" 等于没说 */
const POOL_SHAPE_HINT =
  '兼容层接受三种池子快照形状：\n' +
  '  1) 核心 SDK 的 IPoolStateRaw（大整数是 bigint，字段全部扁平）；\n' +
  '  2) 后端接口的 PoolDetail（大整数是 string，费率字段叫 feeTier，' +
  'sqrtPriceX96/tick/liquidity/feeGrowthGlobal* 嵌在 onchainState 里）；\n' +
  '  3) 后端下发的扁平 JSON（字段名同 EVM 合约，值是 string）。'

const POSITION_SHAPE_HINT =
  '兼容层接受三种仓位快照形状：\n' +
  '  1) 核心 SDK 的 IPositionStateRaw（大整数是 bigint）；\n' +
  '  2) 后端接口的 PositionDetail（大整数是 string，带 pool 字段）；\n' +
  '  3) 后端下发的扁平 JSON（字段名同 NonfungiblePositionManager.positions()）。'

/** 把快照对象当成松散的键值表来读（三种形状的字段集合不同，逐一 narrow 只会写成一坨断言） */
type LooseRecord = Record<string, unknown>

function asRecord(input: unknown, field: string, hint: string): LooseRecord {
  if (input === null || typeof input !== 'object') {
    throw new Error(`${COMPAT_ERR_PREFIX} ${field} 必须是一个对象，收到 ${String(input)}。\n${hint}`)
  }
  return input as LooseRecord
}

/**
 * 「这个值算给了吗」——`undefined` / `null` / **空字符串**都算没给；`0` / `0n` / `false` 算给了。
 *
 * 空串必须算「没给」，判据与 compat 其余各处（`internal.isPresent`）保持一致。
 * 后端序列化时把「没有值」写成 `""` 是极常见的（`operator: ""`、`tokensOwed0: ""`），
 * 把它当成有效值会产生两类都很难查的故障：
 * - **别名被空串抢走**：`{ poolAddress: "", id: "0x…" }` 里明明有池子地址，却报「poolAddress 是空字符串」；
 * - **安全缺省失效**：`operator` / `tokensOwed*` 这些**核心根本不读**的记账字段本该缺省成
 *   零地址 / 0n，却因为一个空串让整份快照解析失败。
 *
 * 必填字段传空串仍然会失败 —— 只是报错从「无法解析为链上整数：收到 ""」变成
 * 「缺少必需字段：liquidity」，后者才指得出方向。
 */
function has(v: unknown): boolean {
  return v !== undefined && v !== null && v !== ''
}

/** 取第一个「给了」的值（用于字段别名：fee ?? feeTier、poolAddress ?? address …） */
function firstOf(...values: unknown[]): unknown {
  for (const v of values) if (has(v)) return v
  return undefined
}

/** token 这一位既可能是裸地址串，也可能是后端接口的 TokenInfo 对象 → 一律取出地址 */
function toTokenAddress(value: unknown, field: string): Address {
  if (
    value !== null &&
    typeof value === 'object' &&
    // Solana PublicKey 交给 toAddress 去给专门的报错，不要在这里当成 { address } 对象处理
    typeof (value as { toBase58?: unknown }).toBase58 !== 'function' &&
    // 这里用 `!== undefined` 而不是 has()：`{ address: "" }` 是一个**畸形的 token 对象**，
    // 该报「token0.address 是空字符串」，而不是掉进下面那条分支去报「[object Object] 不是合法地址」
    (value as { address?: unknown }).address !== undefined
  ) {
    return toAddress((value as { address: string }).address, `${field}.address`)
  }
  return toAddress(value as string, field)
}

// ---------------------------------------------------------------------------
// 池子快照
// ---------------------------------------------------------------------------

/**
 * 任意来源的池子快照 → 核心 SDK 的 `IPoolStateRaw`。
 *
 * 归一化规则：
 * - `tradeFeeRate` ← `tradeFeeRate ?? fee ?? feeTier`（三个名字**同单位 ppm**，纯改名，安全互认）；
 * - 链上动态字段 ← `input.onchainState?.<k> ?? input.<k>`（后端接口嵌一层，扁平形状不嵌）；
 * - `token0` / `token1` 既认裸地址串也认 `{ address, decimals, symbol }` 对象；
 * - 所有大整数走 `toBigInt`（string / BN-like 都认）；
 * - Byreal 扩展字段（protocolFeeRate / pauseFlags / swapOpenTime / alpha、dex extra /
 *   dynamicFeeEnabled）**给了就收，没给按安全缺省**（0 / false）——它们不参与仓位数学与
 *   calldata，只有拿这份快照去做离线 swap 报价这类高级用法时才需要真值（此时请喂新版快照）；
 * - 数学必需字段缺失时抛，**错误里列出缺了哪几个**并附上三种形状说明。
 *
 * 这里刻意**不校验** `sqrtPriceX96` 与 `tick` 是否同块：核心 `toUniPool` 已经有更准确的那一份。
 */
export function toPoolStateRaw(input: PoolSnapshotish, field = 'poolState'): IPoolStateRaw {
  const src = asRecord(input, field, POOL_SHAPE_HINT)
  const onchain = (has(src.onchainState) ? src.onchainState : {}) as LooseRecord

  /** 后端接口把动态字段嵌在 onchainState 里，扁平形状直接放顶层，两处都找一遍 */
  const dyn = (key: string): unknown => firstOf(onchain[key], src[key])

  const raw = {
    poolAddress: firstOf(src.poolAddress, src.address, src.poolId, src.id),
    token0: firstOf(src.token0, onchain.token0),
    token1: firstOf(src.token1, onchain.token1),
    tradeFeeRate: firstOf(dyn('tradeFeeRate'), src.fee, src.feeTier),
    tickSpacing: dyn('tickSpacing'),
    sqrtPriceX96: dyn('sqrtPriceX96'),
    tick: dyn('tick'),
    liquidity: dyn('liquidity'),
    feeGrowthGlobal0X128: dyn('feeGrowthGlobal0X128'),
    feeGrowthGlobal1X128: dyn('feeGrowthGlobal1X128'),
  }

  const missing = Object.entries(raw)
    .filter(([, v]) => !has(v))
    .map(([k]) => (k === 'tradeFeeRate' ? 'tradeFeeRate（旧名 fee / feeTier 也认）' : k))
  if (missing.length > 0) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} ${field} 缺少必需字段：${missing.join('、')}。\n${POOL_SHAPE_HINT}\n` +
        `收到的对象的键：${Object.keys(src).join('、') || '(空对象)'}${
          Object.keys(onchain).length > 0 ? `；onchainState 的键：${Object.keys(onchain).join('、')}` : ''
        }。`,
    )
  }

  /** Byreal 扩展字段：给了就收（onchainState / 顶层都找），没给按安全缺省 */
  const optSmall = (key: string, fallback: number): number =>
    has(dyn(key)) ? toSmallInt(dyn(key), `${field}.${key}`) : fallback

  /**
   * 布尔字段的宽进解析。不能直接 `Boolean(v)`：后端序列化常把布尔写成字符串，
   * 而 `Boolean('false')` / `Boolean('0')` 都是 true —— 会把关着的动态费率误判成开启，
   * 让本应可用的离线报价路径错误地 fail-closed。字符串只认 'true'/'false'（含 '1'/'0'），
   * 其余写法抛错而不是猜。
   */
  const optBool = (key: string, fallback: boolean): boolean => {
    const v = dyn(key)
    if (!has(v)) return fallback
    if (typeof v === 'boolean') return v
    if (v === 'true' || v === '1' || v === 1) return true
    if (v === 'false' || v === '0' || v === 0) return false
    throw new Error(
      `${COMPAT_ERR_PREFIX} ${field}.${key} 无法解析为布尔值：收到 ${JSON.stringify(v)}。` +
        `只接受 boolean 或 'true'/'false'/'1'/'0'。`,
    )
  }

  return {
    poolAddress: toAddress(raw.poolAddress as string, `${field}.poolAddress`),
    token0: toTokenAddress(raw.token0, `${field}.token0`),
    token1: toTokenAddress(raw.token1, `${field}.token1`),
    tickSpacing: toSmallInt(raw.tickSpacing, `${field}.tickSpacing`),
    tradeFeeRate: toSmallInt(raw.tradeFeeRate, `${field}.tradeFeeRate`),
    protocolFeeRate: optSmall('protocolFeeRate', 0),
    pauseFlags: optSmall('pauseFlags', 0),
    swapOpenTime: optSmall('swapOpenTime', 0),
    alphaExtraTradeFeeRate: optSmall('alphaExtraTradeFeeRate', 0),
    dexExtraTradeFeeRate: optSmall('dexExtraTradeFeeRate', 0),
    dynamicFeeEnabled: optBool('dynamicFeeEnabled', false),
    sqrtPriceX96: toBigInt(raw.sqrtPriceX96 as Numericish, `${field}.sqrtPriceX96`),
    tick: toSmallInt(raw.tick, `${field}.tick`),
    liquidity: toBigInt(raw.liquidity as Numericish, `${field}.liquidity`),
    feeGrowthGlobal0X128: toBigInt(raw.feeGrowthGlobal0X128 as Numericish, `${field}.feeGrowthGlobal0X128`),
    feeGrowthGlobal1X128: toBigInt(raw.feeGrowthGlobal1X128 as Numericish, `${field}.feeGrowthGlobal1X128`),
  }
}

// ---------------------------------------------------------------------------
// 仓位快照
// ---------------------------------------------------------------------------

/**
 * 任意来源的仓位快照 → 核心 SDK 的 `IPositionStateRaw`。
 *
 * 字段分三类处理，分界线是「这个字段错了会不会亏钱」：
 *
 * 1. **数学必需**（`tokenId` / `tickLower` / `tickUpper` / `liquidity`）→ 缺就抛。
 *    它们决定 amounts、滑点下限和 calldata，猜一个值出来等于伪造仓位。
 * 2. **池子身份**（`token0` / `token1` / `tickSpacing`）→ 先取自身字段，再退到 `input.pool`
 *    （`PositionDetail` 自带）；都没有就抛。这三项是「这个仓位属于哪个池子」的唯一依据
 *    （定制合约的池身份键是 (token0, token1, tickSpacing)，核心 `chain.getPoolAddressByPosition`
 *    靠它们反查池子地址）。⚠️ 旧字段 `fee` / `feeTier` 与 tickSpacing 是不同量纲，**不能**
 *    互相推导，兼容层不做这个转换。后端接口的 `PositionSummary` 单独喂进来正好缺这三项，
 *    报错里直接给出合并写法。
 * 3. **纯记账字段**（`nonce` / `operator` / `feeGrowthInside*` / `tokensOwed*`）→ 缺省 0 / 零地址。
 *    核心 SDK 的本地数学与 calldata 编码**一个都不读**它们，仅作原样透传；
 *    强制要求反而会挡住「dry-run 虚拟仓位」这类合法用法（见 types.ts 对 pendingFees 的说明）。
 */
export function toPositionStateRaw(
  input: PositionSnapshotish,
  field = 'positionState',
): IPositionStateRaw {
  const src = asRecord(input, field, POSITION_SHAPE_HINT)
  const pool = (has(src.pool) ? asRecord(src.pool, `${field}.pool`, POOL_SHAPE_HINT) : {}) as LooseRecord

  // —— ① 数学必需字段 ——
  const required = {
    // nftMint 也认一手：旧代码里仓位标识就叫这个名字，真传了 base58 地址进来，
    // toBigInt 会抛出「EVM 请用 tokenId」的专门提示，比这里报「缺 tokenId」更有用
    tokenId: firstOf(src.tokenId, src.nftMint),
    tickLower: src.tickLower,
    tickUpper: src.tickUpper,
    liquidity: src.liquidity,
  }
  const missing = Object.entries(required)
    .filter(([, v]) => !has(v))
    .map(([k]) => k)
  if (missing.length > 0) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} ${field} 缺少必需字段：${missing.join('、')}。\n${POSITION_SHAPE_HINT}\n` +
        `收到的对象的键：${Object.keys(src).join('、') || '(空对象)'}。`,
    )
  }

  // —— ② 池子身份字段：自身 → pool 兜底 ——
  // ⚠️ tickSpacing 不认 fee / feeTier 兜底：两者量纲不同（ppm vs tick 步长），推导必错
  const token0 = firstOf(src.token0, pool.token0)
  const token1 = firstOf(src.token1, pool.token1)
  const tickSpacing = firstOf(src.tickSpacing, pool.tickSpacing)
  const missingPoolRef = [
    ['token0', token0],
    ['token1', token1],
    ['tickSpacing', tickSpacing],
  ]
    .filter(([, v]) => !has(v))
    .map(([k]) => k as string)
  if (missingPoolRef.length > 0) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} ${field} 缺少定位池子所需的字段：${missingPoolRef.join('、')}。\n` +
        `Byreal 定制合约的池身份键是 (token0, token1, tickSpacing)——旧字段 fee/feeTier 不能替代 tickSpacing。\n` +
        `后端接口的 PositionSummary 本身不带这几项（它只有 poolAddress）——` +
        `请改用带 pool 字段的 PositionDetail，或把池子快照并进来：\n` +
        `  toPositionStateRaw({ ...position, pool: poolMap[position.poolAddress] })\n` +
        `也可以直接补齐 token0 / token1 / tickSpacing 三个字段。`,
    )
  }

  // —— ③ 纯记账字段：缺省即可，核心 SDK 不读它们 ——
  const optionalBig = (key: string): bigint => (has(src[key]) ? toBigInt(src[key] as Numericish, `${field}.${key}`) : 0n)

  return {
    tokenId: toBigInt(required.tokenId as Numericish, `${field}.tokenId`),
    nonce: optionalBig('nonce'),
    operator: has(src.operator) ? toAddress(src.operator as string, `${field}.operator`) : ZERO_ADDRESS,
    token0: toTokenAddress(token0, `${field}.token0`),
    token1: toTokenAddress(token1, `${field}.token1`),
    tickSpacing: toSmallInt(tickSpacing, `${field}.tickSpacing`),
    tickLower: toSmallInt(required.tickLower, `${field}.tickLower`),
    tickUpper: toSmallInt(required.tickUpper, `${field}.tickUpper`),
    liquidity: toBigInt(required.liquidity as Numericish, `${field}.liquidity`),
    feeGrowthInside0LastX128: optionalBig('feeGrowthInside0LastX128'),
    feeGrowthInside1LastX128: optionalBig('feeGrowthInside1LastX128'),
    tokensOwed0: optionalBig('tokensOwed0'),
    tokensOwed1: optionalBig('tokensOwed1'),
  }
}

// ---------------------------------------------------------------------------
// 代币元数据
// ---------------------------------------------------------------------------

/**
 * 任意来源的代币元数据 → 核心 SDK 的 `ITokenInfo`。
 *
 * `chainId` 由调用方注入：后端接口的 `TokenInfo` 里没有这个字段，而
 * `@uniswap/sdk-core` 的 `Token` 实体必须要（同一池子的两个 token 链不一致会直接抛）。
 * 入参自己带了 `chainId` 就优先用它自己的 —— 更具体的信息优先。
 *
 * `symbol` 解不出来降级成 `'UNKNOWN'`（与核心 `chain.getTokenInfoList` 的降级口径一致）：
 * symbol 只影响错误文案与 UI 展示，不参与任何整数运算，为它抛错得不偿失。
 * 但 `decimals` 缺失一律抛 —— 精度错了金额换算全错。
 */
export function toTokenInfo(input: TokenInfoish, chainId: number, field = 'token'): ITokenInfo {
  const src = asRecord(input, field, 'ITokenInfo / 后端接口 TokenInfo / { address, decimals } 三种形状都认。')

  const missing: string[] = []
  if (!has(src.address)) missing.push('address')
  if (!has(src.decimals)) missing.push('decimals')
  if (missing.length > 0) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} ${field} 缺少必需字段：${missing.join('、')}。` +
        `代币元数据至少要有 address 与 decimals（decimals 缺失会让所有金额换算失真）。` +
        `收到的对象的键：${Object.keys(src).join('、') || '(空对象)'}。`,
    )
  }

  const decimals = toSmallInt(src.decimals, `${field}.decimals`)
  if (decimals < 0 || decimals > 255) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} ${field}.decimals 必须落在 [0, 255]（ERC20 的 decimals 是 uint8），收到 ${decimals}。`,
    )
  }

  const symbol = typeof src.symbol === 'string' && src.symbol !== '' ? src.symbol : 'UNKNOWN'
  const name = typeof src.name === 'string' && src.name !== '' ? src.name : undefined

  return {
    chainId: has(src.chainId) ? toSmallInt(src.chainId, `${field}.chainId`) : chainId,
    address: toAddress(src.address as string, `${field}.address`),
    decimals,
    symbol,
    ...(name === undefined ? {} : { name }),
  }
}
