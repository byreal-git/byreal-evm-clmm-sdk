import { Interface } from '@ethersproject/abi'
import JSBI from './jsbi.js'
import invariant from 'tiny-invariant'
import { BigintIsh, Currency, CurrencyAmount, TradeType } from './core/index.js'
import { quoterAbi } from './abis/index.js'
import { ExtraFeeClass } from './constants.js'
import { Route } from './entities/route.js'
import { ZERO } from './internalConstants.js'
import { MethodParameters, toHex } from './utils/calldata.js'
import { encodeRouteToPath } from './utils/encodeRouteToPath.js'

/**
 * Optional arguments to send to the quoter.
 */
export interface QuoteOptions {
  /**
   * The optional price limit for the trade. Single-hop quotes only — the multi-hop entry points take no limit.
   * 0 (the default) lets the contract fall back to the min/max sqrt ratio for the swap direction.
   */
  sqrtPriceLimitX96?: BigintIsh

  /**
   * The extra trade fee bucket to quote with. Mandatory: every ByrealQuoter entry point takes it.
   */
  extraFeeClass: ExtraFeeClass
}

/**
 * Represents the ByrealQuoter contract with a method for returning the formatted
 * calldata needed to call the quoter contract.
 */
export abstract class SwapQuoter {
  public static INTERFACE: Interface = new Interface(quoterAbi)

  /**
   * Produces the on-chain method name of the appropriate function within ByrealQuoter,
   * and the relevant hex encoded parameters.
   * @template TInput The input token, either Ether or an ERC-20
   * @template TOutput The output token, either Ether or an ERC-20
   * @param route The swap route, a list of pools through which a swap can occur
   * @param amount The amount of the quote, either an amount in, or an amount out. Must be strictly positive and
   * denominated in the route's input currency for exact input, its output currency for exact output
   * @param tradeType The trade type, either exact input or exact output
   * @param options The params including the mandatory extra fee class and an optional price limit
   * @returns The formatted calldata
   */
  public static quoteCallParameters<TInput extends Currency, TOutput extends Currency>(
    route: Route<TInput, TOutput>,
    amount: CurrencyAmount<TInput | TOutput>,
    tradeType: TradeType,
    options: QuoteOptions
  ): MethodParameters {
    // mirrors the pool's own `CLASS` revert string (PoolSwapV1._selectExtraFeeRate)
    invariant(options.extraFeeClass === ExtraFeeClass.ALPHA || options.extraFeeClass === ExtraFeeClass.DEX, 'CLASS')

    // PoolSwapV1.sol:136 `require(amountSpecified != 0, 'AS')` — a zero quote always reverts on chain
    invariant(JSBI.greaterThan(amount.quotient, ZERO), 'AMOUNT')

    // the raw amount is encoded as-is against `route.tokenPath`, so the wrong currency would silently quote
    // that number in the other token's units. Native currencies are accepted through their wrapped token,
    // which is what the path actually names (same handling as `Trade.fromRoute`).
    if (tradeType === TradeType.EXACT_INPUT) {
      invariant(amount.currency.wrapped.equals(route.input.wrapped), 'INPUT')
    } else {
      invariant(amount.currency.wrapped.equals(route.output.wrapped), 'OUTPUT')
    }

    const singleHop = route.pools.length === 1
    const quoteAmount: string = toHex(amount.quotient)
    let calldata: string

    if (singleHop) {
      // Struct layout from `IByrealQuoter`: (tokenIn, tokenOut, amount, tickSpacing, sqrtPriceLimitX96, extraFeeClass).
      // The amount sits before tickSpacing — the opposite of the ByrealSwapRouter structs, which put tickSpacing first.
      const baseQuoteParams = {
        tokenIn: route.tokenPath[0].address,
        tokenOut: route.tokenPath[1].address,
        tickSpacing: route.pools[0].tickSpacing,
        sqrtPriceLimitX96: toHex(options.sqrtPriceLimitX96 ?? 0),
        extraFeeClass: options.extraFeeClass
      }

      // exact input names the amount field `amountIn`, exact output names it `amount`
      const quoteParams = {
        ...baseQuoteParams,
        ...(tradeType === TradeType.EXACT_INPUT ? { amountIn: quoteAmount } : { amount: quoteAmount })
      }

      const tradeTypeFunctionName =
        tradeType === TradeType.EXACT_INPUT ? 'quoteExactInputSingle' : 'quoteExactOutputSingle'
      calldata = SwapQuoter.INTERFACE.encodeFunctionData(tradeTypeFunctionName, [quoteParams])
    } else {
      // the multi-hop entry points take no price limit, they always quote against the full range
      invariant(options.sqrtPriceLimitX96 === undefined, 'MULTIHOP_PRICE_LIMIT')
      const path: string = encodeRouteToPath(route, tradeType === TradeType.EXACT_OUTPUT)
      const tradeTypeFunctionName = tradeType === TradeType.EXACT_INPUT ? 'quoteExactInput' : 'quoteExactOutput'
      calldata = SwapQuoter.INTERFACE.encodeFunctionData(tradeTypeFunctionName, [
        path,
        quoteAmount,
        options.extraFeeClass
      ])
    }

    return {
      calldata,
      value: toHex(0)
    }
  }
}
