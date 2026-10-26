/**
 * compat 层门面：`new ByrealClmmSdk({ chainId })`，结构对齐 Solana 版 `SdkClient`
 * （`sdk.chain.*` / `sdk.clmmClient.*`，顶层再暴露一层便捷透传）。
 *
 * 与核心 `EvmClmmSdk` 的关系：**包一层，不是替一层**。核心实例始终挂在 `sdk` 上，
 * compat 没覆盖到的能力（quoteSwap、getMintPrerequisites、chainConfig…）随时能从那里直接拿。
 * 新代码建议直接用核心 `EvmClmmSdk`；这个门面只为让迁移期的旧页面少改代码。
 */
import type { PublicClient } from 'viem'

import { EvmClmmSdk } from '../client.js'
import type {
  IClmmContracts,
  IEvmClmmSdkParams,
  IPoolStateRaw,
  IPositionStateRaw,
  ITokenInfo,
} from '../types.js'

import { CompatChain, type ICompatPositionInfoOptions } from './chain.js'
import { COMPAT_ERR_PREFIX, type Numericish } from './coerce.js'
import type { CompatCLMMClient } from './liquidity.js'
import type { ICompatPositionInfo } from './models.js'

/**
 * `ByrealClmmSdk` 的构造参数：**两种写法都收**。
 *
 * - `IEvmClmmSdkParams`（`{ chainId, rpcUrl?, contracts?, publicClient? }`）——
 *   门面自己 `new EvmClmmSdk(...)`，迁移期的旧页面改一个类名就能跑；
 * - `{ sdk }` —— 复用外部**已有**的核心实例。前端通常在 app 启动时就建好了一个
 *   `EvmClmmSdk`（连着 wagmi 的 publicClient、带着一整套池子/代币缓存），
 *   再造一个不仅浪费，两份缓存还会让 RPC 次数翻倍。
 */
export type IByrealClmmSdkParams = IEvmClmmSdkParams | { sdk: EvmClmmSdk }

/**
 * compat 层门面，结构对齐 Solana 版 `SdkClient`：`sdk.chain.*` / `sdk.clmmClient.*`，
 * 常用能力在顶层再透传一层（前端不用记住某个方法到底挂在哪个子对象上）。
 *
 * 定位是**迁移期的临时入口**，不是核心 SDK 的替代品：
 * 它只覆盖旧 Solana SDK 有对位概念的那部分能力，其余一律走 {@link ByrealClmmSdk.sdk}
 * 这个逃生口。新代码请直接用核心 `EvmClmmSdk`。
 *
 * 两处与旧版**有意不同**、且必须知道的：
 * - `api` / `token` 恒为 `undefined`（不是报错），理由见这两个字段自己的 JSDoc；
 * - 不传滑点时用的是 `COMPAT_DEFAULT_SLIPPAGE_BPS`（200 bps，对齐 Solana 版），
 *   而核心 `EvmClmmSdk` 是 50 bps —— 同一份业务代码换个入口，默认滑点会变。
 */
export class ByrealClmmSdk {
  /**
   * 原生核心 SDK —— **逃生口**。
   * compat 只覆盖旧 Solana SDK 有对位概念的那部分能力；其余（询价、前置读、链配置）
   * 一律走 `byreal.sdk.*`，而不是在 compat 里再包一层永远追不齐的转发。
   */
  readonly sdk: EvmClmmSdk

  /** 读操作 + `.offchain`（快照注入版写操作）。对齐旧 `sdk.chain.*` */
  readonly chain: CompatChain

  /** 读链版写操作。对齐旧 `sdk.clmmClient.*`；与 `chain.clmmClient` 是同一个实例 */
  readonly clmmClient: CompatCLMMClient

  /** 目标链 id（= `sdk.chainId`） */
  readonly chainId: number

  /** viem 只读客户端（= `sdk.publicClient`），前端要自己发 eth_call 时直接用它 */
  readonly publicClient: PublicClient

  /** 本链的 CLMM 合约地址集合（= `sdk.contracts`） */
  readonly contracts: IClmmContracts

  /**
   * 恒为 `undefined`，**刻意不提供**。
   *
   * 旧 Solana `SdkClient` 上的 `api` 是后端 REST 客户端；EVM SDK 只做链上读写与本地数学，
   * 不内置任何后端客户端。
   *
   * 声明成 `undefined` 而不是干脆不写这个字段，是为了让旧代码 `sdk.api` 在 IDE 里
   * 能直接看到这段说明，而不是只得到一个「属性不存在」。池子/仓位列表请直接调用
   * Byreal 后端接口，详见 docs/compat.md。
   */
  readonly api: undefined = undefined

  /**
   * 恒为 `undefined`，**刻意不提供**。
   *
   * 旧版 `sdk.token` 是通用 ERC20/SPL 工具（余额、ATA、wrap）。EVM 上 ATA 概念不存在，
   * 余额与 approve 是调用方钱包层的事，核心 `EvmClmmSdk` 同样没有这个成员。
   * 单个代币的元数据请用 `chain.getTokenInfoByMint(address)`。
   */
  readonly token: undefined = undefined

  constructor(params: IByrealClmmSdkParams) {
    const injected = (params as { sdk?: EvmClmmSdk } | undefined)?.sdk

    if (injected) {
      this.sdk = injected
    } else {
      const plain = params as IEvmClmmSdkParams | undefined
      if (!plain || typeof plain.chainId !== 'number') {
        throw new Error(
          `${COMPAT_ERR_PREFIX} new ByrealClmmSdk(...) 的参数不合法：需要 ` +
            `{ chainId, rpcUrl?, contracts?, publicClient? }（自己建核心实例），` +
            `或 { sdk: EvmClmmSdk }（复用已有实例）。收到 ${String(params)}。` +
            `注意 chainId 是必填的 —— compat 层不猜链，猜错会把交易发到错误的网络上。`,
        )
      }
      this.sdk = new EvmClmmSdk(plain)
    }

    this.chain = new CompatChain({ sdk: this.sdk })
    // 与 chain 共用同一个写客户端实例，避免出现两份状态
    this.clmmClient = this.chain.clmmClient
    this.chainId = this.sdk.chainId
    this.publicClient = this.sdk.publicClient
    this.contracts = this.sdk.contracts
  }

  // =========================================================================
  // 顶层便捷透传 · 读（对齐旧 SdkClient：常用能力在门面上再暴露一层，
  // 前端不用记住某个方法到底挂在 chain 还是 clmmClient 上）
  // =========================================================================

  /** 读池子链上原始状态（旧名）。→ {@link CompatChain.getRawPoolInfoByPoolId} */
  async getRawPoolInfoByPoolId(id: string): Promise<IPoolStateRaw> {
    return this.chain.getRawPoolInfoByPoolId(id)
  }

  /** 读池子链上原始状态（短名）。→ {@link CompatChain.getRawPoolInfo} */
  async getRawPoolInfo(poolAddress: string): Promise<IPoolStateRaw> {
    return this.chain.getRawPoolInfo(poolAddress)
  }

  /** 读单个仓位的链上原始状态。→ {@link CompatChain.getRawPositionInfoByNftMint} */
  async getRawPositionInfoByNftMint(idish: Numericish): Promise<IPositionStateRaw> {
    return this.chain.getRawPositionInfoByNftMint(idish)
  }

  /** 读某地址名下全部仓位的原始状态。→ {@link CompatChain.getRawPositionInfoListByUserAddress} */
  async getRawPositionInfoListByUserAddress(userAddress: string): Promise<IPositionStateRaw[]> {
    return this.chain.getRawPositionInfoListByUserAddress(userAddress)
  }

  /** 列出某地址持有的仓位 tokenId（旧名，返回的是 bigint 而非 base58）。→ {@link CompatChain.getPositionNftMintListByUserAddress} */
  async getPositionNftMintListByUserAddress(userAddress: string): Promise<bigint[]> {
    return this.chain.getPositionNftMintListByUserAddress(userAddress)
  }

  /** 列出某地址持有的仓位 tokenId（短名）。→ {@link CompatChain.getPositionTokenIdListByOwner} */
  async getPositionTokenIdListByOwner(owner: string): Promise<bigint[]> {
    return this.chain.getPositionTokenIdListByOwner(owner)
  }

  /** 读单个 ERC20 元数据。→ {@link CompatChain.getTokenInfoByMint} */
  async getTokenInfoByMint(address: string): Promise<ITokenInfo> {
    return this.chain.getTokenInfoByMint(address)
  }

  /** 一站式仓位详情（仓位不存在返回 null）。→ {@link CompatChain.getPositionInfoByNftMint} */
  async getPositionInfoByNftMint(
    idish: Numericish,
    opts?: ICompatPositionInfoOptions,
  ): Promise<ICompatPositionInfo | null> {
    return this.chain.getPositionInfoByNftMint(idish, opts)
  }

  /** 批量仓位详情，Map key 为 `tokenId.toString()`。→ {@link CompatChain.getPositionInfoByNftMints} */
  async getPositionInfoByNftMints(
    list: Numericish[],
    opts?: ICompatPositionInfoOptions,
  ): Promise<Map<string, ICompatPositionInfo | null>> {
    return this.chain.getPositionInfoByNftMints(list, opts)
  }

  // =========================================================================
  // 顶层便捷透传 · 写
  //
  // 与 CompatChain 里一样，签名用 Parameters/ReturnType 从 CompatCLMMClient 取，
  // 不在门面上重抄一遍 —— 抄出来的那份一旦漂移，产出的就是错误的 calldata。
  // =========================================================================

  /** 开仓（旧名）。→ {@link CompatCLMMClient.createPositionInstructions} */
  createPositionInstructions(
    ...args: Parameters<CompatCLMMClient['createPositionInstructions']>
  ): ReturnType<CompatCLMMClient['createPositionInstructions']> {
    return this.clmmClient.createPositionInstructions(...args)
  }

  /** 开仓（短名）。→ {@link CompatCLMMClient.createPosition} */
  createPosition(
    ...args: Parameters<CompatCLMMClient['createPosition']>
  ): ReturnType<CompatCLMMClient['createPosition']> {
    return this.clmmClient.createPosition(...args)
  }

  /** 加仓（旧名）。→ {@link CompatCLMMClient.addLiquidityInstructions} */
  addLiquidityInstructions(
    ...args: Parameters<CompatCLMMClient['addLiquidityInstructions']>
  ): ReturnType<CompatCLMMClient['addLiquidityInstructions']> {
    return this.clmmClient.addLiquidityInstructions(...args)
  }

  /** 加仓（短名）。→ {@link CompatCLMMClient.addLiquidity} */
  addLiquidity(
    ...args: Parameters<CompatCLMMClient['addLiquidity']>
  ): ReturnType<CompatCLMMClient['addLiquidity']> {
    return this.clmmClient.addLiquidity(...args)
  }

  /** 减仓（旧名）。→ {@link CompatCLMMClient.decreaseLiquidityInstructions} */
  decreaseLiquidityInstructions(
    ...args: Parameters<CompatCLMMClient['decreaseLiquidityInstructions']>
  ): ReturnType<CompatCLMMClient['decreaseLiquidityInstructions']> {
    return this.clmmClient.decreaseLiquidityInstructions(...args)
  }

  /** 减仓（短名）。→ {@link CompatCLMMClient.decreaseLiquidity} */
  decreaseLiquidity(
    ...args: Parameters<CompatCLMMClient['decreaseLiquidity']>
  ): ReturnType<CompatCLMMClient['decreaseLiquidity']> {
    return this.clmmClient.decreaseLiquidity(...args)
  }

  /** 撤出全部流动性（旧名）。→ {@link CompatCLMMClient.decreaseFullLiquidityInstructions} */
  decreaseFullLiquidityInstructions(
    ...args: Parameters<CompatCLMMClient['decreaseFullLiquidityInstructions']>
  ): ReturnType<CompatCLMMClient['decreaseFullLiquidityInstructions']> {
    return this.clmmClient.decreaseFullLiquidityInstructions(...args)
  }

  /** 撤出全部流动性（短名）。→ {@link CompatCLMMClient.decreaseFullLiquidity} */
  decreaseFullLiquidity(
    ...args: Parameters<CompatCLMMClient['decreaseFullLiquidity']>
  ): ReturnType<CompatCLMMClient['decreaseFullLiquidity']> {
    return this.clmmClient.decreaseFullLiquidity(...args)
  }

  /** 撤出全部流动性（旧代码里的另一个别名）。→ {@link CompatCLMMClient.removeFullLiquidity} */
  removeFullLiquidity(
    ...args: Parameters<CompatCLMMClient['removeFullLiquidity']>
  ): ReturnType<CompatCLMMClient['removeFullLiquidity']> {
    return this.clmmClient.removeFullLiquidity(...args)
  }

  /** 关仓（旧名）。→ {@link CompatCLMMClient.closePositionInstructions} */
  closePositionInstructions(
    ...args: Parameters<CompatCLMMClient['closePositionInstructions']>
  ): ReturnType<CompatCLMMClient['closePositionInstructions']> {
    return this.clmmClient.closePositionInstructions(...args)
  }

  /** 关仓（短名）。→ {@link CompatCLMMClient.closePosition} */
  closePosition(
    ...args: Parameters<CompatCLMMClient['closePosition']>
  ): ReturnType<CompatCLMMClient['closePosition']> {
    return this.clmmClient.closePosition(...args)
  }

  /** 领取手续费（旧名）。→ {@link CompatCLMMClient.collectFeesInstructions} */
  collectFeesInstructions(
    ...args: Parameters<CompatCLMMClient['collectFeesInstructions']>
  ): ReturnType<CompatCLMMClient['collectFeesInstructions']> {
    return this.clmmClient.collectFeesInstructions(...args)
  }

  /** 领取手续费（短名）。→ {@link CompatCLMMClient.collectFees} */
  collectFees(
    ...args: Parameters<CompatCLMMClient['collectFees']>
  ): ReturnType<CompatCLMMClient['collectFees']> {
    return this.clmmClient.collectFees(...args)
  }

  /** 一次领完多个仓位的手续费（旧名）。→ {@link CompatCLMMClient.collectAllPositionFeesInstructions} */
  collectAllPositionFeesInstructions(
    ...args: Parameters<CompatCLMMClient['collectAllPositionFeesInstructions']>
  ): ReturnType<CompatCLMMClient['collectAllPositionFeesInstructions']> {
    return this.clmmClient.collectAllPositionFeesInstructions(...args)
  }

  /** 一次领完多个仓位的手续费（短名）。→ {@link CompatCLMMClient.collectAllFees} */
  collectAllFees(
    ...args: Parameters<CompatCLMMClient['collectAllFees']>
  ): ReturnType<CompatCLMMClient['collectAllFees']> {
    return this.clmmClient.collectAllFees(...args)
  }
}
