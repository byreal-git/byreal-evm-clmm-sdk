import JSBI from 'jsbi'
import { CurrencyAmount, Token, WETH9 } from '../core/index.js'
import { ExtraFeeClass } from '../constants.js'
import { NEGATIVE_ONE } from '../internalConstants.js'
import { encodeSqrtRatioX96 } from '../utils/encodeSqrtRatioX96.js'
import { nearestUsableTick } from '../utils/nearestUsableTick.js'
import { TickMath } from '../utils/tickMath.js'
import { Pool } from './pool.js'

// This SDK ships no address book, so the fixtures register their own wrapped native tokens.
WETH9[1] = new Token(1, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18, 'WETH', 'Wrapped Ether')
WETH9[3] = new Token(3, '0xc778417E063141139Fce010982780140Aa0cD5Ab', 18, 'WETH', 'Wrapped Ether')

const ONE_ETHER = JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(18))

// Reused pool parameter pairs: (1, 100), (10, 500), (60, 3000), and (200, 10000).
describe('Pool', () => {
  const USDC = new Token(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, 'USDC', 'USD Coin')
  const DAI = new Token(1, '0x6B175474E89094C44Da98b954EedeAC495271d0F', 18, 'DAI', 'DAI Stablecoin')

  describe('constructor', () => {
    it('cannot be used for tokens on different chains', () => {
      expect(() => {
        new Pool(USDC, WETH9[3], 60, 3000, encodeSqrtRatioX96(1, 1), 0, 0, [])
      }).toThrow('CHAIN_IDS')
    })

    it('fee must be integer', () => {
      expect(() => {
        new Pool(USDC, WETH9[1], 60, 3000.5, encodeSqrtRatioX96(1, 1), 0, 0, [])
      }).toThrow('FEE')
    })

    it('fee cannot be negative', () => {
      expect(() => {
        new Pool(USDC, WETH9[1], 60, -1, encodeSqrtRatioX96(1, 1), 0, 0, [])
      }).toThrow('FEE')
    })

    it('fee of exactly 999999 is allowed (MAX_TRADE_FEE_RATE is inclusive)', () => {
      const pool = new Pool(USDC, WETH9[1], 60, 999_999, encodeSqrtRatioX96(1, 1), 0, 0, [])
      expect(pool.tradeFeeRate).toEqual(999_999)
    })

    it('fee cannot reach 1e6 (the pool would divide by `1e6 - feePips == 0`, revert TFR)', () => {
      expect(() => {
        new Pool(USDC, WETH9[1], 60, 1e6, encodeSqrtRatioX96(1, 1), 0, 0, [])
      }).toThrow('FEE')
      expect(() => {
        new Pool(USDC, WETH9[1], 60, 1e6 + 1, encodeSqrtRatioX96(1, 1), 0, 0, [])
      }).toThrow('FEE')
    })

    it('rejects tick spacings that TickSpacing.sol rejects', () => {
      // 0 / negative / >= 16384 are out of the hard bounds; 7 and 9 are odd in the 6..10 band;
      // 15 is not a multiple of 10 above 10; 1.5 is not encodable as int24
      for (const tickSpacing of [0, -1, 16384, 7, 9, 15, 1.5]) {
        expect(() => {
          new Pool(USDC, WETH9[1], tickSpacing, 3000, encodeSqrtRatioX96(1, 1), 0, 0, [])
        }).toThrow('TICK_SPACING')
      }
    })

    it('accepts tick spacings that TickSpacing.sol accepts', () => {
      for (const tickSpacing of [1, 2, 5, 6, 8, 10, 20, 60, 200, 16380]) {
        const pool = new Pool(USDC, WETH9[1], tickSpacing, 3000, encodeSqrtRatioX96(1, 1), 0, 0, [])
        expect(pool.tickSpacing).toEqual(tickSpacing)
      }
    })

    it('cannot be given two of the same token', () => {
      expect(() => {
        new Pool(USDC, USDC, 60, 3000, encodeSqrtRatioX96(1, 1), 0, 0, [])
      }).toThrow('ADDRESSES')
    })

    it('price must be within tick price bounds', () => {
      expect(() => {
        new Pool(USDC, WETH9[1], 60, 3000, encodeSqrtRatioX96(1, 1), 0, 1, [])
      }).toThrow('PRICE_BOUNDS')
      expect(() => {
        new Pool(USDC, WETH9[1], 60, 3000, JSBI.add(encodeSqrtRatioX96(1, 1), JSBI.BigInt(1)), 0, -1, [])
      }).toThrow('PRICE_BOUNDS')
    })

    it('works with valid arguments for empty pool medium fee', () => {
      new Pool(USDC, WETH9[1], 60, 3000, encodeSqrtRatioX96(1, 1), 0, 0, [])
    })

    it('works with valid arguments for empty pool low fee', () => {
      new Pool(USDC, WETH9[1], 10, 500, encodeSqrtRatioX96(1, 1), 0, 0, [])
    })

    it('works with valid arguments for empty pool lowest fee', () => {
      new Pool(USDC, WETH9[1], 1, 100, encodeSqrtRatioX96(1, 1), 0, 0, [])
    })

    it('works with valid arguments for empty pool high fee', () => {
      new Pool(USDC, WETH9[1], 200, 10000, encodeSqrtRatioX96(1, 1), 0, 0, [])
    })

    it('defaults extra to an empty state', () => {
      expect(new Pool(USDC, WETH9[1], 60, 3000, encodeSqrtRatioX96(1, 1), 0, 0, []).extra).toEqual({})
    })

    it('keeps the extra state it was given', () => {
      const extra = { protocolFeeRate: 25, pauseFlags: 1, alphaExtraTradeFeeRate: 10_000 }
      expect(new Pool(USDC, WETH9[1], 60, 3000, encodeSqrtRatioX96(1, 1), 0, 0, [], extra).extra).toEqual(extra)
    })
  })

  // `extra` is a snapshot of mutable on-chain state; the Pool must own it outright, and must refuse values the
  // pool itself could never hold (a rate above 1e6 would make the exact-in pre-deduction exceed the input)
  describe('extra state validation', () => {
    const build = (extra: object) => new Pool(USDC, WETH9[1], 60, 3000, encodeSqrtRatioX96(1, 1), 0, 0, [], extra)

    it('accepts every field at both ends of its range', () => {
      const extra = {
        protocolFeeRate: 100,
        pauseFlags: 31,
        swapOpenTime: 4_294_967_295,
        alphaExtraTradeFeeRate: 1_000_000,
        dexExtraTradeFeeRate: 0,
        dynamicFeeEnabled: true
      }
      expect(build(extra).extra).toEqual(extra)
      expect(build({ protocolFeeRate: 0, pauseFlags: 0, swapOpenTime: 0 }).extra).toEqual({
        protocolFeeRate: 0,
        pauseFlags: 0,
        swapOpenTime: 0
      })
    })

    // [field, bad values, error code]
    const matrix: [string, unknown[], string][] = [
      ['protocolFeeRate', [-1, 101, 2.5, 1e6, NaN], 'EXTRA_PROTOCOL_FEE_RATE'],
      ['pauseFlags', [-1, 32, 1.5, NaN], 'EXTRA_PAUSE_FLAGS'],
      ['swapOpenTime', [-1, 4_294_967_296, 1.5, NaN], 'EXTRA_SWAP_OPEN_TIME'],
      ['alphaExtraTradeFeeRate', [-1, 1_000_001, 0.5, NaN], 'EXTRA_ALPHA_FEE_RATE'],
      ['dexExtraTradeFeeRate', [-1, 1_000_001, 0.5, NaN], 'EXTRA_DEX_FEE_RATE'],
      ['dynamicFeeEnabled', [1, 0, 'true', null], 'EXTRA_DYNAMIC_FEE']
    ]

    for (const [field, badValues, code] of matrix) {
      it(`rejects an out-of-range ${field}`, () => {
        for (const value of badValues) {
          expect(() => build({ [field]: value }), `${field} = ${String(value)}`).toThrow(code)
        }
      })
    }

    it('copies and freezes the state, so later mutation of the caller object changes nothing', async () => {
      const extra: { alphaExtraTradeFeeRate?: number } = { alphaExtraTradeFeeRate: 0 }
      const pool = new Pool(USDC, DAI, 10, 500, encodeSqrtRatioX96(1, 1), ONE_ETHER, 0, [], extra)

      expect(pool.extra).not.toBe(extra)
      expect(Object.isFrozen(pool.extra)).toBe(true)

      // a 100% alpha rate would zero out every alpha quote — but only if the Pool had kept the reference
      extra.alphaExtraTradeFeeRate = 1_000_000
      expect(pool.extra.alphaExtraTradeFeeRate).toEqual(0)
      // and the frozen copy itself cannot be written through either
      expect(() => {
        ;(pool.extra as { alphaExtraTradeFeeRate?: number }).alphaExtraTradeFeeRate = 1_000_000
      }).toThrow()
    })

    it('pins the extra property itself — rebinding it cannot disarm the dynamic-fee gate', async () => {
      const pool = new Pool(USDC, DAI, 10, 500, encodeSqrtRatioX96(1, 1), ONE_ETHER, 0, [], {
        dynamicFeeEnabled: true
      })
      // plain-JS reassignment of the whole property must fail (TS readonly alone would not stop it)
      expect(() => {
        ;(pool as any).extra = { dynamicFeeEnabled: false }
      }).toThrow(TypeError)
      // and the fail-closed gate is still armed afterwards
      await expect(
        pool.getOutputAmount(CurrencyAmount.fromRawAmount(USDC, 100), undefined, ExtraFeeClass.ALPHA)
      ).rejects.toThrow('DYNAMIC_FEE')
    })
  })

  describe('#getAddress', () => {
    // golden from `computePoolAddress.test.ts` (derived independently with viem)
    const factoryAddress = '0x1111111111111111111111111111111111111111'
    const initCodeHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'

    it('matches an example', () => {
      const result = Pool.getAddress(USDC, DAI, 10, initCodeHash, factoryAddress)
      expect(result).toEqual('0xFD12b9dc4128C561e729Fa4ce1ff05dB8b5516ed')
    })

    it('is keyed by tickSpacing, not by the fee', () => {
      expect(Pool.getAddress(USDC, DAI, 60, initCodeHash, factoryAddress)).toEqual(
        '0x2F8ac3CAb950fbb7094FC641cB82Fb8265661Fe5'
      )
    })
  })

  describe('#token0', () => {
    it('always is the token that sorts before', () => {
      let pool = new Pool(USDC, DAI, 10, 500, encodeSqrtRatioX96(1, 1), 0, 0, [])
      expect(pool.token0).toEqual(DAI)
      pool = new Pool(DAI, USDC, 10, 500, encodeSqrtRatioX96(1, 1), 0, 0, [])
      expect(pool.token0).toEqual(DAI)
    })
  })
  describe('#token1', () => {
    it('always is the token that sorts after', () => {
      let pool = new Pool(USDC, DAI, 10, 500, encodeSqrtRatioX96(1, 1), 0, 0, [])
      expect(pool.token1).toEqual(USDC)
      pool = new Pool(DAI, USDC, 10, 500, encodeSqrtRatioX96(1, 1), 0, 0, [])
      expect(pool.token1).toEqual(USDC)
    })
  })

  describe('#token0Price', () => {
    it('returns price of token0 in terms of token1', () => {
      expect(
        new Pool(
          USDC,
          DAI,
          10,
          500,
          encodeSqrtRatioX96(101e6, 100e18),
          0,
          TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(101e6, 100e18)),
          []
        ).token0Price.toSignificant(5)
      ).toEqual('1.01')
      expect(
        new Pool(
          DAI,
          USDC,
          10,
          500,
          encodeSqrtRatioX96(101e6, 100e18),
          0,
          TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(101e6, 100e18)),
          []
        ).token0Price.toSignificant(5)
      ).toEqual('1.01')
    })
  })

  describe('#token1Price', () => {
    it('returns price of token1 in terms of token0', () => {
      expect(
        new Pool(
          USDC,
          DAI,
          10,
          500,
          encodeSqrtRatioX96(101e6, 100e18),
          0,
          TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(101e6, 100e18)),
          []
        ).token1Price.toSignificant(5)
      ).toEqual('0.9901')
      expect(
        new Pool(
          DAI,
          USDC,
          10,
          500,
          encodeSqrtRatioX96(101e6, 100e18),
          0,
          TickMath.getTickAtSqrtRatio(encodeSqrtRatioX96(101e6, 100e18)),
          []
        ).token1Price.toSignificant(5)
      ).toEqual('0.9901')
    })
  })

  describe('#priceOf', () => {
    const pool = new Pool(USDC, DAI, 10, 500, encodeSqrtRatioX96(1, 1), 0, 0, [])
    it('returns price of token in terms of other token', () => {
      expect(pool.priceOf(DAI)).toEqual(pool.token0Price)
      expect(pool.priceOf(USDC)).toEqual(pool.token1Price)
    })

    it('throws if invalid token', () => {
      expect(() => pool.priceOf(WETH9[1])).toThrow('TOKEN')
    })
  })

  describe('#chainId', () => {
    it('returns the token0 chainId', () => {
      let pool = new Pool(USDC, DAI, 10, 500, encodeSqrtRatioX96(1, 1), 0, 0, [])
      expect(pool.chainId).toEqual(1)
      pool = new Pool(DAI, USDC, 10, 500, encodeSqrtRatioX96(1, 1), 0, 0, [])
      expect(pool.chainId).toEqual(1)
    })
  })

  describe('#involvesToken', () => {
    // Assertions must live inside a test so Vitest executes them.
    it('is true exactly for token0 and token1', () => {
      const pool = new Pool(USDC, DAI, 10, 500, encodeSqrtRatioX96(1, 1), 0, 0, [])
      expect(pool.involvesToken(USDC)).toEqual(true)
      expect(pool.involvesToken(DAI)).toEqual(true)
      expect(pool.involvesToken(WETH9[1])).toEqual(false)
    })
  })

  describe('swaps', () => {
    let pool: Pool

    beforeEach(() => {
      pool = new Pool(USDC, DAI, 10, 500, encodeSqrtRatioX96(1, 1), ONE_ETHER, 0, [
        {
          index: nearestUsableTick(TickMath.MIN_TICK, 10),
          liquidityNet: ONE_ETHER,
          liquidityGross: ONE_ETHER
        },
        {
          index: nearestUsableTick(TickMath.MAX_TICK, 10),
          liquidityNet: JSBI.multiply(ONE_ETHER, NEGATIVE_ONE),
          liquidityGross: ONE_ETHER
        }
      ])
    })

    describe('#getOutputAmount', () => {
      it('USDC -> DAI', async () => {
        const inputAmount = CurrencyAmount.fromRawAmount(USDC, 100)
        const [outputAmount] = await pool.getOutputAmount(inputAmount, undefined, ExtraFeeClass.ALPHA)
        expect(outputAmount.currency.equals(DAI)).toBe(true)
        expect(outputAmount.quotient).toEqual(JSBI.BigInt(98))
      })

      it('DAI -> USDC', async () => {
        const inputAmount = CurrencyAmount.fromRawAmount(DAI, 100)
        const [outputAmount] = await pool.getOutputAmount(inputAmount, undefined, ExtraFeeClass.ALPHA)
        expect(outputAmount.currency.equals(USDC)).toBe(true)
        expect(outputAmount.quotient).toEqual(JSBI.BigInt(98))
      })

      it('carries tickSpacing / tradeFeeRate / extra over to the returned pool', async () => {
        const extra = { alphaExtraTradeFeeRate: 10_000, dynamicFeeEnabled: false }
        const withExtra = new Pool(
          USDC,
          DAI,
          10,
          500,
          encodeSqrtRatioX96(1, 1),
          ONE_ETHER,
          0,
          pool.tickDataProvider,
          extra
        )
        const [, next] = await withExtra.getOutputAmount(
          CurrencyAmount.fromRawAmount(USDC, 100),
          undefined,
          ExtraFeeClass.ALPHA
        )
        expect(next.tickSpacing).toEqual(10)
        expect(next.tradeFeeRate).toEqual(500)
        // value-identical, but its own frozen copy — never the caller's object
        expect(next.extra).toEqual(extra)
        expect(next.extra).not.toBe(extra)
      })
    })

    describe('#getInputAmount', () => {
      it('USDC -> DAI', async () => {
        const outputAmount = CurrencyAmount.fromRawAmount(DAI, 98)
        const [inputAmount] = await pool.getInputAmount(outputAmount, undefined, ExtraFeeClass.ALPHA)
        expect(inputAmount.currency.equals(USDC)).toBe(true)
        expect(inputAmount.quotient).toEqual(JSBI.BigInt(100))
      })

      it('DAI -> USDC', async () => {
        const outputAmount = CurrencyAmount.fromRawAmount(USDC, 98)
        const [inputAmount] = await pool.getInputAmount(outputAmount, undefined, ExtraFeeClass.ALPHA)
        expect(inputAmount.currency.equals(DAI)).toBe(true)
        expect(inputAmount.quotient).toEqual(JSBI.BigInt(100))
      })
    })

    // PoolSwapV1.sol:136 `require(amountSpecified != 0, 'AS')` — the offline quote refuses what the pool refuses
    describe('amount', () => {
      it('rejects a zero exact-in amount', async () => {
        await expect(
          pool.getOutputAmount(CurrencyAmount.fromRawAmount(USDC, 0), undefined, ExtraFeeClass.ALPHA)
        ).rejects.toThrow('AMOUNT')
      })

      it('rejects a zero exact-out amount', async () => {
        await expect(
          pool.getInputAmount(CurrencyAmount.fromRawAmount(DAI, 0), undefined, ExtraFeeClass.ALPHA)
        ).rejects.toThrow('AMOUNT')
      })

      it('accepts 1 wei on both sides', async () => {
        const [out] = await pool.getOutputAmount(CurrencyAmount.fromRawAmount(USDC, 1), undefined, ExtraFeeClass.ALPHA)
        expect(out.quotient).toEqual(JSBI.BigInt(0))
        const [inp] = await pool.getInputAmount(CurrencyAmount.fromRawAmount(DAI, 1), undefined, ExtraFeeClass.ALPHA)
        expect(inp.quotient).toEqual(JSBI.BigInt(3))
      })

      it('checks the token before the amount', async () => {
        await expect(
          pool.getOutputAmount(CurrencyAmount.fromRawAmount(WETH9[1], 0), undefined, ExtraFeeClass.ALPHA)
        ).rejects.toThrow('TOKEN')
      })
    })
  })

  // PoolSwapV1.sol:
  //   exact-in  L168-169: extraFee = FullMath.mulDiv(amountSpecified, rate, 1e6)          (floor)
  //             L175:     the curve is seeded with amountSpecified - extraFee
  //   exact-out L287-288: extraFee = FullMath.mulDiv(state.amountCalculated, rate, 1e6)   (floor)
  //             L358-360: extraFee is added to the reported token-in amount
  describe('extra trade fee', () => {
    // 1% alpha, 0.3% dex
    const extra = { alphaExtraTradeFeeRate: 10_000, dexExtraTradeFeeRate: 3_000 }
    const ticks = [
      {
        index: nearestUsableTick(TickMath.MIN_TICK, 10),
        liquidityNet: ONE_ETHER,
        liquidityGross: ONE_ETHER
      },
      {
        index: nearestUsableTick(TickMath.MAX_TICK, 10),
        liquidityNet: JSBI.multiply(ONE_ETHER, NEGATIVE_ONE),
        liquidityGross: ONE_ETHER
      }
    ]
    const makePool = (state: object = extra) =>
      new Pool(USDC, DAI, 10, 500, encodeSqrtRatioX96(1, 1), ONE_ETHER, 0, ticks, state)

    const pool = makePool()
    const plain = makePool({})

    describe('exact-in (pre-deducted, curve eats the net amount)', () => {
      it('alpha: 1e6 in loses 10000 to the fee before the curve', async () => {
        const [outputAmount] = await pool.getOutputAmount(
          CurrencyAmount.fromRawAmount(USDC, 1_000_000),
          undefined,
          ExtraFeeClass.ALPHA
        )
        // floor(1_000_000 * 10_000 / 1e6) = 10_000 -> the curve is fed 990_000
        expect(outputAmount.quotient).toEqual(JSBI.BigInt(989504))
        const [reference] = await plain.getOutputAmount(
          CurrencyAmount.fromRawAmount(USDC, 990_000),
          undefined,
          ExtraFeeClass.ALPHA
        )
        expect(outputAmount.quotient).toEqual(reference.quotient)
      })

      it('dex: 1e6 in loses 3000 to the fee before the curve', async () => {
        const [outputAmount] = await pool.getOutputAmount(
          CurrencyAmount.fromRawAmount(USDC, 1_000_000),
          undefined,
          ExtraFeeClass.DEX
        )
        // floor(1_000_000 * 3_000 / 1e6) = 3_000 -> the curve is fed 997_000
        expect(outputAmount.quotient).toEqual(JSBI.BigInt(996500))
        const [reference] = await plain.getOutputAmount(
          CurrencyAmount.fromRawAmount(USDC, 997_000),
          undefined,
          ExtraFeeClass.ALPHA
        )
        expect(outputAmount.quotient).toEqual(reference.quotient)
      })

      // Pool logic v1.1 (91b704e) skims `FullMath.mulDivRoundingUp`, so a sub-wei fee still costs 1 wei.
      it('rounds the fee up: ceil(99 * 1%) = 1, so only 98 reaches the curve', async () => {
        const [outputAmount] = await pool.getOutputAmount(
          CurrencyAmount.fromRawAmount(USDC, 99),
          undefined,
          ExtraFeeClass.ALPHA
        )
        const [reference] = await plain.getOutputAmount(
          CurrencyAmount.fromRawAmount(USDC, 98),
          undefined,
          ExtraFeeClass.ALPHA
        )
        expect(outputAmount.quotient).toEqual(JSBI.BigInt(96))
        expect(outputAmount.quotient).toEqual(reference.quotient)
      })

      it('is a no-op when the selected bucket has rate 0', async () => {
        const [withRate0] = await plain.getOutputAmount(
          CurrencyAmount.fromRawAmount(USDC, 1_000_000),
          undefined,
          ExtraFeeClass.ALPHA
        )
        // an unconfigured bucket is rate 0, which is the curve-only quote — but it still had to be named
        expect(withRate0.quotient).toEqual(JSBI.BigInt(999499))
      })

      // The contract guards the multiplication with `extraFeeRate > 0`, so ceil must NOT turn a dormant
      // bucket into a 1 wei fee.
      it('rate 0 stays 0 — ceil never invents a fee', async () => {
        const dormant = makePool({ alphaExtraTradeFeeRate: 0 })
        const [outputAmount] = await dormant.getOutputAmount(
          CurrencyAmount.fromRawAmount(USDC, 99),
          undefined,
          ExtraFeeClass.ALPHA
        )
        const [reference] = await plain.getOutputAmount(
          CurrencyAmount.fromRawAmount(USDC, 99),
          undefined,
          ExtraFeeClass.ALPHA
        )
        expect(outputAmount.quotient).toEqual(reference.quotient)
      })

      it('a 100% rate skims everything and the curve is never entered', async () => {
        const all = makePool({ alphaExtraTradeFeeRate: 1_000_000 })
        const [outputAmount, next] = await all.getOutputAmount(
          CurrencyAmount.fromRawAmount(USDC, 1_000_000),
          undefined,
          ExtraFeeClass.ALPHA
        )
        expect(outputAmount.quotient).toEqual(JSBI.BigInt(0))
        expect(next.sqrtRatioX96).toEqual(all.sqrtRatioX96)
        expect(next.tickCurrent).toEqual(all.tickCurrent)
      })

      it('applies to the DAI -> USDC direction too', async () => {
        const [outputAmount] = await pool.getOutputAmount(
          CurrencyAmount.fromRawAmount(DAI, 1_000_000),
          undefined,
          ExtraFeeClass.ALPHA
        )
        const [reference] = await plain.getOutputAmount(
          CurrencyAmount.fromRawAmount(DAI, 990_000),
          undefined,
          ExtraFeeClass.ALPHA
        )
        expect(outputAmount.quotient).toEqual(reference.quotient)
      })
    })

    describe('exact-out (surcharged on the curve input)', () => {
      it('alpha: the curve needs 1000502, the fee adds ceil(1000502 * 1%) = 10006', async () => {
        const [inputAmount] = await pool.getInputAmount(
          CurrencyAmount.fromRawAmount(DAI, 1_000_000),
          undefined,
          ExtraFeeClass.ALPHA
        )
        const [curveOnly] = await plain.getInputAmount(
          CurrencyAmount.fromRawAmount(DAI, 1_000_000),
          undefined,
          ExtraFeeClass.ALPHA
        )
        expect(curveOnly.quotient).toEqual(JSBI.BigInt(1000502))
        // 1000502 * 10000 / 1e6 = 10005.02 -> ceil -> 10006
        expect(inputAmount.quotient).toEqual(JSBI.BigInt(1010508))
      })

      it('dex: ceil(1000502 * 0.3%) = 3002', async () => {
        const [inputAmount] = await pool.getInputAmount(
          CurrencyAmount.fromRawAmount(DAI, 1_000_000),
          undefined,
          ExtraFeeClass.DEX
        )
        // 1000502 * 3000 / 1e6 = 3001.506 -> ceil -> 3002
        expect(inputAmount.quotient).toEqual(JSBI.BigInt(1003504))
      })

      it('rounds the fee up: ceil(100 * 0.3%) = 1, so the input gains a wei', async () => {
        const [inputAmount] = await pool.getInputAmount(
          CurrencyAmount.fromRawAmount(DAI, 98),
          undefined,
          ExtraFeeClass.DEX
        )
        expect(inputAmount.quotient).toEqual(JSBI.BigInt(101))
      })

      it('alpha on the same tiny trade adds exactly 1 wei — 100 * 1% is exact, nothing to round', async () => {
        const [inputAmount] = await pool.getInputAmount(
          CurrencyAmount.fromRawAmount(DAI, 98),
          undefined,
          ExtraFeeClass.ALPHA
        )
        expect(inputAmount.quotient).toEqual(JSBI.BigInt(101))
      })

      it('is a no-op when the selected bucket has rate 0', async () => {
        const [withRate0] = await plain.getInputAmount(
          CurrencyAmount.fromRawAmount(DAI, 1_000_000),
          undefined,
          ExtraFeeClass.DEX
        )
        expect(withRate0.quotient).toEqual(JSBI.BigInt(1000502))
      })
    })

    // `_selectExtraFeeRate` (PoolSwapV1.sol:118-122) has two buckets and no default, so neither a bogus class
    // nor a missing one can be turned into a quote — `undefined` used to mean "no extra fee at all"
    it('rejects an unknown or missing extra fee class, like _selectExtraFeeRate does', async () => {
      for (const bad of [7, undefined, -1, 1.5, null]) {
        await expect(
          pool.getOutputAmount(CurrencyAmount.fromRawAmount(USDC, 100), undefined, bad as ExtraFeeClass),
          `exact-in class ${String(bad)}`
        ).rejects.toThrow('CLASS')
        await expect(
          pool.getInputAmount(CurrencyAmount.fromRawAmount(DAI, 98), undefined, bad as ExtraFeeClass),
          `exact-out class ${String(bad)}`
        ).rejects.toThrow('CLASS')
      }
    })

    it('no longer treats a missing class as a zero extra fee', async () => {
      // the old behaviour: omitting the class quoted the curve alone, 999499 out on a 1% alpha pool
      await expect(
        pool.getOutputAmount(CurrencyAmount.fromRawAmount(USDC, 1_000_000), undefined, undefined as any)
      ).rejects.toThrow('CLASS')
    })
  })

  describe('dynamic fee', () => {
    const ticks = [
      {
        index: nearestUsableTick(TickMath.MIN_TICK, 10),
        liquidityNet: ONE_ETHER,
        liquidityGross: ONE_ETHER
      },
      {
        index: nearestUsableTick(TickMath.MAX_TICK, 10),
        liquidityNet: JSBI.multiply(ONE_ETHER, NEGATIVE_ONE),
        liquidityGross: ONE_ETHER
      }
    ]
    const dynamic = new Pool(USDC, DAI, 10, 500, encodeSqrtRatioX96(1, 1), ONE_ETHER, 0, ticks, {
      dynamicFeeEnabled: true
    })
    const stat = new Pool(USDC, DAI, 10, 500, encodeSqrtRatioX96(1, 1), ONE_ETHER, 0, ticks, {
      dynamicFeeEnabled: false
    })

    // PoolSwapV1.sol:188-189 replaces the base tradeFeeRate with an oracle-derived one before the first
    // computeSwapStep. That oracle cannot be read offline, so quoting such a pool off the base rate produces
    // a number that is not executable — fail closed instead of warning and handing it back anyway.
    it('refuses to quote a dynamic fee pool by default', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await expect(
          dynamic.getOutputAmount(CurrencyAmount.fromRawAmount(USDC, 100), undefined, ExtraFeeClass.ALPHA)
        ).rejects.toThrow('DYNAMIC_FEE')
        await expect(
          dynamic.getInputAmount(CurrencyAmount.fromRawAmount(DAI, 98), undefined, ExtraFeeClass.ALPHA)
        ).rejects.toThrow('DYNAMIC_FEE')
        // fail-closed, not fail-noisy: nothing was produced, so there is nothing to warn about
        expect(warn).not.toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })

    it('quotes off the base fee rate only when the caller opts in, and warns', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const [outputAmount] = await dynamic.getOutputAmount(
          CurrencyAmount.fromRawAmount(USDC, 100),
          undefined,
          ExtraFeeClass.ALPHA,
          { assumeBaseFee: true }
        )
        expect(warn).toHaveBeenCalled()
        expect(warn.mock.calls[0][0]).toContain('dynamicFeeEnabled')
        // identical to the static pool: the base tradeFeeRate is still what is used
        expect(outputAmount.quotient).toEqual(JSBI.BigInt(98))

        const [inputAmount] = await dynamic.getInputAmount(
          CurrencyAmount.fromRawAmount(DAI, 98),
          undefined,
          ExtraFeeClass.ALPHA,
          { assumeBaseFee: true }
        )
        expect(inputAmount.quotient).toEqual(JSBI.BigInt(100))
        expect(warn).toHaveBeenCalledTimes(2)
      } finally {
        warn.mockRestore()
      }
    })

    it('only `assumeBaseFee: true` opens the gate', async () => {
      for (const opts of [{}, { assumeBaseFee: false }, { assumeBaseFee: undefined }]) {
        await expect(
          dynamic.getOutputAmount(CurrencyAmount.fromRawAmount(USDC, 100), undefined, ExtraFeeClass.ALPHA, opts)
        ).rejects.toThrow('DYNAMIC_FEE')
      }
    })

    it('does not gate or warn when the flag is off or absent', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await stat.getOutputAmount(CurrencyAmount.fromRawAmount(USDC, 100), undefined, ExtraFeeClass.ALPHA)
        await new Pool(USDC, DAI, 10, 500, encodeSqrtRatioX96(1, 1), ONE_ETHER, 0, ticks).getOutputAmount(
          CurrencyAmount.fromRawAmount(USDC, 100),
          undefined,
          ExtraFeeClass.ALPHA
        )
        expect(warn).not.toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })

    it('checks the amount and the class before the dynamic fee gate', async () => {
      await expect(
        dynamic.getOutputAmount(CurrencyAmount.fromRawAmount(USDC, 0), undefined, ExtraFeeClass.ALPHA)
      ).rejects.toThrow('AMOUNT')
      await expect(
        dynamic.getOutputAmount(CurrencyAmount.fromRawAmount(USDC, 100), undefined, 7 as ExtraFeeClass)
      ).rejects.toThrow('CLASS')
    })
  })

  describe('#bigNums', () => {
    let pool: Pool
    const bigNum1 = JSBI.add(JSBI.BigInt(Number.MAX_SAFE_INTEGER), JSBI.BigInt(1))
    const bigNum2 = JSBI.add(JSBI.BigInt(Number.MAX_SAFE_INTEGER), JSBI.BigInt(1))
    beforeEach(() => {
      pool = new Pool(USDC, DAI, 10, 500, encodeSqrtRatioX96(bigNum1, bigNum2), ONE_ETHER, 0, [
        {
          index: nearestUsableTick(TickMath.MIN_TICK, 10),
          liquidityNet: ONE_ETHER,
          liquidityGross: ONE_ETHER
        },
        {
          index: nearestUsableTick(TickMath.MAX_TICK, 10),
          liquidityNet: JSBI.multiply(ONE_ETHER, NEGATIVE_ONE),
          liquidityGross: ONE_ETHER
        }
      ])
    })

    describe('#priceLimit', () => {
      it('correctly compares two BigIntegers', async () => {
        expect(bigNum1).toEqual(bigNum2)
      })
      it('correctly handles two BigIntegers', async () => {
        const inputAmount = CurrencyAmount.fromRawAmount(USDC, 100)
        const [outputAmount] = await pool.getOutputAmount(inputAmount, undefined, ExtraFeeClass.ALPHA)
        pool.getInputAmount(outputAmount, undefined, ExtraFeeClass.ALPHA)
        expect(outputAmount.currency.equals(DAI)).toBe(true)
        // if output is correct, function has succeeded
      })
    })
  })
})
