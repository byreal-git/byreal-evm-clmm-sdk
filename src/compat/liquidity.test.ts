/**
 * `CompatCLMMClient`（读链版写操作）的测试。
 *
 * 与 `offchain.test.ts` 的分工：那边证明「快照齐备时一次 RPC 都不发」，这边证明
 * 「**真去读链**的那条路，翻译出来的 calldata 与直接调核心 SDK 逐字节相同」。
 * 两条路都必须与核心一致，否则前端从 offchain 切回读链版（或反过来）会拿到不同的交易。
 *
 * 全部离线：`publicClient` 是 `test-fixtures.ts` 里按核心 `Chain` 调用形状应答的替身，
 * 顺带记下每次 RPC 往返 —— 「传了 token 元数据就能少读一次链」这类性能契约靠它钉死。
 *
 * 覆盖：用例 7（与核心逐字节一致，读链版）、用例 8（otherAmountMax 断言，读链版），
 * 以及 §5 要求的「每个动作两个方法名、实现共用」。
 */
import { decodeFunctionData, encodeFunctionData, formatUnits } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NPM_ABI } from '../abis.js'
import { EvmClmmSdk } from '../client.js'

import { CompatCLMMClient } from './liquidity.js'
import {
  API_POOL,
  API_POSITION,
  CHAIN_ID,
  CURRENT_TICK,
  hasTokenMetaCall,
  makeMockPublicClient,
  OTHER,
  POOL_ADDRESS,
  POOL_STATE,
  POSITION_STATE,
  POSITION_STATE_2,
  TOKEN_ID,
  TOKEN_ID_2,
  USDC,
  USER,
  WETH,
  type IMockOptions,
} from './test-fixtures.js'

const TICK_LOWER = CURRENT_TICK - 1000
const TICK_UPPER = CURRENT_TICK + 1000
/** 真实的 Solana base58 地址，用来验证防呆提示能一路穿到写方法 */
const SOLANA_ADDRESS = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'

/** 每个用例都造全新的 SDK：核心 `Chain` 的池子/代币缓存是实例级的，复用会让 RPC 计数互相污染 */
function newSdk(options?: IMockOptions) {
  const mock = makeMockPublicClient(options)
  const sdk = new EvmClmmSdk({ chainId: CHAIN_ID, profileId: 'test', publicClient: mock.client })
  return { sdk, mock, compat: new CompatCLMMClient({ sdk }) }
}

beforeEach(() => {
  // deadline 走 Date.now()：不钉死的话「compat vs 核心」两次调用会差出秒级抖动，
  // 逐字节比较就变成了随机失败
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
})
afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 用例 7 · 读链版与核心 SDK 逐字节一致
// ---------------------------------------------------------------------------

describe('CompatCLMMClient · 与核心 SDK 逐字节一致（用例 7 的读链版）', () => {
  /**
   * 比较**整笔交易**而不只是 `data`：`to` 传错就是把 calldata 发给别的合约，
   * `value` 传错在 ERC20 池子上等于白送原生币，这两处错了 `data` 相同也毫无意义。
   */
  function expectSameTx(a: { to: string; data: string; value: bigint; chainId: number }, b: typeof a) {
    expect(a.data).toBe(b.data)
    expect(a.to).toBe(b.to)
    expect(a.value).toBe(b.value)
    expect(a.chainId).toBe(b.chainId)
  }

  it('createPosition：旧参数名 / 旧枚举 / 旧滑点口径 全部翻译成同一笔 mint', async () => {
    const { compat } = newSdk()
    const { sdk: core } = newSdk()

    const a = await compat.createPositionInstructions({
      // 旧代码的写法：poolId、walletAddress、MintA、小数滑点、字符串金额
      poolId: POOL_ADDRESS.toLowerCase(),
      walletAddress: USER.toLowerCase(),
      tickLower: String(TICK_LOWER),
      tickUpper: String(TICK_UPPER),
      base: 'MintA',
      baseAmount: '1000000000000000',
      slippage: 0.02,
    })
    const b = await core.clmmClient.createPosition({
      poolAddress: POOL_ADDRESS,
      userAddress: USER,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'Token0',
      baseAmount: 10n ** 15n,
      slippageBps: 200,
    })

    expectSameTx(a.main, b.main)
    expect(a.transactions).toHaveLength(b.transactions.length)
    expect(a.meta.liquidity).toBe(b.meta.liquidity)
    expect(a.meta.amount0Min).toBe(b.meta.amount0Min)
    expect(a.meta.amount1Min).toBe(b.meta.amount1Min)
    expect(a.meta.deadline).toBe(b.meta.deadline)
    // compat 独有的增强：换算后的滑点回传 + ui 字符串（各自用**自己那一边**的 decimals）
    expect(a.meta.slippageBps).toBe(200)
    expect(a.meta.uiAmount0Desired).toBe(formatUnits(b.meta.amount0Desired, 18))
    expect(a.meta.uiAmount1Desired).toBe(formatUnits(b.meta.amount1Desired, 6))
    expect(Number(a.meta.uiAmount0Desired)).toBeCloseTo(0.001, 9)
  })

  it('addLiquidity / decreaseLiquidity / closePosition / collectFees 的主交易全部相等', async () => {
    const { compat } = newSdk()
    const { sdk: core } = newSdk()

    const add = await compat.addLiquidityInstructions({
      userAddress: USER,
      nftMint: TOKEN_ID.toString(),
      base: 'MintB',
      baseAmount: 1_000_000,
      slippageBps: 200,
    })
    expectSameTx(
      add.main,
      (
        await core.clmmClient.addLiquidity({
          tokenId: TOKEN_ID,
          userAddress: USER,
          base: 'Token1',
          baseAmount: 1_000_000n,
          slippageBps: 200,
        })
      ).main,
    )

    const dec = await compat.decreaseLiquidityInstructions({
      userAddress: USER,
      tokenId: TOKEN_ID,
      percentage: 50,
      slippageBps: 200,
    })
    expectSameTx(
      dec.main,
      (
        await core.clmmClient.decreaseLiquidity({
          tokenId: TOKEN_ID,
          userAddress: USER,
          percent: 50,
          slippageBps: 200,
        })
      ).main,
    )

    const closed = await compat.closePositionInstructions({
      userAddress: USER,
      tokenId: TOKEN_ID,
      slippageBps: 200,
    })
    expectSameTx(
      closed.main,
      (
        await core.clmmClient.closePosition({
          tokenId: TOKEN_ID,
          userAddress: USER,
          slippageBps: 200,
        })
      ).main,
    )

    const fees = await compat.collectFeesInstructions({ userAddress: USER, tokenId: TOKEN_ID })
    expectSameTx(
      fees.main,
      (await core.clmmClient.collectFees({ tokenId: TOKEN_ID, userAddress: USER })).main,
    )
    expect(fees.meta.uiAmount0).toBe('0.001')
    expect(fees.meta.uiAmount1).toBe('2')
  })

  it('recipient 与 userAddress 不同时，两边都把 recipient 编进 calldata', async () => {
    const { compat } = newSdk()
    const { sdk: core } = newSdk()

    const a = await compat.decreaseLiquidityInstructions({
      userAddress: USER,
      tokenId: TOKEN_ID,
      percent: 100,
      recipient: OTHER,
      slippageBps: 200,
    })
    const b = await core.clmmClient.decreaseLiquidity({
      tokenId: TOKEN_ID,
      userAddress: USER,
      percent: 100,
      recipient: OTHER,
      slippageBps: 200,
    })
    expect(a.main.data).toBe(b.main.data)
    // 反证：recipient 真的进了 calldata（否则上面那条断言换成 USER 也会过）
    const c = await core.clmmClient.decreaseLiquidity({
      tokenId: TOKEN_ID,
      userAddress: USER,
      percent: 100,
      slippageBps: 200,
    })
    expect(a.main.data).not.toBe(c.main.data)
  })

  it('返回值的 Solana 别名指向同一批对象，开仓的 nftAddress / tokenId 恒为 null', async () => {
    const { compat } = newSdk()
    const r = await compat.createPositionInstructions({
      poolAddress: POOL_ADDRESS,
      userAddress: USER,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'MintA',
      baseAmount: 10n ** 15n,
      slippageBps: 200,
    })
    expect(r.instructions).toBe(r.transactions)
    expect(r.transaction).toBe(r.main)
    expect(r.signers).toBeUndefined()
    // null 而不是 undefined：旧代码解构出来能立刻分辨「EVM 上要等回执」
    expect(r.nftAddress).toBeNull()
    expect(r.tokenId).toBeNull()
    expect('nftAddress' in r).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 两个方法名必须产出同一笔交易
// ---------------------------------------------------------------------------

describe('CompatCLMMClient · 旧名与短名逐字节相同', () => {
  it('六个动作的长短名产出同一笔主交易', async () => {
    const { compat } = newSdk()
    const common = { userAddress: USER, tokenId: TOKEN_ID, slippageBps: 200 } as const

    const create = {
      poolAddress: POOL_ADDRESS,
      userAddress: USER,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'MintA' as const,
      baseAmount: 10n ** 15n,
      slippageBps: 200,
    }
    expect((await compat.createPosition(create)).main.data).toBe(
      (await compat.createPositionInstructions(create)).main.data,
    )

    const add = { ...common, base: 'MintA' as const, baseAmount: 10n ** 15n }
    expect((await compat.addLiquidity(add)).main.data).toBe(
      (await compat.addLiquidityInstructions(add)).main.data,
    )

    const dec = { ...common, percent: 50 }
    expect((await compat.decreaseLiquidity(dec)).main.data).toBe(
      (await compat.decreaseLiquidityInstructions(dec)).main.data,
    )

    expect((await compat.closePosition(common)).main.data).toBe(
      (await compat.closePositionInstructions(common)).main.data,
    )

    // decreaseFullLiquidity 的三个名字都等价于关仓
    const full = await compat.decreaseFullLiquidityInstructions(common)
    expect((await compat.decreaseFullLiquidity(common)).main.data).toBe(full.main.data)
    expect((await compat.removeFullLiquidity(common)).main.data).toBe(full.main.data)
    expect(full.main.data).toBe((await compat.closePositionInstructions(common)).main.data)

    expect((await compat.collectFees({ userAddress: USER, tokenId: TOKEN_ID })).main.data).toBe(
      (await compat.collectFeesInstructions({ userAddress: USER, tokenId: TOKEN_ID })).main.data,
    )
  })

  it('decreaseFullLiquidity({ closePosition: false }) 退化成 percent:100，且不 burn', async () => {
    const { compat } = newSdk()
    const kept = await compat.decreaseFullLiquidityInstructions({
      userAddress: USER,
      tokenId: TOKEN_ID,
      closePosition: false,
      slippageBps: 200,
    })
    const equivalent = await compat.decreaseLiquidityInstructions({
      userAddress: USER,
      tokenId: TOKEN_ID,
      percent: 100,
      slippageBps: 200,
    })
    expect(kept.main.data).toBe(equivalent.main.data)
    expect(kept.main.label).not.toContain('burn')
    expect(kept.meta.liquidity).toBe(POSITION_STATE.liquidity)
  })

  it('closePosition 时传 collect:false 必须抛（burn 前 tokensOwed 不清空一定 revert）', async () => {
    const { compat } = newSdk()
    await expect(
      compat.decreaseFullLiquidityInstructions({ userAddress: USER, tokenId: TOKEN_ID, collect: false }),
    ).rejects.toThrow(/burn 前 tokensOwed 必须为 0/)
  })

  it('closePosition:false 时调用方原本的 percentage 别名不会与内部的 100 打架', async () => {
    const { compat } = newSdk()
    const r = await compat.decreaseFullLiquidityInstructions({
      userAddress: USER,
      tokenId: TOKEN_ID,
      closePosition: false,
      // 「撤全部」的入参类型里本来就没有 percent 系列，这里模拟的是**未走类型检查的 JS 调用方**
      // 带过来的残留字段：不清掉就会与内部注入的 percent:100 撞成「取值不一致」
      ...({ percentage: 30 } as unknown as Record<string, never>),
      slippageBps: 200,
    })
    expect(r.meta.liquidity).toBe(POSITION_STATE.liquidity)
  })
})

// ---------------------------------------------------------------------------
// 用例 8 · otherAmountMax 断言（读链版）
// ---------------------------------------------------------------------------

describe('CompatCLMMClient · otherAmountMax 断言（用例 8）', () => {
  it('开仓：上限偏小时抛，文案里带实际需要的数量与代币符号', async () => {
    const { compat } = newSdk()
    await expect(
      compat.createPositionInstructions({
        poolAddress: POOL_ADDRESS,
        userAddress: USER,
        tickLower: TICK_LOWER,
        tickUpper: TICK_UPPER,
        base: 'MintA',
        baseAmount: 10n ** 15n,
        otherAmountMax: 1n,
        slippageBps: 200,
      }),
    ).rejects.toThrow(/另一边实际需要 \d+（[\d.]+ USDC）[\s\S]*otherAmountMax=1/)
  })

  it('错误里点名是读链版的哪个方法（offchain 版也会抛这条，不点名就不知道改哪一处）', async () => {
    const { compat } = newSdk()
    await expect(
      compat.createPositionInstructions({
        poolAddress: POOL_ADDRESS,
        userAddress: USER,
        tickLower: TICK_LOWER,
        tickUpper: TICK_UPPER,
        base: 'MintA',
        baseAmount: 10n ** 15n,
        otherAmountMax: 1n,
        slippageBps: 200,
      }),
    ).rejects.toThrow(/createPositionInstructions：另一边实际需要/)
  })

  it('加仓：base 换成 MintB 时，「另一边」跟着换成 token0（WETH）', async () => {
    const { compat } = newSdk()
    await expect(
      compat.addLiquidityInstructions({
        userAddress: USER,
        tokenId: TOKEN_ID,
        base: 'MintB',
        baseAmount: 1_000_000,
        otherAmountMax: 1n,
        slippageBps: 200,
      }),
    ).rejects.toThrow(/WETH/)
  })

  it('上限足够时正常通过，且与不传上限的产物逐字节相同（断言不改变 calldata）', async () => {
    const { compat } = newSdk()
    const args = {
      poolAddress: POOL_ADDRESS,
      userAddress: USER,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'MintA' as const,
      baseAmount: 10n ** 15n,
      slippageBps: 200,
    }
    const capped = await compat.createPositionInstructions({ ...args, otherAmountMax: 10n ** 30n })
    const plain = await compat.createPositionInstructions(args)
    expect(capped.main.data).toBe(plain.main.data)
  })

  it('otherAmountMax 传空串（表单没填）= 没有上限，不该被当成 0', async () => {
    const { compat } = newSdk()
    const r = await compat.createPositionInstructions({
      poolAddress: POOL_ADDRESS,
      userAddress: USER,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'MintA',
      baseAmount: 10n ** 15n,
      otherAmountMax: '',
      slippageBps: 200,
    })
    expect(r.meta.amount1Desired).toBeGreaterThan(0n)
  })
})

// ---------------------------------------------------------------------------
// 入参归一化：宽进与「不猜」
// ---------------------------------------------------------------------------

describe('CompatCLMMClient · 入参归一化', () => {
  it('userAddress / walletAddress 二认其一；两个不同地址时抛', async () => {
    const { compat } = newSdk()
    const viaWallet = await compat.collectFeesInstructions({
      walletAddress: USER,
      tokenId: TOKEN_ID,
    })
    const viaUser = await compat.collectFeesInstructions({ userAddress: USER, tokenId: TOKEN_ID })
    expect(viaWallet.main.data).toBe(viaUser.main.data)

    await expect(
      compat.collectFeesInstructions({ userAddress: USER, walletAddress: OTHER, tokenId: TOKEN_ID }),
    ).rejects.toThrow(/不猜哪个优先/)
    await expect(compat.collectFeesInstructions({ tokenId: TOKEN_ID })).rejects.toThrow(/userAddress/)
  })

  it('tokenId / nftMint 二认其一；两个不同值时抛；base58 命中 Solana 专门提示', async () => {
    const { compat } = newSdk()
    await expect(
      compat.collectFeesInstructions({ userAddress: USER, tokenId: TOKEN_ID, nftMint: 999 }),
    ).rejects.toThrow(/tokenId 与 nftMint/)
    await expect(
      compat.collectFeesInstructions({ userAddress: USER, nftMint: SOLANA_ADDRESS }),
    ).rejects.toThrow(/Solana[\s\S]*tokenId/)
    await expect(compat.collectFeesInstructions({ userAddress: USER })).rejects.toThrow(/缺少 tokenId/)
  })

  it('refererPosition（Solana 版 Copy Position）翻译成 mint 尾字段 followTokenId；与 followTokenId 冲突时抛', async () => {
    const { compat } = newSdk()
    const base = {
      poolAddress: POOL_ADDRESS,
      userAddress: USER,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'MintA' as const,
      baseAmount: 10n ** 15n,
      slippageBps: 200,
    }
    const viaReferer = await compat.createPositionInstructions({ ...base, refererPosition: String(TOKEN_ID) })
    const viaFollow = await compat.createPositionInstructions({ ...base, followTokenId: TOKEN_ID })
    expect(viaReferer.main.data).toBe(viaFollow.main.data)
    const { args } = decodeFunctionData({ abi: NPM_ABI, data: viaReferer.main.data })
    expect((args[0] as { followTokenId: bigint }).followTokenId).toBe(TOKEN_ID)

    // 空串沿用 Solana 版「falsy 即不复制」，与不传完全相同
    const plain = await compat.createPositionInstructions(base)
    const empty = await compat.createPositionInstructions({ ...base, refererPosition: '' })
    expect(empty.main.data).toBe(plain.main.data)
    expect(viaReferer.main.data).not.toBe(plain.main.data)

    await expect(
      compat.createPositionInstructions({ ...base, refererPosition: '1', followTokenId: 2 }),
    ).rejects.toThrow(/followTokenId 与 refererPosition/)
    // Solana 母仓位地址照搬过来：给出「EVM 请用 tokenId」的迁移提示
    await expect(
      compat.createPositionInstructions({ ...base, refererPosition: SOLANA_ADDRESS }),
    ).rejects.toThrow(/refererPosition[\s\S]*Solana[\s\S]*tokenId/)
  })

  it('userAddress 传 Solana 地址时错误里必须出现 "Solana"（用例 2 的写方法版）', async () => {
    const { compat } = newSdk()
    await expect(
      compat.collectFeesInstructions({ userAddress: SOLANA_ADDRESS, tokenId: TOKEN_ID }),
    ).rejects.toThrow(/Solana/)
  })

  it('percent 的三个别名等价；取值不一致时抛', async () => {
    const { compat } = newSdk()
    const base = { userAddress: USER, tokenId: TOKEN_ID, slippageBps: 200 }
    const a = await compat.decreaseLiquidityInstructions({ ...base, percent: 25 })
    const b = await compat.decreaseLiquidityInstructions({ ...base, decreasePercentage: 25 })
    const c = await compat.decreaseLiquidityInstructions({ ...base, percentage: '25' })
    expect(b.main.data).toBe(a.main.data)
    expect(c.main.data).toBe(a.main.data)

    await expect(
      compat.decreaseLiquidityInstructions({ ...base, percent: 25, percentage: 50 }),
    ).rejects.toThrow(/percent \/ decreasePercentage \/ percentage/)
  })

  it('poolAddress 与快照里的池子不一致时抛（会算出一笔发往错误池子的交易）', async () => {
    const { compat } = newSdk()
    await expect(
      compat.createPositionInstructions({
        poolAddress: OTHER,
        poolState: API_POOL,
        userAddress: USER,
        tickLower: TICK_LOWER,
        tickUpper: TICK_UPPER,
        base: 'MintA',
        baseAmount: 10n ** 15n,
        slippageBps: 200,
      }),
    ).rejects.toThrow(/不是同一个池子/)
  })

  it('positionState 的 tokenId 与本次操作对不上时抛（列表页复用上一行快照的经典事故）', async () => {
    const { compat } = newSdk()
    await expect(
      compat.decreaseLiquidityInstructions({
        userAddress: USER,
        tokenId: TOKEN_ID_2,
        positionState: { ...API_POSITION, pool: API_POOL },
        percent: 50,
      }),
    ).rejects.toThrow(/不是同一个仓位/)
  })

  it('代币元数据只给一边时抛（缺的那边还是要读链，等于没省）', async () => {
    const { compat } = newSdk()
    await expect(
      compat.collectFeesInstructions({ userAddress: USER, tokenId: TOKEN_ID, token0: WETH }),
    ).rejects.toThrow(/必须成对提供/)
  })

  it('代币元数据与快照里的池子代币对不上时拒绝换算（ui 金额会整体偏 10^n 倍）', async () => {
    const { compat } = newSdk()
    await expect(
      compat.decreaseLiquidityInstructions({
        userAddress: USER,
        tokenId: TOKEN_ID,
        poolState: API_POOL,
        percent: 50,
        token0: WETH,
        token1: { ...USDC, address: OTHER },
      }),
    ).rejects.toThrow(/对不上/)
  })
})

// ---------------------------------------------------------------------------
// RPC 口径：compat 不该悄悄多读链
// ---------------------------------------------------------------------------

describe('CompatCLMMClient · RPC 次数', () => {
  it('传了 token 元数据就不再读 ERC20 元数据（预热核心缓存的那段 hack 必须真的生效）', async () => {
    const withMeta = newSdk()
    await withMeta.compat.createPositionInstructions({
      poolAddress: POOL_ADDRESS,
      userAddress: USER,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'MintA',
      baseAmount: 10n ** 15n,
      slippageBps: 200,
      // 顺序故意传反：EVM 上 token0/token1 由地址升序决定，compat 应该自己摆正
      token0: USDC,
      token1: WETH,
    })
    expect(hasTokenMetaCall(withMeta.mock.calls)).toBe(false)

    const withoutMeta = newSdk()
    await withoutMeta.compat.createPositionInstructions({
      poolAddress: POOL_ADDRESS,
      userAddress: USER,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'MintA',
      baseAmount: 10n ** 15n,
      slippageBps: 200,
    })
    expect(hasTokenMetaCall(withoutMeta.mock.calls)).toBe(true)
  })

  it('token 元数据传反了也不会把 decimals 挂到错误的代币上', async () => {
    const { compat } = newSdk()
    const r = await compat.decreaseLiquidityInstructions({
      userAddress: USER,
      tokenId: TOKEN_ID,
      percent: 100,
      slippageBps: 200,
      token0: USDC,
      token1: WETH,
    })
    expect(r.meta.token0.symbol).toBe('WETH')
    expect(r.meta.token1.symbol).toBe('USDC')
    expect(r.meta.uiExpectedAmount1).toBe(
      (Number(r.meta.expectedAmount1) / 1e6).toString(),
    )
  })

  it('第二次操作同一个池子时命中缓存，不再重复读池子不变字段', async () => {
    const { compat, mock } = newSdk()
    const args = {
      poolAddress: POOL_ADDRESS,
      userAddress: USER,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'MintA' as const,
      baseAmount: 10n ** 15n,
      slippageBps: 200,
    }
    await compat.createPositionInstructions(args)
    mock.reset()
    await compat.createPositionInstructions(args)
    // 热路径只剩这一次前置读（14 个 call = 10 个池子动态字段 + 2 余额 + 2 授权）。
    // 不变字段 token0/token1/tickSpacing 已进缓存，不再重读；
    // 但 tradeFeeRate 等费率/暂停参数是链上**可变**数据，每次都必须 fresh 读，
    // 所以它们照样出现在这份列表里 —— 哪天有人「顺手」把它们挪进不变字段缓存，这条会红
    expect(mock.calls).toEqual([
      'multicall(slot0+liquidity+feeGrowthGlobal0X128+feeGrowthGlobal1X128+tradeFeeRate+pauseFlags+swapOpenTime+alphaExtraTradeFeeRate+dexExtraTradeFeeRate+dynamicFeeEnabled+balanceOf+balanceOf+allowance+allowance)',
    ])
  })
})

// ---------------------------------------------------------------------------
// 批量领费：compat 里唯一自己拼 calldata 的地方
// ---------------------------------------------------------------------------

describe('CompatCLMMClient · collectAllPositionFeesInstructions', () => {
  const twoPositions: IMockOptions = { positions: [POSITION_STATE, POSITION_STATE_2] }

  it('多个仓位打成一笔 NPM.multicall，子调用就是各自的 collect calldata', async () => {
    const { compat } = newSdk(twoPositions)
    const { compat: single } = newSdk(twoPositions)

    const batch = await compat.collectAllPositionFeesInstructions({
      userAddress: USER,
      nftMintList: [TOKEN_ID, TOKEN_ID_2],
    })
    const one = await single.collectFeesInstructions({ userAddress: USER, tokenId: TOKEN_ID })
    const two = await single.collectFeesInstructions({ userAddress: USER, tokenId: TOKEN_ID_2 })

    expect(batch.transactions).toHaveLength(1)
    expect(batch.main.to).toBe(one.main.to)
    expect(batch.main.value).toBe(0n)
    expect(batch.main.data).toBe(
      encodeFunctionData({
        abi: NPM_ABI,
        functionName: 'multicall',
        args: [[one.main.data, two.main.data]],
      }),
    )
  })

  it('只有一个仓位时不套 multicall 外壳，与单个 collectFees 逐字节相同', async () => {
    const { compat } = newSdk()
    const batch = await compat.collectAllPositionFeesInstructions({
      userAddress: USER,
      tokenIdList: [TOKEN_ID],
    })
    const one = await compat.collectFeesInstructions({ userAddress: USER, tokenId: TOKEN_ID })
    expect(batch.main.data).toBe(one.main.data)
    expect(batch.main.label).toBe(one.main.label)
  })

  it('重复的 tokenId 静默去重（领第二次必然是 0，只是白烧 gas）', async () => {
    const { compat } = newSdk()
    const r = await compat.collectAllPositionFeesInstructions({
      userAddress: USER,
      tokenIdList: [TOKEN_ID, TOKEN_ID, '123456'],
    })
    expect(r.meta.perPosition.map((p) => p.tokenId)).toEqual([TOKEN_ID])
  })

  it('totals 按代币地址聚合，而不是把不同池子的 amount0 相加', async () => {
    const { compat } = newSdk(twoPositions)
    const r = await compat.collectAllPositionFeesInstructions({
      userAddress: USER,
      tokenIdList: [TOKEN_ID, TOKEN_ID_2],
    })
    expect(r.meta.totals.map((t) => t.token.symbol)).toEqual(['WETH', 'USDC'])
    // mock 里每个仓位可领 0.001 WETH / 2 USDC，两个仓位就是翻倍
    expect(r.meta.totals.map((t) => t.amount)).toEqual([2n * 10n ** 15n, 4_000_000n])
    expect(r.meta.totals[0].uiAmount).toBe('0.002')
  })

  it('pendingFeesMap 命中的仓位跳过 collect staticcall', async () => {
    const { compat, mock } = newSdk()
    await compat.collectAllPositionFeesInstructions({
      userAddress: USER,
      tokenIdList: [TOKEN_ID],
      pendingFeesMap: { [TOKEN_ID.toString()]: { amountA: 5, amountB: 7 } },
      tokens: [WETH, USDC],
      positionStateList: [{ ...API_POSITION, pool: API_POOL }],
    })
    // 快照 + 元数据 + pendingFees 全给齐 → 一次 RPC 都不该发
    expect(mock.calls).toEqual([])
  })

  it('RPC 与仓位个数无关：1 次 NPM.multicall（positions + collect）+ 1 次代币元数据', async () => {
    const { compat, mock } = newSdk(twoPositions)
    const r = await compat.collectAllPositionFeesInstructions({
      userAddress: USER,
      tokenIdList: [TOKEN_ID, TOKEN_ID_2],
    })
    expect(mock.calls).toHaveLength(2)
    expect(mock.calls[0]).toBe('simulateContract(multicall:positions+positions+collect+collect)')
    expect(mock.calls[1]).toMatch(/^multicall\(decimals/)
    // 预读的结果照样填进 meta，与逐仓读链口径一致
    expect(r.meta.perPosition.map((p) => p.amount0)).toEqual([10n ** 15n, 10n ** 15n])
    expect(r.meta.perPosition.map((p) => p.token0.symbol)).toEqual(['WETH', 'WETH'])
  })

  it('给了 pendingFeesMap 的仓位不进 collect 预演，只补读 positions', async () => {
    const { compat, mock } = newSdk()
    await compat.collectAllPositionFeesInstructions({
      userAddress: USER,
      tokenIdList: [TOKEN_ID],
      pendingFeesMap: { [TOKEN_ID.toString()]: { amountA: 5, amountB: 7 } },
    })
    expect(mock.calls[0]).toBe('simulateContract(multicall:positions)')
    expect(mock.calls.some((c) => c === 'simulateContract(collect)')).toBe(false)
  })

  it('批量预读 revert 时退回逐仓读链，让报错落到具体仓位', async () => {
    const MISSING_TOKEN_ID = 999999n // 不在 mock 仓位表里，positions 会像真合约一样 revert
    const { compat, mock } = newSdk()
    await expect(
      compat.collectAllPositionFeesInstructions({
        userAddress: USER,
        tokenIdList: [TOKEN_ID, MISSING_TOKEN_ID],
      }),
    ).rejects.toThrow(/Invalid token ID/)
    expect(mock.calls[0]).toBe('simulateContract(multicall:positions+positions+collect+collect)')
    // 退回逐仓后，第一个正常仓位按老路径读了 collect + positions
    expect(mock.calls).toContain('simulateContract(collect)')
    expect(mock.calls).toContain('readContract(positions)')
  })

  it('网络类错误（超时 / 限频）不退回逐仓，避免把 1 次请求放大成 2N 次', async () => {
    const { compat, mock } = newSdk({
      positions: [POSITION_STATE, POSITION_STATE_2],
      positionsError: new Error('HTTP request failed. Status: 429'),
    })
    await expect(
      compat.collectAllPositionFeesInstructions({
        userAddress: USER,
        tokenIdList: [TOKEN_ID, TOKEN_ID_2],
      }),
    ).rejects.toThrow(/429/)
    expect(mock.calls).toEqual(['simulateContract(multicall:positions+positions+collect+collect)'])
  })

  it('tokenIdList 与 nftMintList 只能传一个；空列表抛', async () => {
    const { compat } = newSdk()
    await expect(
      compat.collectAllPositionFeesInstructions({
        userAddress: USER,
        tokenIdList: [TOKEN_ID],
        nftMintList: [TOKEN_ID],
      }),
    ).rejects.toThrow(/只能传一个/)
    await expect(
      compat.collectAllPositionFeesInstructions({ userAddress: USER, tokenIdList: [] }),
    ).rejects.toThrow(/非空的 tokenIdList/)
  })
})

// ---------------------------------------------------------------------------
// 自带快照：核心的 offline 逃生口在读链版上同样可用
// ---------------------------------------------------------------------------

describe('CompatCLMMClient · 自带快照时与不带快照产出同一笔交易', () => {
  it('传后端接口形状的 poolState / positionState，减仓 calldata 不变', async () => {
    const { compat } = newSdk()
    const withSnapshot = await compat.decreaseLiquidityInstructions({
      userAddress: USER,
      tokenId: TOKEN_ID,
      percent: 50,
      slippageBps: 200,
      poolState: API_POOL,
      positionState: { ...API_POSITION, pool: API_POOL },
    })
    const fromChain = await compat.decreaseLiquidityInstructions({
      userAddress: USER,
      tokenId: TOKEN_ID,
      percent: 50,
      slippageBps: 200,
    })
    expect(withSnapshot.main.data).toBe(fromChain.main.data)
    expect(withSnapshot.meta.expectedAmount0).toBe(fromChain.meta.expectedAmount0)
  })

  it('扁平 JSON 形状的池子快照与核心 raw 形状等价（用例 4 的写路径版）', async () => {
    const { compat } = newSdk()
    const flat = {
      poolAddress: POOL_STATE.poolAddress.toLowerCase(),
      token0: POOL_STATE.token0.toLowerCase(),
      token1: POOL_STATE.token1.toLowerCase(),
      // 刻意用旧名 fee（与 tradeFeeRate 同单位 ppm）：兼容层的「宽进」承诺是旧快照照样能用，
      // 归一化后必须与下面那份用 tradeFeeRate 的核心 raw 快照产出同一笔交易
      fee: '500',
      tickSpacing: '10',
      sqrtPriceX96: POOL_STATE.sqrtPriceX96.toString(),
      tick: String(POOL_STATE.tick),
      liquidity: POOL_STATE.liquidity.toString(),
      feeGrowthGlobal0X128: '111',
      feeGrowthGlobal1X128: '222',
    }
    const args = {
      userAddress: USER,
      tokenId: TOKEN_ID,
      percent: 50,
      slippageBps: 200,
      positionState: { ...API_POSITION, pool: API_POOL },
    }
    const a = await compat.decreaseLiquidityInstructions({ ...args, rawPoolInfo: flat })
    const b = await compat.decreaseLiquidityInstructions({ ...args, poolState: POOL_STATE })
    expect(a.main.data).toBe(b.main.data)
  })
})
