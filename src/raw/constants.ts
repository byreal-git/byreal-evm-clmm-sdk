export const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000'

/**
 * Recipient sentinels understood by ByrealSwapRouter (periphery `Constants.sol`).
 * Passing them instead of a real address saves gas by sending more zero bytes.
 */
export const MSG_SENDER = '0x0000000000000000000000000000000000000001'
export const ADDRESS_THIS = '0x0000000000000000000000000000000000000002'

/**
 * Denominator for every rate expressed in ppm (parts per million). 1e6 = 100%.
 * NB: `protocolFeeRate` does NOT use this denominator — it is a percentage integer in [0, 100].
 */
export const FEE_RATE_DENOMINATOR = 1_000_000

/**
 * Inclusive upper bound of `tradeFeeRate` (`PoolConstants.MAX_TRADE_FEE_RATE`). **1e6 - 1, not 1e6**:
 * the trade fee is always used as the denominator term `1e6 - feePips` inside `SwapMath.computeSwapStep`,
 * so a rate of exactly 1e6 divides by zero on every swap (plain and dynamic-fee paths alike). The pool
 * therefore refuses it at `initializePool` / `setTradeFeeRate` (revert 'TFR') — 100% is a degenerate,
 * untradeable configuration rather than a legal extreme.
 */
export const MAX_TRADE_FEE_RATE = 999_999

/**
 * Inclusive upper bound of the per-class extra trade fee rates (`PoolConstants.MAX_EXTRA_TRADE_FEE_RATE`),
 * i.e. `setAlphaExtraTradeFeeRate` / `setDexExtraTradeFeeRate` (reverts 'AEF' / 'DEF').
 *
 * Deliberately a **separate** constant from {@link MAX_TRADE_FEE_RATE}, whose value it no longer shares:
 * an extra fee is skimmed off the amount before the curve (`mulDiv(amount, rate, 1e6)`) and never reaches
 * the `1e6 - feePips` denominator, so 100% stays representable on chain. Do not re-merge the two.
 */
export const MAX_EXTRA_TRADE_FEE_RATE = 1_000_000

/**
 * Extra trade fee bucket selected per swap. Must be supplied on every swap/quote call path.
 */
export enum ExtraFeeClass {
  ALPHA = 0,
  DEX = 1
}

/**
 * Per-pool pause bitmap (`PoolConstants.sol`). Values are combinable with bitwise OR.
 */
export enum PauseFlags {
  SWAP = 1,
  ADD = 2,
  REMOVE = 4,
  COLLECT = 8,
  FLASH = 16
}

/**
 * Mirrors `TickSpacing.isValid(int24)`: hard bound 0 < ts < 16384; ts <= 5 anything;
 * 6..10 even only (6/8/10); ts > 10 multiples of 10 only.
 * Non-integer inputs are rejected — they cannot be encoded as `int24`.
 */
export function isValidTickSpacing(tickSpacing: number): boolean {
  if (!Number.isInteger(tickSpacing)) return false
  if (tickSpacing <= 0 || tickSpacing >= 16384) return false
  if (tickSpacing <= 5) return true
  if (tickSpacing <= 10) return tickSpacing % 2 === 0
  return tickSpacing % 10 === 0
}
