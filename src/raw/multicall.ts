import { Interface } from '@ethersproject/abi'
import JSBI from './jsbi.js'
import invariant from 'tiny-invariant'
import { BigintIsh, MaxUint256 } from './core/index.js'
import { swapRouterAbi } from './abis/index.js'
import { ZERO } from './internalConstants.js'
import { toHex } from './utils/calldata.js'

/**
 * A deadline is abi-encoded as `uint256` and checked with `require(_blockTimestamp() <= deadline)`
 * (`PeripheryValidation.checkDeadline`). Rejected here: anything that cannot be encoded as a uint256
 * (undefined, a fraction, a negative, > 2**256-1) and 0 — a zero deadline is not "no deadline", it is calldata
 * that can never pass the check, and TypeScript alone does not stop a JS caller from producing either.
 */
export function isValidDeadline(deadline: BigintIsh | undefined | null): boolean {
  if (deadline === undefined || deadline === null) return false

  let parsed: JSBI
  try {
    // JSBI.BigInt throws on a non-integer number and on a string that is not a valid integer literal
    parsed = JSBI.BigInt(deadline)
  } catch {
    return false
  }

  return JSBI.greaterThan(parsed, ZERO) && JSBI.lessThanOrEqual(parsed, MaxUint256)
}

export abstract class Multicall {
  public static INTERFACE: Interface = new Interface(swapRouterAbi)

  /**
   * Cannot be constructed.
   */
  private constructor() {}

  /**
   * Wraps calldatas in a `multicall`. The router exposes three overloads, so signatures are always spelled out
   * in full to keep ethers from resolving `'multicall'` ambiguously.
   *
   * With a `deadline` the `multicall(uint256,bytes[])` overload is used and the wrapper is never elided —
   * Byreal router structs carry no deadline of their own, so the wrapper is what enforces it. The value is
   * range-checked (see `isValidDeadline`); omitting the argument entirely still selects the deadline-less
   * behaviour, which is what the NonfungiblePositionManager needs (its own structs carry the deadline).
   */
  public static encodeMulticall(calldatas: string | string[], deadline?: BigintIsh): string {
    if (!Array.isArray(calldatas)) {
      calldatas = [calldatas]
    }

    if (deadline !== undefined) {
      invariant(isValidDeadline(deadline), 'DEADLINE')
      return Multicall.INTERFACE.encodeFunctionData('multicall(uint256,bytes[])', [toHex(deadline), calldatas])
    }

    return calldatas.length === 1
      ? calldatas[0]
      : Multicall.INTERFACE.encodeFunctionData('multicall(bytes[])', [calldatas])
  }
}
