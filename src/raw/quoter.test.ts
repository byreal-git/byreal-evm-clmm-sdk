import JSBI from 'jsbi'
import { CurrencyAmount, Ether, Token, TradeType, WETH9 } from './core/index.js'
import { ExtraFeeClass } from './constants.js'
import { Pool } from './entities/pool.js'
import { Route } from './entities/route.js'
import { SwapQuoter } from './quoter.js'
import { encodeSqrtRatioX96 } from './utils/encodeSqrtRatioX96.js'

// Selectors are goldens from an independent implementation (viem `toFunctionSelector`) over signatures typed by
// hand from `IByrealQuoter.sol`, so a silent ABI reorder/rename fails here instead of being re-derived from the ABI.
const SELECTORS = {
  quoteExactInputSingle: '0x56e1add2', // quoteExactInputSingle((address,address,uint256,int24,uint160,uint8))
  quoteExactOutputSingle: '0x586836a0', // quoteExactOutputSingle((address,address,uint256,int24,uint160,uint8))
  quoteExactInput: '0xb4564dc8', // quoteExactInput(bytes,uint256,uint8)
  quoteExactOutput: '0x291a535b' // quoteExactOutput(bytes,uint256,uint8)
}

// This SDK ships no address book, so the fixture registers its own wrapped native token.
WETH9[1] = new Token(1, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18, 'WETH', 'Wrapped Ether')

/** Splits calldata into the selector plus its 32-byte argument words, for order-sensitive assertions. */
function words(calldata: string): string[] {
  return (calldata.slice(10).match(/.{64}/g) ?? []).map(word => `0x${word}`)
}

describe('SwapQuoter', () => {
  const token0 = new Token(1, '0x0000000000000000000000000000000000000001', 18, 't0', 'token0')
  const token1 = new Token(1, '0x0000000000000000000000000000000000000002', 18, 't1', 'token1')
  const token2 = new Token(1, '0x0000000000000000000000000000000000000003', 18, 't2', 'token2')

  // Only tickSpacing reaches calldata; the quoter reads the mutable fee rate from the pool on-chain.
  const pool_0_1 = new Pool(token0, token1, 60, 3000, encodeSqrtRatioX96(1, 1), 0, 0, [])
  const pool_1_2 = new Pool(token1, token2, 10, 500, encodeSqrtRatioX96(1, 1), 0, 0, [])

  const route_0_1 = new Route([pool_0_1], token0, token1)
  const route_0_1_2 = new Route([pool_0_1, pool_1_2], token0, token2)

  const amount_0 = CurrencyAmount.fromRawAmount(token0, 100)
  const amount_1 = CurrencyAmount.fromRawAmount(token1, 100)
  const amount_2 = CurrencyAmount.fromRawAmount(token2, 100)

  const alpha = { extraFeeClass: ExtraFeeClass.ALPHA }
  const dex = { extraFeeClass: ExtraFeeClass.DEX }

  describe('#quoteCallParameters', () => {
    it('single-hop exact input', () => {
      const { calldata, value } = SwapQuoter.quoteCallParameters(route_0_1, amount_0, TradeType.EXACT_INPUT, alpha)

      expect(calldata.slice(0, 10)).toBe(SELECTORS.quoteExactInputSingle)
      expect(value).toBe('0x00')

      const { params } = SwapQuoter.INTERFACE.decodeFunctionData('quoteExactInputSingle', calldata)
      expect(params.tokenIn).toBe(token0.address)
      expect(params.tokenOut).toBe(token1.address)
      expect(params.amountIn.toString()).toBe('100')
      expect(params.tickSpacing).toBe(60)
      expect(params.sqrtPriceLimitX96.toString()).toBe('0')
      expect(params.extraFeeClass).toBe(ExtraFeeClass.ALPHA)

      // The struct is all-static, so its six words are inlined right after the selector in declaration order.
      // Word 2 is the amount and word 3 the tickSpacing: the amount comes FIRST (`ByrealSwapRouter` is the
      // other way round). 0x64 = 100, 0x3c = 60.
      expect(words(calldata)).toEqual([
        '0x0000000000000000000000000000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000000000000000000000000000064',
        '0x000000000000000000000000000000000000000000000000000000000000003c',
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      ])
      expect(calldata).toMatchInlineSnapshot(
        `"0x56e1add2000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000003c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"`
      )
    })

    it('single-hop exact output', () => {
      const { calldata, value } = SwapQuoter.quoteCallParameters(route_0_1, amount_1, TradeType.EXACT_OUTPUT, alpha)

      expect(calldata.slice(0, 10)).toBe(SELECTORS.quoteExactOutputSingle)
      expect(value).toBe('0x00')

      const { params } = SwapQuoter.INTERFACE.decodeFunctionData('quoteExactOutputSingle', calldata)
      // exact output keeps the token order of the route (tokenIn is still the route input) and names the field `amount`
      expect(params.tokenIn).toBe(token0.address)
      expect(params.tokenOut).toBe(token1.address)
      expect(params.amount.toString()).toBe('100')
      expect(params.tickSpacing).toBe(60)
      expect(params.sqrtPriceLimitX96.toString()).toBe('0')
      expect(params.extraFeeClass).toBe(ExtraFeeClass.ALPHA)

      // same layout as exact input — only the struct member name differs
      expect(words(calldata)[2]).toBe('0x0000000000000000000000000000000000000000000000000000000000000064')
      expect(words(calldata)[3]).toBe('0x000000000000000000000000000000000000000000000000000000000000003c')
    })

    it('multi-hop exact input', () => {
      const { calldata, value } = SwapQuoter.quoteCallParameters(route_0_1_2, amount_0, TradeType.EXACT_INPUT, alpha)

      expect(calldata.slice(0, 10)).toBe(SELECTORS.quoteExactInput)
      expect(value).toBe('0x00')

      const decoded = SwapQuoter.INTERFACE.decodeFunctionData('quoteExactInput', calldata)
      // path is packed in trade direction: token0 | 60 | token1 | 10 | token2 (goldens from encodeRouteToPath)
      expect(decoded.path).toBe(
        '0x000000000000000000000000000000000000000100003c000000000000000000000000000000000000000200000a0000000000000000000000000000000000000003'
      )
      expect(decoded.amountIn.toString()).toBe('100')
      expect(decoded.extraFeeClass).toBe(ExtraFeeClass.ALPHA)
      expect(calldata).toMatchInlineSnapshot(
        `"0xb4564dc80000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000006400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000042000000000000000000000000000000000000000100003c000000000000000000000000000000000000000200000a0000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000"`
      )
    })

    it('multi-hop exact output', () => {
      const { calldata, value } = SwapQuoter.quoteCallParameters(route_0_1_2, amount_2, TradeType.EXACT_OUTPUT, alpha)

      expect(calldata.slice(0, 10)).toBe(SELECTORS.quoteExactOutput)
      expect(value).toBe('0x00')

      const decoded = SwapQuoter.INTERFACE.decodeFunctionData('quoteExactOutput', calldata)
      // exact output reverses the path: token2 | 10 | token1 | 60 | token0
      expect(decoded.path).toBe(
        '0x000000000000000000000000000000000000000300000a000000000000000000000000000000000000000200003c0000000000000000000000000000000000000001'
      )
      expect(decoded.amountOut.toString()).toBe('100')
      expect(decoded.extraFeeClass).toBe(ExtraFeeClass.ALPHA)
    })

    it('forwards sqrtPriceLimitX96 on a single hop', () => {
      const sqrtPriceLimitX96 = JSBI.exponentiate(JSBI.BigInt(2), JSBI.BigInt(128))
      const { calldata } = SwapQuoter.quoteCallParameters(route_0_1, amount_0, TradeType.EXACT_INPUT, {
        ...alpha,
        sqrtPriceLimitX96
      })

      const { params } = SwapQuoter.INTERFACE.decodeFunctionData('quoteExactInputSingle', calldata)
      expect(params.sqrtPriceLimitX96.toString()).toBe(sqrtPriceLimitX96.toString())
      expect(words(calldata)[4]).toBe('0x0000000000000000000000000000000100000000000000000000000000000000')

      // every BigintIsh form encodes identically
      const asString = SwapQuoter.quoteCallParameters(route_0_1, amount_0, TradeType.EXACT_INPUT, {
        ...alpha,
        sqrtPriceLimitX96: sqrtPriceLimitX96.toString()
      })
      expect(asString.calldata).toBe(calldata)
    })

    it('rejects a price limit on a multi-hop quote', () => {
      expect(() =>
        SwapQuoter.quoteCallParameters(route_0_1_2, amount_0, TradeType.EXACT_INPUT, {
          ...alpha,
          sqrtPriceLimitX96: 1
        })
      ).toThrow('MULTIHOP_PRICE_LIMIT')
      // 0 is a value, not "unset": the multi-hop entry points take no limit at all
      expect(() =>
        SwapQuoter.quoteCallParameters(route_0_1_2, amount_0, TradeType.EXACT_INPUT, {
          ...alpha,
          sqrtPriceLimitX96: 0
        })
      ).toThrow('MULTIHOP_PRICE_LIMIT')
    })
  })

  describe('extraFeeClass', () => {
    it('encodes both buckets on a single hop', () => {
      const withAlpha = SwapQuoter.quoteCallParameters(route_0_1, amount_0, TradeType.EXACT_INPUT, alpha).calldata
      const withDex = SwapQuoter.quoteCallParameters(route_0_1, amount_0, TradeType.EXACT_INPUT, dex).calldata

      expect(words(withAlpha)[5]).toBe('0x0000000000000000000000000000000000000000000000000000000000000000')
      expect(words(withDex)[5]).toBe('0x0000000000000000000000000000000000000000000000000000000000000001')
      // the bucket is the only difference between the two calls
      expect(withDex.slice(0, -64)).toBe(withAlpha.slice(0, -64))

      const outAlpha = SwapQuoter.quoteCallParameters(route_0_1, amount_1, TradeType.EXACT_OUTPUT, alpha).calldata
      const outDex = SwapQuoter.quoteCallParameters(route_0_1, amount_1, TradeType.EXACT_OUTPUT, dex).calldata
      expect(SwapQuoter.INTERFACE.decodeFunctionData('quoteExactOutputSingle', outAlpha).params.extraFeeClass).toBe(0)
      expect(SwapQuoter.INTERFACE.decodeFunctionData('quoteExactOutputSingle', outDex).params.extraFeeClass).toBe(1)
    })

    it('encodes both buckets on a multi hop', () => {
      const withAlpha = SwapQuoter.quoteCallParameters(route_0_1_2, amount_0, TradeType.EXACT_INPUT, alpha).calldata
      const withDex = SwapQuoter.quoteCallParameters(route_0_1_2, amount_0, TradeType.EXACT_INPUT, dex).calldata

      expect(SwapQuoter.INTERFACE.decodeFunctionData('quoteExactInput', withAlpha).extraFeeClass).toBe(0)
      expect(SwapQuoter.INTERFACE.decodeFunctionData('quoteExactInput', withDex).extraFeeClass).toBe(1)

      const outDex = SwapQuoter.quoteCallParameters(route_0_1_2, amount_2, TradeType.EXACT_OUTPUT, dex).calldata
      expect(SwapQuoter.INTERFACE.decodeFunctionData('quoteExactOutput', outDex).extraFeeClass).toBe(1)
    })

    it('rejects an undefined bucket', () => {
      // the field is mandatory in TS, but JS consumers would otherwise get calldata that reverts on the enum cast
      for (const extraFeeClass of [undefined, 2, -1, 1.5]) {
        expect(() =>
          SwapQuoter.quoteCallParameters(route_0_1, amount_0, TradeType.EXACT_INPUT, {
            extraFeeClass: extraFeeClass as ExtraFeeClass
          })
        ).toThrow('CLASS')
      }
    })
  })

  describe('amount', () => {
    // PoolSwapV1.sol:136 `require(amountSpecified != 0, 'AS')` — a zero quote can only ever revert on chain
    it('rejects a zero amount on every entry point', () => {
      const zero_0 = CurrencyAmount.fromRawAmount(token0, 0)
      const zero_1 = CurrencyAmount.fromRawAmount(token1, 0)
      const zero_2 = CurrencyAmount.fromRawAmount(token2, 0)

      expect(() => SwapQuoter.quoteCallParameters(route_0_1, zero_0, TradeType.EXACT_INPUT, alpha)).toThrow('AMOUNT')
      expect(() => SwapQuoter.quoteCallParameters(route_0_1, zero_1, TradeType.EXACT_OUTPUT, alpha)).toThrow('AMOUNT')
      expect(() => SwapQuoter.quoteCallParameters(route_0_1_2, zero_0, TradeType.EXACT_INPUT, alpha)).toThrow('AMOUNT')
      expect(() => SwapQuoter.quoteCallParameters(route_0_1_2, zero_2, TradeType.EXACT_OUTPUT, alpha)).toThrow(
        'AMOUNT'
      )
    })

    it('accepts 1 wei', () => {
      const { calldata } = SwapQuoter.quoteCallParameters(
        route_0_1,
        CurrencyAmount.fromRawAmount(token0, 1),
        TradeType.EXACT_INPUT,
        alpha
      )
      const { params } = SwapQuoter.INTERFACE.decodeFunctionData('quoteExactInputSingle', calldata)
      expect(params.amountIn.toString()).toBe('1')
    })

    // the raw amount is encoded against `route.tokenPath` as-is, so a wrong currency silently quotes that
    // number in the other token's units (6 vs 18 decimals is a factor of 1e12)
    it('rejects an amount denominated in the wrong end of the route', () => {
      expect(() => SwapQuoter.quoteCallParameters(route_0_1, amount_1, TradeType.EXACT_INPUT, alpha)).toThrow('INPUT')
      expect(() => SwapQuoter.quoteCallParameters(route_0_1, amount_0, TradeType.EXACT_OUTPUT, alpha)).toThrow('OUTPUT')
      expect(() => SwapQuoter.quoteCallParameters(route_0_1_2, amount_2, TradeType.EXACT_INPUT, alpha)).toThrow('INPUT')
      expect(() => SwapQuoter.quoteCallParameters(route_0_1_2, amount_0, TradeType.EXACT_OUTPUT, alpha)).toThrow(
        'OUTPUT'
      )
    })

    it('rejects an amount of a token that is not on the route at all', () => {
      expect(() => SwapQuoter.quoteCallParameters(route_0_1, amount_2, TradeType.EXACT_INPUT, alpha)).toThrow('INPUT')
      expect(() => SwapQuoter.quoteCallParameters(route_0_1, amount_2, TradeType.EXACT_OUTPUT, alpha)).toThrow('OUTPUT')
    })

    it('takes a native currency through its wrapped token, which is what the path names', () => {
      const ether = Ether.onChain(1)
      const pool_weth_0 = new Pool(WETH9[1], token0, 60, 3000, encodeSqrtRatioX96(1, 1), 0, 0, [])
      const ethRoute = new Route([pool_weth_0], ether, token0)

      // both spellings of the same input are accepted and encode identically
      const asNative = SwapQuoter.quoteCallParameters(
        ethRoute,
        CurrencyAmount.fromRawAmount(ether, 100),
        TradeType.EXACT_INPUT,
        alpha
      )
      const asWrapped = SwapQuoter.quoteCallParameters(
        ethRoute,
        CurrencyAmount.fromRawAmount(WETH9[1], 100),
        TradeType.EXACT_INPUT,
        alpha
      )
      expect(asNative.calldata).toBe(asWrapped.calldata)

      // but the other end of the route is still refused
      expect(() =>
        SwapQuoter.quoteCallParameters(
          ethRoute,
          CurrencyAmount.fromRawAmount(ether, 100),
          TradeType.EXACT_OUTPUT,
          alpha
        )
      ).toThrow('OUTPUT')
    })

    it('checks the bucket before the amount', () => {
      expect(() =>
        SwapQuoter.quoteCallParameters(route_0_1, CurrencyAmount.fromRawAmount(token0, 0), TradeType.EXACT_INPUT, {
          extraFeeClass: undefined as unknown as ExtraFeeClass
        })
      ).toThrow('CLASS')
    })
  })
})
