import JSBI from './jsbi.js'
import { Interface } from '@ethersproject/abi'
import invariant from 'tiny-invariant'
import { Percent, Token, validateAndParseAddress } from './core/index.js'
import { swapRouterAbi } from './abis/index.js'
import { ONE } from './internalConstants.js'
import { toHex } from './utils/calldata.js'

/** `require(feeBips > 0 && feeBips <= 100)` — PeripheryPaymentsWithFee.sol:23 and :44. */
const MAX_FEE_BIPS = JSBI.BigInt(100)

export interface FeeOptions {
  /**
   * The percent of the output that will be taken as a fee.
   */
  fee: Percent

  /**
   * The recipient of the fee.
   */
  recipient: string
}

export abstract class Payments {
  public static INTERFACE: Interface = new Interface(swapRouterAbi)

  /**
   * Cannot be constructed.
   */
  private constructor() {}

  /**
   * `Percent -> bips` truncates (`quotient` is a floor division), so a fee below one bip would silently encode
   * as 0. Both `WithFee` variants require `0 < feeBips <= 100` (PeripheryPaymentsWithFee.sol:23 and :44), i.e.
   * 0.01% to 1% inclusive, so anything outside that window is calldata that always reverts on chain.
   */
  private static encodeFeeBips(fee: Percent): string {
    const feeBips = fee.multiply(10_000).quotient
    invariant(JSBI.greaterThanOrEqual(feeBips, ONE) && JSBI.lessThanOrEqual(feeBips, MAX_FEE_BIPS), 'FEE_BIPS')

    return toHex(feeBips)
  }

  /**
   * The Byreal router is a SwapRouter02-shaped contract: `unwrapWETH9` / `sweepToken` and their `WithFee`
   * variants each have a recipient-less overload. Signatures are spelled out in full so the explicit-recipient
   * overloads required by these helpers are always selected.
   */
  public static encodeUnwrapWETH9(amountMinimum: JSBI, recipient: string, feeOptions?: FeeOptions): string {
    recipient = validateAndParseAddress(recipient)

    if (!!feeOptions) {
      const feeBips = this.encodeFeeBips(feeOptions.fee)
      const feeRecipient: string = validateAndParseAddress(feeOptions.recipient)

      return Payments.INTERFACE.encodeFunctionData('unwrapWETH9WithFee(uint256,address,uint256,address)', [
        toHex(amountMinimum),
        recipient,
        feeBips,
        feeRecipient
      ])
    } else {
      return Payments.INTERFACE.encodeFunctionData('unwrapWETH9(uint256,address)', [toHex(amountMinimum), recipient])
    }
  }

  public static encodeSweepToken(
    token: Token,
    amountMinimum: JSBI,
    recipient: string,
    feeOptions?: FeeOptions
  ): string {
    recipient = validateAndParseAddress(recipient)

    if (!!feeOptions) {
      const feeBips = this.encodeFeeBips(feeOptions.fee)
      const feeRecipient: string = validateAndParseAddress(feeOptions.recipient)

      return Payments.INTERFACE.encodeFunctionData('sweepTokenWithFee(address,uint256,address,uint256,address)', [
        token.address,
        toHex(amountMinimum),
        recipient,
        feeBips,
        feeRecipient
      ])
    } else {
      return Payments.INTERFACE.encodeFunctionData('sweepToken(address,uint256,address)', [
        token.address,
        toHex(amountMinimum),
        recipient
      ])
    }
  }

  public static encodeRefundETH(): string {
    return Payments.INTERFACE.encodeFunctionData('refundETH()')
  }
}
