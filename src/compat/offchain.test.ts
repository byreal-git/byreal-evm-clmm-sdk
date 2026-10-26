/**
 * `CompatOffchain` 的测试（用例 6 / 7 + offchain 自己的边界）。
 *
 * 这两条是 compat 测试里最值钱的：
 * - **用例 6（0 RPC）**：offchain 存在的**全部理由**就是「链上数据由后端下发，SDK 一次网络请求都不发」。
 *   这里用两种互补的手段证明，缺一不可：
 *   ① 一个「一碰就抛」的 `publicClient`（属性级陷阱）——保证连读一个字段都会炸；
 *   ② 一个**会正常应答**的 `publicClient` + 调用计数 —— 并配上**反证**：
 *      同一份快照直接喂给核心 SDK，它仍然会去读 ERC20 元数据。
 *      没有②的反证，①就可能只是「恰好没碰到」而不是「真的堵住了」。
 * - **用例 7（与核心逐字节一致）**：compat 只许翻译入参，不许改变产出的交易。
 *   这里比较**整笔交易**（to / data / value / chainId）而不只是 `data`，
 *   并用固定的 `Date.now` 消除 deadline 抖动。
 *
 * 快照用 Arbitrum WETH/USDC 池的真实形状（`test-fixtures.ts`，与读链版测试同源，
 * 保证两边比的是同一组数据）。`sqrtPriceX96` 由 tick 现算，与核心 `toUniPool` 的自洽性校验一致。
 */
import { decodeFunctionData } from 'viem'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { NPM_ABI } from '../abis.js'
import { EvmClmmSdk } from '../client.js'
import { ExtraFeeClass } from '../constants.js'

import { CompatOffchain, buildPoolStateRaw } from './offchain.js'
import { toPoolStateRaw, toPositionStateRaw } from './state.js'
import {
  API_POOL,
  API_POSITION,
  CHAIN_ID,
  CURRENT_TICK,
  makeMockPublicClient,
  makeRpcTrapClient,
  POOL_ADDRESS,
  USDC_ADDRESS,
  WETH_ADDRESS,
  TOKEN_ID,
  USER,
} from './test-fixtures.js'

const TICK = CURRENT_TICK
const TICK_LOWER = TICK - 1000
const TICK_UPPER = TICK + 1000

/**
 * **文件级**钉死 `Date.now`。
 *
 * deadline = `floor(Date.now()/1000) + N`，所以任何「比较两次调用产物」的断言都可能
 * 跨秒抖动 —— 同秒内跑相等、跨了秒就在 calldata 的 deadline 槽位上差出几个字节，
 * 报错还是一大坨 hex diff。曾经只在下面两个 describe 里钉，用例 6 那组漏了，
 * 结果是一条只在 CI 负载高时才复现的 flake。钉在文件级就不用每加一个 describe 记一次。
 */
const FIXED_NOW = 1_700_000_000_000
beforeAll(() => {
  vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW)
})
afterAll(() => {
  vi.restoreAllMocks()
})

/** 所有「证明 0 RPC」的用例共用：它的 publicClient 一碰就抛 */
const offchain = new CompatOffchain({
  sdk: new EvmClmmSdk({ chainId: CHAIN_ID, profileId: 'test', extraFeeClass: ExtraFeeClass.DEX, publicClient: makeRpcTrapClient() }),
})

describe('CompatOffchain · 0 RPC（用例 6）', () => {
  it('createPositionInstructions 全程不碰 publicClient', async () => {
    const r = await offchain.createPositionInstructions({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'MintB',
      baseAmount: '1000000',
      slippage: 0.02,
    })
    expect(r.transactions).toHaveLength(1) // autoApprove:false，不会插 approve
    expect(r.meta.slippageBps).toBe(200) // 旧口径小数被换算成基点
    expect(r.meta.uiAmount1Desired).toBe('1')
  })

  it('addLiquidityInstructions / decreaseLiquidityInstructions / 关仓 全程不碰 publicClient', async () => {
    const add = await offchain.addLiquidityInstructions({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
      base: 'MintA',
      baseAmount: 10n ** 15n,
      slippageBps: 200,
    })
    expect(add.main.label).toContain('加仓 #123456')

    const dec = await offchain.decreaseLiquidityInstructions({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
      // 旧代码里的别名
      percentage: 50,
      slippageBps: 200,
    })
    expect(dec.meta.liquidity).toBe(499_999_999_999n)

    const closed = await offchain.decreaseFullLiquidityInstructions({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
      slippageBps: 200,
    })
    expect(closed.main.label).toContain('burn')

    const kept = await offchain.decreaseFullLiquidityInstructions({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
      closePosition: false,
      slippageBps: 200,
    })
    expect(kept.main.label).not.toContain('burn')

    // 短名与旧名走同一条实现
    expect((await offchain.closePosition({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
      slippageBps: 200,
    })).main.data).toBe(closed.main.data)
  })

  it('collectFeesInstructions 传了 pendingFees 就不做 staticcall', async () => {
    const r = await offchain.collectFeesInstructions({
      userAddress: USER,
      tokenId: 123456,
      rawPoolInfo: API_POOL,
      pendingFees: { amount0: '1000000000000000', amount1: '2000000' },
    })
    expect(r.meta.uiAmount0).toBe('0.001')
    expect(r.meta.uiAmount1).toBe('2')
  })

  it('批量领费打成一笔 multicall，明细与按币种汇总都在 meta 里', async () => {
    const r = await offchain.collectAllPositionFeesInstructions({
      userAddress: USER,
      positionDataList: [
        { tokenId: 1, rawPoolInfo: API_POOL, pendingFees: { amount0: 10, amount1: 20 } },
        // amountA / amountB 是 Solana 侧的叫法，也认
        { tokenId: 2, rawPoolInfo: API_POOL, pendingFees: { amountA: 30, amountB: 40 } },
      ],
    })
    expect(r.transactions).toHaveLength(1)
    expect(r.meta.perPosition.map((p) => p.tokenId)).toEqual([1n, 2n])
    expect(r.meta.totals.map((t) => t.amount)).toEqual([40n, 60n])
  })

  it('getPositionInfoByNftMint（纯本地仓位详情）同样不碰 publicClient', () => {
    const info = offchain.getPositionInfoByNftMint({
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
    })
    expect(info.tokenId).toBe(TOKEN_ID)
  })
})

describe('CompatOffchain · 0 RPC 的直接计数与反证（用例 6 的关键一半）', () => {
  it('换成会正常应答的 publicClient：offchain 的调用计数必须是 0', async () => {
    const mock = makeMockPublicClient()
    const sdk = new EvmClmmSdk({ chainId: CHAIN_ID, profileId: 'test', extraFeeClass: ExtraFeeClass.DEX, publicClient: mock.client })
    const off = new CompatOffchain({ sdk })

    await off.createPositionInstructions({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'MintA',
      baseAmount: 10n ** 15n,
      slippageBps: 200,
    })
    await off.addLiquidityInstructions({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
      base: 'MintA',
      baseAmount: 10n ** 15n,
      slippageBps: 200,
    })
    await off.decreaseLiquidityInstructions({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
      percent: 50,
      slippageBps: 200,
    })
    await off.collectFeesInstructions({
      userAddress: USER,
      tokenId: TOKEN_ID,
      rawPoolInfo: API_POOL,
      pendingFees: { amount0: 1, amount1: 2 },
    })
    expect(mock.calls).toEqual([])
  })

  it('反证：同一份快照直接喂给核心 SDK，它仍然会去读 ERC20 元数据', async () => {
    const mock = makeMockPublicClient()
    const sdk = new EvmClmmSdk({ chainId: CHAIN_ID, profileId: 'test', extraFeeClass: ExtraFeeClass.DEX, publicClient: mock.client })

    // 核心的 offline 逃生口只跳过「池子状态 / 余额 / 授权」这一次前置读，
    // **不跳过** getTokenInfoList —— 这正是 CompatOffchain 要用离线 Chain 代理补掉的那一段。
    // 有了这条反证，上一个用例的 `calls === []` 才是「真的堵住了」而不是「mock 恰好没被碰到」。
    await sdk.clmmClient.createPosition({
      poolAddress: POOL_ADDRESS,
      userAddress: USER,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'Token0',
      baseAmount: 10n ** 15n,
      slippageBps: 200,
      poolState: toPoolStateRaw(API_POOL),
      autoApprove: false,
    })
    expect(mock.calls.length).toBeGreaterThan(0)
    expect(mock.calls.some((c) => c.startsWith('multicall(decimals'))).toBe(true)
  })

  it('缺代币元数据时不会「偷偷去读链」，而是抛错（宁可炸也不悄悄多发 RPC）', async () => {
    const mock = makeMockPublicClient()
    const off = new CompatOffchain({
      sdk: new EvmClmmSdk({ chainId: CHAIN_ID, profileId: 'test', extraFeeClass: ExtraFeeClass.DEX, publicClient: mock.client }),
    })
    await expect(
      off.createPositionInstructions({
        userAddress: USER,
        // token 位退化成裸地址串 → 给不出 decimals
        rawPoolInfo: { ...API_POOL, token0: API_POOL.token0.address, token1: API_POOL.token1.address },
        tickLower: TICK_LOWER,
        tickUpper: TICK_UPPER,
        base: 'MintA',
        baseAmount: 10n ** 15n,
        slippageBps: 200,
      }),
    ).rejects.toThrow(/代币元数据/)
    expect(mock.calls).toEqual([])
  })
})

describe('CompatOffchain · 与核心 SDK 逐字节一致（用例 7）', () => {
  const poolState = toPoolStateRaw(API_POOL)
  const positionState = toPositionStateRaw({ ...API_POSITION, pool: poolState })

  /** 比较整笔交易：`to` 错了就是发给别的合约，`value` 错了在 ERC20 池子上等于白送原生币 */
  function expectSameTx(a: { to: string; data: string; value: bigint; chainId: number }, b: typeof a) {
    expect(a.data).toBe(b.data)
    expect(a.to).toBe(b.to)
    expect(a.value).toBe(b.value)
    expect(a.chainId).toBe(b.chainId)
  }

  it('createPosition / addLiquidity / decreaseLiquidity / closePosition / collectFees 完全相等', async () => {
    const core = new EvmClmmSdk({ chainId: CHAIN_ID, profileId: 'test', extraFeeClass: ExtraFeeClass.DEX, publicClient: makeMockPublicClient().client })

    const a = await offchain.createPositionInstructions({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'MintB',
      baseAmount: '1000000',
      slippageBps: 200,
    })
    const b = await core.clmmClient.createPosition({
      poolAddress: poolState.poolAddress,
      userAddress: USER,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'Token1',
      baseAmount: 1_000_000n,
      slippageBps: 200,
      poolState,
      autoApprove: false,
    })
    expectSameTx(a.main, b.main)
    expect(a.transactions).toHaveLength(b.transactions.length)
    expect(a.meta.liquidity).toBe(b.meta.liquidity)
    expect(a.meta.amount0Min).toBe(b.meta.amount0Min)
    expect(a.meta.amount1Min).toBe(b.meta.amount1Min)
    expect(a.meta.deadline).toBe(b.meta.deadline)

    const c = await offchain.addLiquidityInstructions({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
      base: 'MintA',
      baseAmount: 10n ** 15n,
      slippageBps: 200,
    })
    const d = await core.clmmClient.addLiquidity({
      tokenId: TOKEN_ID,
      userAddress: USER,
      base: 'Token0',
      baseAmount: 10n ** 15n,
      slippageBps: 200,
      poolState,
      positionState,
      autoApprove: false,
    })
    expectSameTx(c.main, d.main)
    expect(c.meta.liquidity).toBe(d.meta.liquidity)

    const e = await offchain.decreaseLiquidityInstructions({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
      percent: 50,
      slippageBps: 200,
    })
    const f = await core.clmmClient.decreaseLiquidity({
      tokenId: TOKEN_ID,
      userAddress: USER,
      percent: 50,
      slippageBps: 200,
      poolState,
      positionState,
    })
    expectSameTx(e.main, f.main)
    expect(e.meta.expectedAmount0).toBe(f.meta.expectedAmount0)

    const g = await offchain.closePositionInstructions({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
      slippageBps: 200,
    })
    const h = await core.clmmClient.closePosition({
      tokenId: TOKEN_ID,
      userAddress: USER,
      slippageBps: 200,
      poolState,
      positionState,
    })
    expectSameTx(g.main, h.main)

    const i = await offchain.collectFeesInstructions({
      userAddress: USER,
      tokenId: 123456,
      rawPoolInfo: API_POOL,
      pendingFees: { amount0: 1, amount1: 2 },
    })
    const j = await core.clmmClient.collectFees({
      tokenId: TOKEN_ID,
      userAddress: USER,
      pendingFees: { amount0: 1n, amount1: 2n },
    })
    expectSameTx(i.main, j.main)
    expect(i.meta.amount0).toBe(j.meta.amount0)
  })

  it('deadlineSec 显式传入时同样与核心一致（不是靠默认值恰好相同）', async () => {
    const core = new EvmClmmSdk({ chainId: CHAIN_ID, profileId: 'test', extraFeeClass: ExtraFeeClass.DEX, publicClient: makeMockPublicClient().client })
    const a = await offchain.decreaseLiquidityInstructions({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
      percent: 50,
      slippageBps: 200,
      deadlineSec: 60,
    })
    const b = await core.clmmClient.decreaseLiquidity({
      tokenId: TOKEN_ID,
      userAddress: USER,
      percent: 50,
      slippageBps: 200,
      deadlineSec: 60,
      poolState,
      positionState,
    })
    expect(a.main.data).toBe(b.main.data)
    // 反证：deadline 真的进了 calldata（否则上面那条断言对任何 deadline 都成立）
    const c = await core.clmmClient.decreaseLiquidity({
      tokenId: TOKEN_ID,
      userAddress: USER,
      percent: 50,
      slippageBps: 200,
      deadlineSec: 1200,
      poolState,
      positionState,
    })
    expect(a.main.data).not.toBe(c.main.data)
  })

  it('滑点用旧口径小数传入时，与核心传等价基点的产物相同', async () => {
    const core = new EvmClmmSdk({ chainId: CHAIN_ID, profileId: 'test', extraFeeClass: ExtraFeeClass.DEX, publicClient: makeMockPublicClient().client })
    const a = await offchain.decreaseLiquidityInstructions({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
      percent: 50,
      slippage: 0.02,
    })
    const b = await core.clmmClient.decreaseLiquidity({
      tokenId: TOKEN_ID,
      userAddress: USER,
      percent: 50,
      slippageBps: 200,
      poolState,
      positionState,
    })
    expect(a.main.data).toBe(b.main.data)
    // 反证：滑点确实影响 amount*Min，进而影响 calldata
    const c = await core.clmmClient.decreaseLiquidity({
      tokenId: TOKEN_ID,
      userAddress: USER,
      percent: 50,
      slippageBps: 50,
      poolState,
      positionState,
    })
    expect(a.main.data).not.toBe(c.main.data)
  })
})

describe('CompatOffchain · 缺快照时的报错', () => {
  it('缺池子快照：错误里要指出缺了什么，并给出读链版的替代路径', async () => {
    await expect(
      offchain.createPositionInstructions({
        userAddress: USER,
        tickLower: TICK_LOWER,
        tickUpper: TICK_UPPER,
        base: 'MintA',
        baseAmount: 1,
      }),
    ).rejects.toThrow(/rawPoolInfo[\s\S]*sdk\.chain\.createPositionInstructions/)
  })

  it('缺仓位快照：同上', async () => {
    await expect(
      offchain.decreaseLiquidityInstructions({ userAddress: USER, rawPoolInfo: API_POOL, percent: 50 }),
    ).rejects.toThrow(/rawPositionInfo/)
  })

  it('collectFees 缺 pendingFees 必须抛（否则核心会去 staticcall，就不是 0 RPC 了）', async () => {
    await expect(
      offchain.collectFeesInstructions({ userAddress: USER, tokenId: 1, rawPoolInfo: API_POOL }),
    ).rejects.toThrow(/pendingFees[\s\S]*staticcall/)
  })

  it('pendingFees 传 null（后端也不知道能领多少）走同一条报错，而不是「只给了一边」', async () => {
    await expect(
      offchain.collectFeesInstructions({
        userAddress: USER,
        tokenId: 1,
        rawPoolInfo: API_POOL,
        pendingFees: null as never,
      }),
    ).rejects.toThrow(/pendingFees[\s\S]*staticcall/)
  })

  it('缺代币元数据（池子快照里 token 只是裸地址串）必须抛', async () => {
    await expect(
      offchain.createPositionInstructions({
        userAddress: USER,
        rawPoolInfo: {
          ...API_POOL,
          token0: API_POOL.token0.address,
          token1: API_POOL.token1.address,
        },
        tickLower: TICK_LOWER,
        tickUpper: TICK_UPPER,
        base: 'MintB',
        baseAmount: '1000000',
        slippageBps: 200,
      }),
    ).rejects.toThrow(/代币元数据/)
  })

  it('userAddress 传 Solana base58 地址时给专门提示', async () => {
    await expect(
      offchain.collectFeesInstructions({
        userAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
        tokenId: 1,
        rawPoolInfo: API_POOL,
        pendingFees: { amount0: 1, amount1: 1 },
      }),
    ).rejects.toThrow(/Solana/)
  })

  it('tokenId 与仓位快照里的不一致时抛（当心拿错仓位的快照）', async () => {
    await expect(
      offchain.decreaseLiquidityInstructions({
        userAddress: USER,
        rawPoolInfo: API_POOL,
        rawPositionInfo: API_POSITION,
        tokenId: 999,
        percent: 50,
      }),
    ).rejects.toThrow(/tokenId/)
  })

  it('poolAddress 与池子快照里的不一致时抛（对着错误的池子发交易是纯粹的资金损失）', async () => {
    await expect(
      offchain.createPositionInstructions({
        userAddress: USER,
        poolAddress: '0x2222222222222222222222222222222222222222',
        rawPoolInfo: API_POOL,
        tickLower: TICK_LOWER,
        tickUpper: TICK_UPPER,
        base: 'MintA',
        baseAmount: 10n ** 15n,
        slippageBps: 200,
      }),
    ).rejects.toThrow(/池子地址/)
  })

  it('批量领费传空列表抛（空 multicall 只会白烧 gas）', async () => {
    await expect(
      offchain.collectAllPositionFeesInstructions({ userAddress: USER, positionDataList: [] }),
    ).rejects.toThrow(/没有仓位可领/)
  })

  it('批量领费里某个仓位缺 pendingFees 时，错误要点名是第几个', async () => {
    await expect(
      offchain.collectAllPositionFeesInstructions({
        userAddress: USER,
        positionDataList: [
          { tokenId: 1, rawPoolInfo: API_POOL, pendingFees: { amount0: 1, amount1: 1 } },
          { tokenId: 2, rawPoolInfo: API_POOL },
        ],
      }),
    ).rejects.toThrow(/第 2\/2 个仓位/)
  })
})

describe('CompatOffchain · otherAmountMax 断言（用例 8）', () => {
  it('上限偏小时抛，且文案含实际需要的数量', async () => {
    await expect(
      offchain.addLiquidityInstructions({
        userAddress: USER,
        rawPoolInfo: API_POOL,
        rawPositionInfo: API_POSITION,
        base: 'MintA',
        baseAmount: 10n ** 15n,
        slippageBps: 200,
        otherAmountMax: 1n,
      }),
    ).rejects.toThrow(/另一边实际需要 \d+（[\d.]+ USDC）/)
  })

  it('错误里点名是 offchain 的哪个方法（同一个页面上两条路径都可能抛这条）', async () => {
    await expect(
      offchain.addLiquidityInstructions({
        userAddress: USER,
        rawPoolInfo: API_POOL,
        rawPositionInfo: API_POSITION,
        base: 'MintA',
        baseAmount: 10n ** 15n,
        slippageBps: 200,
        otherAmountMax: 1n,
      }),
    ).rejects.toThrow(/offchain\.addLiquidityInstructions/)
  })

  it('上限足够时正常通过', async () => {
    const r = await offchain.addLiquidityInstructions({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
      base: 'MintA',
      baseAmount: 10n ** 15n,
      slippageBps: 200,
      otherAmountMax: 10n ** 30n,
    })
    expect(r.meta.amount1Desired).toBeGreaterThan(0n)
  })
})

describe('CompatOffchain · getPositionInfoByNftMint（0 RPC 的仓位详情）', () => {
  it('tokenA / tokenB 与 token0 / token1 是同一个对象引用（用例 10）', () => {
    const info = offchain.getPositionInfoByNftMint({
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
    })
    expect(info.tokenA).toBe(info.token0)
    expect(info.tokenB).toBe(info.token1)
    expect(info.uiPriceLower).toBe(info.priceLower)
  })

  it('不传 pendingFees 时 feeAmount 为 null，不编 0', () => {
    const info = offchain.getPositionInfoByNftMint({
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
    })
    expect(info.token0.feeAmount).toBeNull()
    expect(info.token0.uiFeeAmount).toBeNull()
  })

  it('传了 pendingFees 时给出 ui 展示值', () => {
    const info = offchain.getPositionInfoByNftMint({
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
      pendingFees: { amount0: 10n ** 15n, amount1: 2_000_000n },
    })
    expect(info.token0.uiFeeAmount).toBe('0.001')
    expect(info.token1.uiFeeAmount).toBe('2')
    expect(info.inRange).toBe(true)
  })
})

describe('buildPoolStateRaw', () => {
  it('就是 toPoolStateRaw 的再导出别名（旧 readme 里的 buildPoolLayoutWithId 对应物）', () => {
    expect(buildPoolStateRaw).toBe(toPoolStateRaw)
    expect(buildPoolStateRaw(API_POOL)).toEqual(toPoolStateRaw(API_POOL))
  })
})

// ---------------------------------------------------------------------------
// 回归测试
// ---------------------------------------------------------------------------

describe('回归 · token 顺序重排时，配对的金额必须跟着换', () => {
  const WETH_META = { address: WETH_ADDRESS, decimals: 18, symbol: 'WETH' }
  const USDC_META = { address: USDC_ADDRESS, decimals: 6, symbol: 'USDC' }

  /** 同一份事实的两种写法：正序、以及「按承诺可以传反」的逆序 */
  const forward = {
    userAddress: USER,
    tokenId: TOKEN_ID,
    token0: WETH_META,
    token1: USDC_META,
    pendingFees: { amount0: 10n ** 15n, amount1: 2_000_000n },
  }
  const reversed = {
    userAddress: USER,
    tokenId: TOKEN_ID,
    token0: USDC_META,
    token1: WETH_META,
    // 金额跟着调用方自己声明的顺序走：amount0 配 token0
    pendingFees: { amount0: 2_000_000n, amount1: 10n ** 15n },
  }

  it('正序与逆序得到同一份展示金额', async () => {
    const a = await offchain.collectFeesInstructions(forward)
    const b = await offchain.collectFeesInstructions(reversed)

    expect(a.meta.uiAmount0).toBe('0.001') // WETH
    expect(a.meta.uiAmount1).toBe('2') // USDC
    // 传反时若只重排元数据、不重排金额，这里会变成「可领 1000000000 USDC」
    expect(b.meta.uiAmount0).toBe(a.meta.uiAmount0)
    expect(b.meta.uiAmount1).toBe(a.meta.uiAmount1)
    expect(b.meta.amount0).toBe(a.meta.amount0)
    expect(b.meta.amount1).toBe(a.meta.amount1)
  })

  it('两种写法的 calldata 本来就相同（collect 用 uint128.max，与可领额无关）', async () => {
    const a = await offchain.collectFeesInstructions(forward)
    const b = await offchain.collectFeesInstructions(reversed)
    // 正因为链上不受影响，这个 bug 才只在界面上现形 —— 更需要测试盯着
    expect(b.main.data).toBe(a.main.data)
  })
})

describe('回归 · 仓位快照自带的 pool 可以当池子快照用', () => {
  it('后端接口的 PositionDetail 带 pool 时，不必再传一次 rawPoolInfo', async () => {
    const r = await offchain.decreaseLiquidityInstructions({
      userAddress: USER,
      // 只给仓位快照，池子信息藏在它的 pool 字段里（后端接口的真实形状）
      rawPositionInfo: { ...API_POSITION, pool: API_POOL },
      percent: 25,
      slippage: 0.02,
    })
    expect(r.transactions).toHaveLength(1)
    expect(r.meta.slippageBps).toBe(200)
  })
})

describe('回归 · 关仓时 collect:false 两条路径都抛', () => {
  it('offchain 版不再静默忽略', async () => {
    await expect(
      offchain.decreaseFullLiquidityInstructions({
        userAddress: USER,
        rawPoolInfo: API_POOL,
        rawPositionInfo: API_POSITION,
        collect: false,
        slippageBps: 200,
      }),
    ).rejects.toThrow(/collect: false/)
  })

  it('closePosition: false 时 collect:false 是合法的（不关仓就没有 burn 的约束）', async () => {
    const r = await offchain.decreaseFullLiquidityInstructions({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      rawPositionInfo: API_POSITION,
      closePosition: false,
      collect: false,
      slippageBps: 200,
    })
    expect(r.transactions).toHaveLength(1)
  })
})

describe('回归 · refererPosition（Solana 版 Copy Position）在 offchain 也翻译成 followTokenId', () => {
  it('0 RPC 下与核心直接传 followTokenId 产出同一笔 mint', async () => {
    const poolState = toPoolStateRaw(API_POOL)
    const core = new EvmClmmSdk({ chainId: CHAIN_ID, profileId: 'test', extraFeeClass: ExtraFeeClass.DEX, publicClient: makeMockPublicClient().client })

    // offchain 用的是一碰就抛的 publicClient：顺带证明翻译过程不发 RPC
    const a = await offchain.createPositionInstructions({
      userAddress: USER,
      rawPoolInfo: API_POOL,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'MintB',
      baseAmount: '1000000',
      slippageBps: 200,
      refererPosition: String(TOKEN_ID),
    })
    const b = await core.clmmClient.createPosition({
      poolAddress: poolState.poolAddress,
      userAddress: USER,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'Token1',
      baseAmount: 1_000_000n,
      slippageBps: 200,
      poolState,
      autoApprove: false,
      followTokenId: TOKEN_ID,
    })
    expect(a.main.data).toBe(b.main.data)
    const { args } = decodeFunctionData({ abi: NPM_ABI, data: a.main.data })
    expect((args[0] as { followTokenId: bigint }).followTokenId).toBe(TOKEN_ID)
  })
})
