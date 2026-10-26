/**
 * `CompatChain`（读操作层）与 `ByrealClmmSdk`（门面）的测试。
 *
 * 这一层的价值全在「组装」上：核心 `Chain` 只出链上原始字段，旧前端要的是一站式的
 * 仓位详情（ui 字符串、价格区间、inRange、待领手续费）。组装错了不会报错，
 * 只会让界面显示一个**看起来合理的错数**，所以这里逐字段钉。
 *
 * 覆盖 用例 10（`tokenA === token0` 引用相等）的读链版，
 * 以及 §4.4 那条最要紧的约定：拿不到手续费时必须是 `null`，绝不落成 0。
 *
 * 全部离线：`publicClient` 是 `test-fixtures.ts` 里的应答式替身。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EvmClmmSdk } from '../client.js'
import { getPositionView } from '../calculate.js'
import { ExtraFeeClass } from '../constants.js'

import { CompatChain } from './chain.js'
import { ByrealClmmSdk } from './client.js'
import { CompatCLMMClient } from './liquidity.js'
import { CompatOffchain } from './offchain.js'
import {
  CHAIN_ID,
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

const SOLANA_ADDRESS = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
/** 这个 tokenId 不在 mock 的仓位表里，`positions` 会像真合约那样 revert */
const MISSING_TOKEN_ID = 999999n

function newChain(options?: IMockOptions) {
  const mock = makeMockPublicClient(options)
  const sdk = new EvmClmmSdk({ chainId: CHAIN_ID, profileId: 'test', publicClient: mock.client })
  return { sdk, mock, chain: new CompatChain({ sdk }) }
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
})
afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 原始读：旧名与短名
// ---------------------------------------------------------------------------

describe('CompatChain · 原始读', () => {
  it('getRawPoolInfoByPoolId 与 getRawPoolInfo 是同一份实现，且地址大小写无关', async () => {
    const { chain } = newChain()
    const a = await chain.getRawPoolInfoByPoolId(POOL_ADDRESS.toLowerCase())
    const b = await chain.getRawPoolInfo(POOL_ADDRESS)
    expect(a).toEqual(b)
    expect(a).toEqual(POOL_STATE)
  })

  it('池子地址传 Solana base58 时给专门提示（不是 viem 的原始报错）', async () => {
    const { chain } = newChain()
    await expect(chain.getRawPoolInfoByPoolId(SOLANA_ADDRESS)).rejects.toThrow(/Solana/)
  })

  it('getRawPositionInfoByNftMint 收宽松入参，但语义是 tokenId', async () => {
    const { chain } = newChain()
    expect(await chain.getRawPositionInfoByNftMint('123456')).toEqual(POSITION_STATE)
    expect(await chain.getRawPositionInfoByNftMint({ toString: () => '123456' })).toEqual(POSITION_STATE)
    await expect(chain.getRawPositionInfoByNftMint(SOLANA_ADDRESS)).rejects.toThrow(/tokenId/)
  })

  it('仓位列表：旧名返回的是 tokenId（bigint）列表，不是 base58', async () => {
    const { chain } = newChain({ ownedTokenIds: [TOKEN_ID, TOKEN_ID_2] })
    const ids = await chain.getPositionNftMintListByUserAddress(USER.toLowerCase())
    expect(ids).toEqual([TOKEN_ID, TOKEN_ID_2])
    expect(await chain.getPositionTokenIdListByOwner(USER)).toEqual(ids)
  })

  it('getRawPositionInfoListByUserAddress 一次拿齐原始状态', async () => {
    const { chain } = newChain({
      ownedTokenIds: [TOKEN_ID, TOKEN_ID_2],
      positions: [POSITION_STATE, POSITION_STATE_2],
    })
    expect(await chain.getRawPositionInfoListByUserAddress(USER)).toEqual([
      POSITION_STATE,
      POSITION_STATE_2,
    ])
  })

  it('getTokenInfoByMint 读单个 ERC20 元数据，第二次命中缓存不再读链', async () => {
    const { chain, mock } = newChain()
    expect(await chain.getTokenInfoByMint(WETH.address.toLowerCase())).toEqual(WETH)
    mock.reset()
    await chain.getTokenInfoByMint(WETH.address)
    expect(hasTokenMetaCall(mock.calls)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 仓位详情（+ §10 用例 10）
// ---------------------------------------------------------------------------

describe('CompatChain · getPositionInfoByNftMint', () => {
  it('tokenA / tokenB 与 token0 / token1 是同一个对象引用（用例 10）', async () => {
    const { chain } = newChain()
    const info = (await chain.getPositionInfoByNftMint(TOKEN_ID))!
    expect(info).not.toBeNull()
    expect(info.tokenA).toBe(info.token0)
    expect(info.tokenB).toBe(info.token1)
    // 价格的旧字段名同样是**同一个字符串**，不是各算一遍（旧版两份口径漂移过）
    expect(info.uiPriceLower).toBe(info.priceLower)
    expect(info.uiPriceUpper).toBe(info.priceUpper)
  })

  it('数学结果与直接调核心 getPositionView 完全一致（compat 不自己算 CLMM 数学）', async () => {
    const { chain } = newChain()
    const info = (await chain.getPositionInfoByNftMint(TOKEN_ID))!
    const view = getPositionView({
      poolState: POOL_STATE,
      positionState: POSITION_STATE,
      token0: WETH,
      token1: USDC,
    })
    expect(info.token0.amount).toBe(view.amount0)
    expect(info.token1.amount).toBe(view.amount1)
    expect(info.token0.uiAmount).toBe(view.uiAmount0)
    expect(info.token1.uiAmount).toBe(view.uiAmount1)
    expect(info.priceLower).toBe(view.priceLower)
    expect(info.currentPrice).toBe(view.currentPrice)
    expect(info.inRange).toBe(true)
    expect(info.isFullRange).toBe(false)
    expect(info.rawPoolInfo).toEqual(POOL_STATE)
    expect(info.rawPositionInfo).toEqual(POSITION_STATE)
  })

  it('withFees 默认 false：feeAmount / uiFeeAmount 是 null 而不是 0，且不做 collect 预演', async () => {
    const { chain, mock } = newChain()
    const info = (await chain.getPositionInfoByNftMint(TOKEN_ID))!
    expect(info.token0.feeAmount).toBeNull()
    expect(info.token0.uiFeeAmount).toBeNull()
    expect(info.token1.feeAmount).toBeNull()
    // 「0」会让 UI 显示「无手续费可领」，是会让用户损失钱的假数据
    expect(info.token0.uiFeeAmount).not.toBe('0')
    expect(mock.calls.some((c) => c.includes('collect'))).toBe(false)
    expect(mock.calls.some((c) => c.includes('ownerOf'))).toBe(false)
  })

  it('withFees: true 时读一次 collect 预演；传了 owner 就省掉 ownerOf', async () => {
    const withOwner = newChain()
    const a = (await withOwner.chain.getPositionInfoByNftMint(TOKEN_ID, {
      withFees: true,
      owner: USER,
    }))!
    expect(a.token0.feeAmount).toBe(10n ** 15n)
    expect(a.token0.uiFeeAmount).toBe('0.001')
    expect(a.token1.uiFeeAmount).toBe('2')
    expect(withOwner.mock.calls.some((c) => c.includes('ownerOf'))).toBe(false)

    const withoutOwner = newChain()
    await withoutOwner.chain.getPositionInfoByNftMint(TOKEN_ID, { withFees: true })
    expect(withoutOwner.mock.calls).toContain('readContract(ownerOf)')
  })

  it('仓位不存在（合约 revert）返回 null，不抛', async () => {
    const { chain } = newChain()
    expect(await chain.getPositionInfoByNftMint(MISSING_TOKEN_ID)).toBeNull()
  })

  it('网络类错误照抛，绝不吞成 null（否则「网络抖了一下」会显示成「你的仓位没了」）', async () => {
    const { chain } = newChain({ positionsError: new Error('fetch failed: ECONNRESET') })
    await expect(chain.getPositionInfoByNftMint(TOKEN_ID)).rejects.toThrow(/ECONNRESET/)
  })

  it('withFees 读手续费失败时抛，不降级成 null', async () => {
    const { chain, sdk } = newChain()
    vi.spyOn(sdk.chain, 'getPendingFees').mockRejectedValue(new Error('not authorized'))
    await expect(
      chain.getPositionInfoByNftMint(TOKEN_ID, { withFees: true, owner: USER }),
    ).rejects.toThrow(/isAuthorizedForToken/)
  })
})

// ---------------------------------------------------------------------------
// 批量仓位详情
// ---------------------------------------------------------------------------

describe('CompatChain · getPositionInfoByNftMints', () => {
  const two: IMockOptions = { positions: [POSITION_STATE, POSITION_STATE_2] }

  it('Map key 是 tokenId.toString()，查空的仓位键仍在、值为 null', async () => {
    const { chain } = newChain(two)
    const map = await chain.getPositionInfoByNftMints([TOKEN_ID, MISSING_TOKEN_ID, TOKEN_ID_2])
    expect([...map.keys()]).toEqual(['123456', '999999', '123457'])
    expect(map.get('999999')).toBeNull()
    expect(map.get('123456')?.tokenId).toBe(TOKEN_ID)
    expect(map.get('123457')?.liquidity).toBe(POSITION_STATE_2.liquidity)
  })

  it('同池仓位只读一次池子、一次代币元数据（不是 N 份单查的简单叠加）', async () => {
    const { chain, mock } = newChain(two)
    await chain.getPositionInfoByNftMints([TOKEN_ID, TOKEN_ID_2])
    // 池子状态那次 multicall 认 `slot0` 这个成分而不是前缀：定制合约的冷路径先读
    // token0/token1/tickSpacing（13 个 call）、热路径才以 slot0 打头（10 个 call），
    // 用前缀匹配会在冷路径上漏数成 0 次
    const poolReads = mock.calls.filter((c) => c.startsWith('multicall(') && c.includes('slot0'))
    const tokenReads = mock.calls.filter((c) => c.startsWith('multicall(decimals'))
    expect(poolReads).toHaveLength(1)
    expect(tokenReads).toHaveLength(1)
    // 两个仓位各读一次 positions —— 这部分是省不掉的
    expect(mock.calls.filter((c) => c === 'readContract(positions)')).toHaveLength(2)
  })

  it('重复 tokenId 不会重复读链', async () => {
    const { chain, mock } = newChain()
    const map = await chain.getPositionInfoByNftMints([TOKEN_ID, '123456', 123456])
    expect(map.size).toBe(1)
    expect(mock.calls.filter((c) => c === 'readContract(positions)')).toHaveLength(1)
  })

  it('全部查空时不再去读池子与代币（省掉一整轮无意义的 RPC）', async () => {
    const { chain, mock } = newChain()
    const map = await chain.getPositionInfoByNftMints([MISSING_TOKEN_ID])
    expect(map.get('999999')).toBeNull()
    expect(mock.calls.some((c) => c.startsWith('multicall'))).toBe(false)
  })

  it('空数组返回空 Map；非数组入参抛', async () => {
    const { chain } = newChain()
    expect((await chain.getPositionInfoByNftMints([])).size).toBe(0)
    await expect(chain.getPositionInfoByNftMints(TOKEN_ID as never)).rejects.toThrow(/必须是数组/)
  })

  it('单查就是 N=1 的批量查：两条路组装出完全相同的结果', async () => {
    const { chain } = newChain()
    const single = await chain.getPositionInfoByNftMint(TOKEN_ID)
    const batch = (await chain.getPositionInfoByNftMints([TOKEN_ID])).get('123456')
    expect(batch).toEqual(single)
  })
})

// ---------------------------------------------------------------------------
// 写操作透传
// ---------------------------------------------------------------------------

describe('CompatChain · 写操作透传', () => {
  it('chain 上的写方法与 chain.clmmClient 上的产出同一笔交易', async () => {
    const { chain } = newChain()
    const args = { userAddress: USER, tokenId: TOKEN_ID, percent: 50, slippageBps: 200 }
    const viaChain = await chain.decreaseLiquidityInstructions(args)
    const viaClient = await chain.clmmClient.decreaseLiquidityInstructions(args)
    expect(viaChain.main.data).toBe(viaClient.main.data)
  })

  it('offchain 挂在 chain 下，且与读链版对同一组入参产出同一笔交易', async () => {
    const { chain } = newChain()
    expect(chain.offchain).toBeInstanceOf(CompatOffchain)

    const fromChain = await chain.decreaseLiquidityInstructions({
      userAddress: USER,
      tokenId: TOKEN_ID,
      percent: 50,
      slippageBps: 200,
    })
    const fromSnapshot = await chain.offchain.decreaseLiquidityInstructions({
      userAddress: USER,
      tokenId: TOKEN_ID,
      percent: 50,
      slippageBps: 200,
      rawPoolInfo: { ...POOL_STATE, token0: WETH, token1: USDC },
      rawPositionInfo: POSITION_STATE,
    })
    // 读链版与 0 RPC 版必须是同一笔交易，否则页面切换数据源会换出另一笔
    expect(fromSnapshot.main.data).toBe(fromChain.main.data)
    expect(fromSnapshot.meta.amount0Min).toBe(fromChain.meta.amount0Min)
  })
})

// ---------------------------------------------------------------------------
// ByrealClmmSdk 门面
// ---------------------------------------------------------------------------

describe('ByrealClmmSdk 门面', () => {
  it('{ sdk } 构造复用外部实例，不另起一份缓存', () => {
    const mock = makeMockPublicClient()
    const core = new EvmClmmSdk({ chainId: CHAIN_ID, profileId: 'test', extraFeeClass: ExtraFeeClass.DEX, publicClient: mock.client })
    const byreal = new ByrealClmmSdk({ sdk: core })
    expect(byreal.sdk).toBe(core)
    expect(byreal.chainId).toBe(CHAIN_ID)
    expect(byreal.publicClient).toBe(core.publicClient)
    expect(byreal.contracts).toBe(core.contracts)
  })

  it('{ chainId } 构造时自己建核心实例；参数不合法时抛（不猜链）', () => {
    const mock = makeMockPublicClient()
    const byreal = new ByrealClmmSdk({ chainId: CHAIN_ID, profileId: 'test', extraFeeClass: ExtraFeeClass.DEX, publicClient: mock.client })
    expect(byreal.sdk).toBeInstanceOf(EvmClmmSdk)
    expect(() => new ByrealClmmSdk({} as never)).toThrow(/chainId 是必填/)
    expect(() => new ByrealClmmSdk(undefined as never)).toThrow(/\[evm-clmm-sdk\/compat\]/)
  })

  it('clmmClient 与 chain.clmmClient 是同一个实例（避免两份状态）', () => {
    const mock = makeMockPublicClient()
    const byreal = new ByrealClmmSdk({ chainId: CHAIN_ID, profileId: 'test', extraFeeClass: ExtraFeeClass.DEX, publicClient: mock.client })
    expect(byreal.clmmClient).toBe(byreal.chain.clmmClient)
    expect(byreal.clmmClient).toBeInstanceOf(CompatCLMMClient)
    expect(byreal.chain).toBeInstanceOf(CompatChain)
  })

  it('api / token 恒为 undefined —— 是「刻意不提供」，不是报错', () => {
    const mock = makeMockPublicClient()
    const byreal = new ByrealClmmSdk({ chainId: CHAIN_ID, profileId: 'test', extraFeeClass: ExtraFeeClass.DEX, publicClient: mock.client })
    expect(byreal.api).toBeUndefined()
    expect(byreal.token).toBeUndefined()
    // 属性必须**存在**：旧代码 `const { api } = sdk` 才不会在 IDE 里报「属性不存在」
    expect('api' in byreal).toBe(true)
    expect('token' in byreal).toBe(true)
  })

  it('顶层透传的读写方法与 chain / clmmClient 上的结果一致', async () => {
    const mock = makeMockPublicClient()
    const byreal = new ByrealClmmSdk({ chainId: CHAIN_ID, profileId: 'test', extraFeeClass: ExtraFeeClass.DEX, publicClient: mock.client })

    expect(await byreal.getRawPoolInfoByPoolId(POOL_ADDRESS)).toEqual(POOL_STATE)
    expect(await byreal.getRawPoolInfo(POOL_ADDRESS)).toEqual(POOL_STATE)
    expect(await byreal.getRawPositionInfoByNftMint(TOKEN_ID)).toEqual(POSITION_STATE)
    expect(await byreal.getPositionNftMintListByUserAddress(USER)).toEqual([TOKEN_ID])
    expect(await byreal.getPositionTokenIdListByOwner(USER)).toEqual([TOKEN_ID])
    expect(await byreal.getTokenInfoByMint(WETH.address)).toEqual(WETH)
    expect((await byreal.getPositionInfoByNftMint(TOKEN_ID))?.tokenId).toBe(TOKEN_ID)
    expect((await byreal.getPositionInfoByNftMints([TOKEN_ID])).size).toBe(1)

    const args = { userAddress: USER, tokenId: TOKEN_ID, slippageBps: 200 }
    expect((await byreal.closePositionInstructions(args)).main.data).toBe(
      (await byreal.clmmClient.closePositionInstructions(args)).main.data,
    )
    expect((await byreal.collectFees({ userAddress: USER, tokenId: TOKEN_ID })).main.data).toBe(
      (await byreal.chain.collectFeesInstructions({ userAddress: USER, tokenId: TOKEN_ID })).main.data,
    )
    expect((await byreal.removeFullLiquidity(args)).main.data).toBe(
      (await byreal.decreaseFullLiquidityInstructions(args)).main.data,
    )
    expect(
      (await byreal.addLiquidity({ ...args, base: 'MintB', baseAmount: 1_000_000 })).main.data,
    ).toBe(
      (await byreal.addLiquidityInstructions({ ...args, base: 'MintB', baseAmount: 1_000_000 })).main
        .data,
    )
    expect(
      (
        await byreal.createPosition({
          poolAddress: POOL_ADDRESS,
          userAddress: USER,
          tickLower: POSITION_STATE.tickLower,
          tickUpper: POSITION_STATE.tickUpper,
          base: 'MintA',
          baseAmount: 10n ** 15n,
          slippageBps: 200,
        })
      ).main.data,
    ).toBe(
      (
        await byreal.createPositionInstructions({
          poolAddress: POOL_ADDRESS,
          userAddress: USER,
          tickLower: POSITION_STATE.tickLower,
          tickUpper: POSITION_STATE.tickUpper,
          base: 'MintA',
          baseAmount: 10n ** 15n,
          slippageBps: 200,
        })
      ).main.data,
    )
    expect((await byreal.decreaseLiquidity({ ...args, percent: 50 })).main.data).toBe(
      (await byreal.decreaseLiquidityInstructions({ ...args, percent: 50 })).main.data,
    )
    expect((await byreal.decreaseFullLiquidity(args)).main.data).toBe(
      (await byreal.decreaseFullLiquidityInstructions(args)).main.data,
    )
    expect((await byreal.closePosition(args)).main.data).toBe(
      (await byreal.closePositionInstructions(args)).main.data,
    )
    expect(
      (await byreal.collectAllFees({ userAddress: USER, tokenIdList: [TOKEN_ID] })).main.data,
    ).toBe(
      (
        await byreal.collectAllPositionFeesInstructions({
          userAddress: USER,
          tokenIdList: [TOKEN_ID],
        })
      ).main.data,
    )
    expect((await byreal.collectFeesInstructions({ userAddress: USER, tokenId: TOKEN_ID })).main.to)
      .toBe(byreal.contracts.positionManager)
  })

  it('地址传 Solana base58 时门面同样给专门提示（不是等到深处才炸）', async () => {
    const mock = makeMockPublicClient()
    const byreal = new ByrealClmmSdk({ chainId: CHAIN_ID, profileId: 'test', extraFeeClass: ExtraFeeClass.DEX, publicClient: mock.client })
    await expect(byreal.getPositionTokenIdListByOwner(SOLANA_ADDRESS)).rejects.toThrow(/Solana/)
    await expect(byreal.getTokenInfoByMint(OTHER + 'ff')).rejects.toThrow(
      /不是合法的 EVM 地址/,
    )
  })
})

// ---------------------------------------------------------------------------
// 回归测试
// ---------------------------------------------------------------------------

describe('回归 · 代币元数据不污染核心的进程级缓存', () => {
  it('传错 decimals 只影响本次调用，不影响之后任何读链路径', async () => {
    const { chain, mock } = newChain()

    // 先用一份**错的** USDC 元数据（decimals 18，实际是 6）走一次写操作。
    // 这是前端从别的链抄 token list 时的真实事故。
    await chain.createPositionInstructions({
      userAddress: USER,
      poolAddress: POOL_ADDRESS,
      tickLower: POSITION_STATE.tickLower,
      tickUpper: POSITION_STATE.tickUpper,
      base: 'MintA',
      baseAmount: 10n ** 18n,
      slippageBps: 200,
      token0: WETH,
      token1: { ...USDC, decimals: 18 },
    })

    // 之后一次完全无关的读：必须拿到链上真值 6，而不是被上面那次污染成 18
    void mock
    const info = await chain.getPositionInfoByNftMint(TOKEN_ID)
    expect(info!.token1.decimals).toBe(6)
    expect(info!.token1.uiAmount).not.toMatch(/^0\.0000000/)
  })

  it('干净实例与「被喂过错元数据」的实例，读出来的仓位详情一致', async () => {
    const a = newChain()
    const b = newChain()

    await b.chain.createPositionInstructions({
      userAddress: USER,
      poolAddress: POOL_ADDRESS,
      tickLower: POSITION_STATE.tickLower,
      tickUpper: POSITION_STATE.tickUpper,
      base: 'MintA',
      baseAmount: 10n ** 18n,
      slippageBps: 200,
      token0: WETH,
      token1: { ...USDC, decimals: 18 },
    })

    const clean = await a.chain.getPositionInfoByNftMint(TOKEN_ID)
    const after = await b.chain.getPositionInfoByNftMint(TOKEN_ID)
    expect(after!.token1.uiAmount).toBe(clean!.token1.uiAmount)
    expect(after!.token0.uiAmount).toBe(clean!.token0.uiAmount)
  })
})

describe('回归 · 代币元数据与仓位对不上时必须抛', () => {
  /** 与本池无关的代币：地址不同、decimals 也不同 */
  const FOREIGN = {
    chainId: CHAIN_ID,
    address: '0x3333333333333333333333333333333333333333' as const,
    decimals: 0,
    symbol: 'FAKE',
  }

  it('collectFees 只传元数据、不传快照时，也要交叉校验', async () => {
    const { chain } = newChain()
    // 这是 collectFees 最省 RPC 的用法，也正是最需要校验的：
    // 全程只有一次 collect staticcall，没有别的环节能发现代币对错了
    await expect(
      chain.collectFeesInstructions({
        userAddress: USER,
        tokenId: TOKEN_ID,
        token0: WETH,
        token1: FOREIGN,
      }),
    ).rejects.toThrow(/对不上/)
  })

  it('元数据正确时照常通过', async () => {
    const { chain } = newChain()
    const r = await chain.collectFeesInstructions({
      userAddress: USER,
      tokenId: TOKEN_ID,
      token0: WETH,
      token1: USDC,
    })
    expect(r.meta.token1.decimals).toBe(6)
    expect(r.meta.uiAmount1).toBe('2')
  })
})

describe('回归 · getRawPositionInfoByNftMint 的报错带 compat 前缀', () => {
  it('仓位不存在时抛的是可读错误，不是 viem 原文', async () => {
    const { chain } = newChain({ positions: [POSITION_STATE] })
    await expect(chain.getRawPositionInfoByNftMint(MISSING_TOKEN_ID)).rejects.toThrow(
      /\[evm-clmm-sdk\/compat\]/,
    )
    // 并且要指出「想要 null 语义该用哪个方法」
    await expect(chain.getRawPositionInfoByNftMint(MISSING_TOKEN_ID)).rejects.toThrow(
      /getPositionInfoByNftMint/,
    )
  })

  it('网络类错误仍然原样抛，不套 compat 外壳', async () => {
    const { chain } = newChain({ positionsError: new Error('fetch failed: ECONNREFUSED') })
    await expect(chain.getRawPositionInfoByNftMint(TOKEN_ID)).rejects.toThrow(/ECONNREFUSED/)
  })
})
