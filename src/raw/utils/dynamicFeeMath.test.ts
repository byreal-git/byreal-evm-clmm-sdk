import JSBI from 'jsbi'
import { DynamicFeeMath, resolveMaxDynamicFeeRate } from './dynamicFeeMath.js'

// Differential baseline for the dynamic-fee math library. The 77 vectors below are transcribed verbatim from
// the contract repo's `test/core/DynamicFeeMath.spec.ts` (which in turn ports the unit tests of Solana
// raydium-clmm `dynamic_fee_math.rs` into concrete "input -> expected value" vectors), keeping the original
// describe/it names, inputs and expectations.
// Precision mapping: rust uses Q64.64 (Q64 = 2**64), this library uses `price * 2**96` (Q96) everywhere —
// wherever rust uses Q64 for arbitrage / priceFromSqrt / quoteAmountFromBase the vectors use Q96, and the
// ratios/results stay pointwise equal. Integer-only quantities (slippage / imbalance / normalize) are unscaled.
describe('DynamicFeeMath (differential vs dynamic_fee_math.rs)', () => {
  const Q96 = JSBI.exponentiate(JSBI.BigInt(2), JSBI.BigInt(96))
  const bn = (x: number | string) => JSBI.BigInt(x)
  const pow = (base: number, exp: number) => JSBI.exponentiate(JSBI.BigInt(base), JSBI.BigInt(exp))

  // Q96 * n / d, mirroring the rust `Q64 * n / 100` fixtures
  const q96mul = (n: number, d: number) => JSBI.divide(JSBI.multiply(Q96, JSBI.BigInt(n)), JSBI.BigInt(d))

  const eq = (actual: JSBI, expected: JSBI | number | string) => expect(actual.toString()).toEqual(String(expected))
  const num = (x: JSBI) => Number(x.toString())

  describe('arbitrageFee', () => {
    it('1% higher, buffer=0, feeBase=1000 -> 9000', () => {
      eq(DynamicFeeMath.arbitrageFee(q96mul(101, 100), Q96, bn(0), bn(1000)), 9000)
    })
    it('1% higher, buffer=9000, feeBase=1000 -> 0 (absorbed)', () => {
      eq(DynamicFeeMath.arbitrageFee(q96mul(101, 100), Q96, bn(9000), bn(1000)), 0)
    })
    it('reverse direction 1% lower -> 9001 (ceil)', () => {
      eq(DynamicFeeMath.arbitrageFee(q96mul(99, 100), Q96, bn(0), bn(1000)), 9001)
    })
    it('reverse direction 1% lower, buffer 9000 -> 1', () => {
      eq(DynamicFeeMath.arbitrageFee(q96mul(99, 100), Q96, bn(9000), bn(1000)), 1)
    })
    it('equal prices -> 0', () => {
      eq(DynamicFeeMath.arbitrageFee(Q96, Q96, bn(0), bn(1000)), 0)
    })
    it('5% higher, buffer 5000, feeBase 1000 -> 44000', () => {
      eq(DynamicFeeMath.arbitrageFee(q96mul(105, 100), Q96, bn(5000), bn(1000)), 44000)
    })
    it('buffer exactly absorbs (9000+1000=10000) -> 0', () => {
      eq(DynamicFeeMath.arbitrageFee(q96mul(101, 100), Q96, bn(9000), bn(1000)), 0)
    })
    it('buffer just below (8999+1000) -> 1', () => {
      eq(DynamicFeeMath.arbitrageFee(q96mul(101, 100), Q96, bn(8999), bn(1000)), 1)
    })
    it('high feeBase absorbs (2% dev, feeBase 20000) -> 0', () => {
      eq(DynamicFeeMath.arbitrageFee(q96mul(102, 100), Q96, bn(0), bn(20000)), 0)
    })
    it('pIndex==0 reverts (library invariant)', () => {
      expect(() => DynamicFeeMath.arbitrageFee(Q96, bn(0), bn(0), bn(0))).toThrow('PIDX')
    })
    it('50% deviation, feeBase 1000 -> ~499000', () => {
      const fee = num(DynamicFeeMath.arbitrageFee(q96mul(150, 100), Q96, bn(0), bn(1000)))
      expect(fee).toBeGreaterThanOrEqual(498000)
      expect(fee).toBeLessThanOrEqual(500000)
    })
  })

  describe('tradeSlippageFee', () => {
    it('trade 100, base 10, threshold 1 -> 0 (at threshold)', () => {
      eq(DynamicFeeMath.tradeSlippageFee(bn(100), bn(10), bn(1)), 0)
    })
    it('trade 200, base 10, threshold 1 -> 10', () => {
      eq(DynamicFeeMath.tradeSlippageFee(bn(200), bn(10), bn(1)), 10)
    })
    it('base 0 -> 0 regardless of size', () => {
      eq(DynamicFeeMath.tradeSlippageFee(bn(500), bn(0), bn(1)), 0)
    })
    it('threshold 0, trade 100 -> 10', () => {
      eq(DynamicFeeMath.tradeSlippageFee(bn(100), bn(10), bn(0)), 10)
    })
    it('trade 101 threshold 1 -> 1', () => {
      eq(DynamicFeeMath.tradeSlippageFee(bn(101), bn(10), bn(1)), 1)
    })
    it('trade 102 base 1 threshold 1 -> 1', () => {
      eq(DynamicFeeMath.tradeSlippageFee(bn(102), bn(1), bn(1)), 1)
    })
    it('doc example: trade 8000, base 15, threshold 50 -> ~82-83', () => {
      const f = num(DynamicFeeMath.tradeSlippageFee(bn(8000), bn(15), bn(50)))
      expect(f).toBeGreaterThanOrEqual(82)
      expect(f).toBeLessThanOrEqual(83)
    })
    it('doc example no-fee: trade 4000 threshold 50 -> 0', () => {
      eq(DynamicFeeMath.tradeSlippageFee(bn(4000), bn(15), bn(50)), 0)
    })
    it('max base 255, threshold 0, trade 10000 -> 2550', () => {
      eq(DynamicFeeMath.tradeSlippageFee(bn(10000), bn(255), bn(0)), 2550)
    })
    it('sqrt growth: fee_400 == 2*fee_100 and fee_10000 == 10*fee_100', () => {
      const f100 = num(DynamicFeeMath.tradeSlippageFee(bn(200), bn(10), bn(1)))
      const f400 = num(DynamicFeeMath.tradeSlippageFee(bn(500), bn(10), bn(1)))
      const f10000 = num(DynamicFeeMath.tradeSlippageFee(bn(10100), bn(10), bn(1)))
      expect(f400).toEqual(f100 * 2)
      expect(f10000).toEqual(f100 * 10)
    })
    it('ceiling rounding: trade 101 base 1 threshold 0 -> 2', () => {
      eq(DynamicFeeMath.tradeSlippageFee(bn(101), bn(1), bn(0)), 2)
    })
  })

  describe('imbalanceFee', () => {
    it('150/50, base 5, x 10, sell base -> 20', () => {
      eq(DynamicFeeMath.imbalanceFee(bn(150), bn(50), bn(5), bn(10), false), 20)
    })
    it('150/50, base 5, x 10, buy base -> 0 (rebalances)', () => {
      eq(DynamicFeeMath.imbalanceFee(bn(150), bn(50), bn(5), bn(10), true), 0)
    })
    it('balanced 100/100 -> 0', () => {
      eq(DynamicFeeMath.imbalanceFee(bn(100), bn(100), bn(5), bn(10), false), 0)
    })
    it('doc case1 no-fee 1.22M/1.1M x40 -> 0', () => {
      eq(DynamicFeeMath.imbalanceFee(bn(1220000), bn(1100000), bn(50), bn(40), false), 0)
    })
    it('doc case2 122k/1.1M buy base x40 -> 201', () => {
      eq(DynamicFeeMath.imbalanceFee(bn(122000), bn(1100000), bn(50), bn(40), true), 201)
    })
    it('reverse 50/150 buy base -> 20 (same abs imbalance)', () => {
      eq(DynamicFeeMath.imbalanceFee(bn(50), bn(150), bn(5), bn(10), true), 20)
    })
    it('zero total -> 0', () => {
      eq(DynamicFeeMath.imbalanceFee(bn(0), bn(0), bn(5), bn(10), false), 0)
    })
    it('at threshold (imbalance==x_ppm) -> 0', () => {
      eq(DynamicFeeMath.imbalanceFee(bn(550), bn(450), bn(5), bn(10), false), 0)
    })
    it('extreme 1000/1 base 50 x10 -> 450', () => {
      const f = num(DynamicFeeMath.imbalanceFee(bn(1000), bn(1), bn(50), bn(10), false))
      expect(f).toBeGreaterThanOrEqual(448)
      expect(f).toBeLessThanOrEqual(450)
    })
    it('max base 255, 190/10 x1 -> 2270', () => {
      eq(DynamicFeeMath.imbalanceFee(bn(190), bn(10), bn(255), bn(1), false), 2270)
    })
    it('x 0, 105/95 base 5 -> 3', () => {
      eq(DynamicFeeMath.imbalanceFee(bn(105), bn(95), bn(5), bn(0), false), 3)
    })
    it('x 100 never triggers -> 0', () => {
      eq(DynamicFeeMath.imbalanceFee(bn(999), bn(1), bn(50), bn(100), false), 0)
    })
    it('large values 5B/3B base 30 x20 -> 15', () => {
      eq(DynamicFeeMath.imbalanceFee(bn('5000000000'), bn('3000000000'), bn(30), bn(20), false), 15)
    })
    it('direction base-heavy: sell charges, buy free', () => {
      expect(num(DynamicFeeMath.imbalanceFee(bn(800), bn(200), bn(50), bn(10), false))).toBeGreaterThan(0)
      eq(DynamicFeeMath.imbalanceFee(bn(800), bn(200), bn(50), bn(10), true), 0)
    })
    it('direction quote-heavy: buy charges, sell free', () => {
      expect(num(DynamicFeeMath.imbalanceFee(bn(200), bn(800), bn(50), bn(10), true))).toBeGreaterThan(0)
      eq(DynamicFeeMath.imbalanceFee(bn(200), bn(800), bn(50), bn(10), false), 0)
    })
    it('known precision 700/300 base 50 x10 -> 150', () => {
      eq(DynamicFeeMath.imbalanceFee(bn(700), bn(300), bn(50), bn(10), false), 150)
    })
  })

  describe('calcTotal (aggregation + clamp to maxRate)', () => {
    const MAX_DEFAULT = bn(999999) // default cap (= 1e6 - 1, i.e. what the caller resolves the 0 sentinel to)
    it('1% dev + slip + no imb (below the cap -> untouched)', () => {
      // arb=9000, slip=10, imb=0, feeBase=1000
      const r = DynamicFeeMath.calcTotal(bn(9000), bn(10), bn(0), bn(1000), MAX_DEFAULT)
      eq(r.arbF, 9000)
      eq(r.slipF, 10)
      eq(r.imbF, 0)
      eq(r.swapDyn, 9010)
      eq(r.total, 10010)
    })
    it('all zero except base', () => {
      const r = DynamicFeeMath.calcTotal(bn(0), bn(0), bn(0), bn(5000), MAX_DEFAULT)
      eq(r.swapDyn, 0)
      eq(r.total, 5000)
    })
    it('total above the default cap -> clamped to 999999 (replaces the old DFCAP revert)', () => {
      // total=1e6 used to revert, it now clamps to 999999 and trades
      let r = DynamicFeeMath.calcTotal(bn(1000000), bn(0), bn(0), bn(0), MAX_DEFAULT)
      eq(r.total, 999999)
      r = DynamicFeeMath.calcTotal(bn(999999), bn(0), bn(0), bn(1), MAX_DEFAULT) // raw sum = 1e6
      eq(r.total, 999999)
    })
    it('total == 999999 exactly at the cap -> untouched', () => {
      const r = DynamicFeeMath.calcTotal(bn(999999), bn(0), bn(0), bn(0), MAX_DEFAULT)
      eq(r.total, 999999)
    })
    it('custom low cap -> total clamped to it; components keep their raw values (diagnostics)', () => {
      // raw sum = 9000+10+1000 = 10010 > cap 5000 -> total=5000; arb/slip/swapDyn stay raw
      const r = DynamicFeeMath.calcTotal(bn(9000), bn(10), bn(0), bn(1000), bn(5000))
      eq(r.arbF, 9000)
      eq(r.slipF, 10)
      eq(r.swapDyn, 9010)
      eq(r.total, 5000)
    })
    it('base floor: cap < base -> total=base (keeps the total>=base invariant)', () => {
      // feeBase=5000, cap=3000 -> clamped to 3000, then floored back at base -> 5000
      const r = DynamicFeeMath.calcTotal(bn(0), bn(0), bn(0), bn(5000), bn(3000))
      eq(r.total, 5000)
    })
    it('huge arb above uint24 -> components saturate, total clamps (no truncation bypass, no revert)', () => {
      // arb = 20_000_000 (> uint24 max 16_777_215): components saturate at 16777215, total clamps to the cap,
      // never wrapping around into a small value
      const r = DynamicFeeMath.calcTotal(bn(20000000), bn(0), bn(0), bn(0), MAX_DEFAULT)
      eq(r.arbF, 16777215) // saturated at the uint24 bound
      eq(r.swapDyn, 16777215)
      eq(r.total, 999999) // clamped to the cap, not a truncated small value
    })
  })

  describe('priceFromSqrtPriceX96', () => {
    it('sqrtP=Q96 -> price=Q96 (price 1)', () => {
      eq(DynamicFeeMath.priceFromSqrtPriceX96(Q96), Q96)
    })
    it('sqrtP=2*Q96 -> 4*Q96 (price 4)', () => {
      eq(DynamicFeeMath.priceFromSqrtPriceX96(JSBI.multiply(Q96, bn(2))), JSBI.multiply(Q96, bn(4)))
    })
    it('extremely low price sqrtP in [2^32,2^48) -> p0X96 == 0 (truncation)', () => {
      eq(DynamicFeeMath.priceFromSqrtPriceX96(pow(2, 40)), 0)
    })
    it('sqrtP=2^48 boundary -> > 0', () => {
      // mulDiv(2^48, 2^48, 2^96) = 2^96 / 2^96 = 1 -> exactly non-zero
      expect(JSBI.greaterThan(DynamicFeeMath.priceFromSqrtPriceX96(pow(2, 48)), bn(0))).toEqual(true)
    })
  })

  describe('quoteAmountFromBase', () => {
    it('price 1, base 100, quote=token1 -> 100', () => {
      eq(DynamicFeeMath.quoteAmountFromBase(bn(100), Q96, true), 100)
    })
    it('price 2, base 100, quote=token1 -> 200', () => {
      eq(DynamicFeeMath.quoteAmountFromBase(bn(100), JSBI.multiply(Q96, bn(2)), true), 200)
    })
    it('price 2, base 100, quote=token0 -> 50', () => {
      eq(DynamicFeeMath.quoteAmountFromBase(bn(100), JSBI.multiply(Q96, bn(2)), false), 50)
    })
    it('price 0 reverts', () => {
      expect(() => DynamicFeeMath.quoteAmountFromBase(bn(100), bn(0), true)).toThrow('PX0')
    })
  })

  describe('normalizeTradeSize', () => {
    it('250e6 / 10^6 -> 250', () => {
      eq(DynamicFeeMath.normalizeTradeSize(bn(250000000), pow(10, 6)), 250)
    })
    it('250 / 10^0 -> 250', () => {
      eq(DynamicFeeMath.normalizeTradeSize(bn(250), bn(1)), 250)
    })
    it('1e9 / 10^9 -> 1', () => {
      eq(DynamicFeeMath.normalizeTradeSize(pow(10, 9), pow(10, 9)), 1)
    })
    it('999999 / 10^6 -> 0 (truncates)', () => {
      eq(DynamicFeeMath.normalizeTradeSize(bn(999999), pow(10, 6)), 0)
    })
    it('1.5e6 / 10^6 -> 1 (truncates)', () => {
      eq(DynamicFeeMath.normalizeTradeSize(bn(1500000), pow(10, 6)), 1)
    })
  })

  describe('sqrt (floor Babylonian, matches integer_sqrt_u128)', () => {
    for (const [x, r] of [
      [0, 0],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 2],
      [5, 2],
      [9, 3],
      [10, 3],
      [100, 10],
      [1000000, 1000]
    ]) {
      it(`sqrt(${x}) == ${r}`, () => {
        eq(DynamicFeeMath.sqrt(bn(x)), r)
      })
    }
    it('sqrt(10^12) == 10^6', () => {
      eq(DynamicFeeMath.sqrt(pow(10, 12)), 1000000)
    })
    it('sqrt(10^30) == 10^15 and floor(10^30+1)==10^15', () => {
      eq(DynamicFeeMath.sqrt(pow(10, 30)), pow(10, 15))
      eq(DynamicFeeMath.sqrt(JSBI.add(pow(10, 30), bn(1))), pow(10, 15))
    })
    it('near-uint256-max does not overflow (robust seed)', () => {
      const big = pow(2, 255)
      const s = DynamicFeeMath.sqrt(big)
      // floor(sqrt(2^255)) = 2^127 (2^255 = (2^127)^2 * 2, sqrt ~ 2^127.5)
      expect(JSBI.lessThanOrEqual(JSBI.multiply(s, s), big)).toEqual(true)
      expect(JSBI.greaterThan(JSBI.multiply(JSBI.add(s, bn(1)), JSBI.add(s, bn(1))), big)).toEqual(true)
    })
  })

  describe('computePIndexX96 (EVM-only: conversion + fail-soft)', () => {
    it('netExp=0 (pow10=1): answer0=answer1 -> pIndex=Q96 (price 1)', () => {
      const { pIndexX96Out: p, ok } = DynamicFeeMath.computePIndexX96(bn(100), bn(100), bn(1), false)
      expect(ok).toEqual(true)
      eq(p, Q96)
    })
    it('netExp>=0: answer0=200 answer1=100 pow10=1 -> 2*Q96', () => {
      const { pIndexX96Out: p, ok } = DynamicFeeMath.computePIndexX96(bn(200), bn(100), bn(1), false)
      expect(ok).toEqual(true)
      eq(p, JSBI.multiply(Q96, bn(2)))
    })
    it('netExp>=0 with pow10=100: answer0=1 answer1=1 -> 100*Q96', () => {
      const { pIndexX96Out: p, ok } = DynamicFeeMath.computePIndexX96(bn(1), bn(1), bn(100), false)
      expect(ok).toEqual(true)
      eq(p, JSBI.multiply(Q96, bn(100)))
    })
    it('netExp<0 pow10=100: answer0=100 answer1=1 -> (100/100)*Q96 = Q96', () => {
      const { pIndexX96Out: p, ok } = DynamicFeeMath.computePIndexX96(bn(100), bn(1), bn(100), true)
      expect(ok).toEqual(true)
      eq(p, Q96)
    })
    it('netExp<0 denominator overflow pre-check -> fail-soft (ok=false, no revert)', () => {
      const max = JSBI.subtract(pow(2, 256), bn(1))
      // answer1 * 1000 overflows
      const { pIndexX96Out: p, ok } = DynamicFeeMath.computePIndexX96(bn(1), max, bn(1000), true)
      expect(ok).toEqual(false)
      eq(p, 0)
    })
    it('pIndex==0 truncation -> fail-soft (ok=false)', () => {
      // tiny answer0, pow10=1, huge answer1 -> mulDiv(answer0, Q96, answer1) floors to 0
      const { pIndexX96Out: p, ok } = DynamicFeeMath.computePIndexX96(bn(1), pow(2, 200), bn(1), false)
      expect(ok).toEqual(false)
      eq(p, 0)
    })

    // The two result-overflow pre-checks added at contract HEAD 91b704e. Without them these inputs made
    // `mulDiv` revert, and a revert inside the pool's oracle read is a swap DoS rather than a skipped
    // arbitrage term. Both bounds are on the *product*, so they are conservative by design.
    describe('result-overflow pre-checks (HEAD 91b704e)', () => {
      const MAX_UINT256 = JSBI.subtract(pow(2, 256), bn(1))
      const MAX_UINT128 = JSBI.subtract(pow(2, 128), bn(1))

      it('!negExp: answer0 * (pow10 << 96) over uint256 -> fail-soft instead of MULDIV_OVERFLOW', () => {
        const pow10Q96 = JSBI.multiply(MAX_UINT128, Q96)
        const threshold = JSBI.divide(MAX_UINT256, pow10Q96)
        const { pIndexX96Out: p, ok } = DynamicFeeMath.computePIndexX96(
          JSBI.add(threshold, bn(1)),
          bn(1),
          MAX_UINT128,
          false
        )
        expect(ok).toEqual(false)
        eq(p, 0)
      })

      it('!negExp: exactly at the bound still computes', () => {
        const threshold = JSBI.divide(MAX_UINT256, JSBI.multiply(MAX_UINT128, Q96))
        const { ok } = DynamicFeeMath.computePIndexX96(threshold, bn(1), MAX_UINT128, false)
        expect(ok).toEqual(true)
      })

      // `pow10Q96 != 0` in the solidity guard is pure division defence: pow10 is >= 1 whenever arbitrage runs.
      it('!negExp: pow10 == 0 does not divide by zero, it just truncates to 0', () => {
        const { pIndexX96Out: p, ok } = DynamicFeeMath.computePIndexX96(bn(100), bn(1), bn(0), false)
        expect(ok).toEqual(false)
        eq(p, 0)
      })

      it('negExp: answer0 * Q96 over uint256 -> fail-soft instead of MULDIV_OVERFLOW', () => {
        const { pIndexX96Out: p, ok } = DynamicFeeMath.computePIndexX96(MAX_UINT256, bn(1), bn(1), true)
        expect(ok).toEqual(false)
        eq(p, 0)
      })

      it('negExp: exactly at the bound still computes', () => {
        const threshold = JSBI.divide(MAX_UINT256, Q96)
        const { ok } = DynamicFeeMath.computePIndexX96(threshold, bn(1), bn(1), true)
        expect(ok).toEqual(true)
      })

      it('negExp: the denominator check still fires first when both would', () => {
        const { pIndexX96Out: p, ok } = DynamicFeeMath.computePIndexX96(MAX_UINT256, MAX_UINT256, bn(1000), true)
        expect(ok).toEqual(false)
        eq(p, 0)
      })
    })
  })
})

// SDK-only helper (no contract vector): mirrors the caller-side sentinel line in `PoolSwapV1._computeDynamicFeeRate`,
// `uint256 cap = maxDynamicFeeRate == 0 ? FEE_RATE_DENOMINATOR - 1 : maxDynamicFeeRate`.
describe('resolveMaxDynamicFeeRate', () => {
  const eq = (actual: JSBI, expected: number | string) => expect(actual.toString()).toEqual(String(expected))

  it('resolves the 0 sentinel to the default ceiling 1e6 - 1', () => {
    eq(resolveMaxDynamicFeeRate(0), 999999)
    eq(resolveMaxDynamicFeeRate(JSBI.BigInt(0)), 999999)
  })

  it('passes any configured value through unchanged', () => {
    eq(resolveMaxDynamicFeeRate(1), 1)
    eq(resolveMaxDynamicFeeRate(5000), 5000)
    eq(resolveMaxDynamicFeeRate(999999), 999999)
  })

  it('rejects values the uint24 slot could never hold', () => {
    // the pool's own 'DFMAX' bound is tighter (<= 999999); this is only the type-width guard
    expect(() => resolveMaxDynamicFeeRate(16777216)).toThrow('UINT24')
    expect(() => resolveMaxDynamicFeeRate(-1)).toThrow('UINT24')
  })
})
