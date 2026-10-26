import { CurrencyAmount, Ether, Percent, Price, sqrt, Token, TradeType, WETH9 } from '../core/index.js'
import JSBI from 'jsbi'
import { ExtraFeeClass } from '../constants.js'
import { encodeSqrtRatioX96 } from '../utils/encodeSqrtRatioX96.js'
import { nearestUsableTick } from '../utils/nearestUsableTick.js'
import { TickMath } from '../utils/tickMath.js'
import { Pool, PoolExtraState } from './pool.js'
import { Route } from './route.js'
import { Trade } from './trade.js'

// This SDK ships no address book, so the fixtures register their own wrapped native token.
WETH9[1] = new Token(1, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18, 'WETH', 'Wrapped Ether')

// Tests use tickSpacing 60 and tradeFeeRate 3000 unless a case needs different pool parameters.
describe('Trade', () => {
  const ETHER = Ether.onChain(1)
  const token0 = new Token(1, '0x0000000000000000000000000000000000000001', 18, 't0', 'token0')
  const token1 = new Token(1, '0x0000000000000000000000000000000000000002', 18, 't1', 'token1')
  const token2 = new Token(1, '0x0000000000000000000000000000000000000003', 18, 't2', 'token2')
  const token3 = new Token(1, '0x0000000000000000000000000000000000000004', 18, 't3', 'token3')

  function v2StylePool(
    reserve0: CurrencyAmount<Token>,
    reserve1: CurrencyAmount<Token>,
    tickSpacing: number = 60,
    tradeFeeRate: number = 3000,
    extra?: PoolExtraState
  ) {
    const sqrtRatioX96 = encodeSqrtRatioX96(reserve1.quotient, reserve0.quotient)
    const liquidity = sqrt(JSBI.multiply(reserve0.quotient, reserve1.quotient))
    return new Pool(
      reserve0.currency,
      reserve1.currency,
      tickSpacing,
      tradeFeeRate,
      sqrtRatioX96,
      liquidity,
      TickMath.getTickAtSqrtRatio(sqrtRatioX96),
      [
        {
          index: nearestUsableTick(TickMath.MIN_TICK, tickSpacing),
          liquidityNet: liquidity,
          liquidityGross: liquidity
        },
        {
          index: nearestUsableTick(TickMath.MAX_TICK, tickSpacing),
          liquidityNet: JSBI.multiply(liquidity, JSBI.BigInt(-1)),
          liquidityGross: liquidity
        }
      ],
      extra
    )
  }

  const pool_0_1 = v2StylePool(
    CurrencyAmount.fromRawAmount(token0, 100000),
    CurrencyAmount.fromRawAmount(token1, 100000)
  )
  const pool_0_2 = v2StylePool(
    CurrencyAmount.fromRawAmount(token0, 100000),
    CurrencyAmount.fromRawAmount(token2, 110000)
  )
  const pool_0_3 = v2StylePool(
    CurrencyAmount.fromRawAmount(token0, 100000),
    CurrencyAmount.fromRawAmount(token3, 90000)
  )
  const pool_1_2 = v2StylePool(
    CurrencyAmount.fromRawAmount(token1, 120000),
    CurrencyAmount.fromRawAmount(token2, 100000)
  )
  const pool_1_3 = v2StylePool(
    CurrencyAmount.fromRawAmount(token1, 120000),
    CurrencyAmount.fromRawAmount(token3, 130000)
  )

  const pool_weth_0 = v2StylePool(
    CurrencyAmount.fromRawAmount(WETH9[1], JSBI.BigInt(100000)),
    CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(100000))
  )

  const pool_weth_1 = v2StylePool(
    CurrencyAmount.fromRawAmount(WETH9[1], JSBI.BigInt(100000)),
    CurrencyAmount.fromRawAmount(token1, JSBI.BigInt(100000))
  )

  const pool_weth_2 = v2StylePool(
    CurrencyAmount.fromRawAmount(WETH9[1], JSBI.BigInt(100000)),
    CurrencyAmount.fromRawAmount(token2, JSBI.BigInt(100000))
  )

  // None of the fixtures configures an extra fee rate, so ALPHA resolves to rate 0.
  const alphaOnly = { extraFeeClass: ExtraFeeClass.ALPHA }

  describe('#fromRoute', () => {
    it('can be constructed with ETHER as input', async () => {
      const trade = await Trade.fromRoute(
        new Route([pool_weth_0], ETHER, token0),
        CurrencyAmount.fromRawAmount(Ether.onChain(1), JSBI.BigInt(10000)),
        TradeType.EXACT_INPUT,
        ExtraFeeClass.ALPHA
      )
      expect(trade.inputAmount.currency).toEqual(ETHER)
      expect(trade.outputAmount.currency).toEqual(token0)
    })
    it('can be constructed with ETHER as input for exact output', async () => {
      const trade = await Trade.fromRoute(
        new Route([pool_weth_0], ETHER, token0),
        CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(10000)),
        TradeType.EXACT_OUTPUT,
        ExtraFeeClass.ALPHA
      )
      expect(trade.inputAmount.currency).toEqual(ETHER)
      expect(trade.outputAmount.currency).toEqual(token0)
    })

    it('can be constructed with ETHER as output', async () => {
      const trade = await Trade.fromRoute(
        new Route([pool_weth_0], token0, ETHER),
        CurrencyAmount.fromRawAmount(Ether.onChain(1), JSBI.BigInt(10000)),
        TradeType.EXACT_OUTPUT,
        ExtraFeeClass.ALPHA
      )
      expect(trade.inputAmount.currency).toEqual(token0)
      expect(trade.outputAmount.currency).toEqual(ETHER)
    })
    it('can be constructed with ETHER as output for exact input', async () => {
      const trade = await Trade.fromRoute(
        new Route([pool_weth_0], token0, ETHER),
        CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(10000)),
        TradeType.EXACT_INPUT,
        ExtraFeeClass.ALPHA
      )
      expect(trade.inputAmount.currency).toEqual(token0)
      expect(trade.outputAmount.currency).toEqual(ETHER)
    })
  })

  describe('#exactIn / #exactOut', () => {
    it('forward the mandatory bucket to fromRoute and record it', async () => {
      const route = new Route([pool_0_1], token0, token1)
      const exactIn = await Trade.exactIn(route, CurrencyAmount.fromRawAmount(token0, 10000), ExtraFeeClass.DEX)
      const exactOut = await Trade.exactOut(route, CurrencyAmount.fromRawAmount(token1, 5000), ExtraFeeClass.ALPHA)

      expect(exactIn.tradeType).toEqual(TradeType.EXACT_INPUT)
      expect(exactIn.extraFeeClass).toEqual(ExtraFeeClass.DEX)
      expect(exactOut.tradeType).toEqual(TradeType.EXACT_OUTPUT)
      expect(exactOut.extraFeeClass).toEqual(ExtraFeeClass.ALPHA)

      const viaFromRoute = await Trade.fromRoute(
        route,
        CurrencyAmount.fromRawAmount(token0, 10000),
        TradeType.EXACT_INPUT,
        ExtraFeeClass.DEX
      )
      expect(exactIn.outputAmount.quotient).toEqual(viaFromRoute.outputAmount.quotient)
    })

    it('reject a missing bucket', async () => {
      const route = new Route([pool_0_1], token0, token1)
      await expect(
        Trade.exactIn(route, CurrencyAmount.fromRawAmount(token0, 10000), undefined as unknown as ExtraFeeClass)
      ).rejects.toThrow('CLASS')
      await expect(
        Trade.exactOut(route, CurrencyAmount.fromRawAmount(token1, 5000), undefined as unknown as ExtraFeeClass)
      ).rejects.toThrow('CLASS')
    })
  })

  describe('#fromRoutes', () => {
    it('can be constructed with ETHER as input with multiple routes', async () => {
      const trade = await Trade.fromRoutes<Ether, Token, TradeType.EXACT_INPUT>(
        [
          {
            amount: CurrencyAmount.fromRawAmount(Ether.onChain(1), JSBI.BigInt(10000)),
            route: new Route([pool_weth_0], ETHER, token0)
          }
        ],
        TradeType.EXACT_INPUT,
        ExtraFeeClass.ALPHA
      )
      expect(trade.inputAmount.currency).toEqual(ETHER)
      expect(trade.outputAmount.currency).toEqual(token0)
    })

    it('can be constructed with ETHER as input for exact output with multiple routes', async () => {
      const trade = await Trade.fromRoutes<Ether, Token, TradeType.EXACT_OUTPUT>(
        [
          {
            amount: CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(3000)),
            route: new Route([pool_weth_0], ETHER, token0)
          },
          {
            amount: CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(7000)),
            route: new Route([pool_weth_1, pool_0_1], ETHER, token0)
          }
        ],
        TradeType.EXACT_OUTPUT,
        ExtraFeeClass.ALPHA
      )
      expect(trade.inputAmount.currency).toEqual(ETHER)
      expect(trade.outputAmount.currency).toEqual(token0)
    })

    it('can be constructed with ETHER as output with multiple routes', async () => {
      const trade = await Trade.fromRoutes<Token, Ether, TradeType.EXACT_OUTPUT>(
        [
          {
            amount: CurrencyAmount.fromRawAmount(Ether.onChain(1), JSBI.BigInt(4000)),
            route: new Route([pool_weth_0], token0, ETHER)
          },
          {
            amount: CurrencyAmount.fromRawAmount(Ether.onChain(1), JSBI.BigInt(6000)),
            route: new Route([pool_0_1, pool_weth_1], token0, ETHER)
          }
        ],
        TradeType.EXACT_OUTPUT,
        ExtraFeeClass.ALPHA
      )
      expect(trade.inputAmount.currency).toEqual(token0)
      expect(trade.outputAmount.currency).toEqual(ETHER)
    })
    it('can be constructed with ETHER as output for exact input with multiple routes', async () => {
      const trade = await Trade.fromRoutes<Token, Ether, TradeType.EXACT_INPUT>(
        [
          {
            amount: CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(3000)),
            route: new Route([pool_weth_0], token0, ETHER)
          },
          {
            amount: CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(7000)),
            route: new Route([pool_0_1, pool_weth_1], token0, ETHER)
          }
        ],
        TradeType.EXACT_INPUT,
        ExtraFeeClass.ALPHA
      )
      expect(trade.inputAmount.currency).toEqual(token0)
      expect(trade.outputAmount.currency).toEqual(ETHER)
    })

    it('throws if pools are re-used between routes', async () => {
      await expect(
        Trade.fromRoutes<Token, Ether, TradeType.EXACT_INPUT>(
          [
            {
              amount: CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(4500)),
              route: new Route([pool_0_1, pool_weth_1], token0, ETHER)
            },
            {
              amount: CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(5500)),
              route: new Route([pool_0_1, pool_1_2, pool_weth_2], token0, ETHER)
            }
          ],
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
      ).rejects.toThrow('POOLS_DUPLICATED')
    })
  })

  describe('#createUncheckedTrade', () => {
    it('throws if input currency does not match route', () => {
      expect(() =>
        Trade.createUncheckedTrade({
          route: new Route([pool_0_1], token0, token1),
          inputAmount: CurrencyAmount.fromRawAmount(token2, 10000),
          outputAmount: CurrencyAmount.fromRawAmount(token1, 10000),
          tradeType: TradeType.EXACT_INPUT,
          extraFeeClass: ExtraFeeClass.ALPHA
        })
      ).toThrow('INPUT_CURRENCY_MATCH')
    })
    it('throws if output currency does not match route', () => {
      expect(() =>
        Trade.createUncheckedTrade({
          route: new Route([pool_0_1], token0, token1),
          inputAmount: CurrencyAmount.fromRawAmount(token0, 10000),
          outputAmount: CurrencyAmount.fromRawAmount(token2, 10000),
          tradeType: TradeType.EXACT_INPUT,
          extraFeeClass: ExtraFeeClass.ALPHA
        })
      ).toThrow('OUTPUT_CURRENCY_MATCH')
    })
    it('can create an exact input trade without simulating', () => {
      Trade.createUncheckedTrade({
        route: new Route([pool_0_1], token0, token1),
        inputAmount: CurrencyAmount.fromRawAmount(token0, 10000),
        outputAmount: CurrencyAmount.fromRawAmount(token1, 100000),
        tradeType: TradeType.EXACT_INPUT,
        extraFeeClass: ExtraFeeClass.ALPHA
      })
    })
    it('can create an exact output trade without simulating', () => {
      Trade.createUncheckedTrade({
        route: new Route([pool_0_1], token0, token1),
        inputAmount: CurrencyAmount.fromRawAmount(token0, 10000),
        outputAmount: CurrencyAmount.fromRawAmount(token1, 100000),
        tradeType: TradeType.EXACT_OUTPUT,
        extraFeeClass: ExtraFeeClass.ALPHA
      })
    })
  })
  describe('#createUncheckedTradeWithMultipleRoutes', () => {
    it('throws if input currency does not match route with multiple routes', () => {
      expect(() =>
        Trade.createUncheckedTradeWithMultipleRoutes({
          routes: [
            {
              route: new Route([pool_1_2], token2, token1),
              inputAmount: CurrencyAmount.fromRawAmount(token2, 2000),
              outputAmount: CurrencyAmount.fromRawAmount(token1, 2000)
            },
            {
              route: new Route([pool_0_1], token0, token1),
              inputAmount: CurrencyAmount.fromRawAmount(token2, 8000),
              outputAmount: CurrencyAmount.fromRawAmount(token1, 8000)
            }
          ],
          tradeType: TradeType.EXACT_INPUT,
          extraFeeClass: ExtraFeeClass.ALPHA
        })
      ).toThrow('INPUT_CURRENCY_MATCH')
    })
    it('throws if output currency does not match route with multiple routes', () => {
      expect(() =>
        Trade.createUncheckedTradeWithMultipleRoutes({
          routes: [
            {
              route: new Route([pool_0_2], token0, token2),
              inputAmount: CurrencyAmount.fromRawAmount(token0, 10000),
              outputAmount: CurrencyAmount.fromRawAmount(token2, 10000)
            },
            {
              route: new Route([pool_0_1], token0, token1),
              inputAmount: CurrencyAmount.fromRawAmount(token0, 10000),
              outputAmount: CurrencyAmount.fromRawAmount(token2, 10000)
            }
          ],
          tradeType: TradeType.EXACT_INPUT,
          extraFeeClass: ExtraFeeClass.ALPHA
        })
      ).toThrow('OUTPUT_CURRENCY_MATCH')
    })

    it('can create an exact input trade without simulating with multiple routes', () => {
      Trade.createUncheckedTradeWithMultipleRoutes({
        routes: [
          {
            route: new Route([pool_0_1], token0, token1),
            inputAmount: CurrencyAmount.fromRawAmount(token0, 5000),
            outputAmount: CurrencyAmount.fromRawAmount(token1, 50000)
          },
          {
            route: new Route([pool_0_2, pool_1_2], token0, token1),
            inputAmount: CurrencyAmount.fromRawAmount(token0, 5000),
            outputAmount: CurrencyAmount.fromRawAmount(token1, 50000)
          }
        ],
        tradeType: TradeType.EXACT_INPUT,
        extraFeeClass: ExtraFeeClass.ALPHA
      })
    })

    it('can create an exact output trade without simulating with multiple routes', () => {
      Trade.createUncheckedTradeWithMultipleRoutes({
        routes: [
          {
            route: new Route([pool_0_1], token0, token1),
            inputAmount: CurrencyAmount.fromRawAmount(token0, 5001),
            outputAmount: CurrencyAmount.fromRawAmount(token1, 50000)
          },
          {
            route: new Route([pool_0_2, pool_1_2], token0, token1),
            inputAmount: CurrencyAmount.fromRawAmount(token0, 4999),
            outputAmount: CurrencyAmount.fromRawAmount(token1, 50000)
          }
        ],
        tradeType: TradeType.EXACT_OUTPUT,
        extraFeeClass: ExtraFeeClass.ALPHA
      })
    })
  })

  describe('#route and #swaps', () => {
    const singleRoute = Trade.createUncheckedTrade({
      route: new Route([pool_0_1, pool_1_2], token0, token2),
      inputAmount: CurrencyAmount.fromRawAmount(token0, 100),
      outputAmount: CurrencyAmount.fromRawAmount(token2, 69),
      tradeType: TradeType.EXACT_INPUT,
      extraFeeClass: ExtraFeeClass.ALPHA
    })
    const multiRoute = Trade.createUncheckedTradeWithMultipleRoutes({
      routes: [
        {
          route: new Route([pool_0_1, pool_1_2], token0, token2),
          inputAmount: CurrencyAmount.fromRawAmount(token0, 50),
          outputAmount: CurrencyAmount.fromRawAmount(token2, 35)
        },
        {
          route: new Route([pool_0_2], token0, token2),
          inputAmount: CurrencyAmount.fromRawAmount(token0, 50),
          outputAmount: CurrencyAmount.fromRawAmount(token2, 34)
        }
      ],
      tradeType: TradeType.EXACT_INPUT,
      extraFeeClass: ExtraFeeClass.ALPHA
    })
    it('can access route for single route trade if less than 0', () => {
      expect(singleRoute.route).toBeDefined()
    })
    it('can access routes for both single and multi route trades', () => {
      expect(singleRoute.swaps).toBeDefined()
      expect(singleRoute.swaps).toHaveLength(1)
      expect(multiRoute.swaps).toBeDefined()
      expect(multiRoute.swaps).toHaveLength(2)
    })
    it('throws if access route on multi route trade', () => {
      expect(() => multiRoute.route).toThrow('MULTIPLE_ROUTES')
    })
  })

  describe('#worstExecutionPrice', () => {
    describe('tradeType = EXACT_INPUT', () => {
      const exactIn = Trade.createUncheckedTrade({
        route: new Route([pool_0_1, pool_1_2], token0, token2),
        inputAmount: CurrencyAmount.fromRawAmount(token0, 100),
        outputAmount: CurrencyAmount.fromRawAmount(token2, 69),
        tradeType: TradeType.EXACT_INPUT,
        extraFeeClass: ExtraFeeClass.ALPHA
      })
      const exactInMultiRoute = Trade.createUncheckedTradeWithMultipleRoutes({
        routes: [
          {
            route: new Route([pool_0_1, pool_1_2], token0, token2),
            inputAmount: CurrencyAmount.fromRawAmount(token0, 50),
            outputAmount: CurrencyAmount.fromRawAmount(token2, 35)
          },
          {
            route: new Route([pool_0_2], token0, token2),
            inputAmount: CurrencyAmount.fromRawAmount(token0, 50),
            outputAmount: CurrencyAmount.fromRawAmount(token2, 34)
          }
        ],
        tradeType: TradeType.EXACT_INPUT,
        extraFeeClass: ExtraFeeClass.ALPHA
      })
      it('throws if less than 0', () => {
        expect(() => exactIn.minimumAmountOut(new Percent(-1, 100))).toThrow('SLIPPAGE_TOLERANCE')
      })
      it('returns exact if 0', () => {
        expect(exactIn.worstExecutionPrice(new Percent(0, 100))).toEqual(exactIn.executionPrice)
      })
      it('returns exact if nonzero', () => {
        expect(exactIn.worstExecutionPrice(new Percent(0, 100))).toEqual(new Price(token0, token2, 100, 69))
        expect(exactIn.worstExecutionPrice(new Percent(5, 100))).toEqual(new Price(token0, token2, 100, 65))
        expect(exactIn.worstExecutionPrice(new Percent(200, 100))).toEqual(new Price(token0, token2, 100, 23))
      })
      it('returns exact if nonzero with multiple routes', () => {
        expect(exactInMultiRoute.worstExecutionPrice(new Percent(0, 100))).toEqual(new Price(token0, token2, 100, 69))
        expect(exactInMultiRoute.worstExecutionPrice(new Percent(5, 100))).toEqual(new Price(token0, token2, 100, 65))
        expect(exactInMultiRoute.worstExecutionPrice(new Percent(200, 100))).toEqual(new Price(token0, token2, 100, 23))
      })
    })
    describe('tradeType = EXACT_OUTPUT', () => {
      const exactOut = Trade.createUncheckedTrade({
        route: new Route([pool_0_1, pool_1_2], token0, token2),
        inputAmount: CurrencyAmount.fromRawAmount(token0, 156),
        outputAmount: CurrencyAmount.fromRawAmount(token2, 100),
        tradeType: TradeType.EXACT_OUTPUT,
        extraFeeClass: ExtraFeeClass.ALPHA
      })
      const exactOutMultiRoute = Trade.createUncheckedTradeWithMultipleRoutes({
        routes: [
          {
            route: new Route([pool_0_1, pool_1_2], token0, token2),
            inputAmount: CurrencyAmount.fromRawAmount(token0, 78),
            outputAmount: CurrencyAmount.fromRawAmount(token2, 50)
          },
          {
            route: new Route([pool_0_2], token0, token2),
            inputAmount: CurrencyAmount.fromRawAmount(token0, 78),
            outputAmount: CurrencyAmount.fromRawAmount(token2, 50)
          }
        ],
        tradeType: TradeType.EXACT_OUTPUT,
        extraFeeClass: ExtraFeeClass.ALPHA
      })

      it('throws if less than 0', () => {
        expect(() => exactOut.worstExecutionPrice(new Percent(-1, 100))).toThrow('SLIPPAGE_TOLERANCE')
      })
      it('returns exact if 0', () => {
        expect(exactOut.worstExecutionPrice(new Percent(0, 100))).toEqual(exactOut.executionPrice)
      })
      it('returns slippage amount if nonzero', () => {
        expect(
          exactOut.worstExecutionPrice(new Percent(0, 100)).equalTo(new Price(token0, token2, 156, 100))
        ).toBeTruthy()
        expect(
          exactOut.worstExecutionPrice(new Percent(5, 100)).equalTo(new Price(token0, token2, 163, 100))
        ).toBeTruthy()
        expect(
          exactOut.worstExecutionPrice(new Percent(200, 100)).equalTo(new Price(token0, token2, 468, 100))
        ).toBeTruthy()
      })
      it('returns exact if nonzero with multiple routes', () => {
        expect(
          exactOutMultiRoute.worstExecutionPrice(new Percent(0, 100)).equalTo(new Price(token0, token2, 156, 100))
        ).toBeTruthy()
        expect(
          exactOutMultiRoute.worstExecutionPrice(new Percent(5, 100)).equalTo(new Price(token0, token2, 163, 100))
        ).toBeTruthy()
        expect(
          exactOutMultiRoute.worstExecutionPrice(new Percent(200, 100)).equalTo(new Price(token0, token2, 468, 100))
        ).toBeTruthy()
      })
    })
  })

  describe('#priceImpact', () => {
    describe('tradeType = EXACT_INPUT', () => {
      const exactIn = Trade.createUncheckedTradeWithMultipleRoutes({
        routes: [
          {
            route: new Route([pool_0_1, pool_1_2], token0, token2),
            inputAmount: CurrencyAmount.fromRawAmount(token0, 100),
            outputAmount: CurrencyAmount.fromRawAmount(token2, 69)
          }
        ],
        tradeType: TradeType.EXACT_INPUT,
        extraFeeClass: ExtraFeeClass.ALPHA
      })
      const exactInMultipleRoutes = Trade.createUncheckedTradeWithMultipleRoutes({
        routes: [
          {
            route: new Route([pool_0_1, pool_1_2], token0, token2),
            inputAmount: CurrencyAmount.fromRawAmount(token0, 90),
            outputAmount: CurrencyAmount.fromRawAmount(token2, 62)
          },
          {
            route: new Route([pool_0_2], token0, token2),
            inputAmount: CurrencyAmount.fromRawAmount(token0, 10),
            outputAmount: CurrencyAmount.fromRawAmount(token2, 7)
          }
        ],
        tradeType: TradeType.EXACT_INPUT,
        extraFeeClass: ExtraFeeClass.ALPHA
      })
      it('is cached', () => {
        expect(exactIn.priceImpact === exactIn.priceImpact).toStrictEqual(true)
      })
      it('is correct', () => {
        expect(exactIn.priceImpact.toSignificant(3)).toEqual('17.2')
      })

      it('is cached with multiple routes', () => {
        expect(exactInMultipleRoutes.priceImpact === exactInMultipleRoutes.priceImpact).toStrictEqual(true)
      })
      it('is correct with multiple routes', async () => {
        expect(exactInMultipleRoutes.priceImpact.toSignificant(3)).toEqual('19.8')
      })
    })
    describe('tradeType = EXACT_OUTPUT', () => {
      const exactOut = Trade.createUncheckedTradeWithMultipleRoutes({
        routes: [
          {
            route: new Route([pool_0_1, pool_1_2], token0, token2),
            inputAmount: CurrencyAmount.fromRawAmount(token0, 156),
            outputAmount: CurrencyAmount.fromRawAmount(token2, 100)
          }
        ],
        tradeType: TradeType.EXACT_OUTPUT,
        extraFeeClass: ExtraFeeClass.ALPHA
      })
      const exactOutMultipleRoutes = Trade.createUncheckedTradeWithMultipleRoutes({
        routes: [
          {
            route: new Route([pool_0_1, pool_1_2], token0, token2),
            inputAmount: CurrencyAmount.fromRawAmount(token0, 140),
            outputAmount: CurrencyAmount.fromRawAmount(token2, 90)
          },
          {
            route: new Route([pool_0_2], token0, token2),
            inputAmount: CurrencyAmount.fromRawAmount(token0, 16),
            outputAmount: CurrencyAmount.fromRawAmount(token2, 10)
          }
        ],
        tradeType: TradeType.EXACT_OUTPUT,
        extraFeeClass: ExtraFeeClass.ALPHA
      })

      it('is cached', () => {
        expect(exactOut.priceImpact === exactOut.priceImpact).toStrictEqual(true)
      })
      it('is correct', () => {
        expect(exactOut.priceImpact.toSignificant(3)).toEqual('23.1')
      })

      it('is cached with multiple routes', () => {
        expect(exactOutMultipleRoutes.priceImpact === exactOutMultipleRoutes.priceImpact).toStrictEqual(true)
      })
      it('is correct with multiple routes', () => {
        expect(exactOutMultipleRoutes.priceImpact.toSignificant(3)).toEqual('25.5')
      })
    })
  })

  describe('#bestTradeExactIn', () => {
    it('throws with empty pools', async () => {
      await expect(
        Trade.bestTradeExactIn([], CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(10000)), token2, alphaOnly)
      ).rejects.toThrow('POOLS')
    })
    it('throws with max hops of 0', async () => {
      await expect(
        Trade.bestTradeExactIn([pool_0_2], CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(10000)), token2, {
          ...alphaOnly,
          maxHops: 0
        })
      ).rejects.toThrow('MAX_HOPS')
    })

    it('provides best route', async () => {
      const result = await Trade.bestTradeExactIn(
        [pool_0_1, pool_0_2, pool_1_2],
        CurrencyAmount.fromRawAmount(token0, 10000),
        token2,
        alphaOnly
      )
      expect(result).toHaveLength(2)
      expect(result[0].swaps[0].route.pools).toHaveLength(1) // 0 -> 2 at 10:11
      expect(result[0].swaps[0].route.tokenPath).toEqual([token0, token2])
      expect(result[0].inputAmount.equalTo(CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(10000)))).toBeTruthy()
      expect(result[0].outputAmount.equalTo(CurrencyAmount.fromRawAmount(token2, JSBI.BigInt(9971)))).toBeTruthy()
      expect(result[1].swaps[0].route.pools).toHaveLength(2) // 0 -> 1 -> 2 at 12:12:10
      expect(result[1].swaps[0].route.tokenPath).toEqual([token0, token1, token2])
      expect(result[1].inputAmount.equalTo(CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(10000)))).toBeTruthy()
      expect(result[1].outputAmount.equalTo(CurrencyAmount.fromRawAmount(token2, JSBI.BigInt(7004)))).toBeTruthy()
    })

    it('respects maxHops', async () => {
      const result = await Trade.bestTradeExactIn(
        [pool_0_1, pool_0_2, pool_1_2],
        CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(10)),
        token2,
        { ...alphaOnly, maxHops: 1 }
      )
      expect(result).toHaveLength(1)
      expect(result[0].swaps[0].route.pools).toHaveLength(1) // 0 -> 2 at 10:11
      expect(result[0].swaps[0].route.tokenPath).toEqual([token0, token2])
    })

    it('insufficient input for one pool', async () => {
      const result = await Trade.bestTradeExactIn(
        [pool_0_1, pool_0_2, pool_1_2],
        CurrencyAmount.fromRawAmount(token0, 1),
        token2,
        alphaOnly
      )
      // only the direct 0 -> 2 hop survives: 1 wei into 0 -> 1 leaves 0 for the second hop, and a zero leg is
      // not quotable at all now (Pool 'AMOUNT'), so that path dead-ends instead of producing a 0-out 2-hop trade
      expect(result).toHaveLength(1)
      expect(result[0].swaps[0].route.pools).toHaveLength(1) // 0 -> 2 at 10:11
      expect(result[0].swaps[0].route.tokenPath).toEqual([token0, token2])
      expect(result[0].outputAmount).toEqual(CurrencyAmount.fromRawAmount(token2, 0))
    })

    it('refuses a zero input amount outright', async () => {
      await expect(
        Trade.bestTradeExactIn(
          [pool_0_1, pool_0_2, pool_1_2],
          CurrencyAmount.fromRawAmount(token0, 0),
          token2,
          alphaOnly
        )
      ).rejects.toThrow('AMOUNT')
    })

    it('respects n', async () => {
      const result = await Trade.bestTradeExactIn(
        [pool_0_1, pool_0_2, pool_1_2],
        CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(10)),
        token2,
        { ...alphaOnly, maxNumResults: 1 }
      )

      expect(result).toHaveLength(1)
    })

    it('no path', async () => {
      const result = await Trade.bestTradeExactIn(
        [pool_0_1, pool_0_3, pool_1_3],
        CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(10)),
        token2,
        alphaOnly
      )
      expect(result).toHaveLength(0)
    })

    it('works for ETHER currency input', async () => {
      const result = await Trade.bestTradeExactIn(
        [pool_weth_0, pool_0_1, pool_0_3, pool_1_3],
        CurrencyAmount.fromRawAmount(Ether.onChain(1), JSBI.BigInt(100)),
        token3,
        alphaOnly
      )
      expect(result).toHaveLength(2)
      expect(result[0].inputAmount.currency).toEqual(ETHER)
      expect(result[0].swaps[0].route.tokenPath).toEqual([WETH9[1], token0, token1, token3])
      expect(result[0].outputAmount.currency).toEqual(token3)
      expect(result[1].inputAmount.currency).toEqual(ETHER)
      expect(result[1].swaps[0].route.tokenPath).toEqual([WETH9[1], token0, token3])
      expect(result[1].outputAmount.currency).toEqual(token3)
    })

    it('works for ETHER currency output', async () => {
      const result = await Trade.bestTradeExactIn(
        [pool_weth_0, pool_0_1, pool_0_3, pool_1_3],
        CurrencyAmount.fromRawAmount(token3, JSBI.BigInt(100)),
        ETHER,
        alphaOnly
      )
      expect(result).toHaveLength(2)
      expect(result[0].inputAmount.currency).toEqual(token3)
      expect(result[0].swaps[0].route.tokenPath).toEqual([token3, token0, WETH9[1]])
      expect(result[0].outputAmount.currency).toEqual(ETHER)
      expect(result[1].inputAmount.currency).toEqual(token3)
      expect(result[1].swaps[0].route.tokenPath).toEqual([token3, token1, token0, WETH9[1]])
      expect(result[1].outputAmount.currency).toEqual(ETHER)
    })
  })

  describe('#maximumAmountIn', () => {
    describe('tradeType = EXACT_INPUT', () => {
      let exactIn: Trade<Token, Token, TradeType.EXACT_INPUT>
      beforeEach(async () => {
        exactIn = await Trade.fromRoute(
          new Route([pool_0_1, pool_1_2], token0, token2),
          CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(100)),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
      })
      it('throws if less than 0', () => {
        expect(() => exactIn.maximumAmountIn(new Percent(JSBI.BigInt(-1), JSBI.BigInt(100)))).toThrow(
          'SLIPPAGE_TOLERANCE'
        )
      })
      it('returns exact if 0', () => {
        expect(exactIn.maximumAmountIn(new Percent(JSBI.BigInt(0), JSBI.BigInt(100)))).toEqual(exactIn.inputAmount)
      })
      it('returns exact if nonzero', () => {
        expect(
          exactIn
            .maximumAmountIn(new Percent(JSBI.BigInt(0), JSBI.BigInt(100)))
            .equalTo(CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(100)))
        ).toBeTruthy()
        expect(
          exactIn
            .maximumAmountIn(new Percent(JSBI.BigInt(5), JSBI.BigInt(100)))
            .equalTo(CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(100)))
        ).toBeTruthy()
        expect(
          exactIn
            .maximumAmountIn(new Percent(JSBI.BigInt(200), JSBI.BigInt(100)))
            .equalTo(CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(100)))
        ).toBeTruthy()
      })
    })

    describe('tradeType = EXACT_OUTPUT', () => {
      let exactOut: Trade<Token, Token, TradeType.EXACT_OUTPUT>
      beforeEach(async () => {
        exactOut = await Trade.fromRoute(
          new Route([pool_0_1, pool_1_2], token0, token2),
          CurrencyAmount.fromRawAmount(token2, 10000),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )
      })

      it('throws if less than 0', () => {
        expect(() => exactOut.maximumAmountIn(new Percent(JSBI.BigInt(-1), 10000))).toThrow('SLIPPAGE_TOLERANCE')
      })

      it('returns exact if 0', () => {
        expect(exactOut.maximumAmountIn(new Percent(JSBI.BigInt(0), 10000))).toEqual(exactOut.inputAmount)
      })

      it('returns slippage amount if nonzero', () => {
        expect(
          exactOut
            .maximumAmountIn(new Percent(JSBI.BigInt(0), 100))
            .equalTo(CurrencyAmount.fromRawAmount(token0, 15488))
        ).toBeTruthy()
        expect(
          exactOut
            .maximumAmountIn(new Percent(JSBI.BigInt(5), JSBI.BigInt(100)))
            .equalTo(CurrencyAmount.fromRawAmount(token0, 16262))
        ).toBeTruthy()
        expect(
          exactOut
            .maximumAmountIn(new Percent(JSBI.BigInt(200), JSBI.BigInt(100)))
            .equalTo(CurrencyAmount.fromRawAmount(token0, 46464))
        ).toBeTruthy()
      })
    })
  })

  describe('#minimumAmountOut', () => {
    describe('tradeType = EXACT_INPUT', () => {
      let exactIn: Trade<Token, Token, TradeType.EXACT_INPUT>
      beforeEach(
        async () =>
          (exactIn = await Trade.fromRoute(
            new Route([pool_0_1, pool_1_2], token0, token2),
            CurrencyAmount.fromRawAmount(token0, 10000),
            TradeType.EXACT_INPUT,
            ExtraFeeClass.ALPHA
          ))
      )

      it('throws if less than 0', () => {
        expect(() => exactIn.minimumAmountOut(new Percent(JSBI.BigInt(-1), 100))).toThrow('SLIPPAGE_TOLERANCE')
      })

      it('returns exact if 0', () => {
        expect(exactIn.minimumAmountOut(new Percent(JSBI.BigInt(0), 10000))).toEqual(exactIn.outputAmount)
      })

      it('returns exact if nonzero', () => {
        expect(exactIn.minimumAmountOut(new Percent(JSBI.BigInt(0), 100))).toEqual(
          CurrencyAmount.fromRawAmount(token2, 7004)
        )
        expect(exactIn.minimumAmountOut(new Percent(JSBI.BigInt(5), 100))).toEqual(
          CurrencyAmount.fromRawAmount(token2, 6670)
        )
        expect(exactIn.minimumAmountOut(new Percent(JSBI.BigInt(200), 100))).toEqual(
          CurrencyAmount.fromRawAmount(token2, 2334)
        )
      })
    })
    describe('tradeType = EXACT_OUTPUT', () => {
      let exactOut: Trade<Token, Token, TradeType.EXACT_OUTPUT>
      beforeEach(async () => {
        exactOut = await Trade.fromRoute(
          new Route([pool_0_1, pool_1_2], token0, token2),
          CurrencyAmount.fromRawAmount(token2, JSBI.BigInt(100)),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )
      })

      it('throws if less than 0', () => {
        expect(() => exactOut.minimumAmountOut(new Percent(JSBI.BigInt(-1), JSBI.BigInt(100)))).toThrow(
          'SLIPPAGE_TOLERANCE'
        )
      })
      it('returns exact if 0', () => {
        expect(exactOut.minimumAmountOut(new Percent(JSBI.BigInt(0), JSBI.BigInt(100)))).toEqual(exactOut.outputAmount)
      })
      it('returns slippage amount if nonzero', () => {
        expect(
          exactOut
            .minimumAmountOut(new Percent(JSBI.BigInt(0), JSBI.BigInt(100)))
            .equalTo(CurrencyAmount.fromRawAmount(token2, JSBI.BigInt(100)))
        ).toBeTruthy()
        expect(
          exactOut
            .minimumAmountOut(new Percent(JSBI.BigInt(5), JSBI.BigInt(100)))
            .equalTo(CurrencyAmount.fromRawAmount(token2, JSBI.BigInt(100)))
        ).toBeTruthy()
        expect(
          exactOut
            .minimumAmountOut(new Percent(JSBI.BigInt(200), JSBI.BigInt(100)))
            .equalTo(CurrencyAmount.fromRawAmount(token2, JSBI.BigInt(100)))
        ).toBeTruthy()
      })
    })
  })

  describe('#bestTradeExactOut', () => {
    it('throws with empty pools', async () => {
      await expect(
        Trade.bestTradeExactOut([], token0, CurrencyAmount.fromRawAmount(token2, JSBI.BigInt(100)), alphaOnly)
      ).rejects.toThrow('POOLS')
    })
    it('throws with max hops of 0', async () => {
      await expect(
        Trade.bestTradeExactOut([pool_0_2], token0, CurrencyAmount.fromRawAmount(token2, JSBI.BigInt(100)), {
          ...alphaOnly,
          maxHops: 0
        })
      ).rejects.toThrow('MAX_HOPS')
    })

    it('provides best route', async () => {
      const result = await Trade.bestTradeExactOut(
        [pool_0_1, pool_0_2, pool_1_2],
        token0,
        CurrencyAmount.fromRawAmount(token2, 10000),
        alphaOnly
      )
      expect(result).toHaveLength(2)
      expect(result[0].swaps[0].route.pools).toHaveLength(1) // 0 -> 2 at 10:11
      expect(result[0].swaps[0].route.tokenPath).toEqual([token0, token2])
      expect(result[0].inputAmount.equalTo(CurrencyAmount.fromRawAmount(token0, 10032))).toBeTruthy()
      expect(result[0].outputAmount.equalTo(CurrencyAmount.fromRawAmount(token2, 10000))).toBeTruthy()
      expect(result[1].swaps[0].route.pools).toHaveLength(2) // 0 -> 1 -> 2 at 12:12:10
      expect(result[1].swaps[0].route.tokenPath).toEqual([token0, token1, token2])
      expect(result[1].inputAmount.equalTo(CurrencyAmount.fromRawAmount(token0, 15488))).toBeTruthy()
      expect(result[1].outputAmount.equalTo(CurrencyAmount.fromRawAmount(token2, 10000))).toBeTruthy()
    })

    it('respects maxHops', async () => {
      const result = await Trade.bestTradeExactOut(
        [pool_0_1, pool_0_2, pool_1_2],
        token0,
        CurrencyAmount.fromRawAmount(token2, JSBI.BigInt(10)),
        { ...alphaOnly, maxHops: 1 }
      )
      expect(result).toHaveLength(1)
      expect(result[0].swaps[0].route.pools).toHaveLength(1) // 0 -> 2 at 10:11
      expect(result[0].swaps[0].route.tokenPath).toEqual([token0, token2])
    })

    it.skip('insufficient liquidity', () => {
      const result = Trade.bestTradeExactOut(
        [pool_0_1, pool_0_2, pool_1_2],
        token0,
        CurrencyAmount.fromRawAmount(token2, 1200),
        alphaOnly
      )
      expect(result).toHaveLength(0)
    })

    it.skip('insufficient liquidity in one pool but not the other', () => {
      const result = Trade.bestTradeExactOut(
        [pool_0_1, pool_0_2, pool_1_2],
        token0,
        CurrencyAmount.fromRawAmount(token2, JSBI.BigInt(1050)),
        alphaOnly
      )
      expect(result).toHaveLength(1)
    })

    it('respects n', async () => {
      const result = await Trade.bestTradeExactOut(
        [pool_0_1, pool_0_2, pool_1_2],
        token0,
        CurrencyAmount.fromRawAmount(token2, JSBI.BigInt(10)),
        { ...alphaOnly, maxNumResults: 1 }
      )

      expect(result).toHaveLength(1)
    })

    it('no path', async () => {
      const result = await Trade.bestTradeExactOut(
        [pool_0_1, pool_0_3, pool_1_3],
        token0,
        CurrencyAmount.fromRawAmount(token2, JSBI.BigInt(10)),
        alphaOnly
      )
      expect(result).toHaveLength(0)
    })

    it('refuses a zero output amount outright', async () => {
      await expect(
        Trade.bestTradeExactOut(
          [pool_0_1, pool_0_2, pool_1_2],
          token0,
          CurrencyAmount.fromRawAmount(token2, 0),
          alphaOnly
        )
      ).rejects.toThrow('AMOUNT')
    })

    it('works for ETHER currency input', async () => {
      const result = await Trade.bestTradeExactOut(
        [pool_weth_0, pool_0_1, pool_0_3, pool_1_3],
        ETHER,
        CurrencyAmount.fromRawAmount(token3, 10000),
        alphaOnly
      )
      expect(result).toHaveLength(2)
      expect(result[0].inputAmount.currency).toEqual(ETHER)
      expect(result[0].swaps[0].route.tokenPath).toEqual([WETH9[1], token0, token1, token3])
      expect(result[0].outputAmount.currency).toEqual(token3)
      expect(result[1].inputAmount.currency).toEqual(ETHER)
      expect(result[1].swaps[0].route.tokenPath).toEqual([WETH9[1], token0, token3])
      expect(result[1].outputAmount.currency).toEqual(token3)
    })
    it('works for ETHER currency output', async () => {
      const result = await Trade.bestTradeExactOut(
        [pool_weth_0, pool_0_1, pool_0_3, pool_1_3],
        token3,
        CurrencyAmount.fromRawAmount(Ether.onChain(1), JSBI.BigInt(100)),
        alphaOnly
      )
      expect(result).toHaveLength(2)
      expect(result[0].inputAmount.currency).toEqual(token3)
      expect(result[0].swaps[0].route.tokenPath).toEqual([token3, token0, WETH9[1]])
      expect(result[0].outputAmount.currency).toEqual(ETHER)
      expect(result[1].inputAmount.currency).toEqual(token3)
      expect(result[1].swaps[0].route.tokenPath).toEqual([token3, token1, token0, WETH9[1]])
      expect(result[1].outputAmount.currency).toEqual(ETHER)
    })
  })

  describe('pool identity key', () => {
    // dedup is on `(token0, token1, tickSpacing)` — the trade has no init code hash to derive an address with
    it('treats the trade fee as data, not identity: same tokens + tickSpacing is the same pool', async () => {
      const sameIdDifferentFee = v2StylePool(
        CurrencyAmount.fromRawAmount(token0, 100000),
        CurrencyAmount.fromRawAmount(token1, 100000),
        60,
        500
      )
      await expect(
        Trade.fromRoutes<Token, Token, TradeType.EXACT_INPUT>(
          [
            {
              amount: CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(4500)),
              route: new Route([pool_0_1], token0, token1)
            },
            {
              amount: CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(5500)),
              route: new Route([sameIdDifferentFee], token0, token1)
            }
          ],
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
      ).rejects.toThrow('POOLS_DUPLICATED')
    })

    it('treats tickSpacing as part of the identity: same tokens + different tickSpacing are two pools', async () => {
      const otherTickSpacing = v2StylePool(
        CurrencyAmount.fromRawAmount(token0, 100000),
        CurrencyAmount.fromRawAmount(token1, 100000),
        10,
        500
      )
      const trade = await Trade.fromRoutes<Token, Token, TradeType.EXACT_INPUT>(
        [
          {
            amount: CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(4500)),
            route: new Route([pool_0_1], token0, token1)
          },
          {
            amount: CurrencyAmount.fromRawAmount(token0, JSBI.BigInt(5500)),
            route: new Route([otherTickSpacing], token0, token1)
          }
        ],
        TradeType.EXACT_INPUT,
        ExtraFeeClass.ALPHA
      )
      expect(trade.swaps).toHaveLength(2)
    })
  })

  describe('extra trade fee pass-through', () => {
    // 1% alpha, 0.3% dex; identical curve state to pool_0_1 / pool_1_2 so they can be compared directly
    const extra = { alphaExtraTradeFeeRate: 10_000, dexExtraTradeFeeRate: 3_000 }
    const pool_0_1_extra = v2StylePool(
      CurrencyAmount.fromRawAmount(token0, 100000),
      CurrencyAmount.fromRawAmount(token1, 100000),
      60,
      3000,
      extra
    )
    const pool_1_2_extra = v2StylePool(
      CurrencyAmount.fromRawAmount(token1, 120000),
      CurrencyAmount.fromRawAmount(token2, 100000),
      60,
      3000,
      extra
    )

    it('fromRoute exact-in skims each hop before the curve', async () => {
      const withFee = await Trade.fromRoute(
        new Route([pool_0_1_extra], token0, token1),
        CurrencyAmount.fromRawAmount(token0, 10000),
        TradeType.EXACT_INPUT,
        ExtraFeeClass.ALPHA
      )
      // floor(10000 * 1%) = 100 is skimmed, so the curve only sees 9900
      const reference = await Trade.fromRoute(
        new Route([pool_0_1], token0, token1),
        CurrencyAmount.fromRawAmount(token0, 9900),
        TradeType.EXACT_INPUT,
        ExtraFeeClass.ALPHA
      )
      expect(withFee.outputAmount.quotient).toEqual(reference.outputAmount.quotient)
      // the reported input stays the gross amount the user hands over
      expect(withFee.inputAmount.quotient).toEqual(JSBI.BigInt(10000))
    })

    it('fromRoute exact-out surcharges each hop', async () => {
      const withFee = await Trade.fromRoute(
        new Route([pool_0_1_extra], token0, token1),
        CurrencyAmount.fromRawAmount(token1, 10000),
        TradeType.EXACT_OUTPUT,
        ExtraFeeClass.ALPHA
      )
      const curveOnly = await Trade.fromRoute(
        new Route([pool_0_1], token0, token1),
        CurrencyAmount.fromRawAmount(token1, 10000),
        TradeType.EXACT_OUTPUT,
        ExtraFeeClass.ALPHA
      )
      const curveIn = curveOnly.inputAmount.quotient
      // `FullMath.mulDivRoundingUp` on chain (pool logic v1.1) — ceil, which is the `Pool` default
      const product = JSBI.multiply(curveIn, JSBI.BigInt(10_000))
      const denominator = JSBI.BigInt(1_000_000)
      const fee = JSBI.equal(JSBI.remainder(product, denominator), JSBI.BigInt(0))
        ? JSBI.divide(product, denominator)
        : JSBI.add(JSBI.divide(product, denominator), JSBI.BigInt(1))
      expect(withFee.inputAmount.quotient).toEqual(JSBI.add(curveIn, fee))
      expect(withFee.outputAmount.quotient).toEqual(JSBI.BigInt(10000))
    })

    it('picks the bucket the class selects, and records it on the trade', async () => {
      const amount = CurrencyAmount.fromRawAmount(token0, 10000)
      const route = new Route([pool_0_1_extra], token0, token1)
      const alpha = await Trade.fromRoute(route, amount, TradeType.EXACT_INPUT, ExtraFeeClass.ALPHA)
      const dex = await Trade.fromRoute(route, amount, TradeType.EXACT_INPUT, ExtraFeeClass.DEX)
      // 1% alpha vs 0.3% dex on the same curve, and a rate-0 bucket on the fee-less twin as the ceiling
      const rateZero = await Trade.fromRoute(
        new Route([pool_0_1], token0, token1),
        amount,
        TradeType.EXACT_INPUT,
        ExtraFeeClass.ALPHA
      )
      expect(alpha.outputAmount.lessThan(dex.outputAmount)).toBe(true)
      expect(dex.outputAmount.lessThan(rateZero.outputAmount)).toBe(true)

      expect(alpha.extraFeeClass).toEqual(ExtraFeeClass.ALPHA)
      expect(dex.extraFeeClass).toEqual(ExtraFeeClass.DEX)
    })

    it('refuses to build a trade without an executable bucket', async () => {
      const amount = CurrencyAmount.fromRawAmount(token0, 10000)
      const route = new Route([pool_0_1_extra], token0, token1)

      for (const bad of [undefined, 7, -1, 1.5]) {
        await expect(
          Trade.fromRoute(route, amount, TradeType.EXACT_INPUT, bad as ExtraFeeClass),
          `fromRoute class ${String(bad)}`
        ).rejects.toThrow('CLASS')
        await expect(
          Trade.fromRoutes<Token, Token, TradeType.EXACT_INPUT>(
            [{ amount, route }],
            TradeType.EXACT_INPUT,
            bad as ExtraFeeClass
          ),
          `fromRoutes class ${String(bad)}`
        ).rejects.toThrow('CLASS')
        expect(() =>
          Trade.createUncheckedTrade({
            route,
            inputAmount: amount,
            outputAmount: CurrencyAmount.fromRawAmount(token1, 9000),
            tradeType: TradeType.EXACT_INPUT,
            extraFeeClass: bad as ExtraFeeClass
          })
        ).toThrow('CLASS')
        await expect(
          Trade.bestTradeExactIn([pool_0_1_extra], amount, token1, { extraFeeClass: bad as ExtraFeeClass }),
          `bestTradeExactIn class ${String(bad)}`
        ).rejects.toThrow('CLASS')
      }
    })

    it('carries the bucket on unchecked trades too, which is how a dynamic fee pool is quoted', () => {
      const trade = Trade.createUncheckedTrade({
        route: new Route([pool_0_1_extra], token0, token1),
        inputAmount: CurrencyAmount.fromRawAmount(token0, 10000),
        outputAmount: CurrencyAmount.fromRawAmount(token1, 9000),
        tradeType: TradeType.EXACT_INPUT,
        extraFeeClass: ExtraFeeClass.DEX
      })
      expect(trade.extraFeeClass).toEqual(ExtraFeeClass.DEX)

      const multi = Trade.createUncheckedTradeWithMultipleRoutes({
        routes: [
          {
            route: new Route([pool_0_1_extra], token0, token1),
            inputAmount: CurrencyAmount.fromRawAmount(token0, 10000),
            outputAmount: CurrencyAmount.fromRawAmount(token1, 9000)
          }
        ],
        tradeType: TradeType.EXACT_INPUT,
        extraFeeClass: ExtraFeeClass.DEX
      })
      // one bucket for the whole trade, so a split route cannot mix two of them
      expect(multi.extraFeeClass).toEqual(ExtraFeeClass.DEX)
    })

    it('pins the bucket at runtime — plain-JS reassignment after quoting must fail', () => {
      const trade = Trade.createUncheckedTrade({
        route: new Route([pool_0_1_extra], token0, token1),
        inputAmount: CurrencyAmount.fromRawAmount(token0, 10000),
        outputAmount: CurrencyAmount.fromRawAmount(token1, 9000),
        tradeType: TradeType.EXACT_INPUT,
        extraFeeClass: ExtraFeeClass.ALPHA
      })
      // TS readonly is compile-time only; the property itself must reject writes (quote↔execution binding)
      expect(() => {
        ;(trade as any).extraFeeClass = ExtraFeeClass.DEX
      }).toThrow(TypeError)
      expect(() => {
        Object.defineProperty(trade, 'extraFeeClass', { value: 2 })
      }).toThrow(TypeError)
      expect(trade.extraFeeClass).toEqual(ExtraFeeClass.ALPHA)
    })

    it('refuses to quote a dynamic fee pool offline, on every route-simulating entry point', async () => {
      const dynamic = v2StylePool(
        CurrencyAmount.fromRawAmount(token0, 100000),
        CurrencyAmount.fromRawAmount(token1, 100000),
        60,
        3000,
        { dynamicFeeEnabled: true }
      )
      const amountIn = CurrencyAmount.fromRawAmount(token0, 10000)
      const route = new Route([dynamic], token0, token1)

      await expect(Trade.fromRoute(route, amountIn, TradeType.EXACT_INPUT, ExtraFeeClass.ALPHA)).rejects.toThrow(
        'DYNAMIC_FEE'
      )
      await expect(
        Trade.exactOut(route, CurrencyAmount.fromRawAmount(token1, 10000), ExtraFeeClass.ALPHA)
      ).rejects.toThrow('DYNAMIC_FEE')
      await expect(
        Trade.fromRoutes<Token, Token, TradeType.EXACT_INPUT>(
          [{ amount: amountIn, route }],
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
      ).rejects.toThrow('DYNAMIC_FEE')
      await expect(Trade.bestTradeExactIn([dynamic], amountIn, token1, alphaOnly)).rejects.toThrow('DYNAMIC_FEE')

      // the sanctioned path: quote it with ByrealQuoter, then wrap the numbers in an unchecked trade
      expect(
        Trade.createUncheckedTrade({
          route,
          inputAmount: amountIn,
          outputAmount: CurrencyAmount.fromRawAmount(token1, 9000),
          tradeType: TradeType.EXACT_INPUT,
          extraFeeClass: ExtraFeeClass.ALPHA
        }).outputAmount.quotient
      ).toEqual(JSBI.BigInt(9000))
    })

    it('applies on every hop of a multi hop route', async () => {
      const withFee = await Trade.fromRoute(
        new Route([pool_0_1_extra, pool_1_2_extra], token0, token2),
        CurrencyAmount.fromRawAmount(token0, 10000),
        TradeType.EXACT_INPUT,
        ExtraFeeClass.ALPHA
      )
      const oneHopOnly = await Trade.fromRoute(
        new Route([pool_0_1_extra, pool_1_2], token0, token2),
        CurrencyAmount.fromRawAmount(token0, 10000),
        TradeType.EXACT_INPUT,
        ExtraFeeClass.ALPHA
      )
      expect(withFee.outputAmount.lessThan(oneHopOnly.outputAmount)).toBe(true)
    })

    it('fromRoutes forwards the class to each route', async () => {
      const withFee = await Trade.fromRoutes<Token, Token, TradeType.EXACT_INPUT>(
        [
          {
            amount: CurrencyAmount.fromRawAmount(token0, 10000),
            route: new Route([pool_0_1_extra, pool_1_2_extra], token0, token2)
          }
        ],
        TradeType.EXACT_INPUT,
        ExtraFeeClass.ALPHA
      )
      // the 0.3% dex bucket on the same two pools: same routes, strictly more output than the 1% alpha one
      const cheaper = await Trade.fromRoutes<Token, Token, TradeType.EXACT_INPUT>(
        [
          {
            amount: CurrencyAmount.fromRawAmount(token0, 10000),
            route: new Route([pool_0_1_extra, pool_1_2_extra], token0, token2)
          }
        ],
        TradeType.EXACT_INPUT,
        ExtraFeeClass.DEX
      )
      expect(withFee.outputAmount.lessThan(cheaper.outputAmount)).toBe(true)
      expect(withFee.extraFeeClass).toEqual(ExtraFeeClass.ALPHA)
      expect(cheaper.extraFeeClass).toEqual(ExtraFeeClass.DEX)
    })

    it('bestTradeExactIn quotes and ranks with the extra fee, not around it', async () => {
      const [best] = await Trade.bestTradeExactIn(
        [pool_0_1_extra],
        CurrencyAmount.fromRawAmount(token0, 10000),
        token1,
        alphaOnly
      )
      // exactly the fromRoute quote for the same bucket ...
      const sameClass = await Trade.fromRoute(
        new Route([pool_0_1_extra], token0, token1),
        CurrencyAmount.fromRawAmount(token0, 10000),
        TradeType.EXACT_INPUT,
        ExtraFeeClass.ALPHA
      )
      expect(best.outputAmount.quotient).toEqual(sameClass.outputAmount.quotient)
      expect(best.extraFeeClass).toEqual(ExtraFeeClass.ALPHA)

      // ... and strictly worse than the curve-only twin, i.e. the 1% skim really was applied
      const curveOnly = await Trade.fromRoute(
        new Route([pool_0_1], token0, token1),
        CurrencyAmount.fromRawAmount(token0, 10000),
        TradeType.EXACT_INPUT,
        ExtraFeeClass.ALPHA
      )
      expect(best.outputAmount.lessThan(curveOnly.outputAmount)).toBe(true)
    })

    it('bestTradeExactIn ranks two identical pools by their bucket rates', async () => {
      // same curve, but pool A only charges the alpha bucket and pool B only the dex bucket
      const alphaPool = v2StylePool(
        CurrencyAmount.fromRawAmount(token0, 100000),
        CurrencyAmount.fromRawAmount(token1, 100000),
        60,
        3000,
        { alphaExtraTradeFeeRate: 50_000 }
      )
      const dexPool = v2StylePool(
        CurrencyAmount.fromRawAmount(token0, 100000),
        CurrencyAmount.fromRawAmount(token1, 100000),
        10,
        3000,
        { dexExtraTradeFeeRate: 50_000 }
      )
      const amountIn = CurrencyAmount.fromRawAmount(token0, 10000)

      const [bestForAlpha] = await Trade.bestTradeExactIn([alphaPool, dexPool], amountIn, token1, alphaOnly)
      expect(bestForAlpha.swaps[0].route.pools[0]).toBe(dexPool)

      const [bestForDex] = await Trade.bestTradeExactIn([alphaPool, dexPool], amountIn, token1, {
        extraFeeClass: ExtraFeeClass.DEX
      })
      expect(bestForDex.swaps[0].route.pools[0]).toBe(alphaPool)
    })

    it('bestTradeExactOut surcharges with the extra fee, not around it', async () => {
      const [best] = await Trade.bestTradeExactOut(
        [pool_0_1_extra],
        token0,
        CurrencyAmount.fromRawAmount(token1, 10000),
        alphaOnly
      )
      const sameClass = await Trade.fromRoute(
        new Route([pool_0_1_extra], token0, token1),
        CurrencyAmount.fromRawAmount(token1, 10000),
        TradeType.EXACT_OUTPUT,
        ExtraFeeClass.ALPHA
      )
      expect(best.inputAmount.quotient).toEqual(sameClass.inputAmount.quotient)
      expect(best.extraFeeClass).toEqual(ExtraFeeClass.ALPHA)

      const curveOnly = await Trade.fromRoute(
        new Route([pool_0_1], token0, token1),
        CurrencyAmount.fromRawAmount(token1, 10000),
        TradeType.EXACT_OUTPUT,
        ExtraFeeClass.ALPHA
      )
      // the exact-out surcharge makes the required input strictly larger
      expect(curveOnly.inputAmount.lessThan(best.inputAmount)).toBe(true)
    })
  })
})
