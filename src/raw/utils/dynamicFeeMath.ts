import { BigintIsh, MaxUint256 } from '../core/index.js'
import JSBI from '../jsbi.js'
import invariant from 'tiny-invariant'
import { ONE, ZERO, Q96 } from '../internalConstants.js'

const TWO = JSBI.BigInt(2)
const THREE = JSBI.BigInt(3)
const TEN = JSBI.BigInt(10)
const NINETY_SIX = JSBI.BigInt(96)
const ONE_THOUSAND = JSBI.BigInt(1000)

const MaxUint24 = JSBI.subtract(JSBI.exponentiate(TWO, JSBI.BigInt(24)), ONE)
const MaxUint128 = JSBI.subtract(JSBI.exponentiate(TWO, JSBI.BigInt(128)), ONE)
const MaxUint160 = JSBI.subtract(JSBI.exponentiate(TWO, JSBI.BigInt(160)), ONE)

/** ppm denominator (1e-6 precision) — mirrors `DynamicFeeMath.FEE_RATE_DENOMINATOR`. */
const FEE_RATE_DENOMINATOR = JSBI.BigInt(1_000_000)
/** bps denominator (1e-4) — mirrors `DynamicFeeMath.BPS_DENOMINATOR`. */
const BPS_DENOMINATOR = JSBI.BigInt(10_000)
const BPS_DENOMINATOR_MINUS_ONE = JSBI.subtract(BPS_DENOMINATOR, ONE)

/** solidity 0.7.6 bare `+` on uint256: wraps modulo 2**256, no checked arithmetic. */
function addIn256(x: JSBI, y: JSBI): JSBI {
  return JSBI.bitwiseAnd(JSBI.add(x, y), MaxUint256)
}

/** solidity 0.7.6 bare `*` on uint256: wraps modulo 2**256, no checked arithmetic. */
function multiplyIn256(x: JSBI, y: JSBI): JSBI {
  return JSBI.bitwiseAnd(JSBI.multiply(x, y), MaxUint256)
}

/** `LowGasSafeMath.add` — reverts when the sum overflows uint256. */
function safeAdd(x: JSBI, y: JSBI): JSBI {
  const z = JSBI.add(x, y)
  invariant(JSBI.lessThanOrEqual(z, MaxUint256), 'ADD_OVERFLOW')
  return z
}

/** `LowGasSafeMath.mul` — reverts when the product overflows uint256. */
function safeMul(x: JSBI, y: JSBI): JSBI {
  const z = JSBI.multiply(x, y)
  invariant(JSBI.lessThanOrEqual(z, MaxUint256), 'MUL_OVERFLOW')
  return z
}

/** solidity `/` on uint256: floor division, reverts on a zero divisor. */
function divFloor(x: JSBI, y: JSBI): JSBI {
  invariant(JSBI.greaterThan(y, ZERO), 'DIV_ZERO')
  return JSBI.divide(x, y)
}

/**
 * `FullMath.mulDiv` — floor(a*b/denominator). Reverts on `denominator == 0` and whenever the result
 * would not fit in a uint256 (the `require(denominator > prod1)` branch is exactly `result < 2**256`).
 */
function mulDiv(a: JSBI, b: JSBI, denominator: JSBI): JSBI {
  invariant(JSBI.greaterThan(denominator, ZERO), 'DENOMINATOR')
  const result = JSBI.divide(JSBI.multiply(a, b), denominator)
  invariant(JSBI.lessThanOrEqual(result, MaxUint256), 'MULDIV_OVERFLOW')
  return result
}

/**
 * `FullMath.mulDivRoundingUp` — ceil(a*b/denominator). Reverts on a zero denominator and whenever the
 * rounded-up result would not fit in a uint256 (`mulDiv` overflow + the `require(result < max)` guard).
 */
function mulDivRoundingUp(a: JSBI, b: JSBI, denominator: JSBI): JSBI {
  invariant(JSBI.greaterThan(denominator, ZERO), 'DENOMINATOR')
  const product = JSBI.multiply(a, b)
  let result = JSBI.divide(product, denominator)
  if (JSBI.notEqual(JSBI.remainder(product, denominator), ZERO)) result = JSBI.add(result, ONE)
  invariant(JSBI.lessThanOrEqual(result, MaxUint256), 'MULDIV_OVERFLOW')
  return result
}

/** ABI boundary check: the solidity library only ever sees values that fit the declared uint width. */
function checkUint(value: JSBI, max: JSBI, code: string): JSBI {
  invariant(JSBI.greaterThanOrEqual(value, ZERO) && JSBI.lessThanOrEqual(value, max), code)
  return value
}

/** explicit `uint24(x)` downcast — truncates to the low 24 bits. */
function toUint24(value: JSBI): JSBI {
  return JSBI.bitwiseAnd(value, MaxUint24)
}

/**
 * `DynamicFeeMath._u24sat` — narrows to uint24 but **saturates** instead of truncating. Under clamp semantics a
 * raw component may legitimately exceed the uint24 range, and truncating would report a small value for a huge
 * deviation; saturating keeps the diagnostic outputs monotone.
 */
function u24sat(value: JSBI): JSBI {
  return JSBI.greaterThan(value, MaxUint24) ? MaxUint24 : value
}

/**
 * Caller-side resolution of the pool's stored `maxDynamicFeeRate`, mirroring the one line in
 * `PoolSwapV1._computeDynamicFeeRate`: a stored `0` means "not configured" and resolves to the default ceiling
 * `1e6 - 1`; any other value is used as-is.
 *
 * NOT part of `DynamicFeeMath.sol` — in solidity this lives on the caller too. It is exposed here so an offline
 * recomputation feeds {@link DynamicFeeMath.calcTotal} exactly what the pool feeds it, instead of re-deriving the
 * sentinel by hand. Throws `UINT24` on a value the `uint24` storage slot could never hold.
 */
export function resolveMaxDynamicFeeRate(maxDynamicFeeRate: BigintIsh): JSBI {
  const stored = JSBI.BigInt(maxDynamicFeeRate)
  checkUint(stored, MaxUint24, 'UINT24')
  return JSBI.equal(stored, ZERO) ? JSBI.subtract(FEE_RATE_DENOMINATOR, ONE) : stored
}

/** Return shape of {@link DynamicFeeMath.calcTotal} — the five uint24 outputs of the solidity function. */
export interface DynamicFeeTotals {
  arbF: JSBI
  slipF: JSBI
  imbF: JSBI
  swapDyn: JSBI
  total: JSBI
}

/** Return shape of {@link DynamicFeeMath.computePIndexX96} — `(pIndexX96Out, ok)`. */
export interface PriceIndexResult {
  pIndexX96Out: JSBI
  ok: boolean
}

/**
 * Dynamic fee math (arbitrage / trade-slippage / imbalance + clamped aggregation + conversion helpers).
 *
 * One-to-one port of `contracts/core/libraries/DynamicFeeMath.sol` (itself a port of Solana
 * raydium-clmm `dynamic_fee_math.rs`). Every function name, rounding direction, revert condition and
 * uint256 wraparound matches the solidity source; all rates are ppm and all prices are `price * 2**96`.
 *
 * Standalone leaf module: it depends on nothing but the shared JSBI constants.
 */
export abstract class DynamicFeeMath {
  /**
   * Cannot be constructed.
   */
  private constructor() {}

  /** ppm denominator, 1e6 = 100%. */
  public static readonly FEE_RATE_DENOMINATOR = FEE_RATE_DENOMINATOR
  /** bps denominator, 1e4 = 100%. */
  public static readonly BPS_DENOMINATOR = BPS_DENOMINATOR

  /**
   * `arbitrage_fee = max(|p0 - pIndex| / pIndex * 1e6 - buffer - feeBase, 0)` in ppm.
   *
   * `p0X96` and `pIndexX96` must be on the same scale (both `price * 2**96`). The deviation is rounded
   * up (conservative). Throws `PIDX` when `pIndexX96 == 0`, mirroring the library invariant.
   */
  public static arbitrageFee(p0X96: JSBI, pIndexX96: JSBI, bufferPpm: JSBI, feeBase: JSBI): JSBI {
    checkUint(p0X96, MaxUint256, 'UINT256')
    checkUint(pIndexX96, MaxUint256, 'UINT256')
    checkUint(bufferPpm, MaxUint256, 'UINT256')
    checkUint(feeBase, MaxUint256, 'UINT256')

    invariant(JSBI.greaterThan(pIndexX96, ZERO), 'PIDX')
    const diff = JSBI.greaterThanOrEqual(p0X96, pIndexX96)
      ? JSBI.subtract(p0X96, pIndexX96)
      : JSBI.subtract(pIndexX96, p0X96)
    // ceil: round the deviation up (rust `mul_div_ceil`)
    const diffPpm = mulDivRoundingUp(diff, FEE_RATE_DENOMINATOR, pIndexX96)
    // bare `+` in solidity 0.7.6 — wraps on overflow
    const absorb = addIn256(bufferPpm, feeBase)
    if (JSBI.lessThanOrEqual(diffPpm, absorb)) return ZERO
    return JSBI.subtract(diffPpm, absorb)
  }

  /**
   * `trade_slippage_fee = ceil(ceil(base * sqrt((tradeSize - threshold*100) * 1e12) / 1000) / 1e4)` in ppm.
   *
   * `base` is in 0.001bp, `threshold` counts "100 whole quote tokens", `tradeSize` is already normalized
   * to whole quote tokens. The `* 1e12` step uses checked multiplication — an astronomically large
   * `tradeSize` throws `MUL_OVERFLOW` (protective revert, same as the rust `checked_mul`).
   */
  public static tradeSlippageFee(tradeSize: JSBI, base: JSBI, threshold: JSBI): JSBI {
    checkUint(tradeSize, MaxUint256, 'UINT256')
    checkUint(base, MaxUint256, 'UINT256')
    checkUint(threshold, MaxUint256, 'UINT256')

    // bare `*` in solidity 0.7.6 — wraps on overflow (threshold is <= 255 in practice)
    const thresholdScaled = multiplyIn256(threshold, JSBI.BigInt(100))
    if (JSBI.lessThanOrEqual(tradeSize, thresholdScaled)) return ZERO
    // delta = (tradeSize - threshold*100) * 1e12, checked (LowGasSafeMath.mul)
    const delta = safeMul(
      safeMul(JSBI.subtract(tradeSize, thresholdScaled), FEE_RATE_DENOMINATOR),
      FEE_RATE_DENOMINATOR
    )
    const sqrtDelta = DynamicFeeMath.sqrt(delta)
    // fee1 = ceil(base * sqrt(delta) / 1000)
    const fee1 = mulDivRoundingUp(base, sqrtDelta, ONE_THOUSAND)
    // fee = ceil(fee1 / 1e4); the `+ 9999` is a bare add in solidity
    return JSBI.divide(addIn256(fee1, BPS_DENOMINATOR_MINUS_ONE), BPS_DENOMINATOR)
  }

  /**
   * Directional imbalance fee (ppm): only charged when the trade *worsens* the imbalance, free when it
   * rebalances, and always free when the pool is already balanced.
   *
   * `base` is in 0.1bp, `x` is in 1/100 (the exempt share threshold), `isBuyingBase == inputIsQuote`.
   * Throws `ADD_OVERFLOW` when `quoteValueOfBase + quoteBalance` exceeds uint256 (checked add).
   */
  public static imbalanceFee(
    quoteValueOfBase: JSBI,
    quoteBalance: JSBI,
    base: JSBI,
    x: JSBI,
    isBuyingBase: boolean
  ): JSBI {
    checkUint(quoteValueOfBase, MaxUint256, 'UINT256')
    checkUint(quoteBalance, MaxUint256, 'UINT256')
    checkUint(base, MaxUint256, 'UINT256')
    checkUint(x, MaxUint256, 'UINT256')

    const total = safeAdd(quoteValueOfBase, quoteBalance)
    if (JSBI.equal(total, ZERO)) return ZERO

    // direction gate: only the imbalance-worsening side pays
    if (JSBI.greaterThan(quoteValueOfBase, quoteBalance)) {
      if (isBuyingBase) return ZERO // base-heavy: buying base rebalances
    } else if (JSBI.lessThan(quoteValueOfBase, quoteBalance)) {
      if (!isBuyingBase) return ZERO // quote-heavy: selling base rebalances
    } else {
      return ZERO // already balanced
    }

    const diff = JSBI.greaterThanOrEqual(quoteValueOfBase, quoteBalance)
      ? JSBI.subtract(quoteValueOfBase, quoteBalance)
      : JSBI.subtract(quoteBalance, quoteValueOfBase)
    const imbalancePpm = mulDivRoundingUp(diff, FEE_RATE_DENOMINATOR, total) // ceil
    // bare `*` in solidity 0.7.6 — wraps on overflow (x is <= 255 in practice)
    const xPpm = multiplyIn256(x, BPS_DENOMINATOR)
    if (JSBI.lessThanOrEqual(imbalancePpm, xPpm)) return ZERO

    const over = JSBI.subtract(imbalancePpm, xPpm)
    const fee1 = mulDivRoundingUp(over, base, TEN) // ceil(over * base / 10)
    return JSBI.divide(addIn256(fee1, BPS_DENOMINATOR_MINUS_ONE), BPS_DENOMINATOR) // ceil(fee1 / 1e4)
  }

  /**
   * Aggregates the three components plus `feeBase`, **clamps** the total into `[feeBase, maxRate]` and returns the
   * rate actually fed to the curve (always < 1e6).
   *
   * This replaced the old `require(total < 1e6, 'DFCAP')` hard revert: an excessive rate no longer refuses the
   * trade, it is clamped down to the governance ceiling `maxRate`, and then floored back at `feeBase` so the
   * `total >= base` invariant holds even when governance sets `maxRate` below the base fee. `maxRate` arrives
   * already resolved (1..1e6 - 1 — the caller maps the stored `0` sentinel to 1e6 - 1, see
   * {@link resolveMaxDynamicFeeRate}), hence `total < 1e6` and the curve can never divide by zero.
   *
   * `arbF` / `slipF` / `imbF` / `swapDyn` are the **raw** components saturated into uint24 (under clamp semantics a
   * large deviation can exceed the uint24 range, so they saturate rather than truncate — see `_u24sat`). Once the
   * clamp bites they no longer satisfy `total == swapDyn + feeBase`; that mismatch is precisely the signal that the
   * clamp was applied.
   *
   * @param maxRate the resolved governance ceiling, not the raw stored value
   */
  public static calcTotal(arb: JSBI, slip: JSBI, imb: JSBI, feeBase: JSBI, maxRate: JSBI): DynamicFeeTotals {
    checkUint(arb, MaxUint256, 'UINT256')
    checkUint(slip, MaxUint256, 'UINT256')
    checkUint(imb, MaxUint256, 'UINT256')
    checkUint(feeBase, MaxUint256, 'UINT256')
    checkUint(maxRate, MaxUint256, 'UINT256')

    // bare `+` in solidity 0.7.6 — wraps on overflow
    const swapDynamic = addIn256(addIn256(arb, slip), imb)
    let t = addIn256(swapDynamic, feeBase)
    if (JSBI.greaterThan(t, maxRate)) t = maxRate // clamp to the governance ceiling (replaces the DFCAP revert)
    if (JSBI.lessThan(t, feeBase)) t = feeBase // floor at base: only reachable when maxRate < base
    // `total` is a plain `uint24(t)` downcast in solidity: t <= max(maxRate, feeBase) and both are uint24 on chain
    return {
      arbF: u24sat(arb),
      slipF: u24sat(slip),
      imbF: u24sat(imb),
      swapDyn: u24sat(swapDynamic),
      total: toUint24(t)
    }
  }

  /**
   * `p0 = price * 2**96` derived from `sqrtPriceX96`, i.e. `mulDiv(sqrtP, sqrtP, 2**96)`.
   *
   * Still truncates to 0 below `price < 2**-96` (`sqrtP` in `[2**32, 2**48)`); callers fall back to the
   * base fee on a zero result.
   */
  public static priceFromSqrtPriceX96(sqrtPriceX96: JSBI): JSBI {
    checkUint(sqrtPriceX96, MaxUint160, 'UINT160')
    return mulDiv(sqrtPriceX96, sqrtPriceX96, Q96)
  }

  /**
   * Converts a base amount into a quote amount (raw units) at `priceX96`; `quoteIsToken1` selects
   * `* price` vs `* 1/price`. Floor in both branches. Throws `PX0` when `priceX96 == 0`.
   */
  public static quoteAmountFromBase(baseAmount: JSBI, priceX96: JSBI, quoteIsToken1: boolean): JSBI {
    checkUint(baseAmount, MaxUint256, 'UINT256')
    checkUint(priceX96, MaxUint256, 'UINT256')

    invariant(JSBI.greaterThan(priceX96, ZERO), 'PX0')
    if (quoteIsToken1) {
      return mulDiv(baseAmount, priceX96, Q96) // floor
    } else {
      return mulDiv(baseAmount, Q96, priceX96) // floor
    }
  }

  /**
   * Normalizes a raw quote amount into whole quote tokens (`/ 10**quoteDecimals`) for
   * {@link DynamicFeeMath.tradeSlippageFee}. No u64 ceiling — huge trades are absorbed by the `calcTotal` clamp.
   */
  public static normalizeTradeSize(quoteRaw: JSBI, quoteUnit: JSBI): JSBI {
    checkUint(quoteRaw, MaxUint256, 'UINT256')
    checkUint(quoteUnit, MaxUint256, 'UINT256')

    return divFloor(quoteRaw, quoteUnit)
  }

  /**
   * Derives `pIndex * 2**96` from two Chainlink answers and the pre-computed `10**|netExp|` factor.
   *
   * `ok == false` is the fail-soft signal: the caller skips the arbitrage term entirely and keeps quoting
   * instead of reverting. It is returned in four cases, all of them degenerate feed configurations —
   *
   * - `!negExp`: `answer0 * (pow10 << 96)` would exceed uint256, i.e. `mulDiv` could not return a uint256;
   * - `negExp`: the bare-multiply denominator `answer1 * pow10` would wrap around uint256;
   * - `negExp`: `answer0 * 2**96` would exceed uint256;
   * - either branch: `pIndex` truncates to 0.
   *
   * The three multiplication pre-checks are **conservative** (they bound the product, not the quotient), so
   * they can refuse a few configurations `mulDiv` would have survived. That is deliberate: `mulDiv`'s revert
   * inside a pool's oracle read would bubble up as a swap DoS, and the over-refusal only ever lands on feeds
   * that are already malformed. `contracts/core/libraries/DynamicFeeMath.sol` does exactly the same three
   * checks in the same order, including the `pow10Q96 != 0` division guard.
   */
  public static computePIndexX96(answer0: JSBI, answer1: JSBI, pow10: JSBI, negExp: boolean): PriceIndexResult {
    checkUint(answer0, MaxUint256, 'UINT256')
    checkUint(answer1, MaxUint256, 'UINT256')
    checkUint(pow10, MaxUint128, 'UINT128')

    let pIndexX96Out: JSBI
    if (!negExp) {
      const pow10Q96 = JSBI.leftShift(pow10, NINETY_SIX) // safe: pow10 <= 2**128 - 1 so this is <= 2**224
      // fail-soft pre-check for an overflowing `mulDiv` **result**. The `!= 0` guard is pure defence against
      // dividing by zero (arbitrage is only reached with two feeds, where pow10 >= 1).
      if (JSBI.notEqual(pow10Q96, ZERO) && JSBI.greaterThan(answer0, divFloor(MaxUint256, pow10Q96))) {
        return { pIndexX96Out: ZERO, ok: false }
      }
      pIndexX96Out = mulDiv(answer0, pow10Q96, answer1)
    } else {
      // denominator `answer1 * pow10` is a bare solidity multiply: pre-check, and fail soft (no revert)
      if (JSBI.greaterThan(answer1, divFloor(MaxUint256, pow10))) return { pIndexX96Out: ZERO, ok: false }
      // and the same conservative bound as the other branch, for the `mulDiv` result
      if (JSBI.greaterThan(answer0, divFloor(MaxUint256, Q96))) return { pIndexX96Out: ZERO, ok: false }
      pIndexX96Out = mulDiv(answer0, Q96, JSBI.multiply(answer1, pow10))
    }
    return { pIndexX96Out, ok: JSBI.greaterThan(pIndexX96Out, ZERO) }
  }

  /**
   * `floor(sqrt(y))` via Babylonian iteration — satisfies `sqrt(y)**2 <= y < (sqrt(y)+1)**2`, pointwise
   * equal to the rust `integer_sqrt_u128`. Uses the uniswap-v2 seed `y/2 + 1` so that inputs near
   * 2**256 cannot overflow.
   */
  public static sqrt(y: JSBI): JSBI {
    checkUint(y, MaxUint256, 'UINT256')

    let z = ZERO
    if (JSBI.greaterThan(y, THREE)) {
      z = y
      let x = JSBI.add(JSBI.divide(y, TWO), ONE)
      while (JSBI.lessThan(x, z)) {
        z = x
        x = JSBI.divide(JSBI.add(JSBI.divide(y, x), x), TWO)
      }
    } else if (JSBI.notEqual(y, ZERO)) {
      z = ONE
    }
    return z
  }
}
