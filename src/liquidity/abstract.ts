/**
 * 流动性动作层的抽象基类：声明 createPosition / addLiquidity / decreaseLiquidity /
 * collectFees / closePosition 五个写操作。留一层抽象是为将来接自研合约的变体实现。
 * 与 Solana 版的对照见 docs/core.md。
 */
import type { Address } from 'viem'

import type { Chain } from '../chain/index.js'
import type {
  IAddLiquidityParams,
  IClosePositionParams,
  ICollectFeesParams,
  ICreatePositionParams,
  IDecreaseLiquidityParams,
  IDecreaseMeta,
  ILiquidityMeta,
  IPendingFees,
  ITokenInfo,
  ITransactionReturn,
} from '../types.js'

/**
 * 开仓的 meta：在通用的 ILiquidityMeta 之上多带「这一笔到底打进了哪个池子、两种代币是谁」。
 * 开仓时前端手里通常只有 poolAddress，token0/token1 的顺序与精度是 SDK 读链才知道的，
 * 因此顺手回传，省得前端再查一次。
 */
export interface ICreatePositionMeta extends ILiquidityMeta {
  poolAddress: Address
  token0: ITokenInfo
  token1: ITokenInfo
}

export abstract class AbstractLiquidityClient {
  /** 链上直读层：前置读 fresh state、读 token 元数据都从这里走 */
  protected _chain: Chain

  constructor(params: { chain: Chain }) {
    this._chain = params.chain
  }

  /**
   * 开仓（mint 一个新的仓位 NFT）。
   * 产出 0~2 笔前置 approve + 1 笔 `NPM.mint`。
   */
  abstract createPosition(params: ICreatePositionParams): Promise<ITransactionReturn<ICreatePositionMeta>>

  /**
   * 往已有仓位追加流动性（**不能改区间**，区间以链上仓位为准）。
   * 产出 0~2 笔前置 approve + 1 笔 `NPM.increaseLiquidity`。
   */
  abstract addLiquidity(params: IAddLiquidityParams): Promise<ITransactionReturn<ILiquidityMeta>>

  /**
   * 按比例 / 按流动性数量减仓。
   * 默认把 `decreaseLiquidity + collect` 打成一笔 multicall。
   */
  abstract decreaseLiquidity(params: IDecreaseLiquidityParams): Promise<ITransactionReturn<IDecreaseMeta>>

  /**
   * 提取手续费（以及之前 decrease 撤出、尚未领走的本金）。
   * 产出 1 笔 `NPM.collect`。
   */
  abstract collectFees(params: ICollectFeesParams): Promise<ITransactionReturn<IPendingFees>>

  /**
   * 关仓：撤出全部流动性 + 提取 + 销毁仓位 NFT，**一笔原子 multicall**。
   */
  abstract closePosition(params: IClosePositionParams): Promise<ITransactionReturn<IDecreaseMeta>>
}
