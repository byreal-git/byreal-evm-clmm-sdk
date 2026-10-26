import JSBI from 'jsbi'
import { Currency, CurrencyAmount, Ether, MaxUint256, Percent, Token, TradeType, WETH9 } from './core/index.js'
import { ADDRESS_THIS, ExtraFeeClass, MSG_SENDER } from './constants.js'
import { Pool } from './entities/pool.js'
import { Route } from './entities/route.js'
import { Trade } from './entities/trade.js'
import { SwapRouter } from './swapRouter.js'
import { encodeRouteToPath } from './utils/encodeRouteToPath.js'
import { encodeSqrtRatioX96 } from './utils/encodeSqrtRatioX96.js'
import { nearestUsableTick } from './utils/nearestUsableTick.js'
import { TickMath } from './utils/tickMath.js'

// This SDK ships no address book, so the fixtures register their own wrapped native token.
WETH9[1] = new Token(1, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18, 'WETH', 'Wrapped Ether')

const ROUTER = SwapRouter.INTERFACE
const MULTICALL_DEADLINE_SELECTOR = '0x5ae401dc' // multicall(uint256,bytes[])

type AnyTrade = Trade<Currency, Currency, TradeType>
interface Call {
  name: string
  args: Record<string, string>
}

/**
 * Decodes one inner router call into `{ name, args }` with every value stringified, so expectations can be
 * written field by field instead of as opaque hex. Overloads are resolved by selector, and since the decoded
 * argument names differ between overloads (e.g. `unwrapWETH9(uint256)` has no `recipient`), a deep-equal on
 * `args` also pins down which overload was selected.
 */
function decodeCall(call: string): Call {
  const fragment = ROUTER.getFunction(call.slice(0, 10))
  const decoded = ROUTER.decodeFunctionData(fragment, call)
  const isStruct = fragment.inputs.length === 1 && fragment.inputs[0].baseType === 'tuple'
  const inputs = isStruct ? fragment.inputs[0].components : fragment.inputs
  const values = isStruct ? decoded[0] : decoded

  const args: Record<string, string> = {}
  inputs.forEach((input, i) => {
    args[input.name] = String(values[i])
  })

  return { name: fragment.name, args }
}

/** Unwraps the mandatory `multicall(uint256,bytes[])` envelope. */
function decodeMulticall(calldata: string): { deadline: string; calls: Call[] } {
  expect(calldata.slice(0, 10)).toBe(MULTICALL_DEADLINE_SELECTOR)
  const [deadline, data] = ROUTER.decodeFunctionData('multicall(uint256,bytes[])', calldata)
  return { deadline: deadline.toString(), calls: [...data].map(decodeCall) }
}

describe('SwapRouter', () => {
  const ETHER = Ether.onChain(1)
  const token0 = new Token(1, '0x0000000000000000000000000000000000000001', 18, 't0', 'token0')
  const token1 = new Token(1, '0x0000000000000000000000000000000000000002', 18, 't1', 'token1')
  const token2 = new Token(1, '0x0000000000000000000000000000000000000003', 18, 't2', 'token2')
  const token3 = new Token(1, '0x0000000000000000000000000000000000000004', 18, 't3', 'token3')

  // Shared pool parameters keep calldata and amount assertions stable across router cases.
  const tickSpacing = 60
  const tradeFeeRate = 3000
  const sqrtRatioX96 = encodeSqrtRatioX96(1, 1)
  const liquidity = 1_000_000
  const WETH = WETH9[1]

  const makePool = (tokenA: Token, tokenB: Token) => {
    return new Pool(
      tokenA,
      tokenB,
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
          liquidityNet: -liquidity,
          liquidityGross: liquidity
        }
      ]
    )
  }

  const pool_0_1 = makePool(token0, token1)
  const pool_1_weth = makePool(token1, WETH)
  const pool_0_2 = makePool(token0, token2)
  const pool_0_3 = makePool(token0, token3)
  const pool_2_3 = makePool(token2, token3)
  const pool_3_weth = makePool(token3, WETH)
  const pool_1_3 = makePool(token3, token1)

  const slippageTolerance = new Percent(1, 100)
  const recipient = '0x0000000000000000000000000000000000000003'
  const deadline = 123
  // no `extraFeeClass` here on purpose: the router reads the bucket off the trades, never off the options
  const options = { slippageTolerance, recipient, deadline }
  const feeOptions = { fee: new Percent(5, 1000), recipient }

  // amounts are recomputed from the Trade itself, never copied out of a golden blob
  const inOf = (trade: AnyTrade, i = 0) =>
    trade.maximumAmountIn(slippageTolerance, trade.swaps[i].inputAmount).quotient.toString()
  const outOf = (trade: AnyTrade, i = 0) =>
    trade.minimumAmountOut(slippageTolerance, trade.swaps[i].outputAmount).quotient.toString()
  const totalOut = (trades: AnyTrade[]) =>
    trades
      .reduce((sum, trade) => JSBI.add(sum, trade.minimumAmountOut(slippageTolerance).quotient), JSBI.BigInt(0))
      .toString()

  interface SingleOverrides {
    sqrtPriceLimitX96?: string
    extraFeeClass?: string
  }

  const singleIn = (
    tokenIn: Token,
    tokenOut: Token,
    to: string,
    amountIn: string,
    amountOutMinimum: string,
    overrides: SingleOverrides = {}
  ): Call => ({
    name: 'exactInputSingle',
    args: {
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      tickSpacing: '60',
      recipient: to,
      amountIn,
      amountOutMinimum,
      sqrtPriceLimitX96: overrides.sqrtPriceLimitX96 ?? '0',
      extraFeeClass: overrides.extraFeeClass ?? '0'
    }
  })

  const singleOut = (
    tokenIn: Token,
    tokenOut: Token,
    to: string,
    amountOut: string,
    amountInMaximum: string,
    overrides: SingleOverrides = {}
  ): Call => ({
    name: 'exactOutputSingle',
    args: {
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      tickSpacing: '60',
      recipient: to,
      amountOut,
      amountInMaximum,
      sqrtPriceLimitX96: overrides.sqrtPriceLimitX96 ?? '0',
      extraFeeClass: overrides.extraFeeClass ?? '0'
    }
  })

  const pathIn = (
    route: Route<Currency, Currency>,
    to: string,
    amountIn: string,
    amountOutMinimum: string,
    extraFeeClass = '0'
  ): Call => ({
    name: 'exactInput',
    args: { path: encodeRouteToPath(route, false), recipient: to, amountIn, amountOutMinimum, extraFeeClass }
  })

  const pathOut = (
    route: Route<Currency, Currency>,
    to: string,
    amountOut: string,
    amountInMaximum: string,
    extraFeeClass = '0'
  ): Call => ({
    name: 'exactOutput',
    args: { path: encodeRouteToPath(route, true), recipient: to, amountOut, amountInMaximum, extraFeeClass }
  })

  const unwrapWETH9 = (amountMinimum: string): Call => ({
    name: 'unwrapWETH9',
    args: { amountMinimum, recipient }
  })

  const unwrapWETH9WithFee = (amountMinimum: string): Call => ({
    name: 'unwrapWETH9WithFee',
    args: { amountMinimum, recipient, feeBips: '50', feeRecipient: recipient }
  })

  const sweepTokenWithFee = (token: Token, amountMinimum: string): Call => ({
    name: 'sweepTokenWithFee',
    args: { token: token.address, amountMinimum, recipient, feeBips: '50', feeRecipient: recipient }
  })

  const refundETH: Call = { name: 'refundETH', args: {} }

  describe('#swapCallParameters', () => {
    describe('single trade input', () => {
      it('single-hop exact input', async () => {
        const trade = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata, value } = SwapRouter.swapCallParameters(trade, options)
        const { deadline: encodedDeadline, calls } = decodeMulticall(calldata)

        expect(encodedDeadline).toBe('123')
        expect(inOf(trade)).toBe('100') // amountIn 0x64
        expect(outOf(trade)).toBe('97') // amountOutMinimum 0x61
        expect(calls).toEqual([singleIn(token0, token1, recipient, '100', '97')])
        expect(value).toBe('0x00')

        // full-calldata regression anchor; every field in it is pinned by the assertions above
        expect(calldata).toMatchInlineSnapshot(`"0x5ae401dc000000000000000000000000000000000000000000000000000000000000007b00000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000001048df0dee500000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000003c0000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006400000000000000000000000000000000000000000000000000000000000000610000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"`)
      })

      it('single-hop exact output', async () => {
        const trade = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token1, 100),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata, value } = SwapRouter.swapCallParameters(trade, options)
        const { calls } = decodeMulticall(calldata)

        expect(outOf(trade)).toBe('100') // amountOut 0x64
        expect(inOf(trade)).toBe('103') // amountInMaximum 0x67
        expect(calls).toEqual([singleOut(token0, token1, recipient, '100', '103')])
        expect(value).toBe('0x00')
      })

      it('multi-hop exact input', async () => {
        const route = new Route([pool_0_1, pool_1_weth], token0, WETH)
        const trade = await Trade.fromRoute(
          route,
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata, value } = SwapRouter.swapCallParameters(trade, options)
        const { calls } = decodeMulticall(calldata)

        expect(outOf(trade)).toBe('95') // amountOutMinimum 0x5f
        expect(calls).toEqual([pathIn(route, recipient, '100', '95')])
        // tickSpacing (3 bytes) replaces the fee tier in the packed path
        expect(calls[0].args.path).toBe(
          '0x0000000000000000000000000000000000000001' +
            '00003c' +
            '0000000000000000000000000000000000000002' +
            '00003c' +
            'c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
        )
        expect(value).toBe('0x00')
      })

      it('multi-hop exact output', async () => {
        const route = new Route([pool_0_1, pool_1_weth], token0, WETH)
        const trade = await Trade.fromRoute(
          route,
          CurrencyAmount.fromRawAmount(WETH, 100),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata, value } = SwapRouter.swapCallParameters(trade, options)
        const { calls } = decodeMulticall(calldata)

        expect(inOf(trade)).toBe('105') // amountInMaximum 0x69
        expect(calls).toEqual([pathOut(route, recipient, '100', '105')])
        // exact output reverses the path
        expect(calls[0].args.path).toBe(
          '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' +
            '00003c' +
            '0000000000000000000000000000000000000002' +
            '00003c' +
            '0000000000000000000000000000000000000001'
        )
        expect(value).toBe('0x00')
      })

      it('ETH in exact input', async () => {
        const trade = await Trade.fromRoute(
          new Route([pool_1_weth], ETHER, token1),
          CurrencyAmount.fromRawAmount(Ether.onChain(1), 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata, value } = SwapRouter.swapCallParameters(trade, options)
        const { calls } = decodeMulticall(calldata)

        // a native input always ends in refundETH: exact-in can fill partially, and msg.value is the full max
        expect(calls).toEqual([singleIn(WETH, token1, recipient, '100', outOf(trade)), refundETH])
        expect(value).toBe('0x64')
      })

      it('ETH in exact input with a price limit still refunds', async () => {
        // a sqrtPriceLimitX96 is exactly the case where a single-hop exact-in stops early and leaves ETH behind
        const trade = await Trade.fromRoute(
          new Route([pool_1_weth], ETHER, token1),
          CurrencyAmount.fromRawAmount(Ether.onChain(1), 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata, value } = SwapRouter.swapCallParameters(trade, {
          ...options,
          sqrtPriceLimitX96: JSBI.exponentiate(JSBI.BigInt(2), JSBI.BigInt(128))
        })
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          singleIn(WETH, token1, recipient, '100', outOf(trade), {
            sqrtPriceLimitX96: '340282366920938463463374607431768211456'
          }),
          refundETH
        ])
        expect(calls[calls.length - 1]).toEqual(refundETH)
        expect(value).toBe('0x64')
      })

      it('ETH in exact output', async () => {
        const trade = await Trade.fromRoute(
          new Route([pool_1_weth], ETHER, token1),
          CurrencyAmount.fromRawAmount(token1, 100),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata, value } = SwapRouter.swapCallParameters(trade, options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([singleOut(WETH, token1, recipient, '100', '103'), refundETH])
        expect(value).toBe('0x67')
      })

      it('ETH out exact input', async () => {
        const trade = await Trade.fromRoute(
          new Route([pool_1_weth], token1, ETHER),
          CurrencyAmount.fromRawAmount(token1, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata, value } = SwapRouter.swapCallParameters(trade, options)
        const { calls } = decodeMulticall(calldata)

        // custody is spelled ADDRESS_THIS, not ADDRESS_ZERO: the router has no address(0) fallback
        expect(calls).toEqual([singleIn(token1, WETH, ADDRESS_THIS, '100', '97'), unwrapWETH9('97')])
        expect(value).toBe('0x00')

        expect(calldata).toMatchInlineSnapshot(`"0x5ae401dc000000000000000000000000000000000000000000000000000000000000007b000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001048df0dee50000000000000000000000000000000000000000000000000000000000000002000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000000000000000000000000000000000000000003c0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000006400000000000000000000000000000000000000000000000000000000000000610000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004449404b7c0000000000000000000000000000000000000000000000000000000000000061000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000"`)
      })

      it('ETH out exact output', async () => {
        const trade = await Trade.fromRoute(
          new Route([pool_1_weth], token1, ETHER),
          CurrencyAmount.fromRawAmount(Ether.onChain(1), 100),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata, value } = SwapRouter.swapCallParameters(trade, options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([singleOut(token1, WETH, ADDRESS_THIS, '100', '103'), unwrapWETH9('100')])
        expect(value).toBe('0x00')
      })

      it('sqrtPriceLimitX96', async () => {
        const trade = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata, value } = SwapRouter.swapCallParameters(trade, {
          ...options,
          sqrtPriceLimitX96: JSBI.exponentiate(JSBI.BigInt(2), JSBI.BigInt(128))
        })
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          singleIn(token0, token1, recipient, '100', '97', {
            sqrtPriceLimitX96: '340282366920938463463374607431768211456'
          })
        ])
        expect(value).toBe('0x00')
      })

      it('sqrtPriceLimitX96 on a multi-hop route fails', async () => {
        const trade = await Trade.fromRoute(
          new Route([pool_0_1, pool_1_weth], token0, WETH),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )

        expect(() =>
          SwapRouter.swapCallParameters(trade, {
            ...options,
            sqrtPriceLimitX96: JSBI.exponentiate(JSBI.BigInt(2), JSBI.BigInt(128))
          })
        ).toThrow('MULTIHOP_PRICE_LIMIT')
      })

      it('fee with eth out', async () => {
        const trade = await Trade.fromRoute(
          new Route([pool_1_weth], token1, ETHER),
          CurrencyAmount.fromRawAmount(token1, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata, value } = SwapRouter.swapCallParameters(trade, { ...options, fee: feeOptions })
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([singleIn(token1, WETH, ADDRESS_THIS, '100', '97'), unwrapWETH9WithFee('97')])
        expect(value).toBe('0x00')
      })

      it('fee with eth in using exact output', async () => {
        const trade = await Trade.fromRoute(
          new Route([pool_1_weth], ETHER, token1),
          CurrencyAmount.fromRawAmount(token1, 10),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata, value } = SwapRouter.swapCallParameters(trade, { ...options, fee: feeOptions })
        const { calls } = decodeMulticall(calldata)

        expect(inOf(trade)).toBe('12') // amountInMaximum 0x0c
        expect(calls).toEqual([
          singleOut(WETH, token1, ADDRESS_THIS, '10', '12'),
          sweepTokenWithFee(token1, '10'),
          refundETH
        ])
        expect(value).toBe('0x0c')
      })

      it('fee', async () => {
        const trade = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata, value } = SwapRouter.swapCallParameters(trade, { ...options, fee: feeOptions })
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          singleIn(token0, token1, ADDRESS_THIS, '100', '97'),
          sweepTokenWithFee(token1, '97')
        ])
        expect(value).toBe('0x00')
      })
    })

    describe('multiple trade input', () => {
      it('two single-hop exact input', async () => {
        const trade1 = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const trade2 = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade1, trade2], options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          singleIn(token0, token1, recipient, '100', '97'),
          singleIn(token0, token1, recipient, '100', '97')
        ])
        expect(value).toBe('0x00')
      })

      it('one single-hop one multi-hop exact input', async () => {
        const route2 = new Route([pool_0_2, pool_2_3], token0, token3)
        const trade1 = await Trade.fromRoute(
          new Route([pool_0_3], token0, token3),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const trade2 = await Trade.fromRoute(
          route2,
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade1, trade2], options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          singleIn(token0, token3, recipient, '100', '97'),
          pathIn(route2, recipient, '100', '95')
        ])
        expect(value).toBe('0x00')
      })

      it('two multi-hop exact input', async () => {
        const route1 = new Route([pool_0_1, pool_1_3], token0, token3)
        const route2 = new Route([pool_0_2, pool_2_3], token0, token3)
        const trade1 = await Trade.fromRoute(
          route1,
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const trade2 = await Trade.fromRoute(
          route2,
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade1, trade2], options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          pathIn(route1, recipient, '100', '95'),
          pathIn(route2, recipient, '100', '95')
        ])
        expect(value).toBe('0x00')
      })

      it('ETH in exact input', async () => {
        const route1 = new Route([pool_1_weth, pool_1_3], ETHER, token3)
        const trade1 = await Trade.fromRoute(
          route1,
          CurrencyAmount.fromRawAmount(Ether.onChain(1), 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const trade2 = await Trade.fromRoute(
          new Route([pool_3_weth], ETHER, token3),
          CurrencyAmount.fromRawAmount(Ether.onChain(1), 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade1, trade2], options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          pathIn(route1, recipient, '100', '95'),
          singleIn(WETH, token3, recipient, '100', '97'),
          refundETH
        ])
        expect(value).toBe('0xc8')
      })

      it('ETH in exact output', async () => {
        const route1 = new Route([pool_1_weth, pool_1_3], ETHER, token3)
        const trade1 = await Trade.fromRoute(
          route1,
          CurrencyAmount.fromRawAmount(token3, 100),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )
        const trade2 = await Trade.fromRoute(
          new Route([pool_3_weth], ETHER, token3),
          CurrencyAmount.fromRawAmount(token3, 100),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade1, trade2], options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          pathOut(route1, recipient, '100', '105'),
          singleOut(WETH, token3, recipient, '100', '103'),
          refundETH
        ])
        expect(value).toBe('0xd0')
      })

      it('ETH out exact input', async () => {
        const route1 = new Route([pool_1_3, pool_1_weth], token3, ETHER)
        const trade1 = await Trade.fromRoute(
          route1,
          CurrencyAmount.fromRawAmount(token3, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const trade2 = await Trade.fromRoute(
          new Route([pool_3_weth], token3, ETHER),
          CurrencyAmount.fromRawAmount(token3, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade1, trade2], options)
        const { calls } = decodeMulticall(calldata)

        expect(totalOut([trade1, trade2])).toBe('192') // unwrap amountMinimum 0xc0
        expect(calls).toEqual([
          pathIn(route1, ADDRESS_THIS, '100', '95'),
          singleIn(token3, WETH, ADDRESS_THIS, '100', '97'),
          unwrapWETH9('192')
        ])
        expect(value).toBe('0x00')
      })

      it('ETH out exact output', async () => {
        const route1 = new Route([pool_1_3, pool_1_weth], token3, ETHER)
        const trade1 = await Trade.fromRoute(
          route1,
          CurrencyAmount.fromRawAmount(Ether.onChain(1), 100),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )
        const trade2 = await Trade.fromRoute(
          new Route([pool_3_weth], token3, ETHER),
          CurrencyAmount.fromRawAmount(Ether.onChain(1), 100),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade1, trade2], options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          pathOut(route1, ADDRESS_THIS, '100', '105'),
          singleOut(token3, WETH, ADDRESS_THIS, '100', '103'),
          unwrapWETH9('200')
        ])
        expect(value).toBe('0x00')
      })

      it('two single-hop exact output', async () => {
        const trade1 = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token1, 100),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )
        const trade2 = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token1, 100),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade1, trade2], options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          singleOut(token0, token1, recipient, '100', '103'),
          singleOut(token0, token1, recipient, '100', '103')
        ])
        expect(value).toBe('0x00')
      })

      it('one single-hop one multi-hop exact output', async () => {
        const route2 = new Route([pool_0_2, pool_2_3], token0, token3)
        const trade1 = await Trade.fromRoute(
          new Route([pool_0_3], token0, token3),
          CurrencyAmount.fromRawAmount(token3, 100),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )
        const trade2 = await Trade.fromRoute(
          route2,
          CurrencyAmount.fromRawAmount(token3, 100),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade1, trade2], options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          singleOut(token0, token3, recipient, '100', '103'),
          pathOut(route2, recipient, '100', '105')
        ])
        expect(value).toBe('0x00')
      })

      it('two multi-hop exact output', async () => {
        const route1 = new Route([pool_0_1, pool_1_3], token0, token3)
        const route2 = new Route([pool_0_2, pool_2_3], token0, token3)
        const trade1 = await Trade.fromRoute(
          route1,
          CurrencyAmount.fromRawAmount(token3, 100),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )
        const trade2 = await Trade.fromRoute(
          route2,
          CurrencyAmount.fromRawAmount(token3, 100),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade1, trade2], options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          pathOut(route1, recipient, '100', '105'),
          pathOut(route2, recipient, '100', '105')
        ])
        expect(value).toBe('0x00')
      })

      it('different token in fails', async () => {
        const trade1 = await Trade.fromRoute(
          new Route([pool_2_3], token2, token3),
          CurrencyAmount.fromRawAmount(token2, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const trade2 = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )

        expect(() => SwapRouter.swapCallParameters([trade1, trade2], options)).toThrow('TOKEN_IN_DIFF')
      })

      it('different token out fails', async () => {
        const trade1 = await Trade.fromRoute(
          new Route([pool_0_3], token0, token3),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const trade2 = await Trade.fromRoute(
          new Route([pool_0_1, pool_1_weth], token0, WETH),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )

        expect(() => SwapRouter.swapCallParameters([trade1, trade2], options)).toThrow('TOKEN_OUT_DIFF')
      })

      it('sqrtPriceLimitX96', async () => {
        const trade1 = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const trade2 = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade1, trade2], {
          ...options,
          sqrtPriceLimitX96: JSBI.exponentiate(JSBI.BigInt(2), JSBI.BigInt(128))
        })
        const { calls } = decodeMulticall(calldata)
        const limit = { sqrtPriceLimitX96: '340282366920938463463374607431768211456' }

        expect(calls).toEqual([
          singleIn(token0, token1, recipient, '100', '97', limit),
          singleIn(token0, token1, recipient, '100', '97', limit)
        ])
        expect(value).toBe('0x00')
      })

      it('fee with eth out', async () => {
        const route1 = new Route([pool_1_3, pool_1_weth], token3, ETHER)
        const trade1 = await Trade.fromRoute(
          route1,
          CurrencyAmount.fromRawAmount(token3, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const trade2 = await Trade.fromRoute(
          new Route([pool_3_weth], token3, ETHER),
          CurrencyAmount.fromRawAmount(token3, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade1, trade2], { ...options, fee: feeOptions })
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          pathIn(route1, ADDRESS_THIS, '100', '95'),
          singleIn(token3, WETH, ADDRESS_THIS, '100', '97'),
          unwrapWETH9WithFee('192')
        ])
        expect(value).toBe('0x00')
      })

      it('fee with eth in using exact output', async () => {
        const route1 = new Route([pool_1_weth, pool_1_3], ETHER, token3)
        const trade1 = await Trade.fromRoute(
          route1,
          CurrencyAmount.fromRawAmount(token3, 100),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )
        const trade2 = await Trade.fromRoute(
          new Route([pool_3_weth], ETHER, token3),
          CurrencyAmount.fromRawAmount(token3, 100),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade1, trade2], { ...options, fee: feeOptions })
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          pathOut(route1, ADDRESS_THIS, '100', '105'),
          singleOut(WETH, token3, ADDRESS_THIS, '100', '103'),
          sweepTokenWithFee(token3, '200'),
          refundETH
        ])
        expect(value).toBe('0xd0')
      })

      it('fee', async () => {
        const route1 = new Route([pool_0_1, pool_1_3], token0, token3)
        const route2 = new Route([pool_0_2, pool_2_3], token0, token3)
        const trade1 = await Trade.fromRoute(
          route1,
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const trade2 = await Trade.fromRoute(
          route2,
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade1, trade2], { ...options, fee: feeOptions })
        const { calls } = decodeMulticall(calldata)

        expect(totalOut([trade1, trade2])).toBe('190') // sweep amountMinimum 0xbe
        expect(calls).toEqual([
          pathIn(route1, ADDRESS_THIS, '100', '95'),
          pathIn(route2, ADDRESS_THIS, '100', '95'),
          sweepTokenWithFee(token3, '190')
        ])
        expect(value).toBe('0x00')
      })
    })

    describe('trade with multiple routes', () => {
      it('one single-hop one multi-hop exact input', async () => {
        const route2 = new Route([pool_0_2, pool_2_3], token0, token3)
        const trade = await Trade.fromRoutes<Token, Token, TradeType.EXACT_INPUT>(
          [
            { amount: CurrencyAmount.fromRawAmount(token0, 100), route: new Route([pool_0_3], token0, token3) },
            { amount: CurrencyAmount.fromRawAmount(token0, 100), route: route2 }
          ],
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade], options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          singleIn(token0, token3, recipient, inOf(trade, 0), outOf(trade, 0)),
          pathIn(route2, recipient, inOf(trade, 1), outOf(trade, 1))
        ])
        expect(calls[0].args.amountOutMinimum).toBe('97')
        expect(calls[1].args.amountOutMinimum).toBe('95')
        expect(value).toBe('0x00')
      })

      it('two multi-hop exact input', async () => {
        const route1 = new Route([pool_0_1, pool_1_3], token0, token3)
        const route2 = new Route([pool_0_2, pool_2_3], token0, token3)
        const trade = await Trade.fromRoutes<Token, Token, TradeType.EXACT_INPUT>(
          [
            { amount: CurrencyAmount.fromRawAmount(token0, 100), route: route1 },
            { amount: CurrencyAmount.fromRawAmount(token0, 100), route: route2 }
          ],
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade], options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          pathIn(route1, recipient, '100', '95'),
          pathIn(route2, recipient, '100', '95')
        ])
        expect(value).toBe('0x00')
      })

      it('ETH in exact input', async () => {
        const route1 = new Route([pool_1_weth, pool_1_3], ETHER, token3)
        const route2 = new Route([pool_3_weth], ETHER, token3)
        const trade = await Trade.fromRoutes<Ether, Token, TradeType.EXACT_INPUT>(
          [
            { amount: CurrencyAmount.fromRawAmount(Ether.onChain(1), 100), route: route1 },
            { amount: CurrencyAmount.fromRawAmount(Ether.onChain(1), 100), route: route2 }
          ],
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade], options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          pathIn(route1, recipient, '100', '95'),
          singleIn(WETH, token3, recipient, '100', '97'),
          refundETH
        ])
        expect(value).toBe('0xc8')
      })

      it('ETH in exact output', async () => {
        const route1 = new Route([pool_1_weth, pool_1_3], ETHER, token3)
        const route2 = new Route([pool_3_weth], ETHER, token3)
        const trade = await Trade.fromRoutes<Ether, Token, TradeType.EXACT_OUTPUT>(
          [
            { amount: CurrencyAmount.fromRawAmount(token3, 100), route: route1 },
            { amount: CurrencyAmount.fromRawAmount(token3, 100), route: route2 }
          ],
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade], options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          pathOut(route1, recipient, '100', '105'),
          singleOut(WETH, token3, recipient, '100', '103'),
          refundETH
        ])
        expect(value).toBe('0xd0')
      })

      it('ETH out exact input', async () => {
        const route1 = new Route([pool_1_3, pool_1_weth], token3, ETHER)
        const route2 = new Route([pool_3_weth], token3, ETHER)
        const trade = await Trade.fromRoutes<Token, Ether, TradeType.EXACT_INPUT>(
          [
            { amount: CurrencyAmount.fromRawAmount(token3, 100), route: route1 },
            { amount: CurrencyAmount.fromRawAmount(token3, 100), route: route2 }
          ],
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade], options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          pathIn(route1, ADDRESS_THIS, '100', '95'),
          singleIn(token3, WETH, ADDRESS_THIS, '100', '97'),
          unwrapWETH9(totalOut([trade]))
        ])
        expect(totalOut([trade])).toBe('192') // amountMinimum 0xc0
        expect(value).toBe('0x00')
      })

      it('ETH out exact output', async () => {
        const route1 = new Route([pool_1_3, pool_1_weth], token3, ETHER)
        const route2 = new Route([pool_3_weth], token3, ETHER)
        const trade = await Trade.fromRoutes<Token, Ether, TradeType.EXACT_OUTPUT>(
          [
            { amount: CurrencyAmount.fromRawAmount(Ether.onChain(1), 100), route: route1 },
            { amount: CurrencyAmount.fromRawAmount(Ether.onChain(1), 100), route: route2 }
          ],
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade], options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          pathOut(route1, ADDRESS_THIS, '100', '105'),
          singleOut(token3, WETH, ADDRESS_THIS, '100', '103'),
          unwrapWETH9('200')
        ])
        expect(value).toBe('0x00')
      })

      it('one single-hop one multi-hop exact output', async () => {
        const route2 = new Route([pool_0_2, pool_2_3], token0, token3)
        const trade = await Trade.fromRoutes<Token, Token, TradeType.EXACT_OUTPUT>(
          [
            { amount: CurrencyAmount.fromRawAmount(token3, 100), route: new Route([pool_0_3], token0, token3) },
            { amount: CurrencyAmount.fromRawAmount(token3, 100), route: route2 }
          ],
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade], options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          singleOut(token0, token3, recipient, '100', '103'),
          pathOut(route2, recipient, '100', '105')
        ])
        expect(value).toBe('0x00')
      })

      it('two multi-hop exact output', async () => {
        const route1 = new Route([pool_0_1, pool_1_3], token0, token3)
        const route2 = new Route([pool_0_2, pool_2_3], token0, token3)
        const trade = await Trade.fromRoutes<Token, Token, TradeType.EXACT_OUTPUT>(
          [
            { amount: CurrencyAmount.fromRawAmount(token3, 100), route: route1 },
            { amount: CurrencyAmount.fromRawAmount(token3, 100), route: route2 }
          ],
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )

        const { calldata, value } = SwapRouter.swapCallParameters([trade], options)
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          pathOut(route1, recipient, '100', '105'),
          pathOut(route2, recipient, '100', '105')
        ])
        expect(value).toBe('0x00')
      })
    })

    describe('Byreal specifics', () => {
      it('always wraps in multicall(uint256,bytes[]), even a single call', async () => {
        const trade = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata } = SwapRouter.swapCallParameters(trade, { ...options, deadline: '0xdeadbeef' })
        const { deadline: encodedDeadline, calls } = decodeMulticall(calldata)

        expect(calls).toHaveLength(1)
        expect(encodedDeadline).toBe('3735928559')
        // the inner call is a bare exactInputSingle, i.e. the wrapper is the only deadline carrier
        expect(calls[0].name).toBe('exactInputSingle')
        expect(Object.keys(calls[0].args)).toEqual([
          'tokenIn',
          'tokenOut',
          'tickSpacing',
          'recipient',
          'amountIn',
          'amountOutMinimum',
          'sqrtPriceLimitX96',
          'extraFeeClass'
        ])
      })

      it('writes the trade own extraFeeClass on every swap variant', async () => {
        const singleRoute = new Route([pool_0_1], token0, token1)
        const multiRoute = new Route([pool_0_1, pool_1_3], token0, token3)

        // the encoded bucket is the one the Trade was quoted with, so both classes are genuinely quoted here
        // (these fixture pools carry no `extra`, so ALPHA and DEX price identically and only the byte differs)
        for (const [extraFeeClass, encoded] of [
          [ExtraFeeClass.ALPHA, '0'],
          [ExtraFeeClass.DEX, '1']
        ] as [ExtraFeeClass, string][]) {
          const trades = [
            await Trade.fromRoute(
              singleRoute,
              CurrencyAmount.fromRawAmount(token0, 100),
              TradeType.EXACT_INPUT,
              extraFeeClass
            ),
            await Trade.fromRoute(
              singleRoute,
              CurrencyAmount.fromRawAmount(token1, 100),
              TradeType.EXACT_OUTPUT,
              extraFeeClass
            ),
            await Trade.fromRoute(
              multiRoute,
              CurrencyAmount.fromRawAmount(token0, 100),
              TradeType.EXACT_INPUT,
              extraFeeClass
            ),
            await Trade.fromRoute(
              multiRoute,
              CurrencyAmount.fromRawAmount(token3, 100),
              TradeType.EXACT_OUTPUT,
              extraFeeClass
            )
          ]

          for (const trade of trades) {
            expect(trade.extraFeeClass).toBe(extraFeeClass)
            const { calls } = decodeMulticall(SwapRouter.swapCallParameters(trade, options).calldata)
            expect(calls[0].args.extraFeeClass).toBe(encoded)
          }
        }
      })

      it('refuses a batch that mixes extraFeeClass buckets', async () => {
        // one call names exactly one bucket, so a batch quoted against two of them has no correct encoding
        const route = new Route([pool_0_1], token0, token1)
        const alpha = await Trade.fromRoute(
          route,
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const dex = await Trade.fromRoute(
          route,
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.DEX
        )

        expect(() => SwapRouter.swapCallParameters([alpha, dex], options)).toThrow('CLASS_MISMATCH')

        // ...while a batch that agrees on one bucket still encodes that bucket
        const { calls } = decodeMulticall(SwapRouter.swapCallParameters([dex, dex], options).calldata)
        expect(calls.map(call => call.args.extraFeeClass)).toEqual(['1', '1'])
      })

      it('refuses to encode a bucket outside the pool domain, even from a duck-typed trade', async () => {
        // the Trade constructor pins a valid bucket, but plain JS can hand the router an arbitrary object —
        // never emit a class the pool would revert on ('CLASS')
        const trade = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const forged = Object.create(trade) // shadows the frozen own property via the prototype chain
        Object.defineProperty(forged, 'extraFeeClass', { value: 2 })
        expect(() => SwapRouter.swapCallParameters([forged], options)).toThrow('CLASS')
      })

      it('accepts the MSG_SENDER recipient sentinel', async () => {
        const trade = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata } = SwapRouter.swapCallParameters(trade, { ...options, recipient: MSG_SENDER })
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([singleIn(token0, token1, MSG_SENDER, '100', '97')])
      })

      it('unwraps to the recipient-less overload for a MSG_SENDER sentinel with ETH out', async () => {
        // the payment functions do not resolve the sentinels, so an explicit `recipient: MSG_SENDER`
        // would literally pay 0x..01; `unwrapWETH9(uint256)` is the equivalent spelling of msg.sender
        const trade = await Trade.fromRoute(
          new Route([pool_1_weth], token1, ETHER),
          CurrencyAmount.fromRawAmount(token1, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata } = SwapRouter.swapCallParameters(trade, { ...options, recipient: MSG_SENDER })
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          singleIn(token1, WETH, ADDRESS_THIS, '100', '97'),
          // no `recipient` key at all — the deep-equal pins down the 1-arg overload
          { name: 'unwrapWETH9', args: { amountMinimum: '97' } }
        ])

        // and pinned by selector, not just by the decoded shape
        const [, data] = ROUTER.decodeFunctionData('multicall(uint256,bytes[])', calldata)
        expect(data[1].slice(0, 10)).toBe(ROUTER.getSighash('unwrapWETH9(uint256)'))
        expect(ROUTER.getSighash('unwrapWETH9(uint256)')).not.toBe(ROUTER.getSighash('unwrapWETH9(uint256,address)'))
      })

      it('refuses a MSG_SENDER sentinel combined with a fee', async () => {
        // unwrapWETH9WithFee / sweepTokenWithFee are only encoded through their explicit-recipient overloads
        const ethOut = await Trade.fromRoute(
          new Route([pool_1_weth], token1, ETHER),
          CurrencyAmount.fromRawAmount(token1, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        expect(() =>
          SwapRouter.swapCallParameters(ethOut, { ...options, recipient: MSG_SENDER, fee: feeOptions })
        ).toThrow('SENTINEL_RECIPIENT')

        const tokenOut = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        expect(() =>
          SwapRouter.swapCallParameters(tokenOut, { ...options, recipient: MSG_SENDER, fee: feeOptions })
        ).toThrow('SENTINEL_RECIPIENT')
      })

      it('refuses an ADDRESS_THIS sentinel on every path', async () => {
        // custody path: the payment overloads do not resolve sentinels, so the funds would go to 0x..02
        const ethOut = await Trade.fromRoute(
          new Route([pool_1_weth], token1, ETHER),
          CurrencyAmount.fromRawAmount(token1, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        expect(() => SwapRouter.swapCallParameters(ethOut, { ...options, recipient: ADDRESS_THIS })).toThrow(
          'SENTINEL_RECIPIENT'
        )
        expect(() =>
          SwapRouter.swapCallParameters(ethOut, { ...options, recipient: ADDRESS_THIS, fee: feeOptions })
        ).toThrow('SENTINEL_RECIPIENT')

        // and the non-custody ERC20 output too: the swap would pay the router, where the public sweepToken
        // lets any later caller take the proceeds — no sweep of our own is emitted to rescue them
        const tokenOut = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        expect(() => SwapRouter.swapCallParameters(tokenOut, { ...options, recipient: ADDRESS_THIS })).toThrow(
          'SENTINEL_RECIPIENT'
        )

        // exact-output is no different
        const exactOut = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token1, 100),
          TradeType.EXACT_OUTPUT,
          ExtraFeeClass.ALPHA
        )
        expect(() => SwapRouter.swapCallParameters(exactOut, { ...options, recipient: ADDRESS_THIS })).toThrow(
          'SENTINEL_RECIPIENT'
        )
      })

      it('rejects a deadline that cannot be enforced', async () => {
        const trade = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )

        // a JS caller (or an `as any`) can drop the field the type system says is mandatory
        const { deadline: _deadline, ...noDeadline } = options
        expect(() => SwapRouter.swapCallParameters(trade, noDeadline as any)).toThrow('DEADLINE')

        const overUint256 = JSBI.add(MaxUint256, JSBI.BigInt(1))
        for (const bad of [undefined, null, 0, -1, '-1', 1.5, '', 'soon', NaN, Infinity, overUint256]) {
          expect(() => SwapRouter.swapCallParameters(trade, { ...options, deadline: bad as any })).toThrow(
            'DEADLINE'
          )
        }

        // the boundary itself is still fine
        expect(() =>
          SwapRouter.swapCallParameters(trade, { ...options, deadline: MaxUint256.toString() })
        ).not.toThrow()
      })

      it('encodes a standard permit before the swap', async () => {
        const trade = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata } = SwapRouter.swapCallParameters(trade, {
          ...options,
          inputTokenPermit: {
            v: 0,
            r: '0x0000000000000000000000000000000000000000000000000000000000000001',
            s: '0x0000000000000000000000000000000000000000000000000000000000000002',
            amount: 100,
            deadline: 123
          }
        })
        const { calls } = decodeMulticall(calldata)

        expect(calls).toEqual([
          {
            name: 'selfPermit',
            args: {
              token: token0.address,
              value: '100',
              deadline: '123',
              v: '0',
              r: '0x0000000000000000000000000000000000000000000000000000000000000001',
              s: '0x0000000000000000000000000000000000000000000000000000000000000002'
            }
          },
          singleIn(token0, token1, recipient, '100', '97')
        ])
      })

      it('encodes an allowed permit before the swap', async () => {
        const trade = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token0, 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        const { calldata } = SwapRouter.swapCallParameters(trade, {
          ...options,
          inputTokenPermit: {
            v: 0,
            r: '0x0000000000000000000000000000000000000000000000000000000000000001',
            s: '0x0000000000000000000000000000000000000000000000000000000000000002',
            nonce: 1,
            expiry: 123
          }
        })
        const { calls } = decodeMulticall(calldata)

        expect(calls[0].name).toBe('selfPermitAllowed')
        expect(calls[0].args).toEqual({
          token: token0.address,
          nonce: '1',
          expiry: '123',
          v: '0',
          r: '0x0000000000000000000000000000000000000000000000000000000000000001',
          s: '0x0000000000000000000000000000000000000000000000000000000000000002'
        })
        expect(calls[1].name).toBe('exactInputSingle')
      })

      it('rejects a permit on a native input', async () => {
        const trade = await Trade.fromRoute(
          new Route([pool_1_weth], ETHER, token1),
          CurrencyAmount.fromRawAmount(Ether.onChain(1), 100),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )

        expect(() =>
          SwapRouter.swapCallParameters(trade, {
            ...options,
            inputTokenPermit: {
              v: 0,
              r: '0x0000000000000000000000000000000000000000000000000000000000000001',
              s: '0x0000000000000000000000000000000000000000000000000000000000000002',
              amount: 100,
              deadline: 123
            }
          })
        ).toThrow('NON_TOKEN_PERMIT')
      })

      it('refuses an amount that would encode as 0 (CONTRACT_BALANCE)', async () => {
        // 1 in against this fixture yields 0 out, so the output bound rounds down to 0
        const dust = await Trade.fromRoute(
          new Route([pool_0_1], token0, token1),
          CurrencyAmount.fromRawAmount(token0, 1),
          TradeType.EXACT_INPUT,
          ExtraFeeClass.ALPHA
        )
        expect(dust.outputAmount.quotient.toString()).toBe('0')
        expect(() => SwapRouter.swapCallParameters(dust, options)).toThrow('ZERO_AMOUNT')

        // and a zero input, which the router would read as "swap my whole balance". `fromRoute` can no longer
        // quote a zero amount at all (Pool 'AMOUNT'), so the trade is built unchecked to reach the router guard
        const empty = Trade.createUncheckedTrade({
          route: new Route([pool_0_1], token0, token1),
          inputAmount: CurrencyAmount.fromRawAmount(token0, 0),
          outputAmount: CurrencyAmount.fromRawAmount(token1, 0),
          tradeType: TradeType.EXACT_INPUT,
          extraFeeClass: ExtraFeeClass.ALPHA
        })
        expect(() => SwapRouter.swapCallParameters(empty, options)).toThrow('ZERO_AMOUNT')
      })

      it('encodes the Byreal struct layouts', () => {
        // Pin the canonical signatures: pool identity uses tickSpacing, deadline is outside the struct,
        // and extraFeeClass is the trailing member.
        expect(ROUTER.getFunction('exactInputSingle').format()).toBe(
          'exactInputSingle((address,address,int24,address,uint256,uint256,uint160,uint8))'
        )
        expect(ROUTER.getFunction('exactOutputSingle').format()).toBe(
          'exactOutputSingle((address,address,int24,address,uint256,uint256,uint160,uint8))'
        )
        expect(ROUTER.getFunction('exactInput').format()).toBe('exactInput((bytes,address,uint256,uint256,uint8))')
        expect(ROUTER.getFunction('exactOutput').format()).toBe('exactOutput((bytes,address,uint256,uint256,uint8))')

        expect(ROUTER.getSighash('exactInputSingle')).toBe('0x8df0dee5')
        expect(ROUTER.getSighash('exactOutputSingle')).toBe('0xfd6d7477')
        expect(ROUTER.getSighash('exactInput')).toBe('0x195d4835')
        expect(ROUTER.getSighash('exactOutput')).toBe('0x7d006b44')
      })
    })
  })
})
