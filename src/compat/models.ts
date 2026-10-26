/**
 * compat 层的对外类型：在核心 SDK 的返回契约之上，补两样东西 ——
 *
 * 1. **Solana 形状的字段别名**（`instructions` / `transaction` / `signers`），
 *    让旧页面的解构写法不用改就能编译过；
 * 2. **`ui*` 展示字符串与 token 元数据**，对齐旧 Solana SDK「meta 里啥都有」的习惯，
 *    省掉前端在每个页面自己 formatUnits 一遍。
 *
 * 核心原则仍然是「不给两个可能不一致的真相源」：所有别名都是**同一个对象的引用**，
 * 不是深拷贝；所有 `ui*` 都由同一个 `toUiAmount` 生成。
 */
import type { Address } from 'viem'

import type {
  IDecreaseMeta,
  ILiquidityMeta,
  IPendingFees,
  IPoolStateRaw,
  IPositionStateRaw,
  ITokenInfo,
  IUnsignedTx,
} from '../types.js'

// ---------------------------------------------------------------------------
// 4.1 · 写操作统一返回
// ---------------------------------------------------------------------------

/**
 * compat 所有写操作的统一返回。
 *
 * 前三个字段是 EVM 原生形状（与核心 `ITransactionReturn` 完全一致，新代码请用这三个）；
 * 后三个是 Solana 形状的**别名**，只为迁移期让旧的解构写法 `const { instructions } = ...`
 * 继续编译通过。别名指向同一批对象，不会出现「改了 transactions 但 instructions 还是旧的」。
 */
export interface ICompatTransactionReturn<M> {
  // —— EVM 原生（推荐新代码用）——
  /** 按顺序发送的完整交易列表，可能含 0~2 笔前置 approve */
  transactions: IUnsignedTx[]
  /** 主交易（= transactions 的最后一笔） */
  main: IUnsignedTx
  /** 本地算好的中间量，供 UI 展示与自测断言 */
  meta: M

  // —— Solana 形状别名（迁移期用，指向同一批对象，不是副本）——
  /** = transactions。Solana 版这里是 TransactionInstruction[]；EVM 上一笔未签名交易就是最小可发送单元 */
  instructions: IUnsignedTx[]
  /** = main。Solana 版这里是已组装的 VersionedTransaction；EVM 上签名与广播都在 SDK 之外 */
  transaction: IUnsignedTx
  /** 恒为 undefined。EVM 没有「额外签名者」的概念，保留字段只为让旧的解构写法不报错 */
  signers: undefined
}

// ---------------------------------------------------------------------------
// 4.3 · meta 增强（先定义 meta，4.2 的开仓返回要用）
// ---------------------------------------------------------------------------

/**
 * 开仓 / 加仓的 meta：核心 `ILiquidityMeta` + token 元数据 + `ui*` 字符串 + 实际生效滑点。
 *
 * `slippageBps` 一定要回传：调用方传的是旧口径小数 `slippage: 0.02` 时，
 * 这里是换算后的 `200`，前端可以直接拿它跟自己的预期核对 —— 这是 §2 那处量纲陷阱的
 * 「事后可验证」出口，比只在报错时提醒更可靠。
 */
export interface ICompatLiquidityMeta extends ILiquidityMeta {
  token0: ITokenInfo
  token1: ITokenInfo
  uiAmount0Desired: string
  uiAmount1Desired: string
  uiAmount0Min: string
  uiAmount1Min: string
  /** 实际生效的滑点，基点。调用方传 slippage 小数时这里是换算后的值，便于核对 */
  slippageBps: number
}

/**
 * 开仓专用 meta：在 {@link ICompatLiquidityMeta} 之上多带 `poolAddress`。
 *
 * 结构上是核心 `ICreatePositionMeta`（= ILiquidityMeta + poolAddress + token0/token1）的超集，
 * 因此可以直接把核心返回的 meta 铺开再补 `ui*` 字段，不需要重新组装。
 */
export interface ICompatCreatePositionMeta extends ICompatLiquidityMeta {
  poolAddress: Address
}

/** 减仓 / 关仓的 meta：核心 `IDecreaseMeta` + token 元数据 + `ui*` 字符串 + 实际生效滑点 */
export interface ICompatDecreaseMeta extends IDecreaseMeta {
  token0: ITokenInfo
  token1: ITokenInfo
  uiExpectedAmount0: string
  uiExpectedAmount1: string
  uiAmount0Min: string
  uiAmount1Min: string
  slippageBps: number
}

/** 领取手续费的 meta：核心 `IPendingFees` + token 元数据 + `ui*` 字符串 */
export interface ICompatPendingFees extends IPendingFees {
  token0: ITokenInfo
  token1: ITokenInfo
  uiAmount0: string
  uiAmount1: string
}

// ---------------------------------------------------------------------------
// 4.2 · 开仓返回的 nftAddress 缺口
// ---------------------------------------------------------------------------

/**
 * 开仓返回。
 *
 * 与 Solana 版**唯一无法抹平**的结构性差异在这里：Solana 的 `createPositionInstructions`
 * 在发交易前就能返回 `nftAddress`（keypair 是链下生成的），而 EVM 的 `tokenId` 由
 * `NonfungiblePositionManager` 在 mint 交易**上链时**自增分配，发交易前不可知。
 */
export interface ICompatCreatePositionReturn
  extends ICompatTransactionReturn<ICompatCreatePositionMeta> {
  /**
   * 恒为 null —— EVM 的 tokenId 要等 mint 交易上链后才知道。
   * 交易确认后用 `parseTokenIdFromReceipt(receipt)` 从 Transfer 事件里取。
   *
   * 之所以是 `null` 而不是省略该字段：旧代码 `const { nftAddress } = await ...` 拿到
   * 一个明确的 `null`（而不是 `undefined`）时，配合这段 JSDoc 能立刻定位到正确做法；
   * 省略字段则会一路 `undefined` 传下去，直到某个远处的 UI 崩掉。
   */
  nftAddress: null
  /** 同 nftAddress，EVM 语义下的字段名 */
  tokenId: null
}

/** 加仓返回（meta 为 {@link ICompatLiquidityMeta}） */
export type ICompatAddLiquidityReturn = ICompatTransactionReturn<ICompatLiquidityMeta>

/** 减仓 / 关仓返回（meta 为 {@link ICompatDecreaseMeta}） */
export type ICompatDecreaseReturn = ICompatTransactionReturn<ICompatDecreaseMeta>

/** 领取手续费返回（meta 为 {@link ICompatPendingFees}） */
export type ICompatCollectFeesReturn = ICompatTransactionReturn<ICompatPendingFees>

// ---------------------------------------------------------------------------
// 4.4 · 仓位详情（对齐旧 IGetPositionInfoByNftMintReturn）
// ---------------------------------------------------------------------------

/**
 * 仓位详情里「一边代币」的视图。
 *
 * `feeAmount` 用 `bigint | null` 而不是默认 `0n`：旧版 Solana SDK 是链下复现 feeGrowth
 * 算出来的、恒有值；EVM 上手续费要么走 collect staticcall（1 次 RPC），要么由后端下发。
 * **拿不到就是拿不到** —— 返回 0 会让 UI 显示「无手续费可领」，那是会让用户损失钱的假数据。
 */
export interface ICompatPositionSide {
  address: Address
  decimals: number
  symbol: string
  /** 本金（不含未领手续费） */
  amount: bigint
  /** 未领手续费。拿不到时（未传 pendingFees 且未读链）为 null，不编 0 */
  feeAmount: bigint | null
  uiAmount: string
  uiFeeAmount: string | null
}

/**
 * 仓位详情，对齐旧版 `IGetPositionInfoByNftMintReturn` 的字段形状。
 *
 * 价格统一用**已格式化的字符串**（8 位有效数字，与核心 calculate 层同口径）：
 * 旧版同时给 Decimal 与 ui 字符串两份，两份口径一旦不一致就会出现「详情页和列表页价格对不上」，
 * 这里只留一个真相源。
 */
export interface ICompatPositionInfo {
  tokenId: bigint
  poolAddress: Address
  tickLower: number
  tickUpper: number
  liquidity: bigint
  inRange: boolean
  isFullRange: boolean

  // 价格：旧版是 Decimal + ui 字符串两份；这里统一 string（已按 8 位有效数字格式化）
  priceLower: string
  priceUpper: string
  currentPrice: string
  /** = priceLower。旧版字段名，保留以减少改动 */
  uiPriceLower: string
  /** = priceUpper。旧版字段名，保留以减少改动 */
  uiPriceUpper: string

  token0: ICompatPositionSide
  token1: ICompatPositionSide
  /** = token0（**同一个对象引用**，不是深拷贝）。EVM 上 A 恒等于 token0（池子内按地址升序），别名安全 */
  tokenA: ICompatPositionSide
  /** = token1（同一个对象引用） */
  tokenB: ICompatPositionSide

  /** 原始快照原样回传：调用方要自己再算点什么时不用重新拉一次 */
  rawPositionInfo: IPositionStateRaw
  rawPoolInfo: IPoolStateRaw
}

// ---------------------------------------------------------------------------
// 组装帮手（compat 内部各写操作共用，避免四处各写一份别名拼装）
// ---------------------------------------------------------------------------

/**
 * 把核心 SDK 的 `{ transactions, main }` + compat 增强过的 meta，组装成
 * {@link ICompatTransactionReturn}。
 *
 * 抽成函数而不是让每个写方法各自拼一遍对象字面量，是为了从**结构上**保证
 * 「`instructions` 与 `transactions` 是同一个数组引用、`transaction` 与 `main` 是同一个对象」——
 * 手拼时很容易顺手写成 `[...transactions]`，那就变成了两份可能不一致的真相源。
 */
export function toCompatTransactionReturn<M>(
  core: { transactions: IUnsignedTx[]; main: IUnsignedTx },
  meta: M,
): ICompatTransactionReturn<M> {
  const { transactions, main } = core
  return {
    transactions,
    main,
    meta,
    instructions: transactions,
    transaction: main,
    signers: undefined,
  }
}

/**
 * {@link toCompatTransactionReturn} 的开仓版：额外钉上恒为 `null` 的 `nftAddress` / `tokenId`。
 *
 * 单独给一个函数是为了让「开仓返回必须显式带 null」这件事**无法被忘记** ——
 * 忘了写这两个字段，旧代码解构出来就是 `undefined`，而 `undefined` 与 `null` 在这里
 * 是两种完全不同的信号（见 {@link ICompatCreatePositionReturn.nftAddress}）。
 */
export function toCompatCreatePositionReturn(
  core: { transactions: IUnsignedTx[]; main: IUnsignedTx },
  meta: ICompatCreatePositionMeta,
): ICompatCreatePositionReturn {
  return { ...toCompatTransactionReturn(core, meta), nftAddress: null, tokenId: null }
}
