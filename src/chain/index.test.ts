/**
 * Byreal 定制合约的关键回归测试：
 * 1. quoteSwap 实际传出的六字段 struct 与逐调用 extraFeeClass 覆盖；
 * 2. 热路径 fresh 读必须返回**更新后**的 tradeFeeRate（可变数据不许进不变缓存）；
 * 3. slot0 第 6 项按定制合约语义映射为 protocolFeeRate（百分比），不做 V3 打包位解码。
 *
 * 这些点当前实现正确，但最容易在将来重排 ABI / 重构 mock 时无声回归，所以用直接断言钉死。
 */
import { describe, expect, it } from 'vitest'
import type { Address, PublicClient } from 'viem'

import { ExtraFeeClass } from '../raw/index.js'
import type { IClmmContracts } from '../types.js'
import { Chain } from './index.js'

const CONTRACTS: IClmmContracts = {
  factory: '0xa5864429c7a88853951F6Fa50baeF4685D374267',
  positionManager: '0x77704B29BE267ad9a7843fA5F799881ada21b9fa',
  quoter: '0x104dBC505227f705a74837D393d05A43AD22d036',
  weth: '0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8',
}

const POOL: Address = '0xC6962004f452bE9203591991D15f6b388e09E8D0'
const TOKEN_A: Address = '0x0000000000000000000000000000000000000001'
const TOKEN_B: Address = '0x0000000000000000000000000000000000000002'

/** slot0 七元组：第 6 项是 protocolFeeRate（uint8 百分比），不是 V3 的 feeProtocol 打包位 */
const slot0 = (protocolFeeRate: number) => [79228162514264337593543950336n, 0, 0, 1, 1, protocolFeeRate, true]

/** 池子动态字段的一轮 multicall 结果（顺序与 chain 层 poolDynamicCalls 严格一致） */
const dynamicResults = (opts: { tradeFeeRate: number; protocolFeeRate: number; pauseFlags?: number; dyn?: boolean }) => [
  slot0(opts.protocolFeeRate),
  1_000_000n, // liquidity
  0n, // feeGrowthGlobal0X128
  0n, // feeGrowthGlobal1X128
  opts.tradeFeeRate,
  opts.pauseFlags ?? 0,
  0, // swapOpenTime
  0, // alphaExtraTradeFeeRate
  0, // dexExtraTradeFeeRate
  opts.dyn ?? false,
]

describe('quoteSwap：ByrealQuoter 的六字段 struct 与档位覆盖', () => {
  function makeChain() {
    const captured: Array<{ address: string; functionName: string; args: readonly unknown[] }> = []
    const client = {
      async simulateContract(params: { address: string; functionName: string; args: readonly unknown[] }) {
        captured.push(params)
        return { result: [123n, 456n, 3, 789n] }
      },
    } as unknown as PublicClient
    return { chain: new Chain({ publicClient: client, chainId: 5000, contracts: CONTRACTS, extraFeeClass: ExtraFeeClass.DEX }), captured }
  }

  it('struct 恰为 (tokenIn, tokenOut, amountIn, tickSpacing, sqrtPriceLimitX96, extraFeeClass)，缺省用构造档位', async () => {
    const { chain, captured } = makeChain()
    const out = await chain.quoteSwap({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, tickSpacing: 60, amountIn: 10n ** 18n })

    expect(captured).toHaveLength(1)
    expect(captured[0].address).toBe(CONTRACTS.quoter)
    expect(captured[0].functionName).toBe('quoteExactInputSingle')
    expect(captured[0].args[0]).toEqual({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 10n ** 18n,
      tickSpacing: 60,
      sqrtPriceLimitX96: 0n,
      extraFeeClass: ExtraFeeClass.DEX,
    })
    expect(out).toEqual({ amountOut: 123n, sqrtPriceX96After: 456n, ticksCrossed: 3, gasEstimate: 789n })
  })

  it('逐调用 extraFeeClass 覆盖构造档位', async () => {
    const { chain, captured } = makeChain()
    await chain.quoteSwap({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      tickSpacing: 60,
      amountIn: 1n,
      extraFeeClass: ExtraFeeClass.ALPHA,
    })
    expect((captured[0].args[0] as { extraFeeClass: number }).extraFeeClass).toBe(ExtraFeeClass.ALPHA)
  })
})

describe('getRawPoolInfo：可变费率不进缓存，slot0[5] = protocolFeeRate', () => {
  it('热路径返回链上更新后的 tradeFeeRate / pauseFlags / dynamicFeeEnabled', async () => {
    // 第 1 次（冷路径 13 call）：不变字段 + tradeFeeRate=3000；第 2 次（热路径 10 call）：治理已把费率改成 5000
    const rounds = [
      [TOKEN_A, TOKEN_B, 60, ...dynamicResults({ tradeFeeRate: 3000, protocolFeeRate: 10 })],
      dynamicResults({ tradeFeeRate: 5000, protocolFeeRate: 25, pauseFlags: 16, dyn: true }),
    ]
    const callCounts: number[] = []
    const client = {
      async multicall(params: { contracts: readonly unknown[] }) {
        callCounts.push(params.contracts.length)
        return rounds.shift()
      },
    } as unknown as PublicClient
    const chain = new Chain({ publicClient: client, chainId: 5000, contracts: CONTRACTS, extraFeeClass: ExtraFeeClass.DEX })

    const first = await chain.getRawPoolInfo(POOL)
    expect(callCounts[0]).toBe(13)
    expect(first.tickSpacing).toBe(60)
    expect(first.tradeFeeRate).toBe(3000)
    // slot0 第 6 项直接就是百分比，断言没有按 V3 的 feeProtocol 双 4bit 去解包（那样 10 会变成 10&0xf/10>>4）
    expect(first.protocolFeeRate).toBe(10)

    const second = await chain.getRawPoolInfo(POOL)
    expect(callCounts[1]).toBe(10) // 不变字段命中缓存，动态字段每次 fresh 读
    expect(second.tradeFeeRate).toBe(5000) // ← 关键：费率变了必须立刻反映，绝不许读到缓存的 3000
    expect(second.protocolFeeRate).toBe(25)
    expect(second.pauseFlags).toBe(16)
    expect(second.dynamicFeeEnabled).toBe(true)
    expect(second.tickSpacing).toBe(60) // 不变字段来自缓存
  })
})


describe('getMintPrerequisites：原生币余额拼进同一轮 multicall', () => {
  it('withNativeBalance 时末尾多一个 Multicall3.getEthBalance，否则不读', async () => {
    const USER: Address = '0x1111111111111111111111111111111111111111'
    const rounds: Array<ReadonlyArray<{ address: Address; functionName: string; args?: readonly unknown[] }>> = []
    const results = [
      [TOKEN_A, TOKEN_B, 60], // 不变字段（冷路径）
      [...dynamicResults({ tradeFeeRate: 3000, protocolFeeRate: 10 }), 1n, 2n, 3n, 4n, 5n],
      [...dynamicResults({ tradeFeeRate: 3000, protocolFeeRate: 10 }), 1n, 2n, 3n, 4n],
    ]
    const client = {
      async multicall(params: { contracts: ReadonlyArray<{ address: Address; functionName: string }> }) {
        rounds.push(params.contracts)
        return results.shift()
      },
    } as unknown as PublicClient
    const chain = new Chain({ publicClient: client, chainId: 5000, contracts: CONTRACTS, extraFeeClass: ExtraFeeClass.DEX })

    const withNative = await chain.getMintPrerequisites({ poolAddress: POOL, userAddress: USER, spender: CONTRACTS.positionManager, withNativeBalance: true })
    expect(rounds[1]).toHaveLength(15)
    expect(rounds[1][14]).toMatchObject({ functionName: 'getEthBalance', args: [USER] })
    expect(withNative).toMatchObject({ balance0: 1n, balance1: 2n, allowance0: 3n, allowance1: 4n, nativeBalance: 5n })

    const without = await chain.getMintPrerequisites({ poolAddress: POOL, userAddress: USER, spender: CONTRACTS.positionManager })
    expect(rounds[2]).toHaveLength(14)
    expect(without).not.toHaveProperty('nativeBalance')
  })
})
