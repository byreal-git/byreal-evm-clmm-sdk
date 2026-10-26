/**
 * compat 层的「快照注入版」写操作：`sdk.chain.offchain.*`，**0 次 RPC**。
 *
 * 这是 Solana 版 SDK 里 `chain/offchain/*` 的 EVM 对应物，适用于链上数据全部由
 * 后端接口下发的场景：SDK 只负责本地数学 + 拼 calldata，一次网络请求都不发。
 *
 * 与 {@link CompatCLMMClient}（读链版）的**唯一**差别是：
 * 所有链上状态都必须由调用方注入 —— `rawPoolInfo` / `rawPositionInfo` / token 元数据 /
 * `pendingFees`。方法名、别名、返回形状完全一致，页面从读链版切到这里只要多传快照。
 *
 * ## 0 RPC 是怎么保证的（这是本文件的全部技术含量，改动前务必读完）
 *
 * 核心 SDK 的写方法本来就留了「自带快照」的逃生口，但触发条件很挑剔，传错一个参数
 * 就会**偷偷**退回读链分支（见 `liquidity/clmm.ts` 的 `loadMintContext` / `loadModifyContext`）：
 *
 * | 核心方法           | 走 offline 分支的充要条件                                  |
 * |--------------------|-----------------------------------------------------------|
 * | `createPosition`   | `poolState` **且** `autoApprove === false`                 |
 * | `addLiquidity`     | `poolState` + `positionState` **且** `autoApprove === false` |
 * | `decreaseLiquidity`| `poolState` + `positionState`（allowOffline 恒 true）       |
 * | `closePosition`    | `poolState` + `positionState`（allowOffline 恒 true）       |
 * | `collectFees`      | `pendingFees`（否则去做 collect staticcall）                |
 *
 * 但**这还不够**：上面四个写方法在算完之后都会调 `chain.getTokenInfoList()` 取 decimals /
 * symbol，未命中进程内缓存时那是一次实打实的 multicall。冷启动的前端（刚打开页面就点开仓）
 * 必然未命中 —— 也就是说「只传 poolState」根本达不到 0 RPC。
 *
 * 因此本文件的做法是：用调用方给的 token 元数据现场造一个 {@link buildOfflineChain} 代理，
 * 把 `getTokenInfoList` 换成纯查表，再拿这个代理 `new CLMMClient()`。这样：
 * - token 元数据不再需要读链；
 * - 代理还会把 `publicClient` 换成一个**一碰就抛**的哨兵（见下），万一将来核心 SDK 在
 *   offline 分支里新增了什么读链动作，这里会立刻炸出可读错误，而不是悄悄多发一次 RPC。
 *
 * 之所以不去写核心 `Chain` 的 `tokenInfoCache`（那样也能免掉那次 multicall）：
 * 调用方给的元数据是**外部数据**，写进共享缓存会污染后续所有真·读链路径 ——
 * 后端把 decimals 下发错一次，整个 session 的金额换算就全错了。代理把这份数据的作用域
 * 限制在这一次调用内，是这里唯一安全的做法。
 *
 * ⚠️ 依赖边界：只依赖核心 `src/*` 与 viem。
 */
import { encodeFunctionData, type Address } from 'viem'

import { NPM_ABI } from '../abis.js'
import { getPositionView } from '../calculate.js'
import type { Chain } from '../chain/index.js'
import type { EvmClmmSdk } from '../client.js'
import { CLMMClient } from '../liquidity/clmm.js'
import type { IPendingFees, IPoolStateRaw, IPositionStateRaw, ITokenInfo, IUnsignedTx } from '../types.js'

import {
  COMPAT_ERR_PREFIX,
  resolveDeadlineSec,
  resolveSlippageBps,
  toAddress,
  toBaseSide,
  toBigInt,
  toSmallInt,
  toUiAmount,
  type BaseSideish,
  type Numericish,
} from './coerce.js'
import {
  assertOtherAmountMax,
  firstPresent,
  isPresent,
  orderPendingFeesWithFlag,
  orderTokenPairWithFlag,
  pickActorAddress,
  pickFollowTokenId,
  pickTokenIdRef,
  resolvePercentAlias,
  sumFeesByToken,
  toBlankableBigInt,
  toCompatDecreaseMeta,
  toCompatLiquidityMeta,
  toCompatPendingFeesMeta,
  toPendingFees,
  type IPendingFeesish,
} from './internal.js'
import {
  toCompatCreatePositionReturn,
  toCompatTransactionReturn,
  type ICompatAddLiquidityReturn,
  type ICompatCollectFeesReturn,
  type ICompatCreatePositionMeta,
  type ICompatCreatePositionReturn,
  type ICompatDecreaseReturn,
  type ICompatPositionInfo,
  type ICompatPositionSide,
  type ICompatTransactionReturn,
} from './models.js'
import {
  toPoolStateRaw,
  toPositionStateRaw,
  toTokenInfo,
  type PoolSnapshotish,
  type PositionSnapshotish,
  type TokenInfoish,
} from './state.js'

// ---------------------------------------------------------------------------
// 对外类型：入参
//
// 命名全部带 `ICompatOffchain` 前缀，避免与 liquidity.ts（读链版，另一个作者）
// 的同类入参类型在 barrel 里撞名。
// ---------------------------------------------------------------------------

/**
 * 待领手续费的宽松形状（`amountA` / `amountB` 这两个 Solana 旧名也认）。
 *
 * 定义在 `./internal`（读链版 `CompatCLMMClient` 用的是同一份），在这里再导出一次
 * 只是为了让 barrel 与旧代码的 `import { IPendingFeesish } from '.../compat'` 保持不变 ——
 * 同一个形状不该因为「实现挪了个文件」就换名字。
 */
export type { IPendingFeesish }

/**
 * 所有 offchain 写方法的公共入参。
 *
 * 同一个语义给多个字段名，是因为迁移期的调用点来自三处：Solana 版旧代码（`rawPoolInfo` /
 * `mintA` / `slippage`）、核心 EVM SDK（`poolState` / `token0` / `slippageBps`）、
 * 以及后端 JSON 直接铺开。宽进的成本只是几行 `??`，收益是页面一行都不用改。
 */
export interface ICompatOffchainCommonParams {
  /** 钱包地址；也认 `walletAddress` */
  userAddress?: string
  walletAddress?: string
  /** 池子快照（旧名）。三种形状都认，见 {@link toPoolStateRaw} */
  rawPoolInfo?: PoolSnapshotish
  /** 池子快照（核心 SDK 的字段名），与 `rawPoolInfo` 等价 */
  poolState?: PoolSnapshotish
  /**
   * 池子地址。旧 SDK 的 `IPoolLayout` 里不含池子自身地址（Solana 是账户 key 在外面），
   * 所以允许与快照分开传；快照里已经有且两者不一致时会抛。
   */
  poolAddress?: string
  /** 池子地址的旧名（Solana 版叫 poolId） */
  poolId?: string
  /** token0 元数据（要带 decimals）。快照里的 token0 已经是对象时可以不传 */
  token0?: TokenInfoish
  token1?: TokenInfoish
  /** token0 / token1 的 Solana 旧名（EVM 上 A 恒等于 token0，按地址升序） */
  mintA?: TokenInfoish
  mintB?: TokenInfoish
  /** 旧口径滑点，小数（0.02 = 2%）。与 `slippageBps` 二选一 */
  slippage?: number
  /** 新口径滑点，基点（200 = 2%）。与 `slippage` 二选一 */
  slippageBps?: number
  /** deadline：从现在起多少秒。与 `deadline` 二选一，都不传时用核心 SDK 的 1200 秒 */
  deadlineSec?: number
  /** deadline：绝对 unix **秒**时间戳。与 `deadlineSec` 二选一 */
  deadline?: number
  /** 资产 / NFT 接收者，默认 userAddress */
  recipient?: string
}

/** 带仓位快照的公共入参（加仓 / 减仓 / 关仓 / 领费共用） */
export interface ICompatOffchainPositionParams extends ICompatOffchainCommonParams {
  /** 仓位快照（旧名）。三种形状都认，见 {@link toPositionStateRaw} */
  rawPositionInfo?: PositionSnapshotish
  /** 仓位快照（核心 SDK 的字段名），与 `rawPositionInfo` 等价 */
  positionState?: PositionSnapshotish
  /** 仓位标识。不传时从仓位快照里取；两处都有且不一致时抛 */
  tokenId?: Numericish
  /** tokenId 的 Solana 旧名。传 base58 地址会抛出「EVM 请用 tokenId」的专门提示 */
  nftMint?: Numericish
}

/** `createPositionInstructions` 入参 */
export interface ICompatOffchainCreatePositionParams extends ICompatOffchainCommonParams {
  /**
   * 区间下界（会被核心按 tickSpacing 向下对齐）。
   * 用 `Numericish` 而不是 `number | string`，是为了与读链版 `CompatCLMMClient` 完全一致 ——
   * 前端把一段代码从 `chain.*` 换成 `chain.offchain.*` 时，BN 类型的 tick 不该突然编译不过。
   */
  tickLower: Numericish
  /** 区间上界（会被核心按 tickSpacing 向上对齐）。类型口径同 {@link tickLower} */
  tickUpper: Numericish
  /** 以哪一边为输入基准，旧枚举 `MintA`/`MintB` 也认 */
  base: BaseSideish
  /** 基准边的投入数量（最小单位整数） */
  baseAmount: Numericish
  /**
   * 另一边的**上限**（旧签名里的字段）。EVM 侧由 SDK 自己算另一边，这里当**断言**用：
   * 算出来超过上限就抛，而不是静默忽略调用方「别超过这个数」的意图。
   */
  otherAmountMax?: Numericish
  /**
   * Byreal 定制合约独有：跟随建仓的目标仓位 tokenId，默认 0 = 不跟随。
   * ⚠️ 非 0 时合约做五项强制校验（目标存在、有流动性、同池、tick 区间完全一致、不是自己）。
   */
  followTokenId?: Numericish
  /**
   * followTokenId 的 Solana 旧名（Copy Position 的母仓位），值必须是母仓位的 tokenId。
   * ⚠️ Solana 版只是 memo、区间随意；这里会变成链上校验，tick 区间须直接取母仓位的。
   */
  refererPosition?: Numericish
}

/** `addLiquidityInstructions` 入参 */
export interface ICompatOffchainAddLiquidityParams extends ICompatOffchainPositionParams {
  base: BaseSideish
  baseAmount: Numericish
  /** 同 {@link ICompatOffchainCreatePositionParams.otherAmountMax}，当断言用 */
  otherAmountMax?: Numericish
}

/** `decreaseLiquidityInstructions` 入参：`liquidity` 与 `percent` 二选一（核心已有互斥校验） */
export interface ICompatOffchainDecreaseLiquidityParams extends ICompatOffchainPositionParams {
  /** 要移除的流动性绝对量（旧签名的口径）。空串视作「没传」，回退到 percent */
  liquidity?: Numericish
  /** 按百分比减仓（0~100）。也认字符串（表单原样透传），与读链版同口径 */
  percent?: number | string
  /** `percent` 的旧别名 */
  decreasePercentage?: number | string
  /** `percent` 的旧别名 */
  percentage?: number | string
  /**
   * 是否在同一笔 multicall 里追加 collect，默认 true。
   * 关掉的话撤出的本金只会记进 tokensOwed，不会打回钱包。
   */
  collect?: boolean
}

/** `decreaseFullLiquidityInstructions` 入参 */
export interface ICompatOffchainDecreaseFullParams extends ICompatOffchainPositionParams {
  /**
   * 撤完流动性后是否顺便销毁仓位 NFT，默认 **true**（与旧 SDK 一致）。
   * false 时退化成 `decreaseLiquidity({ percent: 100 })`，NFT 留着可以再加仓。
   */
  closePosition?: boolean
  /**
   * 仅在 `closePosition: false` 时有意义；关仓必然包含 collect（否则 burn 会 revert），
   * 此时传 `false` 会抛 —— 与读链版 `CompatCLMMClient` 同口径。
   */
  collect?: boolean
}

/** `closePositionInstructions` 入参 */
export type ICompatOffchainClosePositionParams = ICompatOffchainPositionParams

/** `collectFeesInstructions` 入参 */
export interface ICompatOffchainCollectFeesParams extends ICompatOffchainPositionParams {
  /**
   * **必需**：外部已知的精确可领额。
   * 不传的话核心 SDK 会去做一次 collect staticcall，那就不是 0 RPC 了。
   */
  pendingFees?: IPendingFeesish
  /** 可领额上限，默认 uint128.max（能领多少领多少） */
  amount0Max?: Numericish
  amount1Max?: Numericish
}

/** `collectAllPositionFeesInstructions` 里单个仓位的入参 */
export interface ICompatOffchainCollectAllItem {
  rawPositionInfo?: PositionSnapshotish
  positionState?: PositionSnapshotish
  tokenId?: Numericish
  nftMint?: Numericish
  /** 该仓位所属池子的快照（用来取 token0/token1 地址；已显式给 token 元数据时可省） */
  rawPoolInfo?: PoolSnapshotish
  poolState?: PoolSnapshotish
  token0?: TokenInfoish
  token1?: TokenInfoish
  mintA?: TokenInfoish
  mintB?: TokenInfoish
  /** **必需**：该仓位的精确可领额 */
  pendingFees?: IPendingFeesish
  amount0Max?: Numericish
  amount1Max?: Numericish
}

/** `collectAllPositionFeesInstructions` 入参 */
export interface ICompatOffchainCollectAllFeesParams {
  userAddress?: string
  walletAddress?: string
  recipient?: string
  /** 逐个仓位的快照与可领额（旧 SDK 里也叫这个名字） */
  positionDataList?: ICompatOffchainCollectAllItem[]
  /** `positionDataList` 的别名 */
  positions?: ICompatOffchainCollectAllItem[]
}

/** `getPositionInfoByNftMint` 入参（0 RPC 的仓位详情） */
export interface ICompatOffchainPositionInfoParams extends ICompatOffchainPositionParams {
  /**
   * 可选：后端下发的待领手续费。
   * 不传时 `feeAmount` / `uiFeeAmount` 为 `null` —— **不编 0**，
   * 因为「0」会让 UI 显示「无手续费可领」，那是会让用户损失钱的假数据。
   */
  pendingFees?: IPendingFeesish
}

// ---------------------------------------------------------------------------
// 对外类型：返回
// ---------------------------------------------------------------------------

/** 批量领费里单个仓位的明细（供 UI 展开「这一笔到底领了哪些仓位的多少钱」） */
export interface ICompatOffchainPositionFeeDetail {
  tokenId: bigint
  token0: ITokenInfo
  token1: ITokenInfo
  amount0: bigint
  amount1: bigint
  uiAmount0: string
  uiAmount1: string
}

/**
 * 批量领费的 meta。
 *
 * `totals` 按**代币地址**聚合而不是简单相加 `amount0`/`amount1`：
 * 多个仓位可能来自不同池子，A 池的 token0 与 B 池的 token0 根本不是同一种代币，
 * 相加出来的数字毫无意义（还会误导用户以为能领这么多）。
 */
export interface ICompatOffchainCollectAllFeesMeta {
  perPosition: ICompatOffchainPositionFeeDetail[]
  totals: Array<{ token: ITokenInfo; amount: bigint; uiAmount: string }>
}

/** 批量领费的返回 */
export type ICompatOffchainCollectAllFeesReturn =
  ICompatTransactionReturn<ICompatOffchainCollectAllFeesMeta>

// ---------------------------------------------------------------------------
// 内部：错误文案
// ---------------------------------------------------------------------------

/**
 * 「缺快照」的统一报错。
 *
 * 这类错误必须同时回答三个问题，否则调用方只能靠猜：**缺什么**、**为什么非要不可**、
 * **拿不到时的替代路径**。最后一条尤其重要 —— offchain 拿不到快照并不是死路，
 * 换成读链版就能跑，只是多几次 RPC。
 */
function missingSnapshotError(method: string, what: string, why: string): Error {
  return new Error(
    `${COMPAT_ERR_PREFIX} offchain.${method} 缺少必需的快照：${what}。\n` +
      `${why}\n` +
      'offchain 模式的全部意义就是「0 次 RPC」——所有链上数据都必须由调用方注入（通常来自后端接口）。\n' +
      `拿不到快照时请改用会读链的 sdk.chain.${method}(...)，它会自己去读 fresh 状态（多 1~3 次 RPC）。`,
  )
}

/** 同一个语义传了两个互相矛盾的值时的统一报错（兼容层从不猜哪个优先） */
function conflictError(method: string, what: string, a: string, b: string): Error {
  return new Error(
    `${COMPAT_ERR_PREFIX} offchain.${method} 的 ${what} 前后不一致：${a} ≠ ${b}。\n` +
      '兼容层不猜哪个是对的（猜错就是对着错误的仓位/池子发交易），请只保留一处。',
  )
}

// ---------------------------------------------------------------------------
// 内部：宽进小工具
//
// 与 liquidity.ts（读链版）共用的那些（字段别名取值 / `toSmallInt` / meta 组装 /
// `otherAmountMax` 断言 / 按币种汇总）都在 `./internal` 与 `./coerce`，
// 这里只留本文件独有的两个。
// ---------------------------------------------------------------------------

/** 一个值看起来像不像「带 decimals 的代币元数据」（裸地址串 / 只有 address 的对象都不算） */
function looksLikeTokenInfo(value: unknown): value is TokenInfoish {
  if (value === null || typeof value !== 'object') return false
  const v = value as { address?: unknown; decimals?: unknown }
  return v.address !== undefined && v.decimals !== undefined && v.decimals !== null
}

/** 把快照对象当松散键值表读（三种形状字段集合不同，逐一 narrow 只会写成一坨断言） */
type LooseRecord = Record<string, unknown>

/** 只在入参确实是对象时才当记录读，否则返回空表（缺字段的报错由上层统一给） */
function asLooseRecord(value: unknown): LooseRecord {
  return value !== null && typeof value === 'object' ? (value as LooseRecord) : {}
}

// ---------------------------------------------------------------------------
// 内部：0 RPC 的核心机关 —— 离线 Chain 代理
// ---------------------------------------------------------------------------

/**
 * 任何 RPC 尝试都会撞上的哨兵。
 *
 * 光靠「入口检查快照齐备」只能保证**今天**的核心 SDK 不读链；核心将来在 offline 分支里
 * 顺手加一次读取，静默多一次 RPC 是很难被发现的（功能全对，只是慢了、贵了）。
 * 把 `publicClient` 换成这个哨兵，等于给 offline 路径装了个跳闸开关：
 * 一旦真发生 RPC，当场抛出指名道姓的错误，而不是悄悄退化。
 */
function poisonedPublicClient(method: string): object {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `${COMPAT_ERR_PREFIX} offchain.${method} 试图发起 RPC（publicClient.${String(prop)}），` +
            'offchain 模式承诺 0 次 RPC，这说明快照不齐或核心 SDK 的 offline 分支发生了变化。\n' +
            '请检查是否漏传了 rawPoolInfo / rawPositionInfo / token 元数据 / pendingFees；' +
            '确实需要读链请改用 sdk.chain.* 的读链版方法。',
        )
      },
    },
  )
}

/**
 * 造一个「只查表、不读链」的 `Chain` 代理，供 offline 路径的 `CLMMClient` 使用。
 *
 * 只改两件事，其余全部透传给真的 `Chain` 实例：
 * 1. `getTokenInfoList` → 从调用方给的 token 表里查（核心写方法**每次**都会调它拿 decimals，
 *    未命中进程缓存时那是一次真 multicall，这是「只传 poolState 仍然会发 RPC」的元凶）；
 * 2. `publicClient` → 换成 {@link poisonedPublicClient} 哨兵。
 *
 * 方法一律 `bind(receiver)`（绑到代理本身而不是真实例），这样核心方法体里的
 * `this.publicClient` 也会走到哨兵上 —— 哨兵才真正拦得住东西。绑到真实例的话，
 * 内部调用会绕过代理，哨兵形同虚设。
 *
 * 这里用 Proxy 而不是「把 token 写进 Chain 的私有缓存」：调用方给的元数据是外部数据，
 * 写进共享缓存会污染后续所有真·读链路径（后端下发错一次 decimals，整个 session 全错）。
 * 代理把这份数据的作用域限制在这一次调用内。
 */
function buildOfflineChain(chain: Chain, tokens: ITokenInfo[], method: string): Chain {
  const table = new Map(tokens.map((t) => [t.address.toLowerCase(), t]))

  const getTokenInfoList = async (addresses: Address[]): Promise<ITokenInfo[]> =>
    addresses.map((address) => {
      const hit = table.get(address.toLowerCase())
      if (!hit) {
        throw missingSnapshotError(
          method,
          `代币 ${address} 的元数据（decimals / symbol）`,
          '核心 SDK 要用 decimals 做金额换算，未注入就只能去链上读，那就破坏了 0 RPC 的承诺。' +
            '请把该代币的 { address, decimals, symbol } 通过 token0 / token1（或 mintA / mintB）传进来，' +
            '或者传一份 token0/token1 是对象形状的池子快照（后端接口的 PoolDetail 就是）。',
        )
      }
      return hit
    })

  const proxy: Chain = new Proxy(chain, {
    get(target, prop, _receiver) {
      if (prop === 'getTokenInfoList') return getTokenInfoList
      if (prop === 'publicClient') return poisonedPublicClient(method)
      const value = Reflect.get(target, prop, target)
      // 绑到 proxy（而不是 target）：让核心方法体内部的 this.publicClient 也落在哨兵上
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(proxy) : value
    },
  })
  return proxy
}

// ---------------------------------------------------------------------------
// CompatOffchain
// ---------------------------------------------------------------------------

/**
 * 快照注入版的写操作客户端（0 RPC）。
 *
 * ```ts
 * const offchain = new CompatOffchain({ sdk })
 * const { instructions, main } = await offchain.createPositionInstructions({
 *   userAddress,
 *   rawPoolInfo: poolDetailFromApi,   // 后端接口的 PoolDetail 直接喂
 *   tickLower, tickUpper,
 *   base: 'MintA', baseAmount: '1000000',
 * })
 * ```
 *
 * 每个动作提供**两个方法名**：Solana 旧名（`*Instructions`）与短名，实现共用，签名一致。
 * 旧代码把 `chain.xxxInstructions` 换成 `chain.offchain.xxxInstructions` + 多传快照即可。
 */
export class CompatOffchain {
  /** 逃生口：随时能拿回原生核心 SDK（compat 只是包一层，不藏东西） */
  readonly sdk: EvmClmmSdk

  constructor(params: { sdk: EvmClmmSdk }) {
    if (!params?.sdk) {
      throw new Error(`${COMPAT_ERR_PREFIX} new CompatOffchain({ sdk }) 缺少 sdk：请传入 EvmClmmSdk 实例。`)
    }
    this.sdk = params.sdk
  }

  // =========================================================================
  // 开仓
  // =========================================================================

  /**
   * 开仓（mint 一个新仓位 NFT），**0 RPC**。
   *
   * 对应旧 `chain.offchain.createPositionInstructions`。差异：
   * - 旧版返回的 `nftAddress` 在 EVM 上恒为 `null`（tokenId 由合约在上链时自增分配），
   *   交易确认后用 `parseTokenIdFromReceipt(receipt)` 取；
   * - 旧版的 `otherAmountMax` 不再是入参而是**断言**：EVM 侧另一边由 SDK 自己算，
   *   算出来超过上限就抛，不静默忽略。
   */
  async createPositionInstructions(
    params: ICompatOffchainCreatePositionParams,
  ): Promise<ICompatCreatePositionReturn> {
    const method = 'createPositionInstructions'
    const ctx = this.preparePool(params, method)
    const base = toBaseSide(params.base)

    const core = await ctx.client.createPosition({
      poolAddress: ctx.poolState.poolAddress,
      userAddress: ctx.userAddress,
      tickLower: toSmallInt(params.tickLower, 'tickLower'),
      tickUpper: toSmallInt(params.tickUpper, 'tickUpper'),
      base,
      baseAmount: toBigInt(params.baseAmount, 'baseAmount'),
      recipient: ctx.recipient,
      followTokenId: pickFollowTokenId(params),
      slippageBps: ctx.slippageBps,
      deadlineSec: ctx.deadlineSec,
      // ↓ 这两个共同构成核心 loadMintContext 的 offline 分支的充要条件
      poolState: ctx.poolState,
      autoApprove: false,
    })

    assertOtherAmountMax({
      where: `offchain.${method}`,
      base,
      otherAmountMax: toBlankableBigInt(params.otherAmountMax, 'otherAmountMax'),
      amount0: core.meta.amount0Desired,
      amount1: core.meta.amount1Desired,
      token0: ctx.token0,
      token1: ctx.token1,
    })

    const meta: ICompatCreatePositionMeta = {
      ...toCompatLiquidityMeta(core.meta, ctx.token0, ctx.token1, ctx.slippageBps),
      poolAddress: core.meta.poolAddress,
    }
    return toCompatCreatePositionReturn(core, meta)
  }

  /** {@link createPositionInstructions} 的短名，实现完全相同 */
  async createPosition(
    params: ICompatOffchainCreatePositionParams,
  ): Promise<ICompatCreatePositionReturn> {
    return this.createPositionInstructions(params)
  }

  // =========================================================================
  // 加仓
  // =========================================================================

  /**
   * 往已有仓位追加流动性，**0 RPC**。
   *
   * ⚠️ 区间不可改 —— `tickLower` / `tickUpper` 一律以传入的仓位快照为准（Uniswap V3 的 NFT 语义）。
   * 想换区间只能「关仓 + 重新开仓」。
   *
   * ⚠️ 这里恒定 `autoApprove: false`：offchain 模式读不到 allowance，SDK 不可能知道要不要插
   * approve。**授权由调用方自理**（调用方钱包层先 approve），否则 mint 会 revert。
   */
  async addLiquidityInstructions(
    params: ICompatOffchainAddLiquidityParams,
  ): Promise<ICompatAddLiquidityReturn> {
    const method = 'addLiquidityInstructions'
    const ctx = this.preparePosition(params, method)
    const base = toBaseSide(params.base)

    const core = await ctx.client.addLiquidity({
      tokenId: ctx.positionState.tokenId,
      userAddress: ctx.userAddress,
      base,
      baseAmount: toBigInt(params.baseAmount, 'baseAmount'),
      slippageBps: ctx.slippageBps,
      deadlineSec: ctx.deadlineSec,
      poolState: ctx.poolState,
      positionState: ctx.positionState,
      // 核心 loadModifyContext 的 allowOffline 对加仓来说 = (autoApprove === false)
      autoApprove: false,
    })

    assertOtherAmountMax({
      where: `offchain.${method}`,
      base,
      otherAmountMax: toBlankableBigInt(params.otherAmountMax, 'otherAmountMax'),
      amount0: core.meta.amount0Desired,
      amount1: core.meta.amount1Desired,
      token0: ctx.token0,
      token1: ctx.token1,
    })

    return toCompatTransactionReturn(
      core,
      toCompatLiquidityMeta(core.meta, ctx.token0, ctx.token1, ctx.slippageBps),
    )
  }

  /** {@link addLiquidityInstructions} 的短名 */
  async addLiquidity(params: ICompatOffchainAddLiquidityParams): Promise<ICompatAddLiquidityReturn> {
    return this.addLiquidityInstructions(params)
  }

  // =========================================================================
  // 减仓
  // =========================================================================

  /**
   * 减仓，**0 RPC**。`liquidity`（绝对量，旧签名口径）与 `percent`（百分比）二选一。
   *
   * 默认把 `decreaseLiquidity + collect` 打成**一笔** multicall —— Uniswap 的
   * `decreaseLiquidity` 只把本金记进 tokensOwed，不跟 collect 钱不会回钱包。
   * 只有显式传 `collect: false` 才退化成裸 decrease。
   */
  async decreaseLiquidityInstructions(
    params: ICompatOffchainDecreaseLiquidityParams,
  ): Promise<ICompatDecreaseReturn> {
    const method = 'decreaseLiquidityInstructions'
    const ctx = this.preparePosition(params, method)

    const core = await ctx.client.decreaseLiquidity({
      tokenId: ctx.positionState.tokenId,
      userAddress: ctx.userAddress,
      // percent 的三个别名走共享的 resolvePercentAlias（与读链版同一份：取值冲突时抛，
      // 而不是静默挑一个 —— 「点了减 25% 实际减了 50%」是纯粹的资金事故）；
      // percent 与 liquidity 的互斥校验仍留给核心，重复一份只会让报错变差
      percent: resolvePercentAlias(params),
      liquidity: toBlankableBigInt(params.liquidity, 'liquidity'),
      collect: params.collect,
      recipient: ctx.recipient,
      slippageBps: ctx.slippageBps,
      deadlineSec: ctx.deadlineSec,
      poolState: ctx.poolState,
      positionState: ctx.positionState,
    })

    return toCompatTransactionReturn(
      core,
      toCompatDecreaseMeta(core.meta, ctx.token0, ctx.token1, ctx.slippageBps),
    )
  }

  /** {@link decreaseLiquidityInstructions} 的短名 */
  async decreaseLiquidity(
    params: ICompatOffchainDecreaseLiquidityParams,
  ): Promise<ICompatDecreaseReturn> {
    return this.decreaseLiquidityInstructions(params)
  }

  // =========================================================================
  // 撤全部 / 关仓
  // =========================================================================

  /**
   * 撤出**全部**流动性，**0 RPC**。`closePosition` 默认 `true`（与旧 SDK 一致）：
   * - `true`  → `decreaseLiquidity(全部) + collect + burn`，一笔原子 multicall，NFT 一并销毁；
   * - `false` → 只 `decreaseLiquidity({ percent: 100 }) + collect`，NFT 留着可以再加仓。
   *
   * 为什么 true 时必须打成一笔：`burn` 要求 liquidity == 0 **且** tokensOwed 已清空，
   * 分三笔发会留下「撤了没领 / 领了没销毁」的中间态，用户中断就是一个脏仓位。
   */
  async decreaseFullLiquidityInstructions(
    params: ICompatOffchainDecreaseFullParams,
  ): Promise<ICompatDecreaseReturn> {
    const method = 'decreaseFullLiquidityInstructions'
    const ctx = this.preparePosition(params, method)
    const shouldClose = params.closePosition !== false

    // 与读链版保持同一口径：关仓时 collect 不可关闭（burn 要求 tokensOwed 为 0，
    // 不 collect 的关仓一定 revert）。曾经这里静默忽略、读链版抛错 ——
    // 同一份入参在两条路径上行为不同，正是 internal.ts 开头声明要防的那类分叉。
    if (shouldClose && params.collect === false) {
      throw new Error(
        `${COMPAT_ERR_PREFIX} offchain.${method} 传了 collect: false，但同时要销毁仓位 NFT` +
          '（closePosition 默认 true）—— 合约要求 burn 前 tokensOwed 必须为 0，不 collect 的关仓一定 revert。\n' +
          '请二选一：想保留 NFT 就传 closePosition: false；想关仓就去掉 collect: false。',
      )
    }

    const core = shouldClose
      ? await ctx.client.closePosition({
          tokenId: ctx.positionState.tokenId,
          userAddress: ctx.userAddress,
          recipient: ctx.recipient,
          slippageBps: ctx.slippageBps,
          deadlineSec: ctx.deadlineSec,
          poolState: ctx.poolState,
          positionState: ctx.positionState,
        })
      : await ctx.client.decreaseLiquidity({
          tokenId: ctx.positionState.tokenId,
          userAddress: ctx.userAddress,
          percent: 100,
          recipient: ctx.recipient,
          slippageBps: ctx.slippageBps,
          deadlineSec: ctx.deadlineSec,
          poolState: ctx.poolState,
          positionState: ctx.positionState,
        })

    return toCompatTransactionReturn(
      core,
      toCompatDecreaseMeta(core.meta, ctx.token0, ctx.token1, ctx.slippageBps),
    )
  }

  /** {@link decreaseFullLiquidityInstructions} 的短名 */
  async decreaseFullLiquidity(
    params: ICompatOffchainDecreaseFullParams,
  ): Promise<ICompatDecreaseReturn> {
    return this.decreaseFullLiquidityInstructions(params)
  }

  /** {@link decreaseFullLiquidityInstructions} 的另一个旧别名 */
  async removeFullLiquidity(
    params: ICompatOffchainDecreaseFullParams,
  ): Promise<ICompatDecreaseReturn> {
    return this.decreaseFullLiquidityInstructions(params)
  }

  /**
   * 关仓：撤全部 + 领取 + 销毁 NFT，一笔原子 multicall，**0 RPC**。
   * 等价于 `decreaseFullLiquidityInstructions({ ...params, closePosition: true })`。
   */
  async closePositionInstructions(
    params: ICompatOffchainClosePositionParams,
  ): Promise<ICompatDecreaseReturn> {
    return this.decreaseFullLiquidityInstructions({ ...params, closePosition: true })
  }

  /** {@link closePositionInstructions} 的短名 */
  async closePosition(params: ICompatOffchainClosePositionParams): Promise<ICompatDecreaseReturn> {
    return this.closePositionInstructions(params)
  }

  // =========================================================================
  // 领取手续费
  // =========================================================================

  /**
   * 提取手续费（以及之前 decrease 撤出、还没领走的本金），**0 RPC**。
   *
   * ⚠️ 必须传 `pendingFees`：核心 SDK 拿不到它就会去做一次 collect staticcall
   * （见 `clmm.ts` 的 collectFees），那就不是 0 RPC 了。
   * 注意这次 staticcall 只影响 meta 里的展示数字，**不影响 calldata** ——
   * collect 的入参只有 tokenId / recipient / max，与可领额无关。所以由后端下发
   * pendingFees 是完全安全的：即使数字略有出入，链上也是「能领多少领多少」。
   */
  async collectFeesInstructions(
    params: ICompatOffchainCollectFeesParams,
  ): Promise<ICompatCollectFeesReturn> {
    const method = 'collectFeesInstructions'
    const ctx = this.prepare(params, method, {
      requirePool: false,
      requirePosition: false,
      withSlippage: false,
    })
    const { tokenId, pendingFees } = this.prepareCollect(params, method)
    // 元数据被按地址升序重排过时，配套的金额必须跟着换 —— 否则
    // 「amount0 配 token0」这条调用方唯一能依赖的口径就断了
    const paired = orderPendingFeesWithFlag(pendingFees, ctx.tokensSwapped)

    const core = await ctx.client.collectFees({
      tokenId,
      userAddress: ctx.userAddress,
      recipient: ctx.recipient,
      amount0Max: toBlankableBigInt(params.amount0Max, 'amount0Max'),
      amount1Max: toBlankableBigInt(params.amount1Max, 'amount1Max'),
      pendingFees: paired,
    })

    return toCompatTransactionReturn(core, toCompatPendingFeesMeta(core.meta, ctx.token0, ctx.token1))
  }

  /** {@link collectFeesInstructions} 的短名 */
  async collectFees(params: ICompatOffchainCollectFeesParams): Promise<ICompatCollectFeesReturn> {
    return this.collectFeesInstructions(params)
  }

  /**
   * 批量领取多个仓位的手续费，**0 RPC**，打成**一笔** `NPM.multicall`。
   *
   * 与旧 Solana 版的差别：那边受单笔交易大小限制，只能返回 `instructionsList`（多笔，
   * 用户要签 N 次）；EVM 上 NPM 自带 `multicall`（delegatecall self，子调用里 msg.sender
   * 仍是用户本人），所以**一次签名就能领完所有仓位**。
   *
   * 每个 collect 子调用的 calldata 仍然由核心 SDK 的 `collectFees` 产出（不在 compat 里手写
   * collect 编码），compat 只负责最外层的 multicall 包装。
   */
  async collectAllPositionFeesInstructions(
    params: ICompatOffchainCollectAllFeesParams,
  ): Promise<ICompatOffchainCollectAllFeesReturn> {
    const method = 'collectAllPositionFeesInstructions'
    const userAddress = this.resolveUserAddress(params, method)
    // 提前校验一次（真正下发的是下面每个 collect 的 params.recipient）：
    // 一批仓位里第 7 个才因为地址不合法而失败，不如在进循环前就炸
    if (isPresent(params.recipient)) toAddress(params.recipient as string, 'recipient')

    const list = firstPresent(params.positionDataList, params.positions) ?? []
    if (list.length === 0) {
      throw new Error(
        `${COMPAT_ERR_PREFIX} offchain.${method} 的 positionDataList 是空的：没有仓位可领，` +
          '请先过滤出「确有待领手续费」的仓位再调用（空 multicall 只会白烧 gas）。',
      )
    }

    const perPosition: ICompatOffchainPositionFeeDetail[] = []
    const singles: IUnsignedTx[] = []

    for (let i = 0; i < list.length; i++) {
      const item = list[i]
      // 每个仓位单独走一遍 collectFees：既复用了核心的 calldata 编码（compat 不手写 collect 的 ABI 编码），
      // 也顺手拿到了每个仓位的 meta 明细。失败时把「第几个」补进错误里，否则一堆仓位里没法定位。
      const one = await this.collectFeesInstructions({
        ...item,
        userAddress,
        recipient: params.recipient,
      }).catch((e: Error) => {
        throw new Error(
          `${COMPAT_ERR_PREFIX} offchain.${method} 处理第 ${i + 1}/${list.length} 个仓位时失败：\n${e.message}`,
        )
      })

      singles.push(one.main)
      perPosition.push({
        tokenId: this.resolveTokenId(item, method),
        token0: one.meta.token0,
        token1: one.meta.token1,
        amount0: one.meta.amount0,
        amount1: one.meta.amount1,
        uiAmount0: one.meta.uiAmount0,
        uiAmount1: one.meta.uiAmount1,
      })
    }

    // 只有一个仓位时直接用它本身：多包一层 multicall 纯属白花 gas（与核心 packCalls 同口径）
    const main: IUnsignedTx =
      singles.length === 1
        ? singles[0]
        : {
            to: this.sdk.contracts.positionManager,
            data: encodeFunctionData({
              abi: NPM_ABI,
              functionName: 'multicall',
              args: [singles.map((tx) => tx.data)],
            }),
            value: 0n,
            chainId: this.sdk.chainId,
            label: `批量领取 ${singles.length} 个仓位的手续费（一笔 multicall，只需签名一次）`,
          }

    return toCompatTransactionReturn({ transactions: [main], main }, {
      perPosition,
      totals: sumFeesByToken(perPosition),
    })
  }

  /** {@link collectAllPositionFeesInstructions} 的短名 */
  async collectAllFees(
    params: ICompatOffchainCollectAllFeesParams,
  ): Promise<ICompatOffchainCollectAllFeesReturn> {
    return this.collectAllPositionFeesInstructions(params)
  }

  // =========================================================================
  // 读：仓位详情（纯本地计算，0 RPC）
  // =========================================================================

  /**
   * 由「池子快照 + 仓位快照」本地算出仓位详情，**0 RPC**。
   *
   * 这是旧 `chain.offchain.getPositionInfoByNftMint` 的 EVM 对应物（旧版吃的是四个
   * base64 账户数据，EVM 上只需要 pool + position 两份快照）。
   * 会读链的孪生方法在 `sdk.chain.getPositionInfoByNftMint`，两者返回同一个
   * {@link ICompatPositionInfo} 形状。
   *
   * `pendingFees` 不传时 `feeAmount` / `uiFeeAmount` 为 `null` 而不是 `0` ——
   * 「没拿到」和「确实是 0」在 UI 上是两件完全不同的事。
   */
  getPositionInfoByNftMint(params: ICompatOffchainPositionInfoParams): ICompatPositionInfo {
    const method = 'getPositionInfoByNftMint'
    const ctx = this.preparePosition(params, method, { requireWallet: false, withSlippage: false })

    const view = getPositionView({
      poolState: ctx.poolState,
      positionState: ctx.positionState,
      token0: ctx.token0,
      token1: ctx.token1,
    })

    // 同 collectFeesInstructions：元数据若被重排过，配套金额必须跟着换位。
    // 这条路径要求仓位快照，所以顺序其实由快照定死、ctx.tokensSwapped 恒为 false ——
    // 保留这一步是为了让「金额永远跟着元数据走」成为全文件统一的不变量，
    // 而不是某个分支碰巧成立的巧合。
    const rawFees =
      params.pendingFees === undefined ? undefined : toPendingFees(params.pendingFees, 'pendingFees')
    const fees = rawFees === undefined ? undefined : orderPendingFeesWithFlag(rawFees, ctx.tokensSwapped)
    const side = (token: ITokenInfo, amount: bigint, fee: bigint | undefined): ICompatPositionSide => ({
      address: token.address,
      decimals: token.decimals,
      symbol: token.symbol,
      amount,
      feeAmount: fee ?? null,
      uiAmount: toUiAmount(amount, token.decimals),
      uiFeeAmount: fee === undefined ? null : toUiAmount(fee, token.decimals),
    })

    const token0 = side(ctx.token0, view.amount0, fees?.amount0)
    const token1 = side(ctx.token1, view.amount1, fees?.amount1)

    return {
      tokenId: ctx.positionState.tokenId,
      poolAddress: ctx.poolState.poolAddress,
      tickLower: view.tickLower,
      tickUpper: view.tickUpper,
      liquidity: view.liquidity,
      inRange: view.inRange,
      isFullRange: view.isFullRange,
      priceLower: view.priceLower,
      priceUpper: view.priceUpper,
      currentPrice: view.currentPrice,
      uiPriceLower: view.priceLower,
      uiPriceUpper: view.priceUpper,
      token0,
      token1,
      // 同一个对象引用（不是深拷贝）：EVM 上 A 恒等于 token0，两个名字指同一份数据
      tokenA: token0,
      tokenB: token1,
      rawPositionInfo: ctx.positionState,
      rawPoolInfo: ctx.poolState,
    }
  }

  // =========================================================================
  // 内部：入参归一化
  // =========================================================================

  /**
   * 把「五花八门的宽松入参」一次性收敛成核心 SDK 能直接吃的上下文，
   * 并在这里完成**全部**快照齐备性检查 —— 检查通过之后，核心 SDK 的代码路径就是 0 RPC 的
   * （再配上 {@link buildOfflineChain} 的哨兵兜底）。
   *
   * 之所以集中在一个地方做：七个写方法的前置条件几乎一样，散在各处迟早出现
   * 「某个方法忘了传 autoApprove: false，于是偷偷发了 RPC」这种沉默故障 ——
   * 那种故障功能全对、只是悄悄多了几次 RPC，正是最难被发现的。
   *
   * `requirePool` / `requirePosition` 为 false 时**仍然会解析**传进来的快照（拿来给
   * token 排序、给 tokenId 兜底），只是缺了不抛。
   */
  private prepare(
    params: ICompatOffchainPositionParams,
    method: string,
    options: {
      requirePool: boolean
      requirePosition: boolean
      requireWallet?: boolean
      /** 该方法有没有滑点语义。collect 与纯读方法没有，传 false 免得白喊一次「未指定滑点」的 warn */
      withSlippage?: boolean
    },
  ): IOfflineContext {
    const poolState = this.resolvePoolState(params, method, options.requirePool)
    const positionState = this.resolvePositionState(params, method, poolState, options.requirePosition)
    const { token0, token1, swapped: tokensSwapped } = this.resolveTokenPair(
      params,
      method,
      poolState,
      positionState,
    )

    return {
      poolState,
      positionState,
      token0,
      token1,
      userAddress:
        options.requireWallet === false &&
        firstPresent(params.userAddress, params.walletAddress) === undefined
          ? ZERO_ADDRESS
          : this.resolveUserAddress(params, method),
      // 空串 = 表单没填 = 「打回 userAddress」，不是一个非法地址（判据见 internal.isPresent）
      recipient: isPresent(params.recipient) ? toAddress(params.recipient as string, 'recipient') : undefined,
      // collect / 纯读路径没有滑点这回事，这里的 0 不会被任何下游读到（它们的 meta 里也没有 slippageBps）
      slippageBps: options.withSlippage === false ? 0 : resolveSlippageBps(params),
      deadlineSec: resolveDeadlineSec(params),
      tokensSwapped,
      client: new CLMMClient({
        chain: buildOfflineChain(this.sdk.chain, [token0, token1], method),
      }),
    }
  }

  /**
   * {@link prepare} 的「必须有池子快照」版（开仓用）。
   * 断言是 `requirePool: true` 给的 —— 走到这里 poolState 一定不是 undefined。
   */
  private preparePool(params: ICompatOffchainCommonParams, method: string): IOfflinePoolContext {
    return this.prepare(params, method, { requirePool: true, requirePosition: false }) as IOfflinePoolContext
  }

  /**
   * {@link prepare} 的「池子 + 仓位快照都必须有」版（加仓 / 减仓 / 关仓 / 仓位详情用）。
   * 这正是核心 `loadModifyContext` 走 offline 分支的充要条件。
   */
  private preparePosition(
    params: ICompatOffchainPositionParams,
    method: string,
    options?: { requireWallet?: boolean; withSlippage?: boolean },
  ): IOfflinePositionContext {
    return this.prepare(params, method, {
      requirePool: true,
      requirePosition: true,
      requireWallet: options?.requireWallet,
      withSlippage: options?.withSlippage,
    }) as IOfflinePositionContext
  }

  /**
   * `userAddress` / `walletAddress` 二认其一。
   *
   * 取值与「两个都给了但不是同一个地址」的冲突判定走共享的 {@link pickActorAddress}，
   * 与读链版是同一份实现 —— 曾经这里只做 `firstDefined`，于是 `{ userAddress: '', walletAddress }`
   * （一个没填、一个填了的表单）在读链版上正常、在 offchain 上报「空字符串」，
   * 而两边收到的是完全相同的入参。
   */
  private resolveUserAddress(
    params: { userAddress?: string; walletAddress?: string },
    method: string,
  ): Address {
    const resolved = pickActorAddress(params)
    if (resolved === undefined) {
      throw new Error(
        `${COMPAT_ERR_PREFIX} offchain.${method} 缺少 userAddress（也认 walletAddress）：` +
          '写操作必须知道是谁在发交易（它同时是默认的资产接收者）。',
      )
    }
    return resolved
  }

  /**
   * 池子快照归一化：`rawPoolInfo` / `poolState` 二认其一，
   * 池子地址允许与快照分开传（旧 `IPoolLayout` 里没有池子自身地址，Solana 那边是账户 key 在外面）。
   */
  private resolvePoolState(
    params: ICompatOffchainCommonParams & { rawPositionInfo?: unknown; positionState?: unknown },
    method: string,
    required: boolean,
  ): IPoolStateRaw | undefined {
    // 后端接口的 PositionDetail 自带完整的 pool: PoolDetail —— 认它做兜底，
    // 否则调用方得把同一份数据再抄一遍传给 rawPoolInfo，纯属白干
    const nested = asLooseRecord(firstPresent(params.rawPositionInfo, params.positionState)).pool
    const snapshot = firstPresent(params.rawPoolInfo, params.poolState, nested as PoolSnapshotish)
    if (snapshot === undefined) {
      if (!required) return undefined
      throw missingSnapshotError(
        method,
        '池子快照 rawPoolInfo（核心 SDK 里叫 poolState）',
        '滑点下限、另一边的金额、mint 的 token0/token1/tickSpacing 全都由它推导。',
      )
    }

    // 空串按「没传」处理：池子地址常来自一个可能没填的输入框，
    // 而快照里本来就带着地址，回退过去才是调用方的本意
    const outside = firstPresent(params.poolAddress, params.poolId)
    if (outside === undefined) return toPoolStateRaw(snapshot as PoolSnapshotish, 'rawPoolInfo')

    // 两处都给了池子地址：一致就用，不一致必须抛 —— 对着错误的池子发交易是纯粹的资金损失
    const src = asLooseRecord(snapshot)
    const inside = firstPresent(src.poolAddress, src.address, src.poolId, src.id) as string | undefined
    const resolved = toAddress(outside, 'poolAddress')
    if (inside !== undefined && toAddress(inside, 'rawPoolInfo.poolAddress') !== resolved) {
      throw conflictError(
        method,
        '池子地址',
        `poolAddress=${resolved}`,
        `rawPoolInfo 里的 ${toAddress(inside, 'rawPoolInfo.poolAddress')}`,
      )
    }
    return toPoolStateRaw({ ...(snapshot as object), poolAddress: resolved } as PoolSnapshotish, 'rawPoolInfo')
  }

  /**
   * 仓位快照归一化：`rawPositionInfo` / `positionState` 二认其一；
   * 快照缺 token0/token1/tickSpacing 时（后端接口的 `PositionSummary` 就缺）自动用池子快照兜底。
   */
  private resolvePositionState(
    params: ICompatOffchainPositionParams,
    method: string,
    poolState: IPoolStateRaw | undefined,
    required: boolean,
  ): IPositionStateRaw | undefined {
    const snapshot = firstPresent(params.rawPositionInfo, params.positionState)
    if (snapshot === undefined) {
      if (!required) return undefined
      throw missingSnapshotError(
        method,
        '仓位快照 rawPositionInfo（核心 SDK 里叫 positionState）',
        '区间 tickLower/tickUpper 与当前流动性都在它里面，没有它连要减多少都算不出来。',
      )
    }

    // PositionSummary 只有 poolAddress、没有 token0/token1/fee，把池子快照并进去它就完整了；
    // 快照自己带了 pool 字段时以它自己的为准（更具体的信息优先）
    const merged = {
      ...(snapshot as object),
      pool: firstPresent(asLooseRecord(snapshot).pool as PoolSnapshotish | undefined, poolState),
    } as PositionSnapshotish

    let positionState: IPositionStateRaw
    try {
      positionState = toPositionStateRaw(merged, 'rawPositionInfo')
    } catch (e) {
      // required=false 时（只有 collectFees）这份快照是「有就用、没有也行」的辅助信息：
      // collect 的 calldata 只依赖 tokenId / recipient / max，池子身份字段缺了也不影响正确性。
      // 这里硬抛会让「拿 PositionSummary 领手续费」这个完全合理的用法跑不通，
      // 而真正缺的东西（tokenId、代币元数据）后面各有自己的、更准确的报错。
      if (!required) return undefined
      throw e
    }

    // 走共享的 pickTokenIdRef：它顺带拦下「tokenId 与 nftMint 互相矛盾」——
    // 只取第一个的话，第二个标识指向的那个仓位会被无声无息地忽略
    const outside = pickTokenIdRef(params)
    if (outside !== undefined && outside !== positionState.tokenId) {
      // 核心 loadModifyContext 也会拦这一条，但它只能说「两个数不一样」；
      // 在这里抛能顺带说清「你可能是拿 A 仓位的快照去减 B 仓位」
      throw conflictError(
        method,
        'tokenId',
        `参数里的 ${outside}`,
        `rawPositionInfo 里的 ${positionState.tokenId}（当心拿错了仓位的快照）`,
      )
    }
    return positionState
  }

  /**
   * 凑齐 token0 / token1 的元数据（decimals 是必需的，金额换算全靠它）。
   *
   * 来源按「越具体越优先」排：显式 `token0`/`token1`（或 `mintA`/`mintB`）→ 池子快照里
   * 对象形状的 token 位（后端接口的 `PoolDetail` 天然满足）→ 仓位快照里的对象形状。
   * 凑齐后按**池子的链上顺序**摆正：调用方把两个 token 传反了也能救回来。
   */
  private resolveTokenPair(
    params: ICompatOffchainCommonParams & { rawPositionInfo?: unknown; positionState?: unknown },
    method: string,
    poolState: IPoolStateRaw | undefined,
    positionState: IPositionStateRaw | undefined,
  ): { token0: ITokenInfo; token1: ITokenInfo; swapped: boolean } {
    const chainId = this.sdk.chainId
    const table = new Map<string, ITokenInfo>()
    const push = (info: ITokenInfo): void => {
      table.set(info.address.toLowerCase(), info)
    }

    // ① 快照里顺带带过来的（优先级低，先放，后面被显式入参覆盖）
    const poolSnapshot = asLooseRecord(firstPresent(params.rawPoolInfo, params.poolState))
    const positionSnapshot = asLooseRecord(firstPresent(params.rawPositionInfo, params.positionState))
    const nestedPool = asLooseRecord(positionSnapshot.pool)
    for (const candidate of [
      nestedPool.token0,
      nestedPool.token1,
      positionSnapshot.token0,
      positionSnapshot.token1,
      poolSnapshot.token0,
      poolSnapshot.token1,
    ]) {
      // 只收「带 decimals」的对象；裸地址串给不出精度，收了也没用
      if (looksLikeTokenInfo(candidate)) push(toTokenInfo(candidate, chainId, 'rawPoolInfo.token'))
    }

    // ② 显式入参（优先级最高，覆盖上面的）
    const explicit0 = firstPresent(params.token0, params.mintA)
    const explicit1 = firstPresent(params.token1, params.mintB)
    if (explicit0 !== undefined) push(toTokenInfo(explicit0, chainId, 'token0'))
    if (explicit1 !== undefined) push(toTokenInfo(explicit1, chainId, 'token1'))

    // ③ 按池子/仓位记录的链上顺序取出来（这两处的 token0/token1 一定是地址升序的）
    const ordered = poolState ?? positionState
    if (ordered !== undefined) {
      const t0 = table.get(ordered.token0.toLowerCase())
      const t1 = table.get(ordered.token1.toLowerCase())
      if (t0 && t1) return { token0: t0, token1: t1, swapped: false }
      const missing = [t0 ? undefined : ordered.token0, t1 ? undefined : ordered.token1].filter(Boolean)
      throw missingSnapshotError(
        method,
        `代币元数据（缺 ${missing.join('、')}）`,
        'decimals 决定所有金额换算，猜错一位就是 10 倍的误差，所以只能由调用方提供。' +
          '传法：token0 / token1（或旧名 mintA / mintB）给 { address, decimals, symbol }；' +
          '或者直接把后端接口的 PoolDetail 当 rawPoolInfo 传进来（它的 token0/token1 本身就是对象）。',
      )
    }

    // ④ 连池子/仓位快照都没有（只可能是 collectFees 那条最省的路径）：
    //    按地址升序摆正 —— Uniswap V3 的池子里 token0 < token1 恒成立，这个兜底是可证明正确的
    const both = [explicit0, explicit1].filter((v) => v !== undefined)
    if (both.length === 2) {
      // 这里是**唯一**会静默换位的分支（没有快照可以定序，只能靠地址升序这条硬不变量）。
      // 换位回执必须带出去：调用方配套的 pendingFees.amount0/amount1 得跟着一起换，
      // 否则「元数据换了、金额没换」会让界面显示一个量级完全错误的可领金额。
      return orderTokenPairWithFlag(
        toTokenInfo(both[0] as TokenInfoish, chainId, 'token0'),
        toTokenInfo(both[1] as TokenInfoish, chainId, 'token1'),
      )
    }
    throw missingSnapshotError(
      method,
      '代币元数据 token0 / token1（旧名 mintA / mintB）',
      'meta 里的 ui* 金额与 decimals 换算都依赖它，而 offchain 模式不能去链上读 ERC20 元数据。',
    )
  }

  /** collect 专用：tokenId 与 pendingFees 的解析（两者都是硬要求） */
  private prepareCollect(
    params: ICompatOffchainCollectFeesParams,
    method: string,
  ): { tokenId: bigint; pendingFees: IPendingFees } {
    const tokenId = this.resolveTokenId(params, method)
    // `null`（后端「这个仓位我也不知道能领多少」）与 `undefined` 一样算没给：
    // 交给下面的 toPendingFees 只会报「必须同时给出 amount0 与 amount1」，
    // 而调用方真正需要知道的是「offchain 模式必须自带它，否则请改用读链版」
    if (!isPresent(params.pendingFees)) {
      throw missingSnapshotError(
        method,
        '待领手续费快照 pendingFees（{ amount0, amount1 }）',
        '不传的话核心 SDK 会对 NPM.collect 做一次 staticcall 去拿精确可领额，那就不是 0 RPC 了。\n' +
          '注意它**只影响 meta 里的展示数字，不影响 calldata**（collect 的入参只有 tokenId/recipient/max），' +
          '所以由后端下发这个值是安全的：链上执行的永远是「能领多少领多少」。',
      )
    }
    return { tokenId, pendingFees: toPendingFees(params.pendingFees, 'pendingFees') }
  }

  /** `tokenId` / `nftMint` / 仓位快照里的 tokenId，取到哪个算哪个 */
  private resolveTokenId(
    params: {
      tokenId?: Numericish
      nftMint?: Numericish
      rawPositionInfo?: unknown
      positionState?: unknown
    },
    method: string,
  ): bigint {
    const direct = pickTokenIdRef(params)
    if (direct !== undefined) return direct

    const snapshot = asLooseRecord(firstPresent(params.rawPositionInfo, params.positionState))
    const fromSnapshot = toBlankableBigInt(
      firstPresent(snapshot.tokenId, snapshot.nftMint) as Numericish | undefined,
      'rawPositionInfo.tokenId',
    )
    if (fromSnapshot !== undefined) return fromSnapshot

    throw new Error(
      `${COMPAT_ERR_PREFIX} offchain.${method} 缺少 tokenId：请直接传 tokenId（uint256），` +
        '或传一份带 tokenId 的 rawPositionInfo。\n' +
        '（EVM 上仓位由 NonfungiblePositionManager 的 tokenId 标识，不存在 Solana 那样的 NFT mint 地址。）',
    )
  }
}

// ---------------------------------------------------------------------------
// 内部：上下文与 meta 组装
// ---------------------------------------------------------------------------

/** 零地址：只在「不需要 userAddress 的纯读方法」里占位（不会进任何 calldata） */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

/** 一次 offchain 调用归一化之后的全部上下文 */
interface IOfflineContext {
  /** 缺快照时为 undefined（只有 collectFees 允许缺，它不需要池子状态） */
  poolState: IPoolStateRaw | undefined
  /** 缺快照时为 undefined（只有 collectFees 允许缺，它的 calldata 只依赖 tokenId） */
  positionState: IPositionStateRaw | undefined
  token0: ITokenInfo
  token1: ITokenInfo
  /**
   * `token0`/`token1` 是否相对**调用方声明的顺序**被换过位。
   *
   * 只有「连池子/仓位快照都没有、纯靠地址升序定序」那条分支才可能为 true。
   * 与之配套的金额（目前只有 `pendingFees`）必须按这个回执一起换位 ——
   * 见 internal.ts 的 `orderPendingFeesWithFlag`。
   */
  tokensSwapped: boolean
  userAddress: Address
  recipient: Address | undefined
  slippageBps: number
  deadlineSec: number | undefined
  /** 绑了「离线 Chain 代理」的核心写客户端 —— 所有 calldata 仍由核心 SDK 产出 */
  client: CLMMClient
}

/** 已确认带池子快照的上下文（由 `requirePool: true` 保证） */
type IOfflinePoolContext = IOfflineContext & { poolState: IPoolStateRaw }

/** 已确认带池子 + 仓位快照的上下文（= 核心 loadModifyContext 走 offline 分支的充要条件） */
type IOfflinePositionContext = IOfflinePoolContext & { positionState: IPositionStateRaw }

// ---------------------------------------------------------------------------
// 旧名再导出
// ---------------------------------------------------------------------------

/**
 * 池子快照归一化的旧名别名（= `state.ts` 的 {@link toPoolStateRaw}）。
 *
 * 对应旧 readme 里那句「`chain.getRawPoolInfoByPoolId` 改成 `buildPoolLayoutWithId`」：
 * Solana 版那个函数干的是「把裸账户数据 + poolId 拼成 SDK 能吃的 pool 对象」，
 * EVM 上对应的就是「把后端下发的池子 JSON 归一化成 `IPoolStateRaw`」。
 *
 * 刻意**不**沿用 `buildPoolLayoutWithId` 这个名字：旧函数还会算出 `currentPrice`、
 * 塞进 `programId`，返回的是完全不同的形状。同名不同形状是最难排查的一类坑，
 * 宁可让调用方改一次名字。
 */
export const buildPoolStateRaw: typeof toPoolStateRaw = toPoolStateRaw
