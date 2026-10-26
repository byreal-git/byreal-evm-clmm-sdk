/**
 * SDK 对外类型契约（EVM CLMM / Uniswap V3 式）。
 * 字段名向 EVM event/合约看齐；链上数值一律 bigint，展示值另给 `ui*` 字符串。
 */
import type { Address, Hex, PublicClient } from 'viem'
import type { ExtraFeeClass } from './raw/index.js'

// ---------------------------------------------------------------------------
// 链与合约配置
// ---------------------------------------------------------------------------

/**
 * 一条 EVM 链上 Byreal CLMM 相关的合约地址集合。
 * ⚠️ NPM 必须用 **proxy** 地址，禁止使用 implementation 地址。
 */
export interface IClmmContracts {
  /** PoolBeaconFactory（池子注册表 + 建池入口） */
  factory: Address
  /** NonfungiblePositionManager proxy（仓位 ERC-721 + 增删流动性入口） */
  positionManager: Address
  /** ByrealQuoter（询价 staticcall；struct 带 tickSpacing + extraFeeClass） */
  quoter: Address
  /** ByrealSwapRouter（swap，流动性管理用不到，仅作参照） */
  swapRouter?: Address
  /** Multicall3（批量只读聚合，缺省用官方通用地址） */
  multicall3?: Address
  /** 原生币包装合约（WETH / WMNT），开仓时把原生币换成 ERC20 要用 */
  weth: Address
}

/** 部署环境：`'test'` 测试环境（联调用）/ `'prod'` 生产环境（默认） */
export type DeploymentProfileId = 'test' | 'prod'

/** 一套部署的完整配置（解析后的形状） */
export interface IChainConfig {
  profileId: DeploymentProfileId
  chainId: number
  /** 链名（喂给 viem `defineChain`） */
  name: string
  /** 给人看的部署名，例如「Mantle 测试环境」，报错文案用它 */
  label: string
  rpcUrl: string
  explorer: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  contracts: Partial<IClmmContracts>
}

/** 内置注册表 `DEPLOYMENT_PROFILES` 里的一条记录 */
export interface IDeploymentProfileConfig extends IChainConfig {
  /** 合约是否已部署。`false` 时地址全零占位，解析时直接报错 */
  deployed: boolean
}

/** 构造 SDK 的参数 */
export interface IEvmClmmSdkParams {
  /** 必填：目标链 id（当前只支持 Mantle = 5000） */
  chainId: number
  /** 可选：部署环境，默认 `'prod'`；联调时传 `'test'` */
  profileId?: DeploymentProfileId
  /** 可选：额外费率档位；默认使用 Dex，只有明确需要 Alpha 时才覆盖。 */
  extraFeeClass?: ExtraFeeClass
  /** 可选：覆盖内置注册表里的 RPC */
  rpcUrl?: string
  /** 可选：覆盖/补全内置注册表里的合约地址（新链部署后从这里传） */
  contracts?: Partial<IClmmContracts>
  /** 可选：直接复用外部已有的 viem PublicClient（前端通常这么用） */
  publicClient?: PublicClient
  /** 可选：内建 HTTP transport 完成重试后仍返回 4xx/5xx 时通知调用方 */
  onRpcHttpError?: (event: { rpcMethod: string; httpStatus: number }) => void
}

// ---------------------------------------------------------------------------
// 链上原始状态（这些结构也可以由后端透传后喂给本地数学函数）
// ---------------------------------------------------------------------------

/** ERC20 代币元数据（对齐 sdk-core 的 Token 实体所需字段） */
export interface ITokenInfo {
  chainId: number
  address: Address
  decimals: number
  symbol: string
  name?: string
}

/**
 * 池子链上原始状态：Pool.slot0 + liquidity + feeGrowthGlobal + 费率/暂停等可变参数 + 不变字段。
 *
 * ⚠️ Byreal 定制合约的池身份键是 (token0, token1, tickSpacing)；
 * `tradeFeeRate` 是**链上随时可改的可变数据**，不参与身份、不许拿去当缓存键。
 */
export interface IPoolStateRaw {
  poolAddress: Address
  token0: Address
  token1: Address
  /** 池身份键第三元（不变） */
  tickSpacing: number
  /** 基础交易费率，ppm（500 = 0.05%）。可变，勿缓存、勿作身份键 */
  tradeFeeRate: number
  /** 协议费率，**百分比 0~100**（不是 ppm！），从 slot0 第 6 项读出 */
  protocolFeeRate: number
  /** 5 位暂停位图（1=SWAP 2=ADD 4=REMOVE 8=COLLECT 16=FLASH；具体见 byreal 的 PauseFlags） */
  pauseFlags: number
  /** swap 开闸时间（uint32 秒级时间戳，0 = 不限）。建池后不可改 */
  swapOpenTime: number
  /** Alpha 档额外费率，ppm */
  alphaExtraTradeFeeRate: number
  /** Dex 档额外费率，ppm */
  dexExtraTradeFeeRate: number
  /** 是否开启动态费率。开启时**离线报价不可用**（fail-closed），必须走 Quoter */
  dynamicFeeEnabled: boolean
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  feeGrowthGlobal0X128: bigint
  feeGrowthGlobal1X128: bigint
}

/** 仓位链上原始状态：NonfungiblePositionManager.positions(tokenId) 的原样映射 */
export interface IPositionStateRaw {
  tokenId: bigint
  nonce: bigint
  operator: Address
  token0: Address
  token1: Address
  /** 定制合约的 positions 第 5 项是 tickSpacing（原生 V3 此处是 fee） */
  tickSpacing: number
  tickLower: number
  tickUpper: number
  liquidity: bigint
  feeGrowthInside0LastX128: bigint
  feeGrowthInside1LastX128: bigint
  tokensOwed0: bigint
  tokensOwed1: bigint
}

/** collect staticcall 得到的精确待领手续费 */
export interface IPendingFees {
  amount0: bigint
  amount1: bigint
}

// ---------------------------------------------------------------------------
// 本地数学（纯函数、0 RPC）
// ---------------------------------------------------------------------------

/** 由「池 state + 仓位 state」本地算出来的仓位视图 */
export interface IPositionView {
  tokenId: bigint
  poolAddress: Address
  tickLower: number
  tickUpper: number
  liquidity: bigint
  /** 当前仓位对应的两种代币数量（不含未领手续费） */
  amount0: bigint
  amount1: bigint
  uiAmount0: string
  uiAmount1: string
  /** 价格一律表示为「1 token0 = ? token1」，与 tickToPrice 口径一致 */
  priceLower: string
  priceUpper: string
  currentPrice: string
  /** 当前池子 tick 是否落在 [tickLower, tickUpper) 内 */
  inRange: boolean
  /** 全区间仓位（tickLower/Upper 已到 tickSpacing 对齐后的极值） */
  isFullRange: boolean
}

/** 由一边金额反推另一边（开仓/加仓输入框联动用） */
export interface IAmountsFromAmountReturn {
  liquidity: bigint
  amount0: bigint
  amount1: bigint
  uiAmount0: string
  uiAmount1: string
}

/** APR 计算场景：新建、追加或已有仓位。 */
export type AprScene = 'create' | 'add' | 'exist'

/** 未输入确切双边金额时，按目标 USD 价值估算 APR。 */
export interface IEstimateAprParams {
  /** 24 小时手续费或奖励的 USD 价值。 */
  fee24hUsdValue: number
  token0PriceUsd: number
  token1PriceUsd: number
  tickLower: number
  tickUpper: number
  poolState: IPoolStateRaw
  token0: ITokenInfo
  token1: ITokenInfo
  /** 目标仓位的 USD 价值，默认 1。 */
  positionUsdValue?: number
  scene?: AprScene
  /** 追加流动性时，仓位原有的流动性。 */
  existLiquidity?: bigint
}

/** 根据确切双边金额计算 APR。 */
export interface ICalculateAprParams {
  /** 24 小时手续费或奖励的 USD 价值。 */
  fee24hUsdValue: number
  positionUsdValue: number
  amount0: bigint
  amount1: bigint
  tickLower: number
  tickUpper: number
  poolState: IPoolStateRaw
  token0: ITokenInfo
  token1: ITokenInfo
  scene?: AprScene
  /** 追加流动性时，仓位原有的流动性。 */
  existLiquidity?: bigint
}

// ---------------------------------------------------------------------------
// 写操作：SDK 只产出未签名交易，签名与广播都在 SDK 之外
// ---------------------------------------------------------------------------

/**
 * 一笔未签名交易。
 * 典型路径：SDK 产出 → 调用方交钱包签名 → 调用方广播（`eth_sendRawTransaction` 或钱包直接发送）。
 */
export interface IUnsignedTx {
  to: Address
  data: Hex
  value: bigint
  chainId: number
  /** 人类可读的用途标识，便于前端在多笔交易时给用户提示（如 "approve WETH"） */
  label: string
}

/**
 * 写操作的统一返回（对齐 Solana 版的 `IInstructionReturn`）。
 * - `transactions`：**按顺序**发送的完整交易列表，可能含前置 approve / wrap；
 * - `main`：主交易（= transactions 的最后一笔），方便只关心主交易的调用方；
 * - `meta`：本地算好的中间量（liquidity、amounts、min、deadline…），供 UI 展示与自测断言。
 */
export interface ITransactionReturn<M = Record<string, unknown>> {
  transactions: IUnsignedTx[]
  main: IUnsignedTx
  meta: M
}

/** 开仓 / 加仓这类需要投入两种代币的操作，本地算出来的关键中间量 */
export interface ILiquidityMeta {
  tickLower: number
  tickUpper: number
  liquidity: bigint
  amount0Desired: bigint
  amount1Desired: bigint
  amount0Min: bigint
  amount1Min: bigint
  deadline: bigint
  /** 本次是否插入了前置 approve（0~2 笔） */
  approvals: Array<{ token: Address; amount: bigint }>
}

/** 减仓 / 关仓本地算出来的关键中间量 */
export interface IDecreaseMeta {
  liquidity: bigint
  amount0Min: bigint
  amount1Min: bigint
  /** 预计撤回的本金（不含手续费） */
  expectedAmount0: bigint
  expectedAmount1: bigint
  deadline: bigint
}

// ---------------------------------------------------------------------------
// 各写操作的入参（命名对齐 Solana 版：I*Params）
// ---------------------------------------------------------------------------

/** 以 token0 还是 token1 为输入基准（对齐 Solana 的 'MintA' | 'MintB'） */
export type BaseSide = 'Token0' | 'Token1'

interface ICommonWriteParams {
  userAddress: Address
  /** 滑点，基点。默认 50 = 0.5% */
  slippageBps?: number
  /** deadline 相对当前时间的秒数，默认 1200 */
  deadlineSec?: number
}

export interface ICreatePositionParams extends ICommonWriteParams {
  poolAddress: Address
  tickLower: number
  tickUpper: number
  base: BaseSide
  /** 基准边的投入数量（最小单位） */
  baseAmount: bigint
  /** 仓位 NFT 的接收者，默认 userAddress */
  recipient?: Address
  /**
   * Byreal 定制合约独有：跟随建仓的目标仓位 tokenId，默认 0n = 不跟随。
   * ⚠️ 非 0 时合约会做五项强制校验（目标存在、有流动性、同池、tick 区间完全一致、不是自己），
   * 任一不满足整笔 revert——它不是备注字段。
   */
  followTokenId?: bigint
  /** allowance 不足时是否自动插入前置 approve 交易，默认 true */
  autoApprove?: boolean
  /**
   * 是否在构建交易时校验代币余额，默认 true。
   * 仅费用估算等不依赖当前资金状态的场景可关闭；真实交易必须保留校验。
   */
  validateBalance?: boolean
  /** 可选：外部已有的池子快照，传了就不再读链（省 1 次 RPC） */
  poolState?: IPoolStateRaw
}

export interface IAddLiquidityParams extends ICommonWriteParams {
  tokenId: bigint
  base: BaseSide
  baseAmount: bigint
  autoApprove?: boolean
  poolState?: IPoolStateRaw
  positionState?: IPositionStateRaw
}

export interface IDecreaseLiquidityParams extends ICommonWriteParams {
  tokenId: bigint
  /** 按百分比减仓（0~100）。与 liquidity 二选一 */
  percent?: number
  /** 直接指定要减掉的流动性数量。与 percent 二选一 */
  liquidity?: bigint
  /**
   * 是否在同一笔 multicall 里追加 collect，把撤出的本金 + 手续费直接打回钱包。
   * 默认 true —— Uniswap 的 decreaseLiquidity 只把本金记进 tokensOwed，不 collect 不到账。
   */
  collect?: boolean
  recipient?: Address
  poolState?: IPoolStateRaw
  positionState?: IPositionStateRaw
}

export interface ICollectFeesParams {
  userAddress: Address
  tokenId: bigint
  recipient?: Address
  /** 上限，默认 uint128.max（能领多少领多少） */
  amount0Max?: bigint
  amount1Max?: bigint
  /**
   * 可选：外部已经拿到的「精确可领额」快照，传了就跳过那次 collect staticcall（省 1 次 RPC）。
   *
   * 与其它写方法的 `poolState` / `positionState` 是同一个逃生口：collect 的 calldata 本身
   * 只依赖 tokenId / recipient / max，读链纯粹是为了把 meta 填准。所以在
   * 「仓位还没上链」（dry-run 虚拟区块、批量预演）或「详情页刚读过 pendingFees」的场景下，
   * staticcall 既跑不通也没必要 —— 此时把已知值透传进来即可。
   */
  pendingFees?: IPendingFees
}

export interface IClosePositionParams extends ICommonWriteParams {
  tokenId: bigint
  recipient?: Address
  positionState?: IPositionStateRaw
  poolState?: IPoolStateRaw
}

// ---------------------------------------------------------------------------
// 询价（1 次 staticcall）
// ---------------------------------------------------------------------------

export interface IQuoteSwapParams {
  tokenIn: Address
  tokenOut: Address
  /** 目标池的 tickSpacing（池身份键，原生 V3 此处是 fee） */
  tickSpacing: number
  amountIn: bigint
  /** 可选：覆盖构造 SDK 时定下的默认档位（0 = Alpha、1 = Dex） */
  extraFeeClass?: ExtraFeeClass
  sqrtPriceLimitX96?: bigint
}

export interface IQuoteSwapReturn {
  amountOut: bigint
  sqrtPriceX96After: bigint
  ticksCrossed: number
  gasEstimate: bigint
}
