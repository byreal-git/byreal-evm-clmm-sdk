/**
 * compat 测试专用的夹具与 `publicClient` 模拟器。**只被同目录的 `*.test.ts` import**，
 * 刻意不进 `index.ts`（它不是兼容层契约的一部分，透出去就得当公开 API 维护）。
 *
 * ## 为什么要一份「会应答的」mock，而不是只用「一碰就抛」的哨兵
 * offchain 那条路只需要证明**没有** RPC，一个 throw 型 Proxy 就够了（见 `offchain.test.ts`）。
 * 但 `CompatCLMMClient` / `CompatChain` 是**读链版**：它们的价值恰恰在于「读了什么、读了几次、
 * 读回来之后怎么组装」，用 throw 型 mock 根本跑不起来。所以这里按核心 `Chain` 真实发出的
 * 三种调用形状（`multicall` / `readContract` / `simulateContract`）做一个可应答的替身，
 * 并把每次往返记进 {@link IMockPublicClient.calls} —— 有了这个计数，
 * 「传了 token 元数据就能省掉那次 ERC20 multicall」这类**性能契约**才有办法被钉死，
 * 否则它退化了没人会发现（功能全对，只是慢了、贵了）。
 *
 * ## 夹具数据说明
 * `sqrtPriceX96` 由 `tick` 现算（不是抄一个近似值）：核心 `toUniPool` 会断言
 * 「sqrtPriceX96 必须落在 tick 对应的区间内」，随手编一个数会在与本次测试无关的地方炸掉。
 * 链固定 Mantle 5000，SDK 用 test 部署，NPM / Factory 地址必须与
 * `src/constants.ts` 里 test 部署的地址一致（mock 按地址分发应答）。
 */
import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

import { NPM_ABI } from '../abis.js'

import { TickMath } from '../raw/index.js'
import type { IPoolStateRaw, IPositionStateRaw, ITokenInfo } from '../types.js'

// ---------------------------------------------------------------------------
// 地址与代币
// ---------------------------------------------------------------------------

/** 测试统一用 Mantle（内置注册表里合约地址是齐的，不用在每个用例里传 contracts） */
export const CHAIN_ID = 5000

/** 测试代币 A。地址 0x82.. < 0xaf..，所以它是池子里的 token0（地址沿用广为人知的 WETH，只是当测试数据） */
export const WETH_ADDRESS = getAddress('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1')
/** 测试代币 B，池子里的 token1 */
export const USDC_ADDRESS = getAddress('0xaf88d065e77c8cC2239327C5EDb3A432268e5831')
/** 测试池地址（mock 按地址分发，任意固定值即可） */
export const POOL_ADDRESS = getAddress('0xC6962004f452bE9203591991D15f6b388e09E8D0')
/** test 部署的 NPM proxy（mock 按地址分发要用） */
export const NPM_ADDRESS = getAddress('0x77704B29BE267ad9a7843fA5F799881ada21b9fa')
/** test 部署的 PoolBeaconFactory */
export const FACTORY_ADDRESS = getAddress('0xa5864429c7a88853951F6Fa50baeF4685D374267')

/** 测试用钱包地址 */
export const USER = getAddress('0x1111111111111111111111111111111111111111')
/** 另一个地址，用来验证 recipient 与 userAddress 分离 */
export const OTHER = getAddress('0x2222222222222222222222222222222222222222')

/** token0 侧的元数据（18 位小数：与 USDC 的 6 位一起，能暴露「两边 decimals 搞反」这类错） */
export const WETH: ITokenInfo = {
  chainId: CHAIN_ID,
  address: WETH_ADDRESS,
  decimals: 18,
  symbol: 'WETH',
  name: 'Wrapped Ether',
}

/** token1 侧的元数据 */
export const USDC: ITokenInfo = {
  chainId: CHAIN_ID,
  address: USDC_ADDRESS,
  decimals: 6,
  symbol: 'USDC',
  name: 'USD Coin',
}

// ---------------------------------------------------------------------------
// 池子与仓位快照
// ---------------------------------------------------------------------------

/** 当前池价对应的 tick（已对齐 tickSpacing=10，1 WETH ≈ 2900 USDC 量级） */
export const CURRENT_TICK = -196000

/** 由 tick 现算，保证与核心 `toUniPool` 的自洽性断言一致 */
export const SQRT_PRICE_X96 = BigInt(TickMath.getSqrtRatioAtTick(CURRENT_TICK).toString())

/** 核心 SDK 形状的池子快照（下面几种「宽松形状」都以它为等价基准） */
export const POOL_STATE: IPoolStateRaw = {
  poolAddress: POOL_ADDRESS,
  token0: WETH_ADDRESS,
  token1: USDC_ADDRESS,
  tickSpacing: 10,
  tradeFeeRate: 500,
  protocolFeeRate: 0,
  pauseFlags: 0,
  swapOpenTime: 0,
  alphaExtraTradeFeeRate: 0,
  dexExtraTradeFeeRate: 0,
  dynamicFeeEnabled: false,
  sqrtPriceX96: SQRT_PRICE_X96,
  tick: CURRENT_TICK,
  liquidity: 1_234_567_890_123_456n,
  feeGrowthGlobal0X128: 111n,
  feeGrowthGlobal1X128: 222n,
}

/** 主测仓位的 tokenId */
export const TOKEN_ID = 123456n
/** 第二个仓位（同池子，用来验证「批量查时池子只读一次」） */
export const TOKEN_ID_2 = 123457n

/** 区间 [-197000, -195000] 把当前 tick 夹在中间：两边代币都用得上，减仓/加仓都有解 */
export const POSITION_STATE: IPositionStateRaw = {
  tokenId: TOKEN_ID,
  nonce: 0n,
  operator: '0x0000000000000000000000000000000000000000',
  token0: WETH_ADDRESS,
  token1: USDC_ADDRESS,
  tickSpacing: 10,
  tickLower: CURRENT_TICK - 1000,
  tickUpper: CURRENT_TICK + 1000,
  liquidity: 999_999_999_999n,
  feeGrowthInside0LastX128: 0n,
  feeGrowthInside1LastX128: 0n,
  tokensOwed0: 0n,
  tokensOwed1: 0n,
}

/** 第二个仓位的快照：与主仓位同池、流动性不同，用来区分「谁的明细挂到了谁头上」 */
export const POSITION_STATE_2: IPositionStateRaw = {
  ...POSITION_STATE,
  tokenId: TOKEN_ID_2,
  liquidity: 500_000_000_000n,
}

/** 后端接口 `PoolDetail` 形状：大整数是 string、链上字段嵌 onchainState、费率叫 feeTier */
export const API_POOL = {
  poolAddress: POOL_ADDRESS.toLowerCase(),
  token0: { address: WETH_ADDRESS, decimals: 18, symbol: 'WETH' },
  token1: { address: USDC_ADDRESS, decimals: 6, symbol: 'USDC' },
  feeTier: '500',
  tickSpacing: '10',
  onchainState: {
    sqrtPriceX96: SQRT_PRICE_X96.toString(),
    tick: String(CURRENT_TICK),
    liquidity: POOL_STATE.liquidity.toString(),
    feeGrowthGlobal0X128: '111',
    feeGrowthGlobal1X128: '222',
  },
}

/** 后端接口 `PositionDetail` 形状（大整数是 string，池子身份靠 pool 字段兜底） */
export const API_POSITION = {
  tokenId: TOKEN_ID.toString(),
  tickLower: String(POSITION_STATE.tickLower),
  tickUpper: String(POSITION_STATE.tickUpper),
  liquidity: POSITION_STATE.liquidity.toString(),
}

// ---------------------------------------------------------------------------
// publicClient 模拟器
// ---------------------------------------------------------------------------

/** {@link makeMockPublicClient} 的可调项：只暴露测试真的会改的那几处 */
export interface IMockOptions {
  /** `positions(tokenId)` 能查到的仓位。不在表里的 tokenId 会像真合约那样 revert */
  positions?: IPositionStateRaw[]
  /** 设置后，任何 `positions` 调用都以这个错误 reject（用来验证网络类错误不会被吞成 null） */
  positionsError?: Error
  /** `collect` staticcall 的返回（= 精确待领手续费） */
  pendingFees?: { amount0: bigint; amount1: bigint }
  /** `ownerOf(tokenId)` 的返回 */
  owner?: Address
  /** `balanceOf` / `tokenOfOwnerByIndex` 枚举出来的仓位列表 */
  ownedTokenIds?: bigint[]
  /** ERC20 余额（默认给一个大数，免得每个用例都要操心余额校验） */
  balance?: bigint
  /** ERC20 对 NPM 的授权额度（默认大数 = 不会插入前置 approve） */
  allowance?: bigint
}

/** 带调用记录的 `publicClient` 替身 */
export interface IMockPublicClient {
  /** 交给 `new EvmClmmSdk({ publicClient })` 的那个对象 */
  client: PublicClient
  /**
   * 每次 RPC **往返**一条记录（一次 multicall 无论聚合多少个 call 都只算一次，
   * 与核心 SDK JSDoc 里「几次请求」的口径一致）。
   */
  calls: string[]
  /** 清空调用记录（用例里「先做一次预热，再断言之后 0 次」时用） */
  reset(): void
}

/**
 * 这批调用记录里有没有「读 ERC20 元数据」那一次 multicall。
 *
 * 不做字符串全等：核心 `getTokenInfoList` 会把 N 个代币的 decimals/symbol/name 拼进**同一次**
 * multicall，聚合个数随缓存命中情况变化（1 个没命中是 3 个 call，2 个就是 6 个）。
 * 断言的是「有没有为了元数据多打一次链」，不是「打了几个 call」。
 */
export function hasTokenMetaCall(calls: readonly string[]): boolean {
  return calls.some((c) => c.startsWith('multicall(decimals'))
}

/**
 * 造一个按核心 `Chain` 的真实调用形状应答的 `publicClient`。
 *
 * 分发**先按合约地址、再按 functionName**：`balanceOf` 在 ERC20 与 ERC721 上同名但语义不同，
 * 只看方法名会把「查仓位数量」应答成「查代币余额」。
 * 未覆盖到的调用一律抛错而不是返回 undefined —— 静默返回 undefined 会让失败出现在
 * 几层之外的解构处，那种报错完全指不出方向。
 */
export function makeMockPublicClient(options: IMockOptions = {}): IMockPublicClient {
  const positions = new Map<string, IPositionStateRaw>(
    (options.positions ?? [POSITION_STATE]).map((p) => [p.tokenId.toString(), p]),
  )
  const pendingFees = options.pendingFees ?? { amount0: 10n ** 15n, amount1: 2_000_000n }
  const owner = options.owner ?? USER
  const ownedTokenIds = options.ownedTokenIds ?? [TOKEN_ID]
  const balance = options.balance ?? 10n ** 30n
  const allowance = options.allowance ?? 10n ** 30n

  const calls: string[] = []

  const answer = (address: string, functionName: string, args?: readonly unknown[]): unknown => {
    const at = String(address).toLowerCase()

    if (at === POOL_ADDRESS.toLowerCase()) {
      switch (functionName) {
        // slot0 的 7 元组：核心读 [0] sqrtPriceX96、[1] tick、[5] protocolFeeRate（定制合约语义）
        case 'slot0':
          return [POOL_STATE.sqrtPriceX96, POOL_STATE.tick, 0, 1, 1, POOL_STATE.protocolFeeRate, true]
        case 'liquidity':
          return POOL_STATE.liquidity
        case 'token0':
          return POOL_STATE.token0
        case 'token1':
          return POOL_STATE.token1
        case 'tradeFeeRate':
          return POOL_STATE.tradeFeeRate
        case 'tickSpacing':
          return POOL_STATE.tickSpacing
        case 'feeGrowthGlobal0X128':
          return POOL_STATE.feeGrowthGlobal0X128
        case 'feeGrowthGlobal1X128':
          return POOL_STATE.feeGrowthGlobal1X128
        case 'pauseFlags':
          return POOL_STATE.pauseFlags
        case 'swapOpenTime':
          return POOL_STATE.swapOpenTime
        case 'alphaExtraTradeFeeRate':
          return POOL_STATE.alphaExtraTradeFeeRate
        case 'dexExtraTradeFeeRate':
          return POOL_STATE.dexExtraTradeFeeRate
        case 'dynamicFeeEnabled':
          return POOL_STATE.dynamicFeeEnabled
      }
    }

    if (at === NPM_ADDRESS.toLowerCase()) {
      switch (functionName) {
        case 'positions': {
          if (options.positionsError) throw options.positionsError
          const hit = positions.get(String(args?.[0]))
          if (!hit) {
            // 真合约对无效 tokenId 就是这么 revert 的，CompatChain 靠这条文案落成 null
            throw new Error('The contract function "positions" reverted with reason: Invalid token ID')
          }
          return [
            hit.nonce,
            hit.operator,
            hit.token0,
            hit.token1,
            hit.tickSpacing,
            hit.tickLower,
            hit.tickUpper,
            hit.liquidity,
            hit.feeGrowthInside0LastX128,
            hit.feeGrowthInside1LastX128,
            hit.tokensOwed0,
            hit.tokensOwed1,
          ]
        }
        case 'balanceOf':
          return BigInt(ownedTokenIds.length)
        case 'tokenOfOwnerByIndex':
          return ownedTokenIds[Number(args?.[1])]
        case 'ownerOf':
          return owner
        case 'collect':
          return [pendingFees.amount0, pendingFees.amount1]
      }
    }

    if (at === FACTORY_ADDRESS.toLowerCase() && functionName === 'getPool') return POOL_ADDRESS

    if (at === WETH_ADDRESS.toLowerCase() || at === USDC_ADDRESS.toLowerCase()) {
      const info = at === WETH_ADDRESS.toLowerCase() ? WETH : USDC
      switch (functionName) {
        case 'decimals':
          return info.decimals
        case 'symbol':
          return info.symbol
        case 'name':
          return info.name
        case 'balanceOf':
          return balance
        case 'allowance':
          return allowance
      }
    }

    throw new Error(`[test-fixtures] mock 未覆盖的调用：${address}.${functionName}(${String(args)})`)
  }

  const client = {
    async multicall(params: {
      contracts: Array<{ address: string; functionName: string; args?: readonly unknown[] }>
      allowFailure?: boolean
    }) {
      calls.push(`multicall(${params.contracts.map((c) => c.functionName).join('+')})`)
      const out = params.contracts.map((c) => answer(c.address, c.functionName, c.args))
      // allowFailure: true 时 viem 返回 { status, result } 包装（核心只在读 ERC20 元数据时这么用）
      return params.allowFailure ? out.map((result) => ({ status: 'success', result })) : out
    },
    async readContract(params: { address: string; functionName: string; args?: readonly unknown[] }) {
      calls.push(`readContract(${params.functionName})`)
      return answer(params.address, params.functionName, params.args)
    },
    async simulateContract(params: { address: string; functionName: string; args?: readonly unknown[] }) {
      // NPM 自带的 multicall：按真合约的语义逐个解出子调用、逐个作答、再编码回 bytes[]；
      // 任一子调用抛错整批抛（对齐 NPM.multicall 把子调用 revert 原样冒泡的行为）
      if (params.functionName === 'multicall' && String(params.address).toLowerCase() === NPM_ADDRESS.toLowerCase()) {
        const inner = (params.args?.[0] as readonly Hex[]).map((data) => decodeFunctionData({ abi: NPM_ABI, data }))
        calls.push(`simulateContract(multicall:${inner.map((c) => c.functionName).join('+')})`)
        const result = inner.map((c) =>
          encodeFunctionResult({
            abi: NPM_ABI,
            functionName: c.functionName,
            result: answer(params.address, c.functionName, c.args) as never,
          } as never),
        )
        return { result }
      }
      calls.push(`simulateContract(${params.functionName})`)
      return { result: answer(params.address, params.functionName, params.args) }
    },
  }

  return {
    client: client as unknown as PublicClient,
    calls,
    reset() {
      calls.length = 0
    },
  }
}

/**
 * 「一碰就抛」的 `publicClient`：任何属性访问都会炸。
 *
 * 用于证明某条路径**一次 RPC 都没发**（用例 6）。做成属性级而不是方法级的陷阱，
 * 是因为核心 SDK 可能读 `publicClient.chain` / `.transport` 之类的字段而不只是调方法 ——
 * 那同样意味着这条路径依赖了链上客户端，同样该被挡住。
 */
export function makeRpcTrapClient(): PublicClient {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`[test-fixtures] 不该发生的 RPC：publicClient.${String(prop)}`)
      },
    },
  ) as unknown as PublicClient
}
