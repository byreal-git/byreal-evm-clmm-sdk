import { Interface } from '@ethersproject/abi'
import JSBI from './jsbi.js'
import invariant from 'tiny-invariant'
import { BigintIsh, Currency, CurrencyAmount, Percent, TradeType, validateAndParseAddress } from './core/index.js'
import { swapRouterAbi } from './abis/index.js'
import { ADDRESS_THIS, ExtraFeeClass, MSG_SENDER } from './constants.js'
import { Trade } from './entities/trade.js'
import { ZERO } from './internalConstants.js'
import { isValidDeadline, Multicall } from './multicall.js'
import { FeeOptions, Payments } from './payments.js'
import { PermitOptions, SelfPermit } from './selfPermit.js'
import { encodeRouteToPath } from './utils/encodeRouteToPath.js'
import { MethodParameters, toHex } from './utils/calldata.js'

/**
 * Options for producing the arguments to send calls to the router.
 */
export interface SwapOptions {
  /**
   * How much the execution price is allowed to move unfavorably from the trade execution price.
   */
  slippageTolerance: Percent

  /**
   * The account that should receive the output. The `MSG_SENDER` sentinel is accepted; `ADDRESS_THIS` is not,
   * since it would leave the proceeds in the router where anyone can sweep them.
   */
  recipient: string

  /**
   * When the transaction expires, in epoch seconds. Required: the router structs carry no deadline of their
   * own, it is enforced by the `multicall(uint256,bytes[])` wrapper this class always emits. Validated at
   * runtime, so a JavaScript caller cannot drop it.
   *
   * NB: there is deliberately no `extraFeeClass` here. The bucket is a property of the quote, so it is read off
   * `Trade.extraFeeClass` — a quote/execution mismatch has no spelling in this API.
   */
  deadline: BigintIsh

  /**
   * The optional permit parameters for spending the input.
   */
  inputTokenPermit?: PermitOptions

  /**
   * The optional price limit for the trade.
   */
  sqrtPriceLimitX96?: BigintIsh

  /**
   * Optional information for taking a fee on output.
   */
  fee?: FeeOptions
}

/**
 * Represents the Byreal SwapRouter, and has static methods for helping execute trades.
 */
export abstract class SwapRouter {
  public static INTERFACE: Interface = new Interface(swapRouterAbi)

  /**
   * Cannot be constructed.
   */
  private constructor() {}

  /**
   * Produces the on-chain method name to call and the hex encoded parameters to pass as arguments for a given trade.
   * @param trades to produce call parameters for
   * @param options options for the call parameters
   */
  public static swapCallParameters(
    trades: Trade<Currency, Currency, TradeType> | Trade<Currency, Currency, TradeType>[],
    options: SwapOptions
  ): MethodParameters {
    // the wrapper is the only deadline carrier, and a value that cannot be encoded (or a zero, which no block
    // timestamp can satisfy) would silently produce calldata that always reverts
    invariant(isValidDeadline(options.deadline), 'DEADLINE')

    if (!Array.isArray(trades)) {
      trades = [trades]
    }

    const sampleTrade = trades[0]
    const tokenIn = sampleTrade.inputAmount.currency.wrapped
    const tokenOut = sampleTrade.outputAmount.currency.wrapped

    // every ByrealSwapRouter entry point takes the bucket, and it is what the quote was computed with: it is
    // read off the trades rather than off `options`, so the encoded class is always the quoted one. Mixing
    // buckets inside one batch is refused — a single call has to name exactly one.
    const extraFeeClass = sampleTrade.extraFeeClass
    invariant(
      trades.every(trade => trade.extraFeeClass === extraFeeClass),
      'CLASS_MISMATCH'
    )
    // defense in depth: the Trade constructor already pins a valid bucket, but a duck-typed object could reach
    // here — never encode a class the pool would revert on ('CLASS' mirrors PoolSwapV1._selectExtraFeeRate)
    invariant(extraFeeClass === ExtraFeeClass.ALPHA || extraFeeClass === ExtraFeeClass.DEX, 'CLASS')

    // All trades should have the same starting and ending token.
    invariant(
      trades.every(trade => trade.inputAmount.currency.wrapped.equals(tokenIn)),
      'TOKEN_IN_DIFF'
    )
    invariant(
      trades.every(trade => trade.outputAmount.currency.wrapped.equals(tokenOut)),
      'TOKEN_OUT_DIFF'
    )

    const calldatas: string[] = []

    const ZERO_IN: CurrencyAmount<Currency> = CurrencyAmount.fromRawAmount(trades[0].inputAmount.currency, 0)
    const ZERO_OUT: CurrencyAmount<Currency> = CurrencyAmount.fromRawAmount(trades[0].outputAmount.currency, 0)

    const totalAmountOut: CurrencyAmount<Currency> = trades.reduce(
      (sum, trade) => sum.add(trade.minimumAmountOut(options.slippageTolerance)),
      ZERO_OUT
    )

    // `msg.value` covers every native leg of the batch, so one native trade is enough to make this a
    // value-bearing (and therefore refundable) call
    const inputIsNative = trades.some(trade => trade.inputAmount.currency.isNative)
    // flags for whether funds should be send first to the router
    const outputIsNative = sampleTrade.outputAmount.currency.isNative
    const routerMustCustody = outputIsNative || !!options.fee

    const totalValue: CurrencyAmount<Currency> = inputIsNative
      ? trades.reduce((sum, trade) => sum.add(trade.maximumAmountIn(options.slippageTolerance)), ZERO_IN)
      : ZERO_IN

    // encode permit if necessary
    if (options.inputTokenPermit) {
      invariant(sampleTrade.inputAmount.currency.isToken, 'NON_TOKEN_PERMIT')
      calldatas.push(SelfPermit.encodePermit(sampleTrade.inputAmount.currency, options.inputTokenPermit))
    }

    const recipient: string = validateAndParseAddress(options.recipient)

    // ADDRESS_THIS resolves to the router itself (ByrealSwapRouter.sol:109). On a custody path the payment
    // overloads do not resolve sentinels at all, and off it the swap output simply terminates in the router —
    // where the public `sweepToken` / `refundETH` (PeripheryPayments.sol:30 / :44) let *anyone* take it. There
    // is no spelling of it that ends with the caller holding the funds, so it is refused outright.
    invariant(recipient !== ADDRESS_THIS, 'SENTINEL_RECIPIENT')

    for (const trade of trades) {
      for (const { route, inputAmount, outputAmount } of trade.swaps) {
        const amountInRaw = trade.maximumAmountIn(options.slippageTolerance, inputAmount).quotient
        const amountOutRaw = trade.minimumAmountOut(options.slippageTolerance, outputAmount).quotient

        // `amountIn == 0` is CONTRACT_BALANCE to the router (`Constants.sol`) — it would silently swap the
        // router's whole balance instead of the requested amount. A zero output bound is refused with it.
        invariant(JSBI.greaterThan(amountInRaw, ZERO) && JSBI.greaterThan(amountOutRaw, ZERO), 'ZERO_AMOUNT')

        const amountIn: string = toHex(amountInRaw)
        const amountOut: string = toHex(amountOutRaw)

        // the router has no `address(0) -> address(this)` fallback, only the SwapRouter02-style sentinels,
        // so custody has to be spelled with ADDRESS_THIS or the output would be sent to the zero address
        const swapRecipient: string = routerMustCustody ? ADDRESS_THIS : recipient

        // flag for whether the trade is single hop or not
        const singleHop = route.pools.length === 1

        if (singleHop) {
          if (trade.tradeType === TradeType.EXACT_INPUT) {
            const exactInputSingleParams = {
              tokenIn: route.tokenPath[0].address,
              tokenOut: route.tokenPath[1].address,
              tickSpacing: route.pools[0].tickSpacing,
              recipient: swapRecipient,
              amountIn,
              amountOutMinimum: amountOut,
              sqrtPriceLimitX96: toHex(options.sqrtPriceLimitX96 ?? 0),
              extraFeeClass
            }

            calldatas.push(SwapRouter.INTERFACE.encodeFunctionData('exactInputSingle', [exactInputSingleParams]))
          } else {
            const exactOutputSingleParams = {
              tokenIn: route.tokenPath[0].address,
              tokenOut: route.tokenPath[1].address,
              tickSpacing: route.pools[0].tickSpacing,
              recipient: swapRecipient,
              amountOut,
              amountInMaximum: amountIn,
              sqrtPriceLimitX96: toHex(options.sqrtPriceLimitX96 ?? 0),
              extraFeeClass
            }

            calldatas.push(SwapRouter.INTERFACE.encodeFunctionData('exactOutputSingle', [exactOutputSingleParams]))
          }
        } else {
          invariant(options.sqrtPriceLimitX96 === undefined, 'MULTIHOP_PRICE_LIMIT')

          const path: string = encodeRouteToPath(route, trade.tradeType === TradeType.EXACT_OUTPUT)

          if (trade.tradeType === TradeType.EXACT_INPUT) {
            const exactInputParams = {
              path,
              recipient: swapRecipient,
              amountIn,
              amountOutMinimum: amountOut,
              extraFeeClass
            }

            calldatas.push(SwapRouter.INTERFACE.encodeFunctionData('exactInput', [exactInputParams]))
          } else {
            const exactOutputParams = {
              path,
              recipient: swapRecipient,
              amountOut,
              amountInMaximum: amountIn,
              extraFeeClass
            }

            calldatas.push(SwapRouter.INTERFACE.encodeFunctionData('exactOutput', [exactOutputParams]))
          }
        }
      }
    }

    // unwrap. NB: the explicit-recipient payment overloads do NOT resolve the MSG_SENDER sentinel (only the
    // swap entry points do), so on a custody path (native output or `fee`) an explicit `recipient: MSG_SENDER`
    // would pay the funds out to the sentinel address itself. It is instead rewritten to the recipient-less
    // overload, which is exactly `msg.sender`. (ADDRESS_THIS was already refused above, on every path.)
    if (routerMustCustody) {
      const recipientIsMsgSender = recipient === MSG_SENDER

      if (!!options.fee) {
        // the `WithFee` variants are only encoded through their explicit-recipient overloads here, so a
        // sentinel has no safe spelling on this path
        invariant(!recipientIsMsgSender, 'SENTINEL_RECIPIENT')

        if (outputIsNative) {
          calldatas.push(Payments.encodeUnwrapWETH9(totalAmountOut.quotient, recipient, options.fee))
        } else {
          calldatas.push(
            Payments.encodeSweepToken(
              sampleTrade.outputAmount.currency.wrapped,
              totalAmountOut.quotient,
              recipient,
              options.fee
            )
          )
        }
      } else if (recipientIsMsgSender) {
        // `unwrapWETH9(uint256)` pays out to msg.sender — the same account the MSG_SENDER sentinel names
        calldatas.push(
          SwapRouter.INTERFACE.encodeFunctionData('unwrapWETH9(uint256)', [toHex(totalAmountOut.quotient)])
        )
      } else {
        calldatas.push(Payments.encodeUnwrapWETH9(totalAmountOut.quotient, recipient))
      }
    }

    // refund. `msg.value` is always the full `maximumAmountIn`, but the router only wraps what a callback
    // actually asks for (PeripheryPayments.sol:58) — exact-output leaves the unspent maximum behind, and
    // exact-input does too whenever the swap fills partially (a `sqrtPriceLimitX96` or the end of liquidity).
    // Anything left is claimable by the next caller of the public `refundETH` (PeripheryPayments.sol:44), so
    // every native-input call ends with one. It is a no-op when nothing is left over.
    if (inputIsNative) {
      calldatas.push(Payments.encodeRefundETH())
    }

    // the wrapper is never elided: it is the only thing carrying the deadline
    return {
      calldata: Multicall.encodeMulticall(calldatas, options.deadline),
      value: toHex(totalValue.quotient)
    }
  }
}
