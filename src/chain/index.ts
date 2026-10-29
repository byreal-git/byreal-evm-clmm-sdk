/**
 * 链上直读层（`sdk.chain.*`）：只做 eth_call / staticcall，多点只读一律走 Multicall3 聚合。
 * 每个方法的 JSDoc 标注实测 RPC 次数。
 *
 * ⚠️ Byreal 定制合约与原生 V3 的三个关键差异在这一层体现：
 * 1. 池身份键是 (token0, token1, tickSpacing)，Factory.getPool 的第三参是 tickSpacing（int24）；
 * 2. 池子**没有 `fee()` getter**——基础费率叫 `tradeFeeRate()`，是链上可改的**可变数据**，
 *    所以它归入动态字段（每次 fresh 读），绝不进不变字段缓存；
 * 3. quote 必须带 extraFeeClass（构造时给默认档，逐调用可覆盖）。
 */
import {
  decodeFunctionResult,
  encodeFunctionData,
  type Address,
  type ContractFunctionParameters,
  type Hex,
  type PublicClient,
} from 'viem'

import type { ExtraFeeClass } from '../raw/index.js'
import { ERC20_ABI, FACTORY_ABI, NPM_ABI, POOL_ABI, QUOTER_ABI, REWARD_CLAIM_VAULT_ABI } from '../abis.js'
import { MAX_UINT128, MULTICALL3_ADDRESS } from '../constants.js'
import type {
  IClmmContracts,
  IPendingFees,
  IPoolStateRaw,
  IPositionStateRaw,
  IQuoteSwapParams,
  IQuoteSwapReturn,
  IRewardKey,
  ITokenInfo,
} from '../types.js'

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

/** Multicall3 自带的原生币余额查询，让原生余额能和 ERC20 余额拼进同一轮 multicall */
const MULTICALL3_GET_ETH_BALANCE_ABI = [
  {
    type: 'function',
    name: 'getEthBalance',
    stateMutability: 'view',
    inputs: [{ name: 'addr', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const

/**
 * {@link Chain.getPositionStatesAndPendingFees} 单次 NPM.multicall 最多打包的子调用数。
 * 单个 collect 预演约十几万 gas，100 个子调用离节点 eth_call 的 gas 上限（通常几千万）还很远；
 * 超过就分批串行发，避免一次请求过大被节点拒绝。
 */
const NPM_BATCH_READ_MAX_CALLS = 100

/**
 * 池子的**不变字段**（部署后永远不会变）。
 * 单独抽出来是为了做进程内缓存。⚠️ 与原生 V3 不同，费率（tradeFeeRate）是可变数据，
 * **不在**这里——它跟 slot0 一样归入每次 fresh 读的动态字段。
 */
interface IPoolImmutable {
  token0: Address
  token1: Address
  tickSpacing: number
}

/** `positions(tokenId)` 的 12 个返回值（与 NPM ABI 的 outputs 顺序严格一致；第 5 项是 tickSpacing） */
type PositionsTuple = readonly [
  bigint, // nonce
  Address, // operator
  Address, // token0
  Address, // token1
  number, // tickSpacing（原生 V3 此处是 fee）
  number, // tickLower
  number, // tickUpper
  bigint, // liquidity
  bigint, // feeGrowthInside0LastX128
  bigint, // feeGrowthInside1LastX128
  bigint, // tokensOwed0
  bigint, // tokensOwed1
]

/**
 * `slot0()` 的 7 个返回值。
 * ⚠️ 第 6 项与原生 V3 不同：原生是 feeProtocol（双 4bit 打包），
 * 定制合约是 **protocolFeeRate（uint8，百分比 0~100）**，不要按 V3 方式解包。
 */
type Slot0Tuple = readonly [bigint, number, number, number, number, number, boolean]

/** 池子动态字段一次 multicall 的返回（顺序与 poolDynamicCalls 严格一致） */
type PoolDynamicTuple = readonly [
  Slot0Tuple, // slot0
  bigint, // liquidity
  bigint, // feeGrowthGlobal0X128
  bigint, // feeGrowthGlobal1X128
  number, // tradeFeeRate（ppm，可变）
  number, // pauseFlags
  number, // swapOpenTime
  number, // alphaExtraTradeFeeRate（ppm）
  number, // dexExtraTradeFeeRate（ppm）
  boolean, // dynamicFeeEnabled
]

/** 动态字段的 call 个数（getMintPrerequisites 里拼接余额/授权时用来对位） */
const POOL_DYNAMIC_CALL_COUNT = 10

/**
 * 链上直读客户端。
 *
 * 用法：
 * ```ts
 * const chain = new Chain({ publicClient, chainId: 5000, contracts, extraFeeClass: ExtraFeeClass.DEX })
 * const poolState = await chain.getRawPoolInfo('0x…')
 * ```
 */
export class Chain {
  readonly publicClient: PublicClient
  readonly chainId: number
  readonly contracts: IClmmContracts
  /** 构造时定下的默认额外费率档位（0=Alpha / 1=Dex），quoteSwap 可逐调用覆盖 */
  readonly extraFeeClass: ExtraFeeClass

  /** Multicall3 地址（绝大多数 EVM 链都是同一个确定性地址） */
  private readonly multicallAddress: Address

  /** poolAddress(小写) → 池子不变字段。链上不变量，可无限期缓存 */
  private readonly poolMetaCache = new Map<string, IPoolImmutable>()

  /** `tokenA-tokenB-tickSpacing`(小写) → poolAddress。Factory 里一旦建池就不会变，可无限期缓存 */
  private readonly poolAddressCache = new Map<string, Address>()

  /** address(小写) → ITokenInfo。ERC20 的 decimals/symbol 是链上不变量，可无限期缓存 */
  private readonly tokenInfoCache = new Map<string, ITokenInfo>()

  /** factory.poolInitCodeHash() 的进程内缓存（部署常量，读一次即可） */
  private poolInitCodeHashCache?: Hex

  constructor(params: {
    publicClient: PublicClient
    chainId: number
    contracts: IClmmContracts
    extraFeeClass: ExtraFeeClass
  }) {
    this.publicClient = params.publicClient
    this.chainId = params.chainId
    this.contracts = params.contracts
    this.extraFeeClass = params.extraFeeClass
    this.multicallAddress = params.contracts.multicall3 ?? MULTICALL3_ADDRESS
  }

  // =========================================================================
  // 池子
  // =========================================================================

  /**
   * 用 Factory 反查池子地址。
   *
   * RPC：1 次 eth_call（同一个 tokenA/tokenB/tickSpacing 组合第二次调用命中缓存，0 次）。
   *
   * 坚持走 Factory.getPool 反查而不是本地 CREATE2 推导：反查对「池子是否存在」有明确答案
   * （零地址 = 未建池），本地推导对不存在的池子也会算出一个地址，失去报错能力。
   * 需要本地推导时用 `getPoolInitCodeHash()` + byreal 的 `computePoolAddress`。
   */
  async getPoolAddress(params: { tokenA: Address; tokenB: Address; tickSpacing: number }): Promise<Address> {
    const { tokenA, tokenB, tickSpacing } = params
    const key = this.poolKey(tokenA, tokenB, tickSpacing)
    const cached = this.poolAddressCache.get(key)
    if (cached) return cached

    const poolAddress = (await this.publicClient.readContract({
      address: this.contracts.factory,
      abi: FACTORY_ABI,
      functionName: 'getPool',
      args: [tokenA, tokenB, tickSpacing],
    })) as Address

    if (poolAddress === ZERO_ADDRESS) {
      throw new Error(
        `[evm-clmm-sdk] Factory(${this.contracts.factory}) 上不存在该池子：${tokenA} / ${tokenB} tickSpacing=${tickSpacing}。` +
          `请确认 tickSpacing 是否正确，或该交易对尚未建池。`,
      )
    }
    this.poolAddressCache.set(key, poolAddress)
    return poolAddress
  }

  /**
   * 读取 `factory.poolInitCodeHash()`（部署常量，进程内缓存）。
   *
   * ⚠️ 这个哈希内嵌 beacon 地址、与部署环境相关，**禁止硬编码**——需要本地 CREATE2 推导
   * 池子地址时（配合 byreal 的 `computePoolAddress`），从这里拿。
   * RPC：首次 1 次 eth_call，之后 0 次。
   */
  async getPoolInitCodeHash(): Promise<Hex> {
    if (this.poolInitCodeHashCache) return this.poolInitCodeHashCache
    const hash = (await this.publicClient.readContract({
      address: this.contracts.factory,
      abi: FACTORY_ABI,
      functionName: 'poolInitCodeHash',
    })) as Hex
    this.poolInitCodeHashCache = hash
    return hash
  }

  /**
   * 读取池子的完整链上原始状态（slot0 + liquidity + feeGrowth + 费率/暂停参数 + 不变字段）。
   *
   * RPC：**冷启动 1 次 multicall（13 个 call），热路径 1 次 multicall（10 个 call）**。
   * 不变字段（token0/token1/tickSpacing）读一次进缓存；tradeFeeRate 等费率参数是可变数据，
   * 每次都 fresh 读，**不缓存**。
   */
  async getRawPoolInfo(poolAddress: Address): Promise<IPoolStateRaw> {
    const cachedMeta = this.poolMetaCache.get(poolAddress.toLowerCase())

    if (cachedMeta) {
      // —— 热路径：不变字段已知，只读动态字段 ——
      const dynamic = await this.publicClient.multicall({
        contracts: this.poolDynamicCalls(poolAddress),
        multicallAddress: this.multicallAddress,
        allowFailure: false,
      })
      return this.assemblePoolState(poolAddress, cachedMeta, dynamic as unknown as PoolDynamicTuple)
    }

    // —— 冷路径：一次 multicall 把不变 + 动态 13 项读齐 ——
    const raw = await this.publicClient.multicall({
      contracts: [
        { address: poolAddress, abi: POOL_ABI, functionName: 'token0' },
        { address: poolAddress, abi: POOL_ABI, functionName: 'token1' },
        { address: poolAddress, abi: POOL_ABI, functionName: 'tickSpacing' },
        ...this.poolDynamicCalls(poolAddress),
      ],
      multicallAddress: this.multicallAddress,
      allowFailure: false,
    })

    const [token0, token1, tickSpacing, ...dynamic] = raw as unknown as [Address, Address, number, ...unknown[]]
    const meta: IPoolImmutable = { token0, token1, tickSpacing: Number(tickSpacing) }
    this.poolMetaCache.set(poolAddress.toLowerCase(), meta)
    this.poolAddressCache.set(this.poolKey(token0, token1, meta.tickSpacing), poolAddress)

    return this.assemblePoolState(poolAddress, meta, dynamic as unknown as PoolDynamicTuple)
  }

  // =========================================================================
  // 仓位
  // =========================================================================

  /**
   * 读取单个仓位的链上原始状态（`NonfungiblePositionManager.positions(tokenId)` 原样映射）。
   * RPC：1 次 eth_call。
   */
  async getRawPositionInfo(tokenId: bigint): Promise<IPositionStateRaw> {
    const raw = (await this.publicClient.readContract({
      address: this.contracts.positionManager,
      abi: NPM_ABI,
      functionName: 'positions',
      args: [tokenId],
    })) as PositionsTuple
    return this.toPositionState(tokenId, raw)
  }

  /**
   * 列出某地址持有的全部仓位 tokenId。
   * RPC：2 次 —— 1 次 `balanceOf` + 1 次 multicall（N 个 `tokenOfOwnerByIndex`）。
   */
  async getPositionTokenIdListByOwner(owner: Address): Promise<bigint[]> {
    const count = (await this.publicClient.readContract({
      address: this.contracts.positionManager,
      abi: NPM_ABI,
      functionName: 'balanceOf',
      args: [owner],
    })) as bigint

    const n = Number(count)
    if (n === 0) return []

    const ids = await this.publicClient.multicall({
      contracts: Array.from({ length: n }, (_, i) => ({
        address: this.contracts.positionManager,
        abi: NPM_ABI,
        functionName: 'tokenOfOwnerByIndex' as const,
        args: [owner, BigInt(i)] as const,
      })),
      multicallAddress: this.multicallAddress,
      allowFailure: false,
      // viem 默认 batchSize=1024 字节，会把大批量拆成多个 eth_call；这里显式关掉，
      // 保证「1 轮 = 1 次 RPC」的口径成立。仓位极多（几百个）时若节点拒绝超大 payload，
      // 上层可以自行分页调用。
      batchSize: 0,
    })
    return ids as unknown as bigint[]
  }

  /**
   * 一次拿到某地址名下所有仓位的原始状态。
   * RPC：3 轮 —— `balanceOf` → multicall(N × `tokenOfOwnerByIndex`) → multicall(N × `positions`)。
   */
  async getRawPositionInfoListByOwner(owner: Address): Promise<IPositionStateRaw[]> {
    const tokenIds = await this.getPositionTokenIdListByOwner(owner)
    if (tokenIds.length === 0) return []

    const list = await this.publicClient.multicall({
      contracts: tokenIds.map((tokenId) => ({
        address: this.contracts.positionManager,
        abi: NPM_ABI,
        functionName: 'positions' as const,
        args: [tokenId] as const,
      })),
      multicallAddress: this.multicallAddress,
      allowFailure: false,
      batchSize: 0, // 同上：不按字节数拆分，保证 1 次 RPC
    })

    return (list as unknown as PositionsTuple[]).map((raw, i) => this.toPositionState(tokenIds[i], raw))
  }

  /**
   * 由仓位状态反查它所属的池子地址（`factory.getPool(token0, token1, tickSpacing)`）。
   * RPC：1 次 eth_call；同一交易对 + tickSpacing 第二次调用命中缓存（0 次）。
   */
  async getPoolAddressByPosition(positionState: IPositionStateRaw): Promise<Address> {
    return this.getPoolAddress({
      tokenA: positionState.token0,
      tokenB: positionState.token1,
      tickSpacing: positionState.tickSpacing,
    })
  }

  // =========================================================================
  // 代币元数据（写操作从 poolAddress 出发时，需要 token0/token1 的 decimals 做数学）
  // =========================================================================

  /**
   * 批量读 ERC20 元数据（decimals / symbol / name），带无限期缓存。
   * RPC：未命中缓存时 1 次 multicall（3 × N 个 call），全命中则 0 次。
   *
   * decimals 解不出来直接抛错（精度错了金额换算全错）；symbol/name 解不出来
   * （老代币返回 bytes32）降级成占位符，不影响流动性数学。
   */
  async getTokenInfoList(addresses: Address[]): Promise<ITokenInfo[]> {
    if (addresses.length === 0) return []
    const missing = addresses.filter((a) => !this.tokenInfoCache.has(a.toLowerCase()))

    if (missing.length > 0) {
      const contracts = missing.flatMap((address) => [
        { address, abi: ERC20_ABI, functionName: 'decimals' as const },
        { address, abi: ERC20_ABI, functionName: 'symbol' as const },
        { address, abi: ERC20_ABI, functionName: 'name' as const },
      ])
      const results = await this.publicClient.multicall({
        contracts,
        multicallAddress: this.multicallAddress,
        allowFailure: true,
        batchSize: 0,
      })
      missing.forEach((address, i) => {
        const decimalsRes = results[i * 3]
        if (decimalsRes.status !== 'success') {
          throw new Error(
            `[evm-clmm-sdk] 读取 ${address} 的 decimals 失败，无法安全换算金额：${String(decimalsRes.error)}`,
          )
        }
        const symbolRes = results[i * 3 + 1]
        const nameRes = results[i * 3 + 2]
        this.tokenInfoCache.set(address.toLowerCase(), {
          chainId: this.chainId,
          address,
          decimals: Number(decimalsRes.result as number | bigint),
          symbol: symbolRes.status === 'success' ? (symbolRes.result as string) : 'UNKNOWN',
          name: nameRes.status === 'success' ? (nameRes.result as string) : undefined,
        })
      })
    }

    return addresses.map((a) => this.tokenInfoCache.get(a.toLowerCase())!)
  }

  // =========================================================================
  // 只有链上能给出的实时精确值
  // =========================================================================

  /**
   * 取某仓位**精确的**待领手续费。
   *
   * 实现：对 `NonfungiblePositionManager.collect` 做 staticcall（`simulateContract`，**不发送**），
   * amount0Max/amount1Max 传 uint128.max 表示「能领多少领多少」，返回值就是精确待领额。
   * collect 的模拟执行会先触发一次结算（burn 0），所以拿到的是含未结算部分的实时精确值。
   *
   * RPC：1 次 eth_call。
   *
   * ⚠️ `account` 必须是该仓位的 owner（或被 approve 的 operator），否则合约的授权检查会 revert。
   * ⚠️ 定制合约的 PAUSE_REMOVE 位会连坐 collect（collect 内部用 burn(0) 结算）——
   * 池子被暂停 REMOVE 时这里也会 revert，属预期行为。
   */
  async getPendingFees(params: { tokenId: bigint; owner: Address; recipient?: Address }): Promise<IPendingFees> {
    const { tokenId, owner, recipient = owner } = params
    const { result } = await this.publicClient.simulateContract({
      address: this.contracts.positionManager,
      abi: NPM_ABI,
      functionName: 'collect',
      account: owner,
      args: [
        {
          tokenId,
          recipient,
          amount0Max: MAX_UINT128,
          amount1Max: MAX_UINT128,
        },
      ],
    })
    const [amount0, amount1] = result as readonly [bigint, bigint]
    return { amount0, amount1 }
  }

  /**
   * 批量读仓位原始状态 + 精确待领手续费，**所有仓位合计 1 次 eth_call**（超过
   * {@link NPM_BATCH_READ_MAX_CALLS} 个子调用时按批串行，每批 1 次）。
   *
   * 实现：对 NPM **自带的** `multicall(bytes[])` 做 staticcall，子调用依次是
   * `positions(id)` × len(positionStateOf) 和 `collect(id, recipient, max, max)` × len(pendingFeesOf)。
   * positions 排在 collect 前面，读到的是领取前的状态（tokensOwed 未清零）。
   *
   * 为什么不用 Multicall3：Multicall3 对子调用发的是普通 `call`，合约看到的 `msg.sender` 是
   * Multicall3 自己，collect 过不了 `isAuthorizedForToken`（实测 revert `Not approved`）。
   * NPM 的 multicall 是 `delegatecall(self)`，子调用里 `msg.sender` 仍是 owner，权限检查与单发一致；
   * 真正发交易时批量领费也是用它打包的，读写同一条路径。
   *
   * ⚠️ 任一子调用 revert，整批 revert（NPM.multicall 会把子调用的 revert 原样冒泡）；
   * 调用方需要定位到具体 tokenId 时，应在捕获 revert 后自行逐个重试。
   * ⚠️ `owner` 的要求同 {@link getPendingFees}；`pendingFeesOf` 为空时不做授权相关的调用。
   */
  async getPositionStatesAndPendingFees(params: {
    owner: Address
    recipient?: Address
    /** 需要读 `positions` 的 tokenId */
    positionStateOf: readonly bigint[]
    /** 需要预演 collect 读待领手续费的 tokenId */
    pendingFeesOf: readonly bigint[]
  }): Promise<{ positionStates: Map<string, IPositionStateRaw>; pendingFees: Map<string, IPendingFees> }> {
    const { owner, recipient = owner, positionStateOf, pendingFeesOf } = params
    const positionStates = new Map<string, IPositionStateRaw>()
    const pendingFees = new Map<string, IPendingFees>()

    type Sub = { kind: 'positions' | 'collect'; tokenId: bigint; data: Hex }
    const subs: Sub[] = [
      ...positionStateOf.map<Sub>((tokenId) => ({
        kind: 'positions',
        tokenId,
        data: encodeFunctionData({ abi: NPM_ABI, functionName: 'positions', args: [tokenId] }),
      })),
      ...pendingFeesOf.map<Sub>((tokenId) => ({
        kind: 'collect',
        tokenId,
        data: encodeFunctionData({
          abi: NPM_ABI,
          functionName: 'collect',
          args: [{ tokenId, recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
        }),
      })),
    ]

    // 刻意串行：分批本来就是为了不给节点一次性压太多，并发发出去就失去意义了
    for (let start = 0; start < subs.length; start += NPM_BATCH_READ_MAX_CALLS) {
      const chunk = subs.slice(start, start + NPM_BATCH_READ_MAX_CALLS)
      const { result } = await this.publicClient.simulateContract({
        address: this.contracts.positionManager,
        abi: NPM_ABI,
        functionName: 'multicall',
        account: owner,
        args: [chunk.map((c) => c.data)],
      })
      const outputs = result as readonly Hex[]
      chunk.forEach((sub, i) => {
        const key = sub.tokenId.toString()
        if (sub.kind === 'positions') {
          const raw = decodeFunctionResult({ abi: NPM_ABI, functionName: 'positions', data: outputs[i] })
          positionStates.set(key, this.toPositionState(sub.tokenId, raw as unknown as PositionsTuple))
        } else {
          const [amount0, amount1] = decodeFunctionResult({
            abi: NPM_ABI,
            functionName: 'collect',
            data: outputs[i],
          }) as unknown as readonly [bigint, bigint]
          pendingFees.set(key, { amount0, amount1 })
        }
      })
    }

    return { positionStates, pendingFees }
  }

  /**
   * 单池询价（只能直连链上）。
   *
   * 实现：`ByrealQuoter.quoteExactInputSingle` 是 **nonpayable**（内部靠真实 swap + revert 回传结果），
   * 所以不能用 readContract，要用 `simulateContract` 做 staticcall 取返回值。
   *
   * ⚠️ 与原生 QuoterV2 的差异：struct 用 tickSpacing 定位池子，且必须带 extraFeeClass
   * （缺省用构造 SDK 时定下的档位）。动态费率开启的池子**只能**用这条链路报价——
   * 离线数学算不出预言机覆写后的费率。
   *
   * RPC：1 次 eth_call。
   */
  async quoteSwap(params: IQuoteSwapParams): Promise<IQuoteSwapReturn> {
    const { tokenIn, tokenOut, tickSpacing, amountIn, sqrtPriceLimitX96 = 0n } = params
    const extraFeeClass = params.extraFeeClass ?? this.extraFeeClass
    const { result } = await this.publicClient.simulateContract({
      address: this.contracts.quoter,
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn, tokenOut, amountIn, tickSpacing, sqrtPriceLimitX96, extraFeeClass }],
    })
    const [amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate] = result as readonly [
      bigint,
      bigint,
      number,
      bigint,
    ]
    return {
      amountOut,
      sqrtPriceX96After,
      // 合约里是 uint32，viem 解出来已经是 number，这里再 Number() 一次是为了防御 BigInt 解码差异
      ticksCrossed: Number(initializedTicksCrossed),
      gasEstimate,
    }
  }

  // =========================================================================
  // 写主干的「前置读」：一次 multicall 拿齐拼 calldata 需要的所有 fresh 状态
  // =========================================================================

  /**
   * 开仓（mint）前置读：fresh 池子状态 + 用户两种代币的余额与授权。
   *
   * RPC：**1 次 multicall（14 个 call：10 动态 + 2 余额 + 2 授权；读原生余额时再 +1）**；
   * 若该池子的不变字段（token0/token1/tickSpacing）尚未缓存，前面会多一次 multicall 去取，
   * 即冷启动 2 轮 multicall、热路径 1 轮。
   *
   * @param params.spender 授权对象，开仓场景固定是 NonfungiblePositionManager。
   * @param params.withNativeBalance 为 true 时在同一轮 multicall 里多读一次原生币余额（原生币开仓 / 加仓用）。
   */
  async getMintPrerequisites(params: {
    poolAddress: Address
    userAddress: Address
    spender: Address
    withNativeBalance?: boolean
  }): Promise<{
    poolState: IPoolStateRaw
    balance0: bigint
    balance1: bigint
    allowance0: bigint
    allowance1: bigint
    /** 仅 `withNativeBalance: true` 时有值 */
    nativeBalance?: bigint
  }> {
    const { poolAddress, userAddress, spender, withNativeBalance = false } = params
    const meta = await this.getPoolImmutable(poolAddress)

    const contracts: ContractFunctionParameters[] = [
      ...this.poolDynamicCalls(poolAddress),
      { address: meta.token0, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddress] },
      { address: meta.token1, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddress] },
      { address: meta.token0, abi: ERC20_ABI, functionName: 'allowance', args: [userAddress, spender] },
      { address: meta.token1, abi: ERC20_ABI, functionName: 'allowance', args: [userAddress, spender] },
    ]
    if (withNativeBalance) {
      contracts.push({
        address: this.multicallAddress,
        abi: MULTICALL3_GET_ETH_BALANCE_ABI,
        functionName: 'getEthBalance',
        args: [userAddress],
      })
    }
    const raw = await this.publicClient.multicall({
      contracts,
      multicallAddress: this.multicallAddress,
      allowFailure: false,
    })

    const dynamic = raw.slice(0, POOL_DYNAMIC_CALL_COUNT) as unknown as PoolDynamicTuple
    const [balance0, balance1, allowance0, allowance1, nativeBalance] = raw.slice(
      POOL_DYNAMIC_CALL_COUNT,
    ) as unknown as [bigint, bigint, bigint, bigint, bigint | undefined]

    return {
      poolState: this.assemblePoolState(poolAddress, meta, dynamic),
      balance0,
      balance1,
      allowance0,
      allowance1,
      ...(withNativeBalance ? { nativeBalance } : {}),
    }
  }

  /**
   * 改仓（加/减流动性、关仓、collect）前置读：仓位状态 + 所属池子的 fresh 状态 + 余额与授权。
   *
   * RPC：`positions` 1 次 → （必要时）Factory 反查 1 次 → 状态+余额+授权 1 次 multicall。
   * 池子地址与不变字段命中缓存后稳定在 2 次请求。
   */
  async getModifyPrerequisites(params: {
    tokenId: bigint
    userAddress: Address
    spender: Address
    withNativeBalance?: boolean
  }): Promise<{
    positionState: IPositionStateRaw
    poolState: IPoolStateRaw
    balance0: bigint
    balance1: bigint
    allowance0: bigint
    allowance1: bigint
    nativeBalance?: bigint
  }> {
    const { tokenId, userAddress, spender, withNativeBalance } = params

    const positionState = await this.getRawPositionInfo(tokenId)
    const poolAddress = await this.getPoolAddressByPosition(positionState)

    // 拿到 poolAddress 之后就完全等价于开仓的前置读，直接复用，避免两处逻辑各写一遍 multicall。
    const rest = await this.getMintPrerequisites({ poolAddress, userAddress, spender, withNativeBalance })
    return { positionState, ...rest }
  }

  // =========================================================================
  // 奖励金库（ByrealRewardClaimVault）
  // =========================================================================

  /**
   * 批量读奖励账本的已领累计额（`claimedAmount`），返回值与 `keys` 一一对应。
   *
   * RPC：1 次 multicall（`keys` 为空时 0 次）。
   * 与凭证的 `syncedAmount` 相减即为可领额；RPC 失败会直接抛错，不要把失败当成 0。
   */
  async getRewardClaimedAmountList(keys: readonly IRewardKey[]): Promise<bigint[]> {
    const vault = this.requireRewardClaimVault()
    if (keys.length === 0) return []
    const raw = await this.publicClient.multicall({
      contracts: keys.map((key) => this.claimedAmountCall(vault, key)),
      multicallAddress: this.multicallAddress,
      allowFailure: false,
    })
    return raw as bigint[]
  }

  /**
   * 领奖励的前置读：金库暂停状态 + 各账本键的已领累计额 + 金库对各奖励代币的余额。
   *
   * RPC：**1 次 multicall**（1 + keys.length + rewardTokens.length 个 call）。
   * `claimedAmounts` 与 `keys`、`vaultBalances` 与 `rewardTokens` 分别一一对应。
   */
  async getRewardClaimPrerequisites(params: {
    keys: readonly IRewardKey[]
    rewardTokens: readonly Address[]
  }): Promise<{ vault: Address; paused: boolean; claimedAmounts: bigint[]; vaultBalances: bigint[] }> {
    const { keys, rewardTokens } = params
    const vault = this.requireRewardClaimVault()
    const contracts: ContractFunctionParameters[] = [
      { address: vault, abi: REWARD_CLAIM_VAULT_ABI, functionName: 'paused' },
      ...keys.map((key) => this.claimedAmountCall(vault, key)),
      ...rewardTokens.map((token) => ({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [vault] })),
    ]
    const raw = await this.publicClient.multicall({
      contracts,
      multicallAddress: this.multicallAddress,
      allowFailure: false,
    })
    return {
      vault,
      paused: raw[0] as boolean,
      claimedAmounts: raw.slice(1, 1 + keys.length) as bigint[],
      vaultBalances: raw.slice(1 + keys.length) as bigint[],
    }
  }

  /** 金库 proxy 地址；未配置或仍是零地址占位时直接报错，避免把交易发到零地址 */
  private requireRewardClaimVault(): Address {
    const vault = this.contracts.rewardClaimVault
    if (!vault || vault === ZERO_ADDRESS) {
      throw new Error(
        '[evm-clmm-sdk] 当前部署未配置奖励金库（contracts.rewardClaimVault），' +
          '请换用已部署金库的 profileId，或在构造 SDK 时通过 contracts 传入金库 proxy 地址。',
      )
    }
    return vault
  }

  private claimedAmountCall(vault: Address, key: IRewardKey) {
    return {
      address: vault,
      abi: REWARD_CLAIM_VAULT_ABI,
      functionName: 'claimedAmount',
      args: [key.positionTokenId, key.rewardToken, key.ruleId, key.ruleType, key.epochTime],
    } as const
  }

  // =========================================================================
  // 内部工具
  // =========================================================================

  /** 池子动态（可变）字段的 multicall 描述，顺序与 PoolDynamicTuple 严格一致 */
  private poolDynamicCalls(poolAddress: Address) {
    return [
      { address: poolAddress, abi: POOL_ABI, functionName: 'slot0' },
      { address: poolAddress, abi: POOL_ABI, functionName: 'liquidity' },
      { address: poolAddress, abi: POOL_ABI, functionName: 'feeGrowthGlobal0X128' },
      { address: poolAddress, abi: POOL_ABI, functionName: 'feeGrowthGlobal1X128' },
      { address: poolAddress, abi: POOL_ABI, functionName: 'tradeFeeRate' },
      { address: poolAddress, abi: POOL_ABI, functionName: 'pauseFlags' },
      { address: poolAddress, abi: POOL_ABI, functionName: 'swapOpenTime' },
      { address: poolAddress, abi: POOL_ABI, functionName: 'alphaExtraTradeFeeRate' },
      { address: poolAddress, abi: POOL_ABI, functionName: 'dexExtraTradeFeeRate' },
      { address: poolAddress, abi: POOL_ABI, functionName: 'dynamicFeeEnabled' },
    ] as const
  }

  /** 把「不变字段 + 动态字段元组」组装成 IPoolStateRaw（唯一的组装点，冷/热路径共用） */
  private assemblePoolState(poolAddress: Address, meta: IPoolImmutable, d: PoolDynamicTuple): IPoolStateRaw {
    const [slot0, liquidity, fg0, fg1, tradeFeeRate, pauseFlags, swapOpenTime, alphaExtra, dexExtra, dynamicFeeEnabled] =
      d
    return {
      poolAddress,
      ...meta,
      tradeFeeRate: Number(tradeFeeRate),
      protocolFeeRate: Number(slot0[5]),
      pauseFlags: Number(pauseFlags),
      swapOpenTime: Number(swapOpenTime),
      alphaExtraTradeFeeRate: Number(alphaExtra),
      dexExtraTradeFeeRate: Number(dexExtra),
      dynamicFeeEnabled: Boolean(dynamicFeeEnabled),
      sqrtPriceX96: slot0[0],
      tick: Number(slot0[1]),
      liquidity,
      feeGrowthGlobal0X128: fg0,
      feeGrowthGlobal1X128: fg1,
    }
  }

  /** 取池子的不变字段，优先命中缓存（未命中时 1 次 multicall，3 个 call） */
  private async getPoolImmutable(poolAddress: Address): Promise<IPoolImmutable> {
    const cached = this.poolMetaCache.get(poolAddress.toLowerCase())
    if (cached) return cached

    const raw = await this.publicClient.multicall({
      contracts: [
        { address: poolAddress, abi: POOL_ABI, functionName: 'token0' },
        { address: poolAddress, abi: POOL_ABI, functionName: 'token1' },
        { address: poolAddress, abi: POOL_ABI, functionName: 'tickSpacing' },
      ],
      multicallAddress: this.multicallAddress,
      allowFailure: false,
    })
    const [token0, token1, tickSpacing] = raw as unknown as [Address, Address, number]
    const meta: IPoolImmutable = { token0, token1, tickSpacing: Number(tickSpacing) }
    this.poolMetaCache.set(poolAddress.toLowerCase(), meta)
    this.poolAddressCache.set(this.poolKey(token0, token1, meta.tickSpacing), poolAddress)
    return meta
  }

  /** poolAddressCache 的 key：token 顺序无关（Factory.getPool 本身就与顺序无关） */
  private poolKey(tokenA: Address, tokenB: Address, tickSpacing: number): string {
    const [a, b] = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort()
    return `${a}-${b}-${tickSpacing}`
  }

  /** 把 `positions()` 的裸元组映射成 IPositionStateRaw（int24 等小整数统一 Number 化） */
  private toPositionState(tokenId: bigint, p: PositionsTuple): IPositionStateRaw {
    return {
      tokenId,
      nonce: p[0],
      operator: p[1],
      token0: p[2],
      token1: p[3],
      tickSpacing: Number(p[4]),
      tickLower: Number(p[5]),
      tickUpper: Number(p[6]),
      liquidity: p[7],
      feeGrowthInside0LastX128: p[8],
      feeGrowthInside1LastX128: p[9],
      tokensOwed0: p[10],
      tokensOwed1: p[11],
    }
  }
}
