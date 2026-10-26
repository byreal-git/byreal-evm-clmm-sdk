/**
 * 读链版 {@link CompatCLMMClient} 与快照版 {@link CompatOffchain} 的**行为对齐**测试。
 *
 * ## 为什么单独一份
 * 这两个类是同一套 Solana 调用形状的两种数据来源实现，前端会在同一个页面里混用
 * （详情页有后端快照就走 offchain，缺快照就退回读链版）。它们各自的用例已经在
 * `liquidity.test.ts` / `offchain.test.ts` 里，但**「两边行为相同」这条契约没有归属**——
 * 而它恰恰是最容易破的：任何一边单独改一行归一化逻辑都不会让对方的用例变红。
 *
 * 分叉的后果不是「报错」而是「同一个按钮，换条数据来源就变成另一笔交易」：
 * 比如同一份表单里没填的输入框（`''`）在一边被当作「没填」、在另一边被当作非法值；
 * 或者同一组互相矛盾的百分比别名，一边抛错、一边**静默选了其中一个**去减仓。
 * 这类差异线上极难复现，所以在这里逐条钉死。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EvmClmmSdk } from '../client.js'

import { CompatCLMMClient } from './liquidity.js'
import { CompatOffchain } from './offchain.js'
import {
  CHAIN_ID,
  makeMockPublicClient,
  OTHER,
  POOL_ADDRESS,
  POOL_STATE,
  POSITION_STATE,
  TOKEN_ID,
  USDC,
  USER,
  WETH,
} from './test-fixtures.js'

/** 池子快照里把 token 位换成带 decimals 的对象 —— offchain 靠它免掉读 ERC20 元数据 */
const POOL_SNAPSHOT = { ...POOL_STATE, token0: WETH, token1: USDC }

const TICK_LOWER = POSITION_STATE.tickLower
const TICK_UPPER = POSITION_STATE.tickUpper

/**
 * 两个客户端共用同一个 SDK 实例：读链版会真的去问那个 mock，offchain 一次都不该问。
 * 共用而不是各造一个，是为了让「同一个 sdk、同一份缓存」下的差异只可能来自 compat 自身。
 */
function newPair() {
  const mock = makeMockPublicClient()
  const sdk = new EvmClmmSdk({ chainId: CHAIN_ID, profileId: 'test', publicClient: mock.client })
  return {
    sdk,
    mock,
    onchain: new CompatCLMMClient({ sdk }),
    offchain: new CompatOffchain({ sdk }),
  }
}

/** offchain 侧要多传的那几份快照（读链版会自己去读） */
const SNAPSHOTS = {
  rawPoolInfo: POOL_SNAPSHOT,
  rawPositionInfo: POSITION_STATE,
} as const

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
})
afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// calldata 必须逐字节相同
// ---------------------------------------------------------------------------

describe('两个客户端产出同一笔交易', () => {
  it('开仓 / 加仓 / 减仓 / 关仓 / 领费 五个动作的 main 完全相等', async () => {
    const { onchain, offchain } = newPair()

    const create = {
      userAddress: USER,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'MintA' as const,
      baseAmount: 10n ** 15n,
      slippageBps: 200,
    }
    const a = await onchain.createPositionInstructions({ ...create, poolAddress: POOL_ADDRESS })
    const b = await offchain.createPositionInstructions({ ...create, rawPoolInfo: POOL_SNAPSHOT })
    expect(b.main).toEqual(a.main)
    expect(b.meta.amount0Min).toBe(a.meta.amount0Min)
    expect(b.meta.uiAmount1Desired).toBe(a.meta.uiAmount1Desired)

    const add = {
      userAddress: USER,
      tokenId: TOKEN_ID,
      base: 'MintB' as const,
      baseAmount: 1_000_000,
      slippageBps: 200,
    }
    expect((await offchain.addLiquidityInstructions({ ...add, ...SNAPSHOTS })).main).toEqual(
      (await onchain.addLiquidityInstructions(add)).main,
    )

    const dec = { userAddress: USER, tokenId: TOKEN_ID, percent: 50, slippageBps: 200 }
    expect((await offchain.decreaseLiquidityInstructions({ ...dec, ...SNAPSHOTS })).main).toEqual(
      (await onchain.decreaseLiquidityInstructions(dec)).main,
    )

    const close = { userAddress: USER, tokenId: TOKEN_ID, slippageBps: 200 }
    expect((await offchain.closePositionInstructions({ ...close, ...SNAPSHOTS })).main).toEqual(
      (await onchain.closePositionInstructions(close)).main,
    )

    const collect = { userAddress: USER, tokenId: TOKEN_ID }
    expect(
      (
        await offchain.collectFeesInstructions({
          ...collect,
          rawPoolInfo: POOL_SNAPSHOT,
          pendingFees: { amount0: 10n ** 15n, amount1: 2_000_000n },
        })
      ).main,
    ).toEqual((await onchain.collectFeesInstructions(collect)).main)
  })

  it('meta 的 ui* 与 token 元数据两边一致（decimals 挂错在界面上只表现为「数字有点大」）', async () => {
    const { onchain, offchain } = newPair()
    const args = { userAddress: USER, tokenId: TOKEN_ID, percent: 33.33, slippageBps: 200 }
    const a = await onchain.decreaseLiquidityInstructions(args)
    const b = await offchain.decreaseLiquidityInstructions({ ...args, ...SNAPSHOTS })
    expect(b.meta.token0).toEqual(a.meta.token0)
    expect(b.meta.token1).toEqual(a.meta.token1)
    expect(b.meta.uiExpectedAmount0).toBe(a.meta.uiExpectedAmount0)
    expect(b.meta.uiAmount1Min).toBe(a.meta.uiAmount1Min)
    expect(b.meta.slippageBps).toBe(a.meta.slippageBps)
  })
})

// ---------------------------------------------------------------------------
// 表单里「没填」的输入框：`''` 在两边都必须等于「没给」
// ---------------------------------------------------------------------------

describe('空字符串 = 没填，两个客户端口径必须一致', () => {
  it('recipient 是空串时视作「默认打回 userAddress」，不是非法地址', async () => {
    const { onchain, offchain } = newPair()
    const args = { userAddress: USER, tokenId: TOKEN_ID, percent: 50, slippageBps: 200 }

    const onchainBlank = await onchain.decreaseLiquidityInstructions({ ...args, recipient: '' })
    const onchainOmit = await onchain.decreaseLiquidityInstructions(args)
    expect(onchainBlank.main.data).toBe(onchainOmit.main.data)

    const offchainBlank = await offchain.decreaseLiquidityInstructions({
      ...args,
      ...SNAPSHOTS,
      recipient: '',
    })
    expect(offchainBlank.main.data).toBe(onchainOmit.main.data)
  })

  it('userAddress 是空串时回退到 walletAddress，两边都不该报「空字符串」', async () => {
    const { onchain, offchain } = newPair()
    const args = { userAddress: '', walletAddress: USER, tokenId: TOKEN_ID, slippageBps: 200 }
    const a = await onchain.closePositionInstructions(args)
    const b = await offchain.closePositionInstructions({ ...args, ...SNAPSHOTS })
    expect(b.main.data).toBe(a.main.data)
  })

  it('poolAddress 是空串时回退到快照里的池子地址', async () => {
    const { onchain, offchain } = newPair()
    const create = {
      userAddress: USER,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'MintA' as const,
      baseAmount: 10n ** 15n,
      slippageBps: 200,
    }
    const a = await onchain.createPositionInstructions({
      ...create,
      poolAddress: '',
      poolState: POOL_SNAPSHOT,
    })
    const b = await offchain.createPositionInstructions({
      ...create,
      poolAddress: '',
      rawPoolInfo: POOL_SNAPSHOT,
    })
    expect(b.main.data).toBe(a.main.data)
  })

  it('otherAmountMax 是空串 = 没设上限（两边都不能当成 0，那会让所有开仓都失败）', async () => {
    const { onchain, offchain } = newPair()
    const create = {
      userAddress: USER,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'MintA' as const,
      baseAmount: 10n ** 15n,
      slippageBps: 200,
      otherAmountMax: '',
    }
    const a = await onchain.createPositionInstructions({ ...create, poolAddress: POOL_ADDRESS })
    const b = await offchain.createPositionInstructions({ ...create, rawPoolInfo: POOL_SNAPSHOT })
    expect(b.main.data).toBe(a.main.data)
  })

  it('减仓的 liquidity 是空串时回退到 percent（而不是报「无法解析为链上整数」）', async () => {
    const { onchain, offchain } = newPair()
    const args = { userAddress: USER, tokenId: TOKEN_ID, liquidity: '', percent: 50, slippageBps: 200 }
    const a = await onchain.decreaseLiquidityInstructions(args)
    const b = await offchain.decreaseLiquidityInstructions({ ...args, ...SNAPSHOTS })
    expect(b.main.data).toBe(a.main.data)
  })

  it('领费的 amount0Max / amount1Max 是空串时回退到 uint128.max', async () => {
    const { onchain, offchain } = newPair()
    const blank = { userAddress: USER, tokenId: TOKEN_ID, amount0Max: '', amount1Max: '' }
    const omit = { userAddress: USER, tokenId: TOKEN_ID }
    expect((await onchain.collectFeesInstructions(blank)).main.data).toBe(
      (await onchain.collectFeesInstructions(omit)).main.data,
    )
    const pendingFees = { amount0: 1n, amount1: 2n }
    expect(
      (await offchain.collectFeesInstructions({ ...blank, rawPoolInfo: POOL_SNAPSHOT, pendingFees }))
        .main.data,
    ).toBe(
      (await offchain.collectFeesInstructions({ ...omit, rawPoolInfo: POOL_SNAPSHOT, pendingFees }))
        .main.data,
    )
  })
})

// ---------------------------------------------------------------------------
// 同一个语义的多个别名：两边都必须「不猜」
// ---------------------------------------------------------------------------

describe('别名冲突时两个客户端都必须抛，不许有一边静默挑一个', () => {
  it('percent / decreasePercentage / percentage 取值不一致时都抛', async () => {
    const { onchain, offchain } = newPair()
    const conflict = {
      userAddress: USER,
      tokenId: TOKEN_ID,
      percent: 25,
      percentage: 50,
      slippageBps: 200,
    }
    await expect(onchain.decreaseLiquidityInstructions(conflict)).rejects.toThrow(/只保留一个/)
    // 静默挑一个 = 用户点「减仓 25%」实际减了 50%，是纯粹的资金事故
    await expect(
      offchain.decreaseLiquidityInstructions({ ...conflict, ...SNAPSHOTS }),
    ).rejects.toThrow(/只保留一个/)
  })

  it('percent 的三个别名取值一致时，两边都产出同一笔交易', async () => {
    const { onchain, offchain } = newPair()
    const args = { userAddress: USER, tokenId: TOKEN_ID, slippageBps: 200 }
    const a = await onchain.decreaseLiquidityInstructions({ ...args, percent: 25 })
    const b = await offchain.decreaseLiquidityInstructions({
      ...args,
      ...SNAPSHOTS,
      decreasePercentage: 25,
      percentage: 25,
    })
    expect(b.main.data).toBe(a.main.data)
  })

  it('percent 传字符串（表单原样透传）两边都认', async () => {
    const { onchain, offchain } = newPair()
    const args = { userAddress: USER, tokenId: TOKEN_ID, slippageBps: 200 }
    const a = await onchain.decreaseLiquidityInstructions({ ...args, percent: 50 })
    expect(
      (await onchain.decreaseLiquidityInstructions({ ...args, percent: '50' })).main.data,
    ).toBe(a.main.data)
    expect(
      (await offchain.decreaseLiquidityInstructions({ ...args, ...SNAPSHOTS, percent: '50' })).main
        .data,
    ).toBe(a.main.data)
  })

  it('userAddress 与 walletAddress 是两个不同地址时都抛', async () => {
    const { onchain, offchain } = newPair()
    const conflict = { userAddress: USER, walletAddress: OTHER, tokenId: TOKEN_ID, slippageBps: 200 }
    await expect(onchain.closePositionInstructions(conflict)).rejects.toThrow(/不猜哪个优先/)
    await expect(offchain.closePositionInstructions({ ...conflict, ...SNAPSHOTS })).rejects.toThrow(
      /不猜/,
    )
  })

  it('tokenId 与 nftMint 不一致时都抛', async () => {
    const { onchain, offchain } = newPair()
    const conflict = { userAddress: USER, tokenId: TOKEN_ID, nftMint: 999, slippageBps: 200 }
    await expect(onchain.closePositionInstructions(conflict)).rejects.toThrow(/tokenId/)
    await expect(offchain.closePositionInstructions({ ...conflict, ...SNAPSHOTS })).rejects.toThrow(
      /tokenId/,
    )
  })

  it('pendingFees 的 amountA / amountB 旧名两边都认，且与新名产出同一笔交易', async () => {
    const { onchain, offchain } = newPair()
    const oldNames = { amountA: 1, amountB: 2 }
    const newNames = { amount0: 1, amount1: 2 }
    const a = await onchain.collectFeesInstructions({
      userAddress: USER,
      tokenId: TOKEN_ID,
      pendingFees: oldNames,
    })
    const b = await onchain.collectFeesInstructions({
      userAddress: USER,
      tokenId: TOKEN_ID,
      pendingFees: newNames,
    })
    expect(a.main.data).toBe(b.main.data)
    expect(a.meta.amount0).toBe(1n)

    const c = await offchain.collectFeesInstructions({
      userAddress: USER,
      tokenId: TOKEN_ID,
      rawPoolInfo: POOL_SNAPSHOT,
      pendingFees: oldNames,
    })
    expect(c.main.data).toBe(a.main.data)
    expect(c.meta.amount1).toBe(2n)
  })

  it('pendingFees 只给一边时两边都抛（补 0 会让 UI 显示「那边没手续费」）', async () => {
    const { onchain, offchain } = newPair()
    await expect(
      onchain.collectFeesInstructions({
        userAddress: USER,
        tokenId: TOKEN_ID,
        pendingFees: { amount0: 1 },
      }),
    ).rejects.toThrow(/必须同时给出 amount0 与 amount1/)
    await expect(
      offchain.collectFeesInstructions({
        userAddress: USER,
        tokenId: TOKEN_ID,
        rawPoolInfo: POOL_SNAPSHOT,
        pendingFees: { amount1: 2 },
      }),
    ).rejects.toThrow(/必须同时给出 amount0 与 amount1/)
  })
})
