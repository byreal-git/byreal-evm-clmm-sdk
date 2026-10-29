/**
 * 原生币（MNT）开仓 / 加仓 / 到账：WMNT 那一边随 value 支付并同笔 refundETH，
 * 或 collect 到 NPM 后同笔 unwrapWETH9 + sweepToken。全程 mock 前置读，0 RPC。
 */
import { describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, getAddress, type Address, type Hex, type PublicClient } from 'viem'

import { ExtraFeeClass, TickMath } from '../../raw/index.js'
import { NPM_ABI } from '../../abis.js'
import { Chain } from '../../chain/index.js'
import type { IClmmContracts, IPoolStateRaw, IPositionStateRaw } from '../../types.js'
import { CLMMClient } from '../clmm.js'

const WMNT = getAddress('0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8')
const CONTRACTS: IClmmContracts = {
  factory: '0xa5864429c7a88853951F6Fa50baeF4685D374267',
  positionManager: '0x77704B29BE267ad9a7843fA5F799881ada21b9fa',
  quoter: '0x104dBC505227f705a74837D393d05A43AD22d036',
  weth: WMNT,
}

const USDC = getAddress('0x0000000000000000000000000000000000000001')
const HIGH = getAddress('0xf000000000000000000000000000000000000001')
const USER = getAddress('0x1111111111111111111111111111111111111111')
const ZERO = '0x0000000000000000000000000000000000000000'
const BIG = 10n ** 30n

const pool = (token0: Address, token1: Address, tick = 0): IPoolStateRaw => ({
  poolAddress: getAddress('0xD67e3eb94Fb6a5cB5640A7439d99C84a6c12Ea86'),
  token0,
  token1,
  tickSpacing: 60,
  tradeFeeRate: 3000,
  protocolFeeRate: 10,
  pauseFlags: 0,
  swapOpenTime: 0,
  alphaExtraTradeFeeRate: 0,
  dexExtraTradeFeeRate: 0,
  dynamicFeeEnabled: false,
  sqrtPriceX96: BigInt(TickMath.getSqrtRatioAtTick(tick).toString()),
  tick,
  liquidity: 10n ** 18n,
  feeGrowthGlobal0X128: 0n,
  feeGrowthGlobal1X128: 0n,
})

// token0 = USDC，token1 = WMNT（地址排序决定）
const POOL = pool(USDC, WMNT)

const position = (poolState: IPoolStateRaw, liquidity = 10n ** 18n): IPositionStateRaw => ({
  tokenId: 7n,
  nonce: 0n,
  operator: ZERO,
  token0: poolState.token0,
  token1: poolState.token1,
  tickSpacing: poolState.tickSpacing,
  tickLower: -120,
  tickUpper: 120,
  liquidity,
  feeGrowthInside0LastX128: 0n,
  feeGrowthInside1LastX128: 0n,
  tokensOwed0: 0n,
  tokensOwed1: 0n,
})

function setup(opts: { poolState?: IPoolStateRaw; nativeBalance?: bigint; balance?: bigint; allowance?: bigint } = {}) {
  const { poolState = POOL, nativeBalance = BIG, balance = BIG, allowance = 0n } = opts
  const chain = new Chain({ publicClient: {} as PublicClient, chainId: 5000, contracts: CONTRACTS, extraFeeClass: ExtraFeeClass.DEX })
  const balances = { balance0: balance, balance1: balance, allowance0: allowance, allowance1: allowance }
  const mint = vi
    .spyOn(chain, 'getMintPrerequisites')
    .mockImplementation(async (p) => ({ poolState, ...balances, ...(p.withNativeBalance ? { nativeBalance } : {}) }))
  const modify = vi.spyOn(chain, 'getModifyPrerequisites').mockImplementation(async (p) => ({
    positionState: position(poolState),
    poolState,
    ...balances,
    ...(p.withNativeBalance ? { nativeBalance } : {}),
  }))
  vi.spyOn(chain, 'getTokenInfoList').mockImplementation(async (addresses) =>
    addresses.map((address) => ({
      chainId: 5000,
      address,
      decimals: 18,
      symbol: address === WMNT ? 'WMNT' : 'TK',
    })),
  )
  const positions = vi.spyOn(chain, 'getRawPositionInfo').mockResolvedValue(position(poolState))
  return { client: new CLMMClient({ chain }), mint, modify, positions }
}

/** 解出 NPM 调用：multicall 展开成子调用列表，单个调用原样返回 */
function npmCalls(data: Hex) {
  const outer = decodeFunctionData({ abi: NPM_ABI, data })
  const inner = outer.functionName === 'multicall' ? (outer.args[0] as readonly Hex[]) : [data]
  return inner.map((d) => decodeFunctionData({ abi: NPM_ABI, data: d }))
}

const createParams = {
  poolAddress: POOL.poolAddress,
  userAddress: USER,
  tickLower: -120,
  tickUpper: 120,
  base: 'Token0' as const,
  baseAmount: 10n ** 18n,
}

describe('useNative：原生币开仓 / 加仓', () => {
  it('createPosition：value = WMNT 一侧投入量，主交易为 multicall([mint, refundETH])，只 approve 另一边', async () => {
    const { client, mint } = setup()
    const { transactions, main, meta } = await client.createPosition({ ...createParams, useNative: true })

    expect(mint).toHaveBeenCalledWith(expect.objectContaining({ withNativeBalance: true }))
    expect(main.value).toBe(meta.amount1Desired)
    expect(main.value).toBeGreaterThan(0n)
    expect(npmCalls(main.data).map((c) => c.functionName)).toEqual(['mint', 'refundETH'])
    expect(meta.approvals).toEqual([{ token: USDC, amount: meta.amount0Desired }])
    expect(transactions).toHaveLength(2)
  })

  it('WMNT 在 token0 一侧时同样识别', async () => {
    const poolState = pool(WMNT, HIGH)
    const { client } = setup({ poolState })
    const { main, meta } = await client.createPosition({ ...createParams, poolAddress: poolState.poolAddress, useNative: true })
    expect(main.value).toBe(meta.amount0Desired)
    expect(meta.approvals).toEqual([{ token: HIGH, amount: meta.amount1Desired }])
  })

  it('原生币余额不足时报错，不再检查 WMNT 余额', async () => {
    const { client } = setup({ nativeBalance: 1n, balance: BIG })
    await expect(client.createPosition({ ...createParams, useNative: true })).rejects.toThrow(/原生币（代替 WMNT 支付/)
    // 反过来：WMNT 余额为 0 但原生币充足，照样能开仓
    const ok = setup({ nativeBalance: BIG, balance: 0n })
    await expect(ok.client.createPosition({ ...createParams, useNative: true, validateBalance: false })).resolves.toBeDefined()
  })

  it('池子不含 WMNT 时拒绝 useNative', async () => {
    const { client } = setup({ poolState: pool(USDC, HIGH) })
    await expect(client.createPosition({ ...createParams, useNative: true })).rejects.toThrow(/useNative 只适用于/)
  })

  it('价格在区间外、WMNT 一侧投入为 0 时退化为普通 mint，value 为 0', async () => {
    // tick 远低于区间：仓位 100% 由 token0（USDC）构成
    const { client } = setup({ poolState: pool(USDC, WMNT, -6000) })
    const { main, meta } = await client.createPosition({ ...createParams, useNative: true })
    expect(meta.amount1Desired).toBe(0n)
    expect(main.value).toBe(0n)
    expect(npmCalls(main.data).map((c) => c.functionName)).toEqual(['mint'])
  })

  it('不传 useNative 时行为不变：value 为 0，不读原生余额', async () => {
    const { client, mint } = setup()
    const { main } = await client.createPosition(createParams)
    expect(mint).toHaveBeenCalledWith(expect.objectContaining({ withNativeBalance: false }))
    expect(main.value).toBe(0n)
    expect(npmCalls(main.data).map((c) => c.functionName)).toEqual(['mint'])
  })

  it('addLiquidity：multicall([increaseLiquidity, refundETH])，value = WMNT 一侧投入量', async () => {
    const { client, modify } = setup()
    const { main, meta } = await client.addLiquidity({
      tokenId: 7n,
      userAddress: USER,
      base: 'Token0',
      baseAmount: 10n ** 18n,
      useNative: true,
    })
    expect(modify).toHaveBeenCalledWith(expect.objectContaining({ withNativeBalance: true }))
    expect(main.value).toBe(meta.amount1Desired)
    expect(npmCalls(main.data).map((c) => c.functionName)).toEqual(['increaseLiquidity', 'refundETH'])
  })
})

describe('receiveNative：WMNT 一侧以原生币到账', () => {
  it('decreaseLiquidity：collect 到 NPM，再 unwrapWETH9 + sweepToken 给 recipient', async () => {
    const { client } = setup()
    const { main } = await client.decreaseLiquidity({ tokenId: 7n, userAddress: USER, percent: 50, receiveNative: true })
    const calls = npmCalls(main.data)
    expect(calls.map((c) => c.functionName)).toEqual(['decreaseLiquidity', 'collect', 'unwrapWETH9', 'sweepToken'])
    expect((calls[1].args[0] as { recipient: string }).recipient).toBe(ZERO)
    expect(calls[2].args).toEqual([0n, USER])
    expect(calls[3].args).toEqual([USDC, 0n, USER])
    expect(main.value).toBe(0n)
  })

  it('decreaseLiquidity：receiveNative 不能与 collect: false 同时使用', async () => {
    const { client } = setup()
    await expect(
      client.decreaseLiquidity({ tokenId: 7n, userAddress: USER, percent: 50, collect: false, receiveNative: true }),
    ).rejects.toThrow(/receiveNative/)
  })

  it('collectFees：传了 positionState + pendingFees 时 0 次读链', async () => {
    const { client, positions } = setup()
    const recipient = getAddress('0x2222222222222222222222222222222222222222')
    const { main } = await client.collectFees({
      tokenId: 7n,
      userAddress: USER,
      recipient,
      receiveNative: true,
      positionState: position(POOL),
      pendingFees: { amount0: 1n, amount1: 2n },
    })
    expect(positions).not.toHaveBeenCalled()
    const calls = npmCalls(main.data)
    expect(calls.map((c) => c.functionName)).toEqual(['collect', 'unwrapWETH9', 'sweepToken'])
    expect(calls[1].args).toEqual([0n, recipient])
    expect(calls[2].args).toEqual([USDC, 0n, recipient])
  })

  it('collectFees：没传 positionState 时读一次 positions 判断哪边是 WMNT', async () => {
    const { client, positions } = setup()
    await client.collectFees({ tokenId: 7n, userAddress: USER, receiveNative: true, pendingFees: { amount0: 0n, amount1: 0n } })
    expect(positions).toHaveBeenCalledWith(7n)
  })

  it('collectFees：不传 receiveNative 时仍是单笔 collect', async () => {
    const { client, positions } = setup()
    const { main } = await client.collectFees({ tokenId: 7n, userAddress: USER, pendingFees: { amount0: 0n, amount1: 0n } })
    expect(positions).not.toHaveBeenCalled()
    expect(npmCalls(main.data).map((c) => c.functionName)).toEqual(['collect'])
  })

  it('closePosition：unwrap / sweep 在 burn 之前', async () => {
    const { client } = setup()
    const { main } = await client.closePosition({ tokenId: 7n, userAddress: USER, receiveNative: true })
    expect(npmCalls(main.data).map((c) => c.functionName)).toEqual([
      'decreaseLiquidity',
      'collect',
      'unwrapWETH9',
      'sweepToken',
      'burn',
    ])
  })

  it('池子不含 WMNT 时拒绝 receiveNative', async () => {
    const { client } = setup({ poolState: pool(USDC, HIGH) })
    await expect(client.closePosition({ tokenId: 7n, userAddress: USER, receiveNative: true })).rejects.toThrow(
      /receiveNative 只适用于/,
    )
  })
})
