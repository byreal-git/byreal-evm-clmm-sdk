/**
 * `math.ts` 三个静态类的测试。
 *
 * 这一层的唯一职责是「把旧 Solana SDK 的调用形状翻译过来，然后**转调** `../calculate`」，
 * 所以用例的主干不是「算出来等于某个硬编码的数」，而是**「与核心纯函数逐位相等」**——
 * 硬编码期望值只会在核心口径正确演进时变成噪声，而 compat 真正会坏的是「悄悄自己算了一遍」。
 *
 * X64 那四个方法的抛错在 `coerce.test.ts`（用例 5）；这里补的是
 * `LiquidityMath` 与 `TickMath` 的换算路径 —— 它们是开仓/加仓输入框联动的全部数学来源。
 */
import { describe, expect, it } from 'vitest'

import {
  getAmountsFromAmount,
  getBurnAmountsWithSlippage,
  getMintAmountsWithSlippage,
  getPositionView,
  priceToTick,
  sqrtPriceX96ToPrice,
  tickToPrice,
} from '../calculate.js'
import { MAX_TICK, MIN_TICK } from '../constants.js'

import { LiquidityMath, SqrtPriceMath, TickMath } from './math.js'
import {
  API_POOL,
  CURRENT_TICK,
  POOL_STATE,
  SQRT_PRICE_X96,
  USDC,
  WETH,
} from './test-fixtures.js'

const TICK_LOWER = CURRENT_TICK - 1000
const TICK_UPPER = CURRENT_TICK + 1000
const RANGE = { token0: WETH, token1: USDC, tickLower: TICK_LOWER, tickUpper: TICK_UPPER } as const

// ---------------------------------------------------------------------------
// LiquidityMath
// ---------------------------------------------------------------------------

describe('LiquidityMath · 由一边金额反推另一边', () => {
  it('getAmount1FromAmount0 结果与核心 getAmountsFromAmount 深度相等', () => {
    const compat = LiquidityMath.getAmount1FromAmount0({
      poolState: POOL_STATE,
      ...RANGE,
      amount0: 10n ** 15n,
    })
    const core = getAmountsFromAmount({
      poolState: POOL_STATE,
      token0: WETH,
      token1: USDC,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      base: 'Token0',
      baseAmount: 10n ** 15n,
    })
    expect(compat).toEqual(core)
    expect(compat.liquidity).toBeGreaterThan(0n)
  })

  it('getAmount0FromAmount1 同理（base 换到 token1）', () => {
    const compat = LiquidityMath.getAmount0FromAmount1({
      poolState: POOL_STATE,
      ...RANGE,
      amount1: 1_000_000n,
    })
    expect(compat).toEqual(
      getAmountsFromAmount({
        poolState: POOL_STATE,
        token0: WETH,
        token1: USDC,
        tickLower: TICK_LOWER,
        tickUpper: TICK_UPPER,
        base: 'Token1',
        baseAmount: 1_000_000n,
      }),
    )
  })

  it('旧名 getAmountBFromAmountA / getAmountAFromAmountB 指向**同一个函数**，不是拷贝的实现', () => {
    expect(LiquidityMath.getAmountBFromAmountA).toBe(LiquidityMath.getAmount1FromAmount0)
    expect(LiquidityMath.getAmountAFromAmountB).toBe(LiquidityMath.getAmount0FromAmount1)
  })

  it('旧参数名 amountA / amountB 与新名等价；两个都给且不一致时抛', () => {
    const a = LiquidityMath.getAmountBFromAmountA({
      poolState: POOL_STATE,
      ...RANGE,
      amountA: '1000000000000000',
    })
    const b = LiquidityMath.getAmount1FromAmount0({
      poolState: POOL_STATE,
      ...RANGE,
      amount0: 10n ** 15n,
    })
    expect(a).toEqual(b)

    expect(() =>
      LiquidityMath.getAmount1FromAmount0({
        poolState: POOL_STATE,
        ...RANGE,
        amount0: 1n,
        amountA: 2n,
      }),
    ).toThrow(/amount0=1 与旧名 amountA=2 不一致/)

    expect(() =>
      LiquidityMath.getAmount1FromAmount0({ poolState: POOL_STATE, ...RANGE }),
    ).toThrow(/必须传 amount0（旧名 amountA 也认）/)
  })

  it('池子快照三种形状都能直接喂（后端接口的 PoolDetail 不用先手动转一遍）', () => {
    const fromRaw = LiquidityMath.getAmount1FromAmount0({
      poolState: POOL_STATE,
      ...RANGE,
      amount0: 10n ** 15n,
    })
    const fromApi = LiquidityMath.getAmount1FromAmount0({
      poolState: API_POOL,
      ...RANGE,
      amount0: 10n ** 15n,
    })
    expect(fromApi).toEqual(fromRaw)
  })

  it('这一边在当前价格下用不上时返回 liquidity=0 而不是抛（输入框联动里的正常状态）', () => {
    // 区间整体落在当前价**下方** → 仓位 100% 由 token1 构成，从 token0 那一边输入无解
    const belowPrice = { tickLower: CURRENT_TICK - 2000, tickUpper: CURRENT_TICK - 1000 }
    const noSolution = LiquidityMath.getAmount1FromAmount0({
      poolState: POOL_STATE,
      token0: WETH,
      token1: USDC,
      ...belowPrice,
      amount0: 10n ** 15n,
    })
    expect(noSolution.liquidity).toBe(0n)
    expect(noSolution.amount0).toBe(0n)
    expect(noSolution.uiAmount0).toBe('0')

    // 换到另一边就有解 —— 这正是 UI 该提示用户做的事
    expect(
      LiquidityMath.getAmount0FromAmount1({
        poolState: POOL_STATE,
        token0: WETH,
        token1: USDC,
        ...belowPrice,
        amount1: 1_000_000n,
      }).liquidity,
    ).toBeGreaterThan(0n)
  })
})

describe('LiquidityMath · 由流动性反推两边', () => {
  const liquidity = 999_999_999_999n

  it('getAmountsFromLiquidity 与核心 getPositionView 的持仓量口径一致（向下取整）', () => {
    const compat = LiquidityMath.getAmountsFromLiquidity({ poolState: POOL_STATE, ...RANGE, liquidity })
    const view = getPositionView({
      poolState: POOL_STATE,
      positionState: {
        tokenId: 0n,
        nonce: 0n,
        operator: '0x0000000000000000000000000000000000000000',
        token0: POOL_STATE.token0,
        token1: POOL_STATE.token1,
        // 定制合约的 positions 第 5 项是 tickSpacing（原生 V3 此处是 fee）
        tickSpacing: POOL_STATE.tickSpacing,
        tickLower: TICK_LOWER,
        tickUpper: TICK_UPPER,
        liquidity,
        feeGrowthInside0LastX128: 0n,
        feeGrowthInside1LastX128: 0n,
        tokensOwed0: 0n,
        tokensOwed1: 0n,
      },
      token0: WETH,
      token1: USDC,
    })
    expect(compat).toEqual({
      amount0: view.amount0,
      amount1: view.amount1,
      uiAmount0: view.uiAmount0,
      uiAmount1: view.uiAmount1,
    })
  })

  it('「持仓量」比「投入量」小：两个方法的语义差异必须真的存在', () => {
    const hold = LiquidityMath.getAmountsFromLiquidity({ poolState: POOL_STATE, ...RANGE, liquidity })
    const mint = LiquidityMath.getAmount1FromAmount0({
      poolState: POOL_STATE,
      ...RANGE,
      amount0: hold.amount0,
    })
    // mintAmounts 向上取整、position.amount0 向下取整 —— 两者**严格**不等。
    // 用 toBeGreaterThan 而不是 toBeGreaterThanOrEqual：后者恰好放过了这条用例
    // 声称要抓的那个失败（两个方法用了同一个口径 ⇒ 结果相等 ⇒ 断言仍然通过）。
    expect(mint.amount1).toBeGreaterThan(hold.amount1)
  })

  it('getAmountsFromLiquidityWithSlippage 的 mint / burn 分别对上核心两个函数', () => {
    const args = { poolState: POOL_STATE, ...RANGE, liquidity, slippageBps: 200 }
    const coreArgs = {
      poolState: POOL_STATE,
      token0: WETH,
      token1: USDC,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      liquidity,
      slippageBps: 200,
    }
    expect(LiquidityMath.getAmountsFromLiquidityWithSlippage({ ...args, action: 'mint' })).toEqual(
      getMintAmountsWithSlippage(coreArgs),
    )
    expect(LiquidityMath.getAmountsFromLiquidityWithSlippage({ ...args, action: 'burn' })).toEqual(
      getBurnAmountsWithSlippage(coreArgs),
    )
    // 两个方向的数值必须不同，否则「用错 action」这件事根本不会有后果
    expect(LiquidityMath.getAmountsFromLiquidityWithSlippage({ ...args, action: 'mint' })).not.toEqual(
      LiquidityMath.getAmountsFromLiquidityWithSlippage({ ...args, action: 'burn' }),
    )
  })

  it('旧口径小数滑点与新口径基点等价；action 非法时抛并列出合法取值', () => {
    const base = { poolState: POOL_STATE, ...RANGE, liquidity, action: 'mint' as const }
    expect(LiquidityMath.getAmountsFromLiquidityWithSlippage({ ...base, slippage: 0.02 })).toEqual(
      LiquidityMath.getAmountsFromLiquidityWithSlippage({ ...base, slippageBps: 200 }),
    )
    expect(() =>
      LiquidityMath.getAmountsFromLiquidityWithSlippage({
        ...base,
        slippage: 0.02,
        slippageBps: 200,
      }),
    ).toThrow(/只能二选一/)
    expect(() =>
      LiquidityMath.getAmountsFromLiquidityWithSlippage({
        ...base,
        action: 'burnn' as unknown as 'burn',
        slippageBps: 200,
      }),
    ).toThrow(/只接受 'mint'[\s\S]*'burn'/)
  })

  it('未对齐 tickSpacing 的区间由核心挡下（compat 不替调用方悄悄对齐）', () => {
    expect(() =>
      LiquidityMath.getAmountsFromLiquidity({
        poolState: POOL_STATE,
        token0: WETH,
        token1: USDC,
        tickLower: TICK_LOWER + 1,
        tickUpper: TICK_UPPER,
        liquidity,
      }),
    ).toThrow(/未对齐到 tickSpacing/)
  })
})

// ---------------------------------------------------------------------------
// TickMath / SqrtPriceMath 的换算路径
// ---------------------------------------------------------------------------

describe('TickMath · 价格换算全部转调核心', () => {
  it('getPriceFromTick == 核心 tickToPrice', () => {
    expect(TickMath.getPriceFromTick({ tick: CURRENT_TICK, token0: WETH, token1: USDC })).toBe(
      tickToPrice({ tick: CURRENT_TICK, token0: WETH, token1: USDC }),
    )
  })

  it('getTickWithPriceAndTickspacing == 核心 priceToTick（且真的对齐到 tickSpacing）', () => {
    const tick = TickMath.getTickWithPriceAndTickspacing({
      price: '2900',
      token0: WETH,
      token1: USDC,
      tickSpacing: 60,
    })
    expect(tick).toBe(priceToTick({ price: '2900', token0: WETH, token1: USDC, tickSpacing: 60 }))
    expect(tick % 60 === 0).toBe(true)
    // 数字入参与字符串入参等价（旧代码两种都写）
    expect(
      TickMath.getTickWithPriceAndTickspacing({
        price: 2900,
        token0: WETH,
        token1: USDC,
        tickSpacing: 60,
      }),
    ).toBe(tick)
  })

  it('MIN_TICK / MAX_TICK 与核心常量同源，越界与非整数各给专门文案', () => {
    expect(TickMath.MIN_TICK).toBe(MIN_TICK)
    expect(TickMath.MAX_TICK).toBe(MAX_TICK)
    expect(() => TickMath.getSqrtRatioAtTick(MIN_TICK - 1)).toThrow(/越界/)
    expect(() => TickMath.getSqrtRatioAtTick(NaN)).toThrow(/必须是整数 tick/)
  })

  it('getSqrtRatioAtTick 与夹具里由 v3-sdk 现算的 sqrtPriceX96 一致', () => {
    expect(TickMath.getSqrtRatioAtTick(CURRENT_TICK)).toBe(SQRT_PRICE_X96)
    expect(TickMath.getTickAtSqrtRatio(SQRT_PRICE_X96)).toBe(CURRENT_TICK)
    // 入参宽进：后端下发的 JSON 里是字符串
    expect(TickMath.getTickAtSqrtRatio(SQRT_PRICE_X96.toString())).toBe(CURRENT_TICK)
  })

  it('sqrtPriceX96 越界时的报错要点破「可能传成了 Solana 的 X64」', () => {
    expect(() => TickMath.getTickAtSqrtRatio(1n)).toThrow(/sqrtPriceX64/)
    expect(() => TickMath.getTickAtSqrtRatio(1n)).toThrow(/超出可表示范围/)
  })

  it('getFullRangeTicks 与 nearestUsableTick 转调核心', () => {
    expect(TickMath.getFullRangeTicks(60)).toEqual({ tickLower: -887220, tickUpper: 887220 })
    expect(TickMath.nearestUsableTick(-196004, 10)).toBe(-196000)
    expect(() => TickMath.nearestUsableTick(0, 0)).toThrow(/tickSpacing 必须是正整数/)
  })
})

describe('SqrtPriceMath · X96 口径', () => {
  it('sqrtPriceX96ToPrice == 核心 sqrtPriceX96ToPrice，且宽进字符串', () => {
    const expected = sqrtPriceX96ToPrice({ sqrtPriceX96: SQRT_PRICE_X96, token0: WETH, token1: USDC })
    expect(SqrtPriceMath.sqrtPriceX96ToPrice({ sqrtPriceX96: SQRT_PRICE_X96, token0: WETH, token1: USDC })).toBe(
      expected,
    )
    expect(
      SqrtPriceMath.sqrtPriceX96ToPrice({
        sqrtPriceX96: SQRT_PRICE_X96.toString(),
        token0: WETH,
        token1: USDC,
      }),
    ).toBe(expected)
  })

  it('priceToSqrtPriceX96 不被 tick 网格吸附（这正是它与 getSqrtPriceX96FromTick 的区别）', () => {
    const exact = SqrtPriceMath.priceToSqrtPriceX96({ price: '2900', token0: WETH, token1: USDC })
    const snapped = SqrtPriceMath.getSqrtPriceX96FromTick(
      TickMath.getTickWithPriceAndTickspacing({
        price: '2900',
        token0: WETH,
        token1: USDC,
        tickSpacing: 1,
      }),
    )
    expect(exact).not.toBe(snapped)
    // 但两者应当非常接近（差不到一个 tick，约万分之一）
    const diff = Number(exact - snapped) / Number(exact)
    expect(Math.abs(diff)).toBeLessThan(1e-4)
  })

  it('getSqrtPriceX96FromTick / getTickFromSqrtPriceX96 与 TickMath 上的同义方法完全一致', () => {
    expect(SqrtPriceMath.getSqrtPriceX96FromTick(CURRENT_TICK)).toBe(
      TickMath.getSqrtRatioAtTick(CURRENT_TICK),
    )
    expect(SqrtPriceMath.getTickFromSqrtPriceX96(SQRT_PRICE_X96)).toBe(
      TickMath.getTickAtSqrtRatio(SQRT_PRICE_X96),
    )
  })

  it('priceToSqrtPriceX96 ↔ sqrtPriceX96ToPrice 往返（8 位有效数字内一致）', () => {
    const sqrt = SqrtPriceMath.priceToSqrtPriceX96({ price: '2900', token0: WETH, token1: USDC })
    const back = SqrtPriceMath.sqrtPriceX96ToPrice({ sqrtPriceX96: sqrt, token0: WETH, token1: USDC })
    expect(Number(back)).toBeCloseTo(2900, 4)
  })
})
