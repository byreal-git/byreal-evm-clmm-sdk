import JSBI from '../jsbi.js'
import invariant from 'tiny-invariant'
import warning from 'tiny-warning'
import { BigintIsh, CurrencyAmount, Price, Token } from '../core/index.js'
import {
  ExtraFeeClass,
  FEE_RATE_DENOMINATOR,
  MAX_EXTRA_TRADE_FEE_RATE,
  MAX_TRADE_FEE_RATE,
  PauseFlags,
  isValidTickSpacing
} from '../constants.js'
import { NEGATIVE_ONE, ONE, Q192, ZERO } from '../internalConstants.js'
import { computePoolAddress } from '../utils/computePoolAddress.js'
import { LiquidityMath } from '../utils/liquidityMath.js'
import { SwapMath } from '../utils/swapMath.js'
import { TickMath } from '../utils/tickMath.js'
import { Tick, TickConstructorArgs } from './tick.js'
import { NoTickDataProvider, TickDataProvider } from './tickDataProvider.js'
import { TickListDataProvider } from './tickListDataProvider.js'

interface StepComputations {
  sqrtPriceStartX96: JSBI
  tickNext: number
  initialized: boolean
  sqrtPriceNextX96: JSBI
  amountIn: JSBI
  amountOut: JSBI
  feeAmount: JSBI
}

/**
 * By default, pools will not allow operations that require ticks.
 */
const NO_TICK_DATA_PROVIDER_DEFAULT = new NoTickDataProvider()

const FEE_RATE_DENOMINATOR_JSBI = JSBI.BigInt(FEE_RATE_DENOMINATOR)

/** `slot0.protocolFeeRate` is a percentage, not a ppm rate (`PoolAdminV1.setProtocolFeeRate`). */
const MAX_PROTOCOL_FEE_RATE = 100

/** Every bit `PoolConstants.sol` defines; anything above is an unknown flag the pool would never set. */
const MAX_PAUSE_FLAGS = PauseFlags.SWAP | PauseFlags.ADD | PauseFlags.REMOVE | PauseFlags.COLLECT | PauseFlags.FLASH

/** `swapOpenTime` is a `uint32` in the pool's packed slot. */
const MAX_SWAP_OPEN_TIME = 4_294_967_295

/**
 * Mutable, admin-controlled pool state that is not part of the pool identity. Every field is optional:
 * an omitted field means "unknown / not loaded", and is treated as its neutral value by the SDK.
 *
 * The `Pool` constructor validates every present field and stores a frozen **copy**: this object is a
 * snapshot of on-chain state, so mutating it afterwards must not retroactively change quotes already
 * computed against a `Pool` built from it.
 */
export interface PoolExtraState {
  /** `slot0.protocolFeeRate`, a percentage integer in [0, 100] (NOT ppm). */
  protocolFeeRate?: number
  /** `PauseFlags` bitmap, see `PoolConstants.sol`. Integer in [0, 31]. */
  pauseFlags?: number
  /** Unix seconds; on-chain swaps revert with 'TIME' until `block.timestamp > swapOpenTime`. uint32. */
  swapOpenTime?: number
  /** ppm, extra trade fee of the `ExtraFeeClass.ALPHA` bucket. Integer in [0, 1e6]. */
  alphaExtraTradeFeeRate?: number
  /** ppm, extra trade fee of the `ExtraFeeClass.DEX` bucket. Integer in [0, 1e6]. */
  dexExtraTradeFeeRate?: number
  /** When true the pool overrides `tradeFeeRate` with an oracle-derived rate at swap time. */
  dynamicFeeEnabled?: boolean
}

/**
 * Extra knobs for the two offline quote entry points. Anything in here loosens a fail-closed guard, so
 * every field is opt-in and named after what the caller is asserting.
 */
export interface PoolQuoteOptions {
  /**
   * Quote a `dynamicFeeEnabled` pool off its **base** `tradeFeeRate`, which is only a lower bound on the
   * rate the pool will actually apply. Off by default: such a quote is not safe to turn into an on-chain
   * slippage bound. Use `ByrealQuoter` + `Trade.createUncheckedTrade` for an executable quote instead.
   */
  assumeBaseFee?: boolean
}

const isUintAtMost = (value: unknown, max: number): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max

/**
 * Shallow-copies `extra`, validates every present field against the on-chain domain of that field, and
 * freezes the copy. Out-of-range values are refused rather than clamped: a fee rate above
 * `FEE_RATE_DENOMINATOR` would make the exact-in pre-deduction exceed the input and feed a negative
 * amount into the swap loop, which is a state the pool itself can never reach.
 * @param extra The caller-owned extra state
 * @returns A frozen, validated copy
 */
function freezeExtraState(extra: PoolExtraState): Readonly<PoolExtraState> {
  const copy: PoolExtraState = { ...extra }

  invariant(
    copy.protocolFeeRate === undefined || isUintAtMost(copy.protocolFeeRate, MAX_PROTOCOL_FEE_RATE),
    'EXTRA_PROTOCOL_FEE_RATE'
  )
  invariant(copy.pauseFlags === undefined || isUintAtMost(copy.pauseFlags, MAX_PAUSE_FLAGS), 'EXTRA_PAUSE_FLAGS')
  invariant(
    copy.swapOpenTime === undefined || isUintAtMost(copy.swapOpenTime, MAX_SWAP_OPEN_TIME),
    'EXTRA_SWAP_OPEN_TIME'
  )
  // extra fee rates are bounded by MAX_EXTRA_TRADE_FEE_RATE (1e6), which is NOT MAX_TRADE_FEE_RATE (1e6 - 1):
  // they are skimmed before the curve, so they never feed the `1e6 - feePips` denominator
  invariant(
    copy.alphaExtraTradeFeeRate === undefined || isUintAtMost(copy.alphaExtraTradeFeeRate, MAX_EXTRA_TRADE_FEE_RATE),
    'EXTRA_ALPHA_FEE_RATE'
  )
  invariant(
    copy.dexExtraTradeFeeRate === undefined || isUintAtMost(copy.dexExtraTradeFeeRate, MAX_EXTRA_TRADE_FEE_RATE),
    'EXTRA_DEX_FEE_RATE'
  )
  invariant(copy.dynamicFeeEnabled === undefined || typeof copy.dynamicFeeEnabled === 'boolean', 'EXTRA_DYNAMIC_FEE')

  return Object.freeze(copy)
}

/**
 * Represents a V3 pool
 */
export class Pool {
  public readonly token0: Token
  public readonly token1: Token
  /** Third element of the pool identity key. Stored, never derived from the fee. */
  public readonly tickSpacing: number
  /** ppm. Mutable on-chain data (`PoolAdmin.setTradeFeeRate`), NOT part of the identity key. */
  public readonly tradeFeeRate: number
  public readonly sqrtRatioX96: JSBI
  public readonly liquidity: JSBI
  public readonly tickCurrent: number
  public readonly tickDataProvider: TickDataProvider
  public readonly extra!: Readonly<PoolExtraState> // definite-assignment: set via Object.defineProperty (runtime-frozen)

  private _token0Price?: Price<Token, Token>
  private _token1Price?: Price<Token, Token>

  public static getAddress(
    tokenA: Token,
    tokenB: Token,
    tickSpacing: number,
    initCodeHash: string,
    factoryAddress: string
  ): string {
    return computePoolAddress({
      factoryAddress,
      tokenA,
      tokenB,
      tickSpacing,
      initCodeHash
    })
  }

  /**
   * Construct a pool
   * @param tokenA One of the tokens in the pool
   * @param tokenB The other token in the pool
   * @param tickSpacing The tick spacing of the pool, third element of the pool identity key
   * @param tradeFeeRate The base trade fee in ppm charged on the input amount of every swap
   * @param sqrtRatioX96 The sqrt of the current ratio of amounts of token1 to token0
   * @param liquidity The current value of in range liquidity
   * @param tickCurrent The current tick of the pool
   * @param ticks The current state of the pool ticks or a data provider that can return tick data
   * @param extra Mutable, admin-controlled pool state (fees, pause flags, ...)
   */
  public constructor(
    tokenA: Token,
    tokenB: Token,
    tickSpacing: number,
    tradeFeeRate: number,
    sqrtRatioX96: BigintIsh,
    liquidity: BigintIsh,
    tickCurrent: number,
    ticks: TickDataProvider | (Tick | TickConstructorArgs)[] = NO_TICK_DATA_PROVIDER_DEFAULT,
    extra: PoolExtraState = {}
  ) {
    invariant(isValidTickSpacing(tickSpacing), 'TICK_SPACING')
    // `PoolConstants.MAX_TRADE_FEE_RATE` is inclusive but stops at 1e6 - 1: a rate of exactly 1e6 would make
    // the swap loop divide by `1e6 - feePips == 0`, so the pool itself refuses it ('TFR') and so do we.
    invariant(Number.isInteger(tradeFeeRate) && tradeFeeRate >= 0 && tradeFeeRate <= MAX_TRADE_FEE_RATE, 'FEE')

    const tickCurrentSqrtRatioX96 = TickMath.getSqrtRatioAtTick(tickCurrent)
    const nextTickSqrtRatioX96 = TickMath.getSqrtRatioAtTick(tickCurrent + 1)
    invariant(
      JSBI.greaterThanOrEqual(JSBI.BigInt(sqrtRatioX96), tickCurrentSqrtRatioX96) &&
        JSBI.lessThanOrEqual(JSBI.BigInt(sqrtRatioX96), nextTickSqrtRatioX96),
      'PRICE_BOUNDS'
    )
    // always create a copy of the list since we want the pool's tick list to be immutable
    ;[this.token0, this.token1] = tokenA.sortsBefore(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA]
    this.tickSpacing = tickSpacing
    this.tradeFeeRate = tradeFeeRate
    this.sqrtRatioX96 = JSBI.BigInt(sqrtRatioX96)
    this.liquidity = JSBI.BigInt(liquidity)
    this.tickCurrent = tickCurrent
    this.tickDataProvider = Array.isArray(ticks) ? new TickListDataProvider(ticks, tickSpacing) : ticks
    // defensive copy: `extra` is a snapshot of mutable on-chain state, and a Pool must not change its
    // quotes because the caller kept mutating the object it was built from. The property itself is pinned
    // non-writable too — TS `readonly` alone would still let plain-JS callers rebind `pool.extra` and
    // silently disarm the dynamic-fee fail-closed gate
    Object.defineProperty(this, 'extra', {
      value: freezeExtraState(extra),
      writable: false,
      configurable: false,
      enumerable: true
    })
  }

  /**
   * Returns true if the token is either token0 or token1
   * @param token The token to check
   * @returns True if token is either token0 or token
   */
  public involvesToken(token: Token): boolean {
    return token.equals(this.token0) || token.equals(this.token1)
  }

  /**
   * Returns the current mid price of the pool in terms of token0, i.e. the ratio of token1 over token0
   */
  public get token0Price(): Price<Token, Token> {
    return (
      this._token0Price ??
      (this._token0Price = new Price(
        this.token0,
        this.token1,
        Q192,
        JSBI.multiply(this.sqrtRatioX96, this.sqrtRatioX96)
      ))
    )
  }

  /**
   * Returns the current mid price of the pool in terms of token1, i.e. the ratio of token0 over token1
   */
  public get token1Price(): Price<Token, Token> {
    return (
      this._token1Price ??
      (this._token1Price = new Price(
        this.token1,
        this.token0,
        JSBI.multiply(this.sqrtRatioX96, this.sqrtRatioX96),
        Q192
      ))
    )
  }

  /**
   * Return the price of the given token in terms of the other token in the pool.
   * @param token The token to return price of
   * @returns The price of the given token, in terms of the other.
   */
  public priceOf(token: Token): Price<Token, Token> {
    invariant(this.involvesToken(token), 'TOKEN')
    return token.equals(this.token0) ? this.token0Price : this.token1Price
  }

  /**
   * Returns the chain ID of the tokens in the pool.
   */
  public get chainId(): number {
    return this.token0.chainId
  }

  /**
   * Given an input amount of a token, return the computed output amount, and a pool with state updated after the trade
   * @param inputAmount The input amount for which to quote the output amount, must be strictly positive
   * @param sqrtPriceLimitX96 The Q64.96 sqrt price limit, `undefined` for none
   * @param extraFeeClass The extra trade fee bucket charged by the pool. Mandatory: the pool picks a bucket on
   * every swap (`PoolSwapV1.sol:160`), there is no "no extra fee" mode to borrow `undefined` for
   * @param opts Escape hatches, see `PoolQuoteOptions`
   * @returns The net output amount (what the user actually receives) and the pool with updated state
   */
  public async getOutputAmount(
    inputAmount: CurrencyAmount<Token>,
    sqrtPriceLimitX96: JSBI | undefined,
    extraFeeClass: ExtraFeeClass,
    opts?: PoolQuoteOptions
  ): Promise<[CurrencyAmount<Token>, Pool]> {
    invariant(this.involvesToken(inputAmount.currency), 'TOKEN')
    this.assertQuotable(inputAmount, extraFeeClass, opts)

    const zeroForOne = inputAmount.currency.equals(this.token0)

    // PoolSwapV1.sol:174-176 — exact-in pre-deduction (ceil by default, see `extraFeeAmount`). The curve is
    // then seeded with the net amount (`amountSpecifiedRemaining = amountSpecified - extraFee`), so the
    // output returned here is already the net output the user receives.
    const extraFee = this.extraFeeAmount(inputAmount.quotient, extraFeeClass)

    const { amountCalculated: outputAmount, sqrtRatioX96, liquidity, tickCurrent } = await this.swap(
      zeroForOne,
      JSBI.subtract(inputAmount.quotient, extraFee),
      sqrtPriceLimitX96
    )
    const outputToken = zeroForOne ? this.token1 : this.token0
    return [
      CurrencyAmount.fromRawAmount(outputToken, JSBI.multiply(outputAmount, NEGATIVE_ONE)),
      new Pool(
        this.token0,
        this.token1,
        this.tickSpacing,
        this.tradeFeeRate,
        sqrtRatioX96,
        liquidity,
        tickCurrent,
        this.tickDataProvider,
        this.extra
      )
    ]
  }

  /**
   * Given a desired output amount of a token, return the computed input amount and a pool with state updated after the trade
   * @param outputAmount the output amount for which to quote the input amount, must be strictly positive
   * @param sqrtPriceLimitX96 The Q64.96 sqrt price limit. If zero for one, the price cannot be less than this value after the swap. If one for zero, the price cannot be greater than this value after the swap
   * @param extraFeeClass The extra trade fee bucket charged by the pool. Mandatory: the pool picks a bucket on
   * every swap (`PoolSwapV1.sol:160`), there is no "no extra fee" mode to borrow `undefined` for
   * @param opts Escape hatches, see `PoolQuoteOptions`
   * @returns The total input amount (curve input + extra fee, i.e. what the user actually pays) and the pool with updated state
   */
  public async getInputAmount(
    outputAmount: CurrencyAmount<Token>,
    sqrtPriceLimitX96: JSBI | undefined,
    extraFeeClass: ExtraFeeClass,
    opts?: PoolQuoteOptions
  ): Promise<[CurrencyAmount<Token>, Pool]> {
    invariant(outputAmount.currency.isToken && this.involvesToken(outputAmount.currency), 'TOKEN')
    this.assertQuotable(outputAmount, extraFeeClass, opts)

    const zeroForOne = outputAmount.currency.equals(this.token1)

    const { amountCalculated: inputAmount, sqrtRatioX96, liquidity, tickCurrent } = await this.swap(
      zeroForOne,
      JSBI.multiply(outputAmount.quotient, NEGATIVE_ONE),
      sqrtPriceLimitX96
    )
    // PoolSwapV1.sol:294-296 — exact-out surcharge (ceil by default, see `extraFeeAmount`), taken on the
    // curve input that the loop just computed, then added to the reported token-in amount.
    const extraFee = this.extraFeeAmount(inputAmount, extraFeeClass)
    const inputToken = zeroForOne ? this.token0 : this.token1
    return [
      CurrencyAmount.fromRawAmount(inputToken, JSBI.add(inputAmount, extraFee)),
      new Pool(
        this.token0,
        this.token1,
        this.tickSpacing,
        this.tradeFeeRate,
        sqrtRatioX96,
        liquidity,
        tickCurrent,
        this.tickDataProvider,
        this.extra
      )
    ]
  }

  /**
   * The guards both offline quote entry points share, all mirroring something the pool itself refuses.
   * @param amount The amount being quoted, exact-in or exact-out
   * @param extraFeeClass The extra trade fee bucket
   * @param opts Escape hatches, see `PoolQuoteOptions`
   */
  private assertQuotable(amount: CurrencyAmount<Token>, extraFeeClass: ExtraFeeClass, opts?: PoolQuoteOptions): void {
    // PoolSwapV1.sol:136 `require(amountSpecified != 0, 'AS')`. Both entry points take a magnitude, so the
    // sign is implied by which one is called and a zero (or negative) amount is never a valid quote.
    invariant(JSBI.greaterThan(amount.quotient, ZERO), 'AMOUNT')

    // `_selectExtraFeeRate` (PoolSwapV1.sol:118-122) has exactly two buckets and no default: a quote that
    // does not name one cannot be executed, so it is refused here instead of silently meaning "no fee".
    invariant(extraFeeClass === ExtraFeeClass.ALPHA || extraFeeClass === ExtraFeeClass.DEX, 'CLASS')

    if (this.extra.dynamicFeeEnabled !== true) return

    // PoolSwapV1.sol:188-189 overrides `cache.tradeFeeRate` with an oracle-derived rate before the first
    // `computeSwapStep`; that oracle is not readable offline, so the base rate is only a floor on the real
    // fee. Fail closed — an estimate that cannot be executed must not be mistaken for one that can.
    invariant(opts?.assumeBaseFee === true, 'DYNAMIC_FEE')
    warning(
      false,
      'dynamicFeeEnabled: this pool overrides its trade fee on-chain with an oracle-derived rate that is always ' +
        '>= the base tradeFeeRate used here. So this offline quote is a LOWER bound on the fee and therefore an ' +
        'UPPER bound on the output amount (and a LOWER bound on the required input): the on-chain swap can return ' +
        'less than quoted. Do NOT feed it into amountOutMinimum / do NOT use it as amountInMaximum — a bound ' +
        'derived from these numbers MAY be unmeetable and revert the swap (it survives only when the dynamic ' +
        'component happens to be zero or the price moved in your favour). Use ByrealQuoter for the ' +
        'authoritative price.'
    )
  }

  /**
   * Mirrors `PoolSwapV1._selectExtraFeeRate` (PoolSwapV1.sol:118-122): two buckets, no default. The class is
   * validated up front in `assertQuotable`, the invariant here is the belt to that suspenders.
   * @param extraFeeClass The extra trade fee bucket
   * @returns The extra trade fee rate in ppm
   */
  private extraFeeRate(extraFeeClass: ExtraFeeClass): number {
    if (extraFeeClass === ExtraFeeClass.ALPHA) return this.extra.alphaExtraTradeFeeRate ?? 0
    if (extraFeeClass === ExtraFeeClass.DEX) return this.extra.dexExtraTradeFeeRate ?? 0
    invariant(false, 'CLASS')
  }

  /**
   * The extra trade fee skimmed off the token-in side, at both `PoolSwapV1.sol` call sites:
   *
   * - exact-in  (PoolSwapV1.sol:174-176): `base = amountSpecified`, the user supplied input amount.
   * - exact-out (PoolSwapV1.sol:294-296): `base = state.amountCalculated`, the curve input incl. LP fee.
   *
   * Rounding is always **ceil**, matching the pool contract's `FullMath.mulDivRoundingUp` — in favour of
   * the protocol, like the base LP/flash fee. Both operands are non-negative here, so `JSBI.divide`
   * (truncation towards zero) equals floor and the ceil is the usual "+1 when there is a remainder",
   * making this wei-for-wei identical to the contract.
   *
   * A zero rate short-circuits to zero — the contract skips the multiplication entirely
   * (`extraFeeRate > 0` guard), so ceil never turns a dormant bucket into a 1 wei fee.
   * @param base The amount the rate is applied to
   * @param extraFeeClass The extra trade fee bucket
   * @returns The extra fee amount, in token-in units
   */
  private extraFeeAmount(base: JSBI, extraFeeClass: ExtraFeeClass): JSBI {
    const rate = this.extraFeeRate(extraFeeClass)
    if (rate <= 0) return ZERO
    const product = JSBI.multiply(base, JSBI.BigInt(rate))
    const quotient = JSBI.divide(product, FEE_RATE_DENOMINATOR_JSBI)
    return JSBI.equal(JSBI.remainder(product, FEE_RATE_DENOMINATOR_JSBI), ZERO) ? quotient : JSBI.add(quotient, ONE)
  }

  /**
   * Executes a swap
   * @param zeroForOne Whether the amount in is token0 or token1
   * @param amountSpecified The amount of the swap, which implicitly configures the swap as exact input (positive), or exact output (negative)
   * @param sqrtPriceLimitX96 The Q64.96 sqrt price limit. If zero for one, the price cannot be less than this value after the swap. If one for zero, the price cannot be greater than this value after the swap
   * @returns amountCalculated
   * @returns sqrtRatioX96
   * @returns liquidity
   * @returns tickCurrent
   */
  private async swap(
    zeroForOne: boolean,
    amountSpecified: JSBI,
    sqrtPriceLimitX96?: JSBI
  ): Promise<{ amountCalculated: JSBI; sqrtRatioX96: JSBI; liquidity: JSBI; tickCurrent: number }> {
    if (!sqrtPriceLimitX96)
      sqrtPriceLimitX96 = zeroForOne
        ? JSBI.add(TickMath.MIN_SQRT_RATIO, ONE)
        : JSBI.subtract(TickMath.MAX_SQRT_RATIO, ONE)

    if (zeroForOne) {
      invariant(JSBI.greaterThan(sqrtPriceLimitX96, TickMath.MIN_SQRT_RATIO), 'RATIO_MIN')
      invariant(JSBI.lessThan(sqrtPriceLimitX96, this.sqrtRatioX96), 'RATIO_CURRENT')
    } else {
      invariant(JSBI.lessThan(sqrtPriceLimitX96, TickMath.MAX_SQRT_RATIO), 'RATIO_MAX')
      invariant(JSBI.greaterThan(sqrtPriceLimitX96, this.sqrtRatioX96), 'RATIO_CURRENT')
    }

    const exactInput = JSBI.greaterThanOrEqual(amountSpecified, ZERO)

    // keep track of swap state

    const state = {
      amountSpecifiedRemaining: amountSpecified,
      amountCalculated: ZERO,
      sqrtPriceX96: this.sqrtRatioX96,
      tick: this.tickCurrent,
      liquidity: this.liquidity
    }

    // start swap while loop
    // `!=` compares JSBI object identity, not value. The loop only terminates because
    // `computeSwapStep` passes the `sqrtRatioTargetX96` object through unchanged when the limit is reached —
    // if that return path ever constructs a fresh JSBI instead, this silently becomes an infinite loop.
    while (JSBI.notEqual(state.amountSpecifiedRemaining, ZERO) && state.sqrtPriceX96 != sqrtPriceLimitX96) {
      let step: Partial<StepComputations> = {}
      step.sqrtPriceStartX96 = state.sqrtPriceX96

      // because each iteration of the while loop rounds, we can't optimize this code (relative to the smart contract)
      // by simply traversing to the next available tick, we instead need to exactly replicate
      // tickBitmap.nextInitializedTickWithinOneWord
      ;[step.tickNext, step.initialized] = await this.tickDataProvider.nextInitializedTickWithinOneWord(
        state.tick,
        zeroForOne,
        this.tickSpacing
      )

      if (step.tickNext < TickMath.MIN_TICK) {
        step.tickNext = TickMath.MIN_TICK
      } else if (step.tickNext > TickMath.MAX_TICK) {
        step.tickNext = TickMath.MAX_TICK
      }

      step.sqrtPriceNextX96 = TickMath.getSqrtRatioAtTick(step.tickNext)
      ;[state.sqrtPriceX96, step.amountIn, step.amountOut, step.feeAmount] = SwapMath.computeSwapStep(
        state.sqrtPriceX96,
        (zeroForOne
        ? JSBI.lessThan(step.sqrtPriceNextX96, sqrtPriceLimitX96)
        : JSBI.greaterThan(step.sqrtPriceNextX96, sqrtPriceLimitX96))
          ? sqrtPriceLimitX96
          : step.sqrtPriceNextX96,
        state.liquidity,
        state.amountSpecifiedRemaining,
        this.tradeFeeRate
      )

      if (exactInput) {
        state.amountSpecifiedRemaining = JSBI.subtract(
          state.amountSpecifiedRemaining,
          JSBI.add(step.amountIn, step.feeAmount)
        )
        state.amountCalculated = JSBI.subtract(state.amountCalculated, step.amountOut)
      } else {
        state.amountSpecifiedRemaining = JSBI.add(state.amountSpecifiedRemaining, step.amountOut)
        state.amountCalculated = JSBI.add(state.amountCalculated, JSBI.add(step.amountIn, step.feeAmount))
      }

      // TODO
      if (JSBI.equal(state.sqrtPriceX96, step.sqrtPriceNextX96)) {
        // if the tick is initialized, run the tick transition
        if (step.initialized) {
          let liquidityNet = JSBI.BigInt((await this.tickDataProvider.getTick(step.tickNext)).liquidityNet)
          // if we're moving leftward, we interpret liquidityNet as the opposite sign
          // safe because liquidityNet cannot be type(int128).min
          if (zeroForOne) liquidityNet = JSBI.multiply(liquidityNet, NEGATIVE_ONE)

          state.liquidity = LiquidityMath.addDelta(state.liquidity, liquidityNet)
        }

        state.tick = zeroForOne ? step.tickNext - 1 : step.tickNext
      } else if (JSBI.notEqual(state.sqrtPriceX96, step.sqrtPriceStartX96)) {
        // updated comparison function
        // recompute unless we're on a lower tick boundary (i.e. already transitioned ticks), and haven't moved
        state.tick = TickMath.getTickAtSqrtRatio(state.sqrtPriceX96)
      }
    }

    return {
      amountCalculated: state.amountCalculated,
      sqrtRatioX96: state.sqrtPriceX96,
      liquidity: state.liquidity,
      tickCurrent: state.tick
    }
  }
}
