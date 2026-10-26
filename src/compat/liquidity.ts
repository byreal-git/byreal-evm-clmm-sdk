/**
 * compat 层的**读链版**写操作：`CompatCLMMClient`。
 *
 * 定位：把 Solana 版 SDK 的调用形状（旧方法名、旧参数名、旧量纲）翻译成
 * 核心 `sdk.clmmClient.*` 的入参，再把核心的返回翻译回旧形状。
 * **本文件不做任何 CLMM 数学** —— 金额、滑点下限、tick 对齐一律由核心 SDK 算，
 * compat 只负责「入参归一化 + 返回值增强」。这条边界一破，兼容层就会变成第二份、
 * 且必然与核心漂移的数学实现。
 *
 * 三条贯穿全文件的原则：
 * 1. **每个动作两个方法名**（旧的 `xxxInstructions` + 短名）。短名一律**转调**长名，
 *    不复制实现 —— 两个名字必须逐字节产出同一笔交易，否则「换个名字结果不一样」
 *    会成为迁移期最诡异的一类 bug。
 * 2. **旧参数不许静默丢弃**。典型是 `otherAmountMax`：EVM 侧 SDK 自己算另一边、
 *    用不到这个入参，但它承载着调用方「另一边别超过这个数」的真实意图，
 *    这里把它降级成**断言**（超了就抛），而不是当作噪声删掉。
 * 3. **返回值的 Solana 形状别名指向同一批对象**（统一走 models.ts 的
 *    `toCompatTransactionReturn` / `toCompatCreatePositionReturn`，不手拼）。
 *
 * RPC 口径：= 核心 SDK 的次数 + compat 为了把 token 元数据填进 meta 可能多读的
 * 1 次 `positions`。调用方把 `token0` / `token1`（或旧名 `mintA` / `mintB`）的元数据
 * 传进来时，这一次也会被省掉，见 {@link CompatCLMMClient} 的类注释。
 */
import { encodeFunctionData, type Address, type Hex } from 'viem'

import { NPM_ABI } from '../abis.js'
import type { EvmClmmSdk } from '../client.js'
import { CLMMClient } from '../liquidity/clmm.js'
import type { IPendingFees, IPoolStateRaw, IPositionStateRaw, ITokenInfo, IUnsignedTx } from '../types.js'

import {
  COMPAT_ERR_PREFIX,
  resolveDeadlineSec,
  resolveSlippageBps,
  sameAddress,
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
  buildTokenScopedChain,
  firstPresent,
  isContractRevertError,
  isPresent,
  orderTokenPairByAddress,
  pickActorAddress,
  pickFollowTokenId,
  pickTokenIdRef,
  resolvePercentAlias,
  sumFeesByToken,
  toBlankableBigInt,
  toCompatDecreaseMeta,
  toCompatLiquidityMeta,
  toCompatPendingFeesMeta,
  toOptionalPendingFees,
  type IPendingFeesish,
} from './internal.js'
import {
  toCompatCreatePositionReturn,
  toCompatTransactionReturn,
  type ICompatCreatePositionMeta,
  type ICompatCreatePositionReturn,
  type ICompatDecreaseReturn,
  type ICompatAddLiquidityReturn,
  type ICompatCollectFeesReturn,
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
// 入参类型（入参归一化）
// ---------------------------------------------------------------------------

/**
 * 「谁在操作、资产打给谁」—— 所有写方法都认的两个字段。
 *
 * `userAddress` 与 `walletAddress` 是同一个东西的两种旧写法，二者认其一：
 * 类型上都做成可选、运行时再校验「至少给一个」，是因为若把 `userAddress` 声明成必填，
 * 旧代码里那批只有 `walletAddress` 的调用点会**编译不过** —— 而兼容层存在的意义
 * 恰恰是让它们不用改。两个都传且不是同一个地址时抛（不猜哪个优先）。
 */
export interface ICompatActorParams {
  /** 操作发起人（EVM 地址）。与 walletAddress 二者认其一 */
  userAddress?: string
  /** userAddress 的旧别名 */
  walletAddress?: string
  /** 资产 / 仓位 NFT 的接收者，默认 userAddress */
  recipient?: string
}

/**
 * 会改变价格敞口的写方法（开仓 / 加仓 / 减仓 / 关仓）通用入参。
 *
 * 刻意**不**把滑点与 deadline 放进 {@link ICompatActorParams}：`collect` 既不涉及价格
 * 也没有 deadline 参数，给它开这两个口子只会让调用方以为「传了就生效」。
 */
export interface ICompatCommonWrite extends ICompatActorParams {
  /** 旧口径滑点，小数（0.02 = 2%）。与 slippageBps 二者认其一 */
  slippage?: number
  /** 新口径滑点，基点（200 = 2%）。与 slippage 二者认其一 */
  slippageBps?: number
  /** deadline：从现在起多少秒后过期（核心 SDK 的口径） */
  deadlineSec?: number
  /** deadline 的旧写法：unix **秒**级绝对时间戳，也认相对秒（按数量级判定，见 resolveDeadlineSec） */
  deadline?: number
}

/**
 * 仓位标识：`tokenId`（EVM 口径）与 `nftMint`（Solana 口径）二者认其一。
 *
 * `nftMint` 保留下来不是为了「能用」，而是为了**报错报得准**：旧代码传进来的多半是
 * base58 的 Solana NFT mint，`toBigInt` 会抛出一条明确写着「EVM 上请用 tokenId」的提示，
 * 比 TypeScript 报「对象上不存在 nftMint 属性」有用得多。
 */
export interface ICompatPositionRef {
  /** 仓位 NFT 的 tokenId（uint256） */
  tokenId?: Numericish
  /** tokenId 的 Solana 旧名 */
  nftMint?: Numericish
}

/**
 * 调用方自带的两种代币元数据（可选）。
 *
 * 传了能省 RPC：compat 会用它们造一个**只作用于本次调用**的 `Chain` 代理
 * （见 internal.ts 的 `buildTokenScopedChain`），核心 SDK 内部那次 ERC20 元数据 multicall
 * 与 compat 填 meta 时的查询都会命中它。**不会**写进核心的进程级缓存 ——
 * 那样一次错误输入会污染整个 session 的所有读链路径。
 *
 * 顺序传反了也不要紧 —— compat 按地址升序重排（Uniswap V3 的硬不变量：token0 < token1）。
 * 配对口径：与之配套的金额（如 `pendingFees.amount0`）恒与**你声明的** `token0` 配对，
 * 重排时会跟着一起换位，所以只要你自己内部一致就是安全的。
 */
export interface ICompatTokenMetaParams {
  /** token0 的元数据（address + decimals 必需，symbol 可缺） */
  token0?: TokenInfoish
  /** token1 的元数据 */
  token1?: TokenInfoish
  /** token0 的 Solana 旧名（EVM 上 A 恒等于 token0） */
  mintA?: TokenInfoish
  /** token1 的 Solana 旧名 */
  mintB?: TokenInfoish
}

/**
 * 调用方自带的池子快照（可选）。
 *
 * 透传给核心 SDK 的「自带快照」逃生口。⚠️ 只有**同时**满足
 * 「给了 poolState」+「autoApprove: false」核心才会真的跳过读链（见 `clmm.ts:loadMintContext`）；
 * 只给快照不关 autoApprove 时核心仍会读 fresh 状态，快照只用于覆盖池子那一份。
 */
export interface ICompatPoolSnapshotParams {
  /** 池子快照，三种形状都认（见 state.ts 的 PoolSnapshotish） */
  poolState?: PoolSnapshotish
  /** poolState 的旧名（对齐旧 SDK 的 rawPoolInfo） */
  rawPoolInfo?: PoolSnapshotish
}

/** 调用方自带的仓位快照（可选）。语义同 {@link ICompatPoolSnapshotParams} */
export interface ICompatPositionSnapshotParams {
  /** 仓位快照，三种形状都认（见 state.ts 的 PositionSnapshotish） */
  positionState?: PositionSnapshotish
  /** positionState 的旧名 */
  rawPositionInfo?: PositionSnapshotish
}

/** 开仓入参（对齐旧 `createPositionInstructions`） */
export interface ICompatCreatePositionParams
  extends ICompatCommonWrite,
    ICompatTokenMetaParams,
    ICompatPoolSnapshotParams {
  /** 池子地址。与 poolId、poolState.poolAddress 三者取其一（都给了必须一致） */
  poolAddress?: string
  /** poolAddress 的旧名（Solana 版池子标识叫 poolId） */
  poolId?: string
  /** 区间下界 tick，未对齐也没关系（核心会向下对齐到 tickSpacing） */
  tickLower: Numericish
  /** 区间上界 tick，未对齐也没关系（核心会向上对齐到 tickSpacing） */
  tickUpper: Numericish
  /** 以哪一边为输入基准，旧枚举名（MintA/MintB）也认 */
  base: BaseSideish
  /** 基准边投入数量（最小单位整数） */
  baseAmount: Numericish
  /**
   * 另一边的**上限**（旧签名里的 `otherAmountMax: BN`）。
   * EVM 侧不需要这个入参，compat 把它当**断言**用：算出来的另一边超过它就抛。
   */
  otherAmountMax?: Numericish
  /** allowance 不足时是否自动插入前置 approve，默认 true */
  autoApprove?: boolean
  /**
   * Byreal 定制合约独有：跟随建仓的目标仓位 tokenId，默认 0 = 不跟随。
   * ⚠️ 非 0 时合约做五项强制校验（目标存在、有流动性、同池、tick 区间完全一致、不是自己），
   * 任一不满足整笔 revert——它不是备注字段。
   */
  followTokenId?: Numericish
  /**
   * followTokenId 的 Solana 旧名（Copy Position 的母仓位），值必须是母仓位的 tokenId。
   * ⚠️ Solana 版只是 memo、区间随意；这里会变成链上校验，tick 区间须直接取母仓位的。
   */
  refererPosition?: Numericish
}

/** 加仓入参（对齐旧 `addLiquidityInstructions`） */
export interface ICompatAddLiquidityParams
  extends ICompatCommonWrite,
    ICompatPositionRef,
    ICompatTokenMetaParams,
    ICompatPoolSnapshotParams,
    ICompatPositionSnapshotParams {
  base: BaseSideish
  baseAmount: Numericish
  /** 同开仓：另一边的上限，compat 当断言用 */
  otherAmountMax?: Numericish
  autoApprove?: boolean
}

/** 减仓入参（对齐旧 `decreaseLiquidityInstructions`） */
export interface ICompatDecreaseLiquidityParams
  extends ICompatCommonWrite,
    ICompatPositionRef,
    ICompatTokenMetaParams,
    ICompatPoolSnapshotParams,
    ICompatPositionSnapshotParams {
  /** 直接指定要减掉的流动性数量（旧签名里的 `liquidity: BN`）。与 percent 二选一 */
  liquidity?: Numericish
  /** 按百分比减仓（0~100）。与 liquidity 二选一 */
  percent?: number | string
  /** percent 的旧别名 */
  decreasePercentage?: number | string
  /** percent 的旧别名 */
  percentage?: number | string
  /** 是否在同一笔 multicall 里追加 collect，默认 true（不 collect 资产不会回钱包） */
  collect?: boolean
}

/** 全额减仓入参（对齐旧 `decreaseFullLiquidityInstructions`） */
export interface ICompatDecreaseFullLiquidityParams
  extends ICompatCommonWrite,
    ICompatPositionRef,
    ICompatTokenMetaParams,
    ICompatPoolSnapshotParams,
    ICompatPositionSnapshotParams {
  /**
   * 撤完流动性后是否顺带销毁仓位 NFT，**默认 true**（= 走核心 `closePosition`）。
   * 传 false 时退化成 `decreaseLiquidity({ percent: 100 })`，NFT 保留、可再次加仓。
   */
  closePosition?: boolean
  /** 仅在 `closePosition: false` 时有意义；关仓必然包含 collect（否则 burn 会 revert） */
  collect?: boolean
}

/** 关仓入参（对齐旧 `closePositionInstructions`） */
export interface ICompatClosePositionParams
  extends ICompatCommonWrite,
    ICompatPositionRef,
    ICompatTokenMetaParams,
    ICompatPoolSnapshotParams,
    ICompatPositionSnapshotParams {}

/** 领取单个仓位手续费的入参（对齐旧 `collectFeesInstructions`） */
export interface ICompatCollectFeesParams
  extends ICompatActorParams,
    ICompatPositionRef,
    ICompatTokenMetaParams,
    ICompatPositionSnapshotParams {
  /** 上限，默认 uint128.max（能领多少领多少） */
  amount0Max?: Numericish
  amount1Max?: Numericish
  /**
   * 已知的精确可领额，传了就跳过核心那次 collect staticcall（省 1 次 RPC）。
   * 形状与 offchain 版一致（`amountA` / `amountB` 旧名也认），见 {@link IPendingFeesish}。
   */
  pendingFees?: IPendingFeesish
}

/** 批量领取手续费的入参（对齐旧 `collectAllPositionFeesInstructions`） */
export interface ICompatCollectAllFeesParams extends ICompatActorParams {
  /** 要领取的仓位 tokenId 列表。与 nftMintList 二者认其一 */
  tokenIdList?: Numericish[]
  /** tokenIdList 的 Solana 旧名 */
  nftMintList?: Numericish[]
  /**
   * 可选：`tokenId.toString()` → 已知的精确可领额（形状见 {@link IPendingFeesish}）。
   * 命中的仓位会跳过核心那次 collect staticcall（N 个仓位就省 N 次 RPC）。
   */
  pendingFeesMap?: Record<string, IPendingFeesish>
  /**
   * 可选：仓位快照列表（按 tokenId 匹配，顺序无关）。
   * 传了就不用为了拿 token0/token1 再逐个读 `positions`。
   */
  positionStateList?: PositionSnapshotish[]
  /**
   * 可选：本次涉及的**全部**代币元数据，扁平一个数组即可（顺序无关、多传不要紧）。
   *
   * 这里不是 `token0`/`token1` 一对 —— 批量领费的仓位可以横跨多个池子，涉及的代币
   * 天然多于两种。传了就会预热进核心 `Chain` 的缓存，配合 `positionStateList` 可做到 0 RPC。
   */
  tokens?: TokenInfoish[]
}

// ---------------------------------------------------------------------------
// 批量领费的返回类型（的 perPosition 明细）
// ---------------------------------------------------------------------------

/** 批量领费里单个仓位的明细（UI 展开「这一笔到底领了哪些仓位、各多少」时用） */
export interface ICompatCollectAllFeesItem {
  tokenId: bigint
  /** 该仓位 token0 侧可领额（已按 amount0Max 截断，这里恒为 uint128.max 故等于全额） */
  amount0: bigint
  amount1: bigint
  uiAmount0: string
  uiAmount1: string
  /** 该仓位所属池子的 token0 元数据（**不同仓位可能属于不同池子**） */
  token0: ITokenInfo
  token1: ITokenInfo
}

/**
 * 批量领费的 meta。
 *
 * 刻意**不**提供 `amount0` / `amount1` 两个合计字段：批量领费的仓位可以来自不同池子，
 * A 仓的 token0 是 WETH、B 仓的 token0 是 USDC，把它们相加得到的数没有任何含义，
 * 而一个「看起来能用」的错误数字迟早会被 UI 直接显示出来。
 * 因此合计只按**代币**聚合（{@link ICompatCollectAllFeesMeta.totals}）。
 */
export interface ICompatCollectAllFeesMeta {
  /** 逐仓位明细，顺序与 multicall 子调用顺序一致 */
  perPosition: ICompatCollectAllFeesItem[]
  /** 按代币聚合的合计（跨池仓位唯一有意义的加总口径） */
  totals: Array<{ token: ITokenInfo; amount: bigint; uiAmount: string }>
}

/** 批量领费的返回（一笔 `NPM.multicall`） */
export type ICompatCollectAllFeesReturn = ICompatTransactionReturn<ICompatCollectAllFeesMeta>

// ---------------------------------------------------------------------------
// CompatCLMMClient
// ---------------------------------------------------------------------------

/**
 * 读链版写操作客户端：`new CompatCLMMClient({ sdk })`。
 *
 * 每个动作都提供**两个方法名**（旧的 `xxxInstructions` 与短名），签名完全一致、
 * 短名转调长名。方法对照见 docs/compat.md 的「API 映射」。
 *
 * ## RPC 与「怎么才能省掉 compat 这一层的额外开销」
 * 核心 SDK 的 meta 里只有 bigint，没有 token 元数据；而 compat 的 meta 契约
 * 要求带 `token0` / `token1` 与 `ui*` 字符串。因此除开仓外（核心开仓 meta 自带 token 元数据），
 * compat 需要额外知道这个仓位属于哪两种代币，代价是**最多 1 次 `positions` 读**。
 * 三种消除方式，任选其一即可回到「与直接用核心 SDK 同样的 RPC 次数」：
 * - 传 `token0` / `token1`（或旧名 `mintA` / `mintB`）的元数据 —— 最省，连核心内部那次
 *   ERC20 元数据 multicall 也一并命中缓存；
 * - 传 `positionState` / `rawPositionInfo` 快照；
 * - 什么都不传，但同一个 SDK 实例此前已经读过这个仓位（`Chain` 的缓存是进程级的）。
 */
export class CompatCLMMClient {
  /** 逃生口：随时能拿到原生核心 SDK（compat 只是包一层，不藏东西） */
  readonly sdk: EvmClmmSdk

  constructor(params: { sdk: EvmClmmSdk }) {
    if (!params?.sdk) {
      throw new Error(`${COMPAT_ERR_PREFIX} new CompatCLMMClient({ sdk }) 缺少 sdk（EvmClmmSdk 实例）。`)
    }
    this.sdk = params.sdk
  }

  // =========================================================================
  // 开仓
  // =========================================================================

  /**
   * 开仓（旧名）。→ 核心 `sdk.clmmClient.createPosition`。
   *
   * RPC：与核心一致（热路径 1 次 multicall）。compat 不额外读链 —— 核心的开仓 meta
   * 已经带了 token0/token1 元数据。
   *
   * 与旧 Solana 版**唯一无法抹平**的差异：返回的 `nftAddress` / `tokenId` 恒为 `null`，
   * EVM 的 tokenId 由合约在 mint 上链时自增分配，发交易前不可知，
   * 交易确认后用 `parseTokenIdFromReceipt(receipt)` 取（见 models.ts §4.2）。
   */
  async createPositionInstructions(
    params: ICompatCreatePositionParams,
  ): Promise<ICompatCreatePositionReturn> {
    const userAddress = this.resolveActor(params)
    const slippageBps = resolveSlippageBps(params)
    const deadlineSec = resolveDeadlineSec(params)
    const poolState = this.resolvePoolSnapshot(params)
    const poolAddress = this.resolvePoolAddress(params, poolState)
    // 调用方自带 token 元数据时，核心内部那次 ERC20 multicall 就能省掉
    const given = this.readGivenTokenPair(params, 'createPosition')

    const base = toBaseSide(params.base)
    const core = await this.clientWith(given ?? []).createPosition({
      poolAddress,
      userAddress,
      tickLower: toSmallInt(params.tickLower, 'tickLower'),
      tickUpper: toSmallInt(params.tickUpper, 'tickUpper'),
      base,
      baseAmount: toBigInt(params.baseAmount, 'baseAmount'),
      recipient: isPresent(params.recipient) ? toAddress(params.recipient as string, 'recipient') : undefined,
      followTokenId: pickFollowTokenId(params),
      autoApprove: params.autoApprove,
      slippageBps,
      deadlineSec,
      poolState,
    })

    const { token0, token1 } = core.meta
    assertOtherAmountMax({
      where: 'createPositionInstructions',
      otherAmountMax: toBlankableBigInt(params.otherAmountMax, 'otherAmountMax'),
      base,
      amount0: core.meta.amount0Desired,
      amount1: core.meta.amount1Desired,
      token0,
      token1,
    })

    const meta: ICompatCreatePositionMeta = {
      ...toCompatLiquidityMeta(core.meta, token0, token1, slippageBps),
      poolAddress: core.meta.poolAddress,
    }
    return toCompatCreatePositionReturn(core, meta)
  }

  /** 开仓（短名）。转调 {@link createPositionInstructions}，行为完全一致 */
  async createPosition(params: ICompatCreatePositionParams): Promise<ICompatCreatePositionReturn> {
    return this.createPositionInstructions(params)
  }

  // =========================================================================
  // 加仓
  // =========================================================================

  /**
   * 往已有仓位追加流动性（旧名）。→ 核心 `sdk.clmmClient.addLiquidity`。
   *
   * **区间不可改**：tickLower/tickUpper 一律以链上仓位为准（Uniswap V3 的 NFT 语义），
   * 想换区间只能「关仓 + 重新开仓」。旧代码里若给这个方法传了 tick，会被忽略 ——
   * 这不是 compat 的选择，是链上语义如此。
   *
   * RPC：核心的次数 + 最多 1 次 `positions`（用于填 meta 的 token 元数据，见类注释）。
   */
  async addLiquidityInstructions(params: ICompatAddLiquidityParams): Promise<ICompatAddLiquidityReturn> {
    const userAddress = this.resolveActor(params)
    const tokenId = this.resolveTokenId(params)
    const slippageBps = resolveSlippageBps(params)
    const deadlineSec = resolveDeadlineSec(params)
    const poolState = this.resolvePoolSnapshot(params)
    const positionState = this.resolvePositionSnapshot(params, tokenId)
    const given = this.readGivenTokenPair(params, 'addLiquidity')

    const base = toBaseSide(params.base)
    const core = await this.clientWith(given ?? []).addLiquidity({
      tokenId,
      userAddress,
      base,
      baseAmount: toBigInt(params.baseAmount, 'baseAmount'),
      autoApprove: params.autoApprove,
      slippageBps,
      deadlineSec,
      poolState,
      positionState,
    })

    const [token0, token1] = await this.resolveTokenPair({ given, poolState, positionState, tokenId })
    assertOtherAmountMax({
      // 点名是读链版的哪个方法：同一个页面上 offchain 版也会抛这条，不点名就不知道该改哪一处
      where: 'addLiquidityInstructions',
      otherAmountMax: toBlankableBigInt(params.otherAmountMax, 'otherAmountMax'),
      base,
      amount0: core.meta.amount0Desired,
      amount1: core.meta.amount1Desired,
      token0,
      token1,
    })

    return toCompatTransactionReturn(core, toCompatLiquidityMeta(core.meta, token0, token1, slippageBps))
  }

  /** 加仓（短名）。转调 {@link addLiquidityInstructions} */
  async addLiquidity(params: ICompatAddLiquidityParams): Promise<ICompatAddLiquidityReturn> {
    return this.addLiquidityInstructions(params)
  }

  // =========================================================================
  // 减仓
  // =========================================================================

  /**
   * 减仓（旧名）。→ 核心 `sdk.clmmClient.decreaseLiquidity`。
   *
   * 旧签名是 `liquidity: BN`（绝对量），新核心是 `percent` 与 `liquidity` **二选一**。
   * 兼容层两个都收、**直接透传**（互斥校验由核心统一做，compat 不复制一份判断），
   * 并额外认旧代码里常见的 `decreasePercentage` / `percentage` 作为 `percent` 的别名。
   *
   * ⚠️ `collect` 默认 true：Uniswap 的 `decreaseLiquidity` 只把本金记进 tokensOwed，
   * 不跟一次 collect 钱不会回钱包。传 `collect: false` 才会退化成裸 decrease。
   */
  async decreaseLiquidityInstructions(
    params: ICompatDecreaseLiquidityParams,
  ): Promise<ICompatDecreaseReturn> {
    const userAddress = this.resolveActor(params)
    const tokenId = this.resolveTokenId(params)
    const slippageBps = resolveSlippageBps(params)
    const deadlineSec = resolveDeadlineSec(params)
    const poolState = this.resolvePoolSnapshot(params)
    const positionState = this.resolvePositionSnapshot(params, tokenId)
    const given = this.readGivenTokenPair(params, 'decreaseLiquidity')

    const core = await this.clientWith(given ?? []).decreaseLiquidity({
      tokenId,
      userAddress,
      percent: resolvePercentAlias(params),
      liquidity: toBlankableBigInt(params.liquidity, 'liquidity'),
      collect: params.collect,
      recipient: isPresent(params.recipient) ? toAddress(params.recipient as string, 'recipient') : undefined,
      slippageBps,
      deadlineSec,
      poolState,
      positionState,
    })

    const [token0, token1] = await this.resolveTokenPair({ given, poolState, positionState, tokenId })
    return toCompatTransactionReturn(core, toCompatDecreaseMeta(core.meta, token0, token1, slippageBps))
  }

  /** 减仓（短名）。转调 {@link decreaseLiquidityInstructions} */
  async decreaseLiquidity(params: ICompatDecreaseLiquidityParams): Promise<ICompatDecreaseReturn> {
    return this.decreaseLiquidityInstructions(params)
  }

  // =========================================================================
  // 全额减仓 / 关仓
  // =========================================================================

  /**
   * 撤出**全部**流动性（旧名）。
   *
   * 两条路，由 `closePosition` 决定（默认 true）：
   * - `true` → 核心 `closePosition`：decrease 全部 + collect + burn 打成**一笔**原子交易，
   *   仓位 NFT 一并销毁。这是旧 SDK 该方法的默认行为，也是绝大多数「移除全部流动性」按钮想要的；
   * - `false` → 核心 `decreaseLiquidity({ percent: 100 })`：NFT 保留，之后还能往同一个区间加仓。
   *
   * `closePosition: true` 时传 `collect: false` 会**抛错**而不是被忽略：
   * burn 要求 tokensOwed 已清空，不 collect 的关仓在链上必然 revert，
   * 静默忽略只会把失败推迟到用户签完名之后。
   */
  async decreaseFullLiquidityInstructions(
    params: ICompatDecreaseFullLiquidityParams,
  ): Promise<ICompatDecreaseReturn> {
    const closeNft = params.closePosition !== false

    if (!closeNft) {
      return this.decreaseLiquidityInstructions({
        ...params,
        percent: 100,
        // 三个别名一并清掉，否则调用方原本传的 percentage 会和这里的 100 打架
        decreasePercentage: undefined,
        percentage: undefined,
        liquidity: undefined,
      })
    }

    if (params.collect === false) {
      throw new Error(
        `${COMPAT_ERR_PREFIX} decreaseFullLiquidityInstructions 传了 collect: false，但同时要销毁仓位 NFT` +
          `（closePosition 默认 true）—— 合约要求 burn 前 tokensOwed 必须为 0，不 collect 的关仓一定 revert。\n` +
          `请二选一：想保留 NFT 就传 closePosition: false；想关仓就去掉 collect: false。`,
      )
    }
    return this.closePositionInstructions(params)
  }

  /** 全额减仓（短名）。转调 {@link decreaseFullLiquidityInstructions} */
  async decreaseFullLiquidity(
    params: ICompatDecreaseFullLiquidityParams,
  ): Promise<ICompatDecreaseReturn> {
    return this.decreaseFullLiquidityInstructions(params)
  }

  /** 全额减仓（旧代码里的第三个名字）。转调 {@link decreaseFullLiquidityInstructions} */
  async removeFullLiquidity(params: ICompatDecreaseFullLiquidityParams): Promise<ICompatDecreaseReturn> {
    return this.decreaseFullLiquidityInstructions(params)
  }

  /**
   * 关仓（旧名）：撤出全部流动性 → 领本金与手续费 → 销毁 NFT，**一笔原子 multicall**。
   * → 核心 `sdk.clmmClient.closePosition`。
   *
   * 仓位流动性本来就是 0（只剩手续费待领）时核心会自动跳过 decrease 那一步，
   * 此时 meta 里的 `liquidity` / `expectedAmount*` / `amount*Min` 全为 0 是正常的。
   */
  async closePositionInstructions(params: ICompatClosePositionParams): Promise<ICompatDecreaseReturn> {
    const userAddress = this.resolveActor(params)
    const tokenId = this.resolveTokenId(params)
    const slippageBps = resolveSlippageBps(params)
    const deadlineSec = resolveDeadlineSec(params)
    const poolState = this.resolvePoolSnapshot(params)
    const positionState = this.resolvePositionSnapshot(params, tokenId)
    const given = this.readGivenTokenPair(params, 'closePosition')

    const core = await this.clientWith(given ?? []).closePosition({
      tokenId,
      userAddress,
      recipient: isPresent(params.recipient) ? toAddress(params.recipient as string, 'recipient') : undefined,
      slippageBps,
      deadlineSec,
      poolState,
      positionState,
    })

    const [token0, token1] = await this.resolveTokenPair({ given, poolState, positionState, tokenId })
    return toCompatTransactionReturn(core, toCompatDecreaseMeta(core.meta, token0, token1, slippageBps))
  }

  /** 关仓（短名）。转调 {@link closePositionInstructions} */
  async closePosition(params: ICompatClosePositionParams): Promise<ICompatDecreaseReturn> {
    return this.closePositionInstructions(params)
  }

  // =========================================================================
  // 领取手续费
  // =========================================================================

  /**
   * 领取单个仓位的手续费（旧名）。→ 核心 `sdk.clmmClient.collectFees`。
   *
   * RPC：核心 1 次 collect staticcall（传了 `pendingFees` 则 0 次）
   *      + compat 最多 1 次 `positions`（用于填 meta 的 token 元数据，见类注释）。
   *
   * ⚠️ 走 staticcall 分支时 `userAddress` 必须是该仓位的 owner 或被 approve 的 operator，
   * 否则合约的 `isAuthorizedForToken` 检查会 revert（核心会把它翻译成可读错误）。
   */
  async collectFeesInstructions(params: ICompatCollectFeesParams): Promise<ICompatCollectFeesReturn> {
    const userAddress = this.resolveActor(params)
    const tokenId = this.resolveTokenId(params)
    const positionState = this.resolvePositionSnapshot(params, tokenId)
    const given = this.readGivenTokenPair(params, 'collectFees')

    const core = await this.clientWith(given ?? []).collectFees({
      tokenId,
      userAddress,
      recipient: isPresent(params.recipient) ? toAddress(params.recipient as string, 'recipient') : undefined,
      amount0Max: toBlankableBigInt(params.amount0Max, 'amount0Max'),
      amount1Max: toBlankableBigInt(params.amount1Max, 'amount1Max'),
      pendingFees: toOptionalPendingFees(params.pendingFees, 'pendingFees'),
    })

    const [token0, token1] = await this.resolveTokenPair({ given, positionState, tokenId })
    return toCompatTransactionReturn(core, toCompatPendingFeesMeta(core.meta, token0, token1))
  }

  /** 领取单个仓位手续费（短名）。转调 {@link collectFeesInstructions} */
  async collectFees(params: ICompatCollectFeesParams): Promise<ICompatCollectFeesReturn> {
    return this.collectFeesInstructions(params)
  }

  /**
   * 批量领取多个仓位的手续费（旧名），**打成一笔 `NPM.multicall`**（一次签名领完）。
   *
   * 这是 compat 里**唯一**自己拼 calldata 的地方 —— 核心 SDK 没有这个方法，
   * 而旧 SDK 有、前端在用。拼法与核心 `clmm.ts` 的 `packCalls` 完全一致：
   * 子调用直接取核心 `collectFees` 产出的那笔交易的 `data`（而不是自己再 encode 一遍 collect，
   * 少一份可能与核心漂移的编码逻辑）；只有一个仓位时不套 multicall 外壳，
   * 产物与 {@link collectFeesInstructions} 逐字节相同。
   *
   * NPM 的 multicall 是 `delegatecall self`，子调用里的 `msg.sender` 仍是用户本人，
   * 权限检查与分开发送完全一致，只是变成了原子的一笔。
   *
   * RPC：与仓位个数无关，最多 **2 次** ——
   *   ① 1 次 `NPM.multicall` staticcall：缺 `pendingFeesMap` 的仓位预演 collect、
   *     缺 `positionStateList` 快照的仓位读 `positions`（见 chain.getPositionStatesAndPendingFees）；
   *   ② 1 次 Multicall3 读涉及的全部 ERC20 元数据（`tokens` 给齐或已缓存时省掉）。
   * 之后逐仓拼交易时核心与 compat 都走快照，不再发 RPC。
   * 批量预读 revert（某个仓位无权限 / 不存在 / 池子暂停）时退回逐仓读，
   * 让报错落到具体的 tokenId 上；网络类错误（含限频）照抛，不重试放大请求量。
   */
  async collectAllPositionFeesInstructions(
    params: ICompatCollectAllFeesParams,
  ): Promise<ICompatCollectAllFeesReturn> {
    const userAddress = this.resolveActor(params)
    const recipient = isPresent(params.recipient)
      ? toAddress(params.recipient as string, 'recipient')
      : undefined
    const tokenIds = this.resolveTokenIdList(params)
    const snapshots = this.indexPositionSnapshots(params.positionStateList)
    const givenList = this.readGivenTokenList(params.tokens, 'collectAllPositionFees')
    // 整批共用一个作用域客户端：它内部的 Chain 代理会把这批元数据带给每一次 collect
    const client = this.clientWith(givenList)

    const givenFees = new Map<string, IPendingFees>()
    for (const tokenId of tokenIds) {
      const key = tokenId.toString()
      const fees = toOptionalPendingFees(params.pendingFeesMap?.[key], `pendingFeesMap["${key}"]`)
      if (fees) givenFees.set(key, fees)
    }

    // —— ① 批量预读：把逐仓的 collect 预演 / positions 合成一次 NPM.multicall，再一次读齐代币元数据 ——
    const prefetchedFees = await this.prefetchCollectInputs({
      tokenIds,
      userAddress,
      recipient,
      givenFees,
      snapshots,
      givenList,
    })

    const items: ICompatCollectAllFeesItem[] = []
    const calls: Hex[] = []
    let lastTx: IUnsignedTx | undefined

    // —— ② 逐仓拼交易：快照已齐时这里 0 RPC；预读退化时核心/compat 自己按需读链 ——
    // 保持串行：退化路径下核心 Chain 的 token 元数据缓存逐次填充，串行才能让后面的仓位命中缓存。
    for (const tokenId of tokenIds) {
      const key = tokenId.toString()
      const core = await client.collectFees({
        tokenId,
        userAddress,
        recipient,
        pendingFees: givenFees.get(key) ?? prefetchedFees.get(key),
      })
      const positionState = snapshots.get(key)
      const [token0, token1] = await this.resolveTokenPair({ positionState, tokenId, scoped: givenList })

      calls.push(core.main.data)
      lastTx = core.main
      items.push({
        tokenId,
        amount0: core.meta.amount0,
        amount1: core.meta.amount1,
        uiAmount0: toUiAmount(core.meta.amount0, token0.decimals),
        uiAmount1: toUiAmount(core.meta.amount1, token1.decimals),
        token0,
        token1,
      })
    }

    // 单个仓位时直接复用核心那笔交易（label 也更贴切），保证与 collectFeesInstructions 完全一致
    const tx: IUnsignedTx =
      calls.length === 1
        ? lastTx!
        : {
            to: this.sdk.contracts.positionManager,
            data: encodeFunctionData({ abi: NPM_ABI, functionName: 'multicall', args: [calls] }),
            value: 0n,
            chainId: this.sdk.chainId,
            label: `批量领取 ${calls.length} 个仓位的手续费（${calls.length} 步打成一笔 multicall）`,
          }

    const transactions = [tx]
    return toCompatTransactionReturn({ transactions, main: tx }, {
      perPosition: items,
      totals: sumFeesByToken(items),
    })
  }

  /**
   * 批量领费的预读：一次 `NPM.multicall` 补齐缺的待领额与仓位快照，再一次读齐代币元数据。
   *
   * 读到的仓位快照直接写进 `snapshots`（调用方给的快照优先，不覆盖），返回预演得到的待领额。
   * 代币元数据不返回 —— 读完就进了核心 Chain 的缓存，后续 `resolveTokenPair` 直接命中。
   *
   * 批量 staticcall 是「一个 revert 全部 revert」，而且看不出是哪个仓位出的问题，
   * 所以遇到合约 revert 时返回空表，让调用方退回逐仓读链：逐仓那条路径的报错带着 tokenId。
   * 网络类错误（超时 / 5xx / 429 限频）不退回 —— 退回会把 1 次请求放大成 2N 次，限频时只会更糟。
   */
  private async prefetchCollectInputs(args: {
    tokenIds: bigint[]
    userAddress: Address
    recipient: Address | undefined
    givenFees: Map<string, IPendingFees>
    snapshots: Map<string, IPositionStateRaw>
    givenList: ITokenInfo[]
  }): Promise<Map<string, IPendingFees>> {
    const { tokenIds, userAddress, recipient, givenFees, snapshots, givenList } = args
    const pendingFeesOf = tokenIds.filter((id) => !givenFees.has(id.toString()))
    const positionStateOf = tokenIds.filter((id) => !snapshots.has(id.toString()))

    let pendingFees = new Map<string, IPendingFees>()
    if (pendingFeesOf.length > 0 || positionStateOf.length > 0) {
      try {
        const read = await this.sdk.chain.getPositionStatesAndPendingFees({
          owner: userAddress,
          recipient,
          positionStateOf,
          pendingFeesOf,
        })
        pendingFees = read.pendingFees
        read.positionStates.forEach((state, key) => snapshots.set(key, state))
      } catch (e) {
        if (!isContractRevertError(e)) throw e
        return new Map()
      }
    }

    // 所有仓位的代币地址去重后一次读齐（调用方给的 `tokens` 不读链，见 buildTokenScopedChain）
    const addresses = new Map<string, Address>()
    for (const tokenId of tokenIds) {
      const state = snapshots.get(tokenId.toString())
      if (!state) continue
      for (const address of [state.token0, state.token1]) addresses.set(address.toLowerCase(), address)
    }
    if (addresses.size > 0) {
      await buildTokenScopedChain(this.sdk.chain, givenList).getTokenInfoList([...addresses.values()])
    }

    return pendingFees
  }

  /** 批量领取手续费（短名）。转调 {@link collectAllPositionFeesInstructions} */
  async collectAllFees(params: ICompatCollectAllFeesParams): Promise<ICompatCollectAllFeesReturn> {
    return this.collectAllPositionFeesInstructions(params)
  }

  // =========================================================================
  // 内部：入参归一化
  // =========================================================================

  /**
   * `userAddress` 与旧名 `walletAddress` 收敛成一个 checksum 地址。
   *
   * 取值与冲突判定走共享的 {@link pickActorAddress}（offchain 版用的是同一份，
   * 否则「两个地址都给了」这类入参会在两条路径上得到不同的结果）；
   * 这里只补「一个都没给」的报错 —— 那句文案要点出「它同时是余额校验对象」，
   * 而 offchain 模式根本不校验余额，两边说法本就不该一样。
   */
  private resolveActor(params: ICompatActorParams): Address {
    const resolved = pickActorAddress(params)
    if (!resolved) {
      throw new Error(
        `${COMPAT_ERR_PREFIX} 缺少 userAddress（旧代码里也叫 walletAddress）：写操作必须知道由谁发起，` +
          `它同时是余额/授权校验的对象与资产默认接收者。`,
      )
    }
    return resolved
  }

  /** `tokenId` 与旧名 `nftMint` 收敛成一个 bigint（取值与冲突判定见共享的 {@link pickTokenIdRef}） */
  private resolveTokenId(params: ICompatPositionRef): bigint {
    const resolved = pickTokenIdRef(params)
    if (resolved === undefined) {
      throw new Error(
        `${COMPAT_ERR_PREFIX} 缺少 tokenId（旧代码里叫 nftMint）：EVM 上仓位由 ` +
          `NonfungiblePositionManager 的 tokenId（uint256）标识。`,
      )
    }
    return resolved
  }

  /** `tokenIdList` 与旧名 `nftMintList` 收敛成一个去重后的 bigint 列表（保持入参顺序） */
  private resolveTokenIdList(params: ICompatCollectAllFeesParams): bigint[] {
    const hasIds = Array.isArray(params?.tokenIdList)
    const hasMints = Array.isArray(params?.nftMintList)
    if (hasIds && hasMints) {
      throw new Error(
        `${COMPAT_ERR_PREFIX} tokenIdList 与 nftMintList 是同一个字段的两种写法，只能传一个。`,
      )
    }
    const source = hasIds ? params.tokenIdList! : hasMints ? params.nftMintList! : undefined
    if (!source || source.length === 0) {
      throw new Error(
        `${COMPAT_ERR_PREFIX} collectAllPositionFeesInstructions 需要一个非空的 tokenIdList` +
          `（旧代码里叫 nftMintList）：没有仓位就没有可以打包的 collect 调用。`,
      )
    }

    const seen = new Set<string>()
    const out: bigint[] = []
    source.forEach((raw, i) => {
      const id = toBigInt(raw, `${hasIds ? 'tokenIdList' : 'nftMintList'}[${i}]`)
      const key = id.toString()
      // 同一个 tokenId 领两次：第二次必然领到 0，只是白烧 gas，静默去重比报错友好
      if (seen.has(key)) return
      seen.add(key)
      out.push(id)
    })
    return out
  }

  /** `poolState` / 旧名 `rawPoolInfo` → 归一化后的 `IPoolStateRaw`（都没给返回 undefined） */
  private resolvePoolSnapshot(params: ICompatPoolSnapshotParams): IPoolStateRaw | undefined {
    const raw = firstPresent(params?.poolState, params?.rawPoolInfo)
    if (raw === undefined) return undefined
    return toPoolStateRaw(raw, 'poolState')
  }

  /**
   * `positionState` / 旧名 `rawPositionInfo` → 归一化后的 `IPositionStateRaw`。
   * 顺带校验它与本次操作的 `tokenId` 是同一个仓位 —— 核心也会查一遍，但那条错误发生在
   * 更深的调用栈里，在入参层先挡住更容易定位。
   */
  private resolvePositionSnapshot(
    params: ICompatPositionSnapshotParams,
    tokenId: bigint,
  ): IPositionStateRaw | undefined {
    const raw = firstPresent(params?.positionState, params?.rawPositionInfo)
    if (raw === undefined) return undefined
    const state = toPositionStateRaw(raw, 'positionState')
    if (state.tokenId !== tokenId) {
      throw new Error(
        `${COMPAT_ERR_PREFIX} positionState.tokenId=${state.tokenId} 与本次操作的 tokenId=${tokenId} 不是同一个仓位。` +
          `多半是列表页复用了上一行的快照，请传对应仓位的快照或直接不传（让 SDK 读链）。`,
      )
    }
    return state
  }

  /**
   * 批量领费的仓位快照列表 → `tokenId.toString()` → 快照 的索引。
   *
   * 按 tokenId 建索引而不是按数组下标对齐，是因为调用方的快照列表通常直接来自
   * 「我的仓位」列表接口，顺序与本次要领取的 tokenIdList 未必一致；
   * 按下标对齐一旦错位，展示金额会挂到错误的代币上。多余的快照静默忽略即可。
   */
  private indexPositionSnapshots(
    list: PositionSnapshotish[] | undefined,
  ): Map<string, IPositionStateRaw> {
    const map = new Map<string, IPositionStateRaw>()
    if (!Array.isArray(list)) return map
    list.forEach((raw, i) => {
      const state = toPositionStateRaw(raw, `positionStateList[${i}]`)
      map.set(state.tokenId.toString(), state)
    })
    return map
  }

  /** 池子地址：`poolAddress` / 旧名 `poolId` / 快照里的 `poolAddress`，三者取一且必须互相一致 */
  private resolvePoolAddress(
    params: ICompatCreatePositionParams,
    poolState: IPoolStateRaw | undefined,
  ): Address {
    const explicit = firstPresent(params?.poolAddress, params?.poolId)
    if (explicit === undefined) {
      if (poolState) return poolState.poolAddress
      throw new Error(
        `${COMPAT_ERR_PREFIX} 缺少 poolAddress（旧代码里叫 poolId）：开仓必须先确定往哪个池子里打钱。` +
          `也可以传 poolState / rawPoolInfo 快照，compat 会取它的 poolAddress。`,
      )
    }
    const address = toAddress(explicit, 'poolAddress')
    if (poolState && !sameAddress(address, poolState.poolAddress)) {
      throw new Error(
        `${COMPAT_ERR_PREFIX} poolAddress=${address} 与 poolState.poolAddress=${poolState.poolAddress} 不是同一个池子。` +
          `核心 SDK 会用前者读链、用后者做数学，两者不一致会算出一笔发往错误池子的交易。`,
      )
    }
    return address
  }

  // =========================================================================
  // 内部：token 元数据
  // =========================================================================

  /**
   * 读取调用方自带的两种代币元数据（`token0`/`token1`，旧名 `mintA`/`mintB`）。
   *
   * 返回值按**地址升序**排好：Uniswap V3 工厂建池时强制 `token0 < token1`，
   * 所以「哪个是 token0」根本不需要读链，调用方顺序传反了也能救回来。
   *
   * 只给一个而不给另一个时抛：半份元数据没法用（另一边还是要读链），
   * 而调用方多半是漏写了，静默忽略会让「为什么还是读了链」变成一个查不出原因的问题。
   *
   * ⚠️ 这里**只做形状与 chainId 校验，不判断这两种代币是不是真属于本次操作的池子** ——
   * 那件事必须在拿到快照或链上仓位之后做，见 {@link resolveTokenPair}。
   */
  private readGivenTokenPair(
    params: ICompatTokenMetaParams,
    field: string,
  ): [ITokenInfo, ITokenInfo] | undefined {
    const a = firstPresent(params?.token0, params?.mintA)
    const b = firstPresent(params?.token1, params?.mintB)
    if (a === undefined && b === undefined) return undefined
    if (a === undefined || b === undefined) {
      throw new Error(
        `${COMPAT_ERR_PREFIX} ${field} 的代币元数据必须成对提供：只给了 ${a ? 'token0/mintA' : 'token1/mintB'}。` +
          `缺一边的话另一边仍要读链，等于没省，还会让两边的 decimals 来源不一致。`,
      )
    }

    const i0 = toTokenInfo(a, this.sdk.chainId, `${field}.token0`)
    const i1 = toTokenInfo(b, this.sdk.chainId, `${field}.token1`)
    for (const t of [i0, i1]) {
      if (t.chainId !== this.sdk.chainId) {
        throw new Error(
          `${COMPAT_ERR_PREFIX} ${field} 的代币元数据 ${t.symbol}(${t.address}) 属于 chainId=${t.chainId}，` +
            `与 SDK 的 chainId=${this.sdk.chainId} 不一致。同一个池子的两种代币必须在同一条链上。`,
        )
      }
    }
    return orderTokenPairByAddress(i0, i1)
  }

  /**
   * 归一化一组「不成对」的代币元数据（批量领费专用：仓位横跨多池时代币多于两种）。
   *
   * 与 {@link readGivenTokenPair} 的区别是这里**不需要**知道谁是 token0、谁是 token1 ——
   * 作用域表本来就按各自的地址索引，配对交给后续的快照/链上数据去决定。
   */
  private readGivenTokenList(list: TokenInfoish[] | undefined, field: string): ITokenInfo[] {
    if (!Array.isArray(list) || list.length === 0) return []
    return list.map((raw, i) => {
      const info = toTokenInfo(raw, this.sdk.chainId, `${field}.tokens[${i}]`)
      if (info.chainId !== this.sdk.chainId) {
        throw new Error(
          `${COMPAT_ERR_PREFIX} ${field}.tokens[${i}] 的 ${info.symbol}(${info.address}) 属于 ` +
            `chainId=${info.chainId}，与 SDK 的 chainId=${this.sdk.chainId} 不一致。`,
        )
      }
      return info
    })
  }

  /**
   * 拿到本次操作两种代币的元数据（用于填 meta 的 `ui*` 与 `token0/token1`）。
   *
   * 优先级：调用方自带 > 快照里的地址 > 读一次 `positions` 拿地址。
   * 拿到地址后走核心 `chain.getTokenInfoList`（进程级缓存，热路径 0 RPC）。
   */
  private async resolveTokenPair(args: {
    given?: [ITokenInfo, ITokenInfo]
    poolState?: IPoolStateRaw
    positionState?: IPositionStateRaw
    tokenId?: bigint
    /**
     * 调用方另外提供的、**不成对**的元数据（批量领费的 `tokens`）。
     * 走作用域表而不是核心的共享缓存 —— 理由见 {@link clientWith}。
     */
    scoped?: readonly ITokenInfo[]
  }): Promise<[ITokenInfo, ITokenInfo]> {
    const chain =
      args.scoped && args.scoped.length > 0
        ? buildTokenScopedChain(this.sdk.chain, args.scoped)
        : this.sdk.chain
    const known0 = args.poolState?.token0 ?? args.positionState?.token0
    const known1 = args.poolState?.token1 ?? args.positionState?.token1

    if (args.given) {
      // 交叉校验：元数据传错代币时 ui 金额会整体偏 10^n 倍，
      // 这种错误在界面上「看起来只是数字大了点」，不当场挡住基本发现不了。
      //
      // 快照没给时**不能就这么放行** —— collectFees 最省 RPC 的那条路径
      //（只传 token 元数据、不传快照）恰恰会落到这里，而它正是最需要校验的：
      // 全程只有一次 collect staticcall，没有任何其它环节能发现代币对错了。
      // 所以这里宁可多读一次 `positions(tokenId)` 也要把参照物拿到手：
      // 这是读链版，本来就在发 RPC，多一次换一个「不会显示错金额」的保证是划算的。
      let ref0 = known0
      let ref1 = known1
      if ((!ref0 || !ref1) && args.tokenId !== undefined) {
        const state = await chain.getRawPositionInfo(args.tokenId)
        ref0 = state.token0
        ref1 = state.token1
      }

      if (ref0 && ref1) {
        const pair = [args.given[0].address, args.given[1].address]
        const matched = pair.some((a) => sameAddress(a, ref0)) && pair.some((a) => sameAddress(a, ref1))
        if (!matched) {
          throw new Error(
            `${COMPAT_ERR_PREFIX} 传入的代币元数据（${pair.join(' / ')}）与这个仓位/池子实际的两种代币` +
              `（${ref0} / ${ref1}）对不上，拒绝用它换算展示金额 —— ` +
              'decimals 用错一位，界面上的金额就会差 10 倍。请核对 token0 / token1（旧名 mintA / mintB）。',
          )
        }
      }
      return args.given
    }

    let address0 = known0
    let address1 = known1
    if (!address0 || !address1) {
      if (args.tokenId === undefined) {
        throw new Error(
          `${COMPAT_ERR_PREFIX} 内部错误：既没有代币元数据 / 快照，也没有 tokenId，无法确定这个仓位属于哪两种代币。`,
        )
      }
      const state = await chain.getRawPositionInfo(args.tokenId)
      address0 = state.token0
      address1 = state.token1
    }

    const [t0, t1] = await chain.getTokenInfoList([address0, address1])
    return [t0, t1]
  }

  /**
   * 拿一个「优先用调用方给的代币元数据」的核心写客户端。
   *
   * 没给元数据时直接复用 `sdk.clmmClient`（零开销）；给了就现造一个挂在
   * {@link buildTokenScopedChain} 代理上的 `CLMMClient` —— 元数据的作用域**只到这一次调用**。
   *
   * 早先这里的做法是把元数据塞进核心 `Chain` 的 `tokenInfoCache`（实例级、跨调用持久），
   * 那样一次错误输入会污染整个 session 的所有读链路径，而且是静默的。
   * `offchain.ts` 早就为同样的风险用了作用域代理，这里对齐同一套做法。
   */
  private clientWith(tokens: readonly ITokenInfo[]): CLMMClient {
    if (tokens.length === 0) return this.sdk.clmmClient
    return new CLMMClient({ chain: buildTokenScopedChain(this.sdk.chain, tokens) })
  }
}
