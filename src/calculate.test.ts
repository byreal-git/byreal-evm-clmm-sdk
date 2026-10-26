import { describe, expect, it } from 'vitest'

import { MAX_TICK, MIN_TICK } from './constants.js'
import {
  alignTick,
  calculateApr,
  estimateApr,
  getFullRangeTicks,
  getSqrtPriceX96FromTick,
  getTicksByPercentRange,
  isFullRange,
  parseDecimalToFraction,
  priceToTick,
  tickToPrice,
} from './calculate.js'
import type { IPoolStateRaw, ITokenInfo } from './types.js'

// Arbitrum WETH/USDC：地址 0x82.. < 0xaf..，所以 WETH 是 token0，价格口径 = 1 WETH = ? USDC
const WETH: ITokenInfo = {
  chainId: 42161,
  address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  decimals: 18,
  symbol: 'WETH',
}
const USDC: ITokenInfo = {
  chainId: 42161,
  address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  decimals: 6,
  symbol: 'USDC',
}

function createPoolState(tick = 0): IPoolStateRaw {
  return {
    poolAddress: '0x0000000000000000000000000000000000000001',
    token0: WETH.address,
    token1: USDC.address,
    tickSpacing: 10,
    tradeFeeRate: 500,
    protocolFeeRate: 0,
    pauseFlags: 0,
    swapOpenTime: 0,
    alphaExtraTradeFeeRate: 0,
    dexExtraTradeFeeRate: 0,
    dynamicFeeEnabled: false,
    sqrtPriceX96: getSqrtPriceX96FromTick(tick),
    tick,
    liquidity: 10n ** 24n,
    feeGrowthGlobal0X128: 0n,
    feeGrowthGlobal1X128: 0n,
  }
}

describe('parseDecimalToFraction', () => {
  it('普通小数：1234.56 → 123456 / 100', () => {
    expect(parseDecimalToFraction('1234.56')).toEqual({ numerator: 123456n, denominator: 100n })
  })
  it('纯整数：3200 → 3200 / 1', () => {
    expect(parseDecimalToFraction('3200')).toEqual({ numerator: 3200n, denominator: 1n })
  })
  it('正指数科学计数法：1.5e3 → 1500 / 1', () => {
    expect(parseDecimalToFraction('1.5e3')).toEqual({ numerator: 1500n, denominator: 1n })
  })
  it('负指数科学计数法：1.2e-8 → 12 / 1e9', () => {
    expect(parseDecimalToFraction('1.2e-8')).toEqual({ numerator: 12n, denominator: 1_000_000_000n })
  })
  it('前后空白被 trim', () => {
    expect(parseDecimalToFraction('  42.5  ')).toEqual({ numerator: 425n, denominator: 10n })
  })
  it('值为 0 抛错（价格必须 > 0）', () => {
    expect(() => parseDecimalToFraction('0')).toThrow()
    expect(() => parseDecimalToFraction('0.00')).toThrow()
  })
  it('非法字符串抛错', () => {
    expect(() => parseDecimalToFraction('abc')).toThrow()
    expect(() => parseDecimalToFraction('-5')).toThrow()
    expect(() => parseDecimalToFraction('1,000')).toThrow()
  })
})

describe('alignTick', () => {
  it('down 向下取整到 tickSpacing 的整数倍', () => {
    expect(alignTick({ tick: 105, tickSpacing: 10, mode: 'down' })).toBe(100)
    expect(alignTick({ tick: -105, tickSpacing: 10, mode: 'down' })).toBe(-110)
  })
  it('up 向上取整', () => {
    expect(alignTick({ tick: 101, tickSpacing: 10, mode: 'up' })).toBe(110)
    expect(alignTick({ tick: -101, tickSpacing: 10, mode: 'up' })).toBe(-100)
  })
  it('nearest 四舍五入', () => {
    expect(alignTick({ tick: 104, tickSpacing: 10, mode: 'nearest' })).toBe(100)
    expect(alignTick({ tick: 106, tickSpacing: 10, mode: 'nearest' })).toBe(110)
  })
  it('已经对齐的 tick 原样返回', () => {
    expect(alignTick({ tick: -200700, tickSpacing: 10, mode: 'down' })).toBe(-200700)
  })
  it('结果始终夹在 [MIN_TICK, MAX_TICK] 内的可用极值', () => {
    const up = alignTick({ tick: MAX_TICK + 999999, tickSpacing: 60, mode: 'up' })
    expect(up).toBeLessThanOrEqual(MAX_TICK)
    expect(up % 60 === 0).toBe(true)
    const down = alignTick({ tick: MIN_TICK - 999999, tickSpacing: 60, mode: 'down' })
    expect(down).toBeGreaterThanOrEqual(MIN_TICK)
    expect(down % 60 === 0).toBe(true)
  })
  it('非法 tickSpacing 抛错', () => {
    expect(() => alignTick({ tick: 100, tickSpacing: 0 })).toThrow()
    expect(() => alignTick({ tick: 100, tickSpacing: -10 })).toThrow()
    expect(() => alignTick({ tick: 100, tickSpacing: 1.5 })).toThrow()
  })
})

// tradeFeeRate 与 tickSpacing 不存在映射；tickSpacing 合法性由 `isValidTickSpacing` 单独覆盖。

describe('getFullRangeTicks', () => {
  it('两端都是 tickSpacing 的整数倍且关于 0 对称', () => {
    const { tickLower, tickUpper } = getFullRangeTicks(60)
    // 用 === 0 而非 toBe(0)：负数取模会得到 -0，Object.is(-0, +0) 为 false
    expect(tickLower % 60 === 0).toBe(true)
    expect(tickUpper % 60 === 0).toBe(true)
    expect(tickLower).toBe(-tickUpper)
    // 落在合法 tick 边界内
    expect(tickLower).toBeGreaterThanOrEqual(MIN_TICK)
    expect(tickUpper).toBeLessThanOrEqual(MAX_TICK)
  })
  it('非法 tickSpacing 抛错', () => {
    expect(() => getFullRangeTicks(0)).toThrow()
  })
})

describe('isFullRange', () => {
  it('全区间 → true', () => {
    const full = getFullRangeTicks(10)
    expect(isFullRange({ ...full, tickSpacing: 10 })).toBe(true)
  })
  it('窄区间 → false', () => {
    expect(isFullRange({ tickLower: -1000, tickUpper: 1000, tickSpacing: 10 })).toBe(false)
  })
})

describe('APR', () => {
  const common = {
    fee24hUsdValue: 1_000,
    positionUsdValue: 10_000,
    tickLower: -100,
    tickUpper: 100,
    poolState: createPoolState(),
    token0: WETH,
    token1: USDC,
  }

  it('根据确切双边金额计算百分比 APR', () => {
    const apr = calculateApr({
      ...common,
      amount0: 10n ** 18n,
      amount1: 10n ** 6n,
    })
    expect(apr).toBeGreaterThan(0)
    expect(Number.isFinite(apr)).toBe(true)
  })

  it('按 USD 目标仓位估算 APR', () => {
    const apr = estimateApr({
      ...common,
      token0PriceUsd: 2_500,
      token1PriceUsd: 1,
    })
    expect(apr).toBeGreaterThan(0)
    expect(Number.isFinite(apr)).toBe(true)
  })

  it('仓位不在价格区间内时 APR 为 0', () => {
    expect(
      calculateApr({
        ...common,
        poolState: createPoolState(200),
        amount0: 10n ** 18n,
        amount1: 10n ** 6n,
      }),
    ).toBe(0)
  })

  it('追加场景会把已有流动性计入用户份额', () => {
    const params = {
      ...common,
      amount0: 10n ** 18n,
      amount1: 10n ** 6n,
    }
    const existingApr = calculateApr({ ...params, scene: 'exist' })
    const addApr = calculateApr({ ...params, scene: 'add', existLiquidity: 10n ** 22n })
    expect(addApr).toBeGreaterThan(existingApr)
  })
})

describe('getTicksByPercentRange', () => {
  const tickSpacing = 10
  const currentTick = -200700

  it('区间两端对齐 tickSpacing，且 lower < upper', () => {
    const { tickLower, tickUpper } = getTicksByPercentRange({
      currentTick,
      tickSpacing,
      lowerPercent: 5,
      upperPercent: 5,
    })
    expect(tickLower % tickSpacing === 0).toBe(true)
    expect(tickUpper % tickSpacing === 0).toBe(true)
    expect(tickLower).toBeLessThan(tickUpper)
  })

  it('中心在区间内（当前 tick 落在 [lower, upper) 之间）', () => {
    const { tickLower, tickUpper } = getTicksByPercentRange({
      currentTick,
      tickSpacing,
      lowerPercent: 10,
      upperPercent: 10,
    })
    expect(currentTick).toBeGreaterThanOrEqual(tickLower)
    expect(currentTick).toBeLessThan(tickUpper)
  })

  it('承诺：实际区间只会更宽、不会更窄（扫多个 currentTick 都成立）', () => {
    // 精确的 ±20% tick 偏移（未对齐前）
    const LN = Math.log(1.0001)
    const exactLowerOff = Math.log(1 - 20 / 100) / LN // 负数
    const exactUpperOff = Math.log(1 + 20 / 100) / LN // 正数
    for (let base = -201000; base <= -200000; base += 7) {
      const { tickLower, tickUpper } = getTicksByPercentRange({
        currentTick: base,
        tickSpacing,
        lowerPercent: 20,
        upperPercent: 20,
      })
      // 实际下界 <= 理论下界（更低的价格 = 更宽），实际上界 >= 理论上界
      expect(tickLower).toBeLessThanOrEqual(base + exactLowerOff)
      expect(tickUpper).toBeGreaterThanOrEqual(base + exactUpperOff)
    }
  })

  it('跌幅 >= 100% 时下界取全区间下界', () => {
    const full = getFullRangeTicks(tickSpacing)
    const { tickLower } = getTicksByPercentRange({
      currentTick,
      tickSpacing,
      lowerPercent: 100,
      upperPercent: 10,
    })
    expect(tickLower).toBe(full.tickLower)
  })

  it('负百分比按绝对值处理（±5 与 5 等价）', () => {
    const a = getTicksByPercentRange({ currentTick, tickSpacing, lowerPercent: -5, upperPercent: -5 })
    const b = getTicksByPercentRange({ currentTick, tickSpacing, lowerPercent: 5, upperPercent: 5 })
    expect(a).toEqual(b)
  })
})

describe('tickToPrice / priceToTick 互逆', () => {
  it('对齐过的 tick 往返回到自己（误差 <= 1 个 tickSpacing）', () => {
    const tickSpacing = 10
    for (const tick of [-200700, -200000, -180000, -220000]) {
      const price = tickToPrice({ tick, token0: WETH, token1: USDC })
      const back = priceToTick({ price, token0: WETH, token1: USDC, tickSpacing })
      expect(Math.abs(back - tick)).toBeLessThanOrEqual(tickSpacing)
    }
  })

  it('价格往返：priceToTick 再 tickToPrice，相对误差很小', () => {
    const price = '2500'
    const tick = priceToTick({ price, token0: WETH, token1: USDC })
    const back = Number(tickToPrice({ tick, token0: WETH, token1: USDC }))
    // tick 是离散的，一个 tick ≈ 0.01% 价格，往返落在 0.1% 以内
    expect(Math.abs(back - 2500) / 2500).toBeLessThan(0.001)
  })

  it('WETH 价格 tick 为负（1 WETH = 千级 USDC，token0 更贵）', () => {
    const tick = priceToTick({ price: '2500', token0: WETH, token1: USDC })
    expect(tick).toBeLessThan(0)
  })

  it('超出可表示范围的价格抛错', () => {
    // 1e40 因 USDC 只有 6 位精度换算后仍在 tick 范围内；1e60 才真正越界
    expect(() => priceToTick({ price: '1e60', token0: WETH, token1: USDC })).toThrow()
    expect(() => priceToTick({ price: '1e-30', token0: WETH, token1: USDC })).toThrow()
  })
})
