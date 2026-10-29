/**
 * SDK 门面（`new EvmClmmSdk({ chainId, rpcUrl })`）：结构对齐 Solana 版 `SdkClient`
 * （`sdk.chain.*` / `sdk.clmmClient.*` / `sdk.rewardClient.*`）。顶层再暴露一层便捷透传，前端不用记方法挂在哪一层。
 *
 * 没有 `api` 成员（池子 / 仓位列表等走 Byreal 后端接口，由调用方自行接入）；也没有通用 ERC20 工具（余额 / 授权由调用方钱包层处理）。
 * 与 Solana 版的对照见 docs/core.md。
 */
import { createPublicClient, defineChain, http, HttpRequestError, type Address, type HttpTransport, type PublicClient } from 'viem'

import { ExtraFeeClass } from './raw/index.js'
import { Chain } from './chain/index.js'
import { DEFAULT_PROFILE_ID, resolveProfileConfig } from './constants.js'
import { CLMMClient } from './liquidity/clmm.js'
import { RewardClient } from './reward/index.js'
import type {
  IAddLiquidityParams,
  IChainConfig,
  IClaimRewardsParams,
  IClmmContracts,
  IClosePositionParams,
  ICollectFeesParams,
  ICreatePositionParams,
  IDecreaseLiquidityParams,
  DeploymentProfileId,
  IEvmClmmSdkParams,
  IPendingFees,
  IPoolStateRaw,
  IQuoteSwapParams,
  IQuoteSwapReturn,
  IRewardKey,
} from './types.js'

const createObservedHttpTransport = (
  rpcUrl: string,
  onRpcHttpError?: IEvmClmmSdkParams['onRpcHttpError'],
): HttpTransport => {
  const baseTransport = http(rpcUrl)
  if (!onRpcHttpError) return baseTransport

  return (options) => {
    const transport = baseTransport(options)
    const request: typeof transport.request = async (args, requestOptions) => {
      try {
        return await transport.request(args, requestOptions)
      } catch (error) {
        const httpStatus = error instanceof HttpRequestError ? error.status : undefined
        if (httpStatus !== undefined && httpStatus >= 400 && httpStatus <= 599) {
          // 监控回调不能改变 SDK 请求结果，也不能让已成功的重试被计入失败。
          try {
            onRpcHttpError({ rpcMethod: args.method, httpStatus })
          } catch {}
        }
        throw error
      }
    }
    return { ...transport, request }
  }
}

export class EvmClmmSdk {
  /** 目标链 id */
  readonly chainId: number

  /** 实际使用的部署环境（构造时没给就是 `'prod'`） */
  readonly profileId: DeploymentProfileId

  /** 解析后的完整部署配置（内置注册表 + 构造时的 overrides） */
  readonly chainConfig: IChainConfig & { contracts: IClmmContracts }

  /** 本链上 CLMM 相关的合约地址集合（= chainConfig.contracts 的快捷方式） */
  readonly contracts: IClmmContracts

  /** viem 只读客户端：外部传进来就复用（前端场景），否则按 chainConfig 现造一个 */
  readonly publicClient: PublicClient

  /** 链上直读层：池子 / 仓位 / pending fee / 询价 / 写主干前置读 */
  readonly chain: Chain

  /** 流动性动作层：开仓 / 加仓 / 减仓 / 领费 / 关仓，只产出未签名交易 */
  readonly clmmClient: CLMMClient

  /** 奖励领取层：凭后端签发的凭证从 RewardClaimVault 领奖励，只产出未签名交易 */
  readonly rewardClient: RewardClient

  /**
   * 构造时定下的默认额外费率档位（0 = Alpha、1 = Dex）。
   * 合约的 swap / quote 全链路必带档位；quoteSwap 可逐调用覆盖。
   */
  readonly extraFeeClass: ExtraFeeClass

  constructor(params: IEvmClmmSdkParams) {
    const { chainId, profileId, rpcUrl, contracts, publicClient, onRpcHttpError, extraFeeClass = ExtraFeeClass.DEX } = params

    if (extraFeeClass !== 0 && extraFeeClass !== 1) {
      throw new Error(
        `[evm-clmm-sdk] extraFeeClass 只能是 0（Alpha）或 1（Dex），收到 ${String(extraFeeClass)}。`,
      )
    }
    this.extraFeeClass = extraFeeClass

    this.chainConfig = resolveProfileConfig(profileId ?? DEFAULT_PROFILE_ID, { rpcUrl, contracts })
    // chainId 必须与部署所在链一致，防止把交易发到错误的网络
    if (this.chainConfig.chainId !== chainId) {
      throw new Error(
        `[evm-clmm-sdk] ${this.chainConfig.label}（profileId='${this.chainConfig.profileId}'）在 ` +
          `chainId=${this.chainConfig.chainId} 上，与传入的 chainId=${chainId} 不一致。`,
      )
    }
    this.chainId = this.chainConfig.chainId
    this.profileId = this.chainConfig.profileId
    this.contracts = this.chainConfig.contracts

    // 用 defineChain 从注册表现场组装链定义，不依赖 viem/chains
    this.publicClient = publicClient ?? (createPublicClient({
      chain: defineChain({
        id: this.chainConfig.chainId,
        name: this.chainConfig.name,
        nativeCurrency: this.chainConfig.nativeCurrency,
        rpcUrls: { default: { http: [this.chainConfig.rpcUrl] } },
        blockExplorers: this.chainConfig.explorer
          ? { default: { name: `${this.chainConfig.name} Explorer`, url: this.chainConfig.explorer } }
          : undefined,
        contracts: this.contracts.multicall3
          ? { multicall3: { address: this.contracts.multicall3 } }
          : undefined,
      }),
      transport: createObservedHttpTransport(this.chainConfig.rpcUrl, onRpcHttpError),
    }) as PublicClient)

    this.chain = new Chain({
      publicClient: this.publicClient,
      chainId: this.chainId,
      contracts: this.contracts,
      extraFeeClass,
    })
    this.clmmClient = new CLMMClient({ chain: this.chain })
    this.rewardClient = new RewardClient({ chain: this.chain })
  }

  // =========================================================================
  // 顶层便捷透传（对齐 Solana 版 SdkClient：常用能力在门面上再暴露一层，
  // 前端不用记住某个方法到底挂在 chain 还是 clmmClient 上）
  // =========================================================================

  /** 读池子的链上原始状态（slot0 + liquidity + feeGrowth + 不变字段）。→ chain.getRawPoolInfo */
  async getRawPoolInfoByPoolAddress(poolAddress: Address): Promise<IPoolStateRaw> {
    return this.chain.getRawPoolInfo(poolAddress)
  }

  /** 列出某地址持有的全部仓位 tokenId。→ chain.getPositionTokenIdListByOwner */
  async getPositionTokenIdListByOwner(owner: Address): Promise<bigint[]> {
    return this.chain.getPositionTokenIdListByOwner(owner)
  }

  /** 取某仓位精确的待领手续费（collect staticcall，含未结算部分）。→ chain.getPendingFees */
  async getPendingFees(params: { tokenId: bigint; owner: Address; recipient?: Address }): Promise<IPendingFees> {
    return this.chain.getPendingFees(params)
  }

  /** 单池询价（ByrealQuoter staticcall，必带 extraFeeClass，缺省用构造时的档位）。→ chain.quoteSwap */
  async quoteSwap(params: IQuoteSwapParams): Promise<IQuoteSwapReturn> {
    return this.chain.quoteSwap(params)
  }

  /** 开仓（mint）。→ clmmClient.createPosition */
  async createPosition(params: ICreatePositionParams) {
    return this.clmmClient.createPosition(params)
  }

  /** 加流动性。→ clmmClient.addLiquidity */
  async addLiquidity(params: IAddLiquidityParams) {
    return this.clmmClient.addLiquidity(params)
  }

  /** 减仓（默认 decrease + collect 一笔 multicall）。→ clmmClient.decreaseLiquidity */
  async decreaseLiquidity(params: IDecreaseLiquidityParams) {
    return this.clmmClient.decreaseLiquidity(params)
  }

  /** 提取手续费。→ clmmClient.collectFees */
  async collectFees(params: ICollectFeesParams) {
    return this.clmmClient.collectFees(params)
  }

  /** 关仓（decrease 全部 + collect + burn，一笔原子交易）。→ clmmClient.closePosition */
  async closePosition(params: IClosePositionParams) {
    return this.clmmClient.closePosition(params)
  }

  /** 批量读奖励账本的已领累计额，与 keys 一一对应。→ chain.getRewardClaimedAmountList */
  async getRewardClaimedAmountList(keys: readonly IRewardKey[]): Promise<bigint[]> {
    return this.chain.getRewardClaimedAmountList(keys)
  }

  /** 凭签名凭证领取奖励（1 张 claim / 多张 claimBatch）。→ rewardClient.claimRewards */
  async claimRewards(params: IClaimRewardsParams) {
    return this.rewardClient.claimRewards(params)
  }
}
