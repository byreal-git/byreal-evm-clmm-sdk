/**
 * compat 层的静态数学类：把 Solana 版 SDK 的
 * `TickMath` / `SqrtPriceMath` / `LiquidityMath` 三个静态类的**调用形状**搬到 EVM 上。
 *
 * 两条铁律：
 *
 * 1. **本文件不含任何定点数运算**。每个方法都只做三件事：宽进转换（`./coerce`、`./state`）→
 *    转调 `../calculate` 的纯函数（或 `../uniswap` 包出来的 v3-sdk `TickMath`）→ 原样返回。
 *    CLMM 数学只允许有一份实现，compat 抄一份就等于埋一个「两处结果不一致」的定时炸弹。
 * 2. **`ui*` 一律透传核心算好的值，compat 不自己格式化**。核心的 `getAmountsFromAmount` /
 *    `getPositionView` 内部会先按池子的链上顺序把 token0/token1 排正（调用方传反了也能救回来），
 *    再用**排序后**那一边的 decimals 去格式化。compat 若拿 `params.token0.decimals` 重新格式化一遍，
 *    在「传反了」的场景下会算出小数点位置错误的展示值 —— 那比不给 ui 字段更危险。
 *
 * ⚠️ 全文件最重要的一段是 X64 → X96：Solana/Raydium 是 Q64.64（`sqrtPriceX64`），
 * Uniswap V3 是 Q64.96（`sqrtPriceX96`），两者差 2^32 倍。4 个 `*X64*` 方法**存在但一定抛错**，
 * 绝不静默返回 X96 的值 —— 详见 {@link SqrtPriceMath}。
 */
import { zeroAddress } from 'viem'

import {
  alignTick,
  getAmountsFromAmount,
  getBurnAmountsWithSlippage,
  getFullRangeTicks as coreGetFullRangeTicks,
  getMintAmountsWithSlippage,
  getPositionView,
  parseDecimalToFraction,
  priceToTick as corePriceToTick,
  sqrtPriceX96ToPrice as coreSqrtPriceX96ToPrice,
  tickToPrice as coreTickToPrice,
} from '../calculate.js'
import { MAX_TICK as CORE_MAX_TICK, MIN_TICK as CORE_MIN_TICK } from '../constants.js'
import type { IAmountsFromAmountReturn, IPoolStateRaw, IPositionStateRaw, ITokenInfo } from '../types.js'
// 底层 TickMath 与本文件导出的兼容层 TickMath 同名，取别名区分
import { TickMath as UniTickMath, encodeSqrtRatioX96, Fraction } from '../raw/index.js'

import { COMPAT_ERR_PREFIX, resolveSlippageBps, toBigInt, type Numericish } from './coerce.js'
import { toPoolStateRaw, type PoolSnapshotish } from './state.js'

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** JSBI（v3-sdk 内部的大整数） → bigint。与核心 calculate.ts 同一套字符串过渡口径 */
function jsbiToBigInt(v: { toString(): string }): bigint {
  return BigInt(v.toString())
}

/**
 * bigint → JSBI（v3-sdk 的 `TickMath.getTickAtSqrtRatio` 只吃 JSBI）。
 *
 * 之所以绕 `Fraction` 而不是 `import JSBI from 'jsbi'`：
 * - compat 的依赖边界是「只依赖 `src/*` 与 viem」，不该多一个直接依赖；
 * - 更要紧的是**必须与 v3-sdk 用同一份 JSBI**。`new Fraction(x).quotient` 产出的 JSBI
 *   来自 sdk-core（与 v3-sdk 同一份解析结果），跨副本传值时那些 `__unsignedDigit` 之类的
 *   原型方法调用不会出问题。
 *
 * `new Fraction(v)` 的分母默认是 1，`quotient` = v / 1，**精确**等于原值，不存在取整损失。
 * 返回类型交给 TS 从 sdk-core 的 `.d.ts` 推导（就是 JSBI），本文件不写出这个类型名。
 */
function toJsbi(v: bigint) {
  return new Fraction(v.toString()).quotient
}

/** tick 合法性校验：整数 + 落在 [MIN_TICK, MAX_TICK]。v3-sdk 原生只抛一个 'TICK'，指不出方向 */
function assertTick(tick: number, field: string): number {
  if (typeof tick !== 'number' || !Number.isInteger(tick)) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} ${field} 必须是整数 tick，收到 ${String(tick)}。` +
        `若手上是价格，请先用 TickMath.getTickWithPriceAndTickspacing 换算。`,
    )
  }
  if (tick < CORE_MIN_TICK || tick > CORE_MAX_TICK) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} ${field}=${tick} 越界，必须落在 [${CORE_MIN_TICK}, ${CORE_MAX_TICK}]。`,
    )
  }
  return tick
}

/**
 * 「主名 + 旧别名」二选一的取值器（如 `amount0` / `amountA`）。
 *
 * 两个都传且不相等时**抛而不是挑一个**：这两个字段在语义上是同一个金额，
 * 出现两个不同的值只可能是调用方改了一半，猜哪个都可能让用户投错钱。
 */
function pickAmountAlias(
  primary: Numericish | undefined | null,
  alias: Numericish | undefined | null,
  primaryName: string,
  aliasName: string,
  method: string,
): bigint {
  const a = primary === undefined || primary === null ? undefined : toBigInt(primary, primaryName)
  const b = alias === undefined || alias === null ? undefined : toBigInt(alias, aliasName)

  if (a === undefined && b === undefined) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} ${method} 必须传 ${primaryName}（旧名 ${aliasName} 也认），当前两个都没传。`,
    )
  }
  if (a !== undefined && b !== undefined && a !== b) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} ${method} 的 ${primaryName}=${a} 与旧名 ${aliasName}=${b} 不一致。` +
        '两者是同一个金额的新旧写法，请只保留一个。',
    )
  }
  return a ?? (b as bigint)
}

/**
 * 造一个「只有区间与流动性」的虚拟仓位快照，喂给核心 `getPositionView`。
 *
 * `LiquidityMath` 面向的是「还没上链的仓位」（开仓预览、区间滑块联动），本来就没有
 * tokenId / nonce / feeGrowth 这些记账字段；核心的本地数学一个都不读它们
 * （只用 tickLower / tickUpper / liquidity），所以填零是安全的，不是在编数据。
 */
function virtualPositionState(
  poolState: IPoolStateRaw,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): IPositionStateRaw {
  return {
    tokenId: 0n,
    nonce: 0n,
    operator: zeroAddress,
    token0: poolState.token0,
    token1: poolState.token1,
    tickSpacing: poolState.tickSpacing,
    tickLower,
    tickUpper,
    liquidity,
    feeGrowthInside0LastX128: 0n,
    feeGrowthInside1LastX128: 0n,
    tokensOwed0: 0n,
    tokensOwed1: 0n,
  }
}

/**
 * 4 个 `*X64*` 方法共用的抛错器。
 *
 * **为什么抛而不是返回 X96 的值**：调用方拿到一个数会继续往下算，量纲错误会在几层之后
 * 以「价格差了 43 亿倍」的形式暴露，极难定位；在调用点当场炸掉，定位成本是 0。
 */
function throwX64Removed(method: string, replacement: string): never {
  throw new Error(
    `${COMPAT_ERR_PREFIX} SqrtPriceMath.${method} 在 EVM 上不存在。\n` +
      'Solana/Raydium 用 Q64.64 定点数（sqrtPriceX64），Uniswap V3 用 Q64.96（sqrtPriceX96），\n' +
      '两者相差 2^32 倍（约 43 亿），直接换名会算出错误的价格。\n' +
      `请改用 SqrtPriceMath.${replacement}。`,
  )
}

// ---------------------------------------------------------------------------
// TickMath
// ---------------------------------------------------------------------------

/**
 * tick ↔ 价格 / sqrtPrice 的换算，对齐旧 Solana `TickMath` 的调用形状。
 *
 * 兼容层需要注意两处口径差异：
 * - 旧版价格用 `Decimal`，这里一律是**已格式化的字符串**（8 位有效数字，与核心 calculate 同口径）。
 *   理由见 models.ts：两个真相源迟早不一致，只留一个。
 * - 旧版按 `decimalsA` / `decimalsB` 两个数字传参，这里传完整的 `ITokenInfo` ——
 *   v3-sdk 的价格实体需要地址来判断谁是 base、谁是 quote，只给 decimals 不够。
 */
export class TickMath {
  /** tick 下界（= 核心 `MIN_TICK`，与 @uniswap/v3-sdk 一致） */
  static readonly MIN_TICK: number = CORE_MIN_TICK
  /** tick 上界（= 核心 `MAX_TICK`） */
  static readonly MAX_TICK: number = CORE_MAX_TICK

  /**
   * tick → 人类可读价格「1 token0 = ? token1」（8 位有效数字）。对应旧 `TickMath.getPriceFromTick`。
   *
   * `baseIn` 保留了旧版的同名开关：`true`（默认）= 「1 token0 值多少 token1」，
   * `false` = 反过来「1 token1 值多少 token0」。实现上是把 base/quote 对调后再让
   * v3-sdk 算一次（而不是拿 1 去除结果），所以反向价格同样是精确分数换算出来的，不会有二次误差。
   */
  static getPriceFromTick(params: {
    tick: number
    token0: ITokenInfo
    token1: ITokenInfo
    /** 默认 true。false 时返回反向价格「1 token1 = ? token0」 */
    baseIn?: boolean
  }): string {
    const { tick, token0, token1, baseIn = true } = params
    assertTick(tick, 'tick')
    return baseIn
      ? coreTickToPrice({ tick, token0, token1 })
      : coreTickToPrice({ tick, token0: token1, token1: token0 })
  }

  /**
   * 人类可读价格「1 token0 = ? token1」→ 对齐到 tickSpacing 的 tick。
   * 对应旧 `TickMath.getTickWithPriceAndTickspacing`。
   *
   * ⚠️ 与旧版的取整方向不同：旧版是「远离 0 取整」（负数 floor、正数 ceil），
   * 这里走核心 `priceToTick` 的**四舍五入到最近可用 tick**（与 Uniswap 前端一致）。
   * 之所以不复刻旧行为：远离 0 取整在价格轴上不对称（同一个价格，在 tick>0 和 tick<0
   * 两侧会朝相反方向偏），前端做「输入框失焦自动吸附」时会看到价格莫名跳动。
   * 需要明确的方向性对齐（做区间时保证不被收窄）请直接用核心的 `alignTick({mode:'down'|'up'})`。
   */
  static getTickWithPriceAndTickspacing(params: {
    price: string | number
    token0: ITokenInfo
    token1: ITokenInfo
    tickSpacing: number
  }): number {
    const { price, token0, token1, tickSpacing } = params
    return corePriceToTick({ price: String(price), token0, token1, tickSpacing })
  }

  /** tick → sqrtPriceX96（**Q64.96**，不是 Solana 的 X64）。转调 v3-sdk 的 `TickMath.getSqrtRatioAtTick` */
  static getSqrtRatioAtTick(tick: number): bigint {
    assertTick(tick, 'tick')
    return jsbiToBigInt(UniTickMath.getSqrtRatioAtTick(tick))
  }

  /**
   * sqrtPriceX96 → tick（取满足 `getSqrtRatioAtTick(tick) <= sqrtPriceX96` 的最大 tick，即向下取整）。
   *
   * 入参走 `toBigInt` 宽进（string / BN-like 都认），因为这个值最常见的来源是后端下发的 JSON。
   */
  static getTickAtSqrtRatio(sqrtPriceX96: Numericish): number {
    const value = toBigInt(sqrtPriceX96, 'sqrtPriceX96')
    try {
      return UniTickMath.getTickAtSqrtRatio(toJsbi(value))
    } catch (e) {
      const lo = jsbiToBigInt(UniTickMath.MIN_SQRT_RATIO)
      const hi = jsbiToBigInt(UniTickMath.MAX_SQRT_RATIO)
      throw new Error(
        `${COMPAT_ERR_PREFIX} sqrtPriceX96=${value} 超出可表示范围 [${lo}, ${hi})` +
          `（上界开区间 —— 池子价格永远取不到 MAX_TICK 对应的那个值）。\n` +
          '常见原因：① 传进来的其实是 Solana 的 sqrtPriceX64（两者差 2^32 倍）；' +
          '② 传成了「价格」而不是 Q64.96 定点数（价格请用 SqrtPriceMath.priceToSqrtPriceX96 先转）。\n' +
          `原始错误：${(e as Error).message}`,
      )
    }
  }

  /** 把任意 tick 四舍五入到 tickSpacing 的整数倍（并夹在 [MIN_TICK, MAX_TICK] 内）。转调核心 `alignTick` */
  static nearestUsableTick(tick: number, tickSpacing: number): number {
    return alignTick({ tick, tickSpacing, mode: 'nearest' })
  }

  /** 全区间的 tick 上下界（Uniswap 前端「Full Range」按钮的口径）。转调核心 `getFullRangeTicks` */
  static getFullRangeTicks(tickSpacing: number): { tickLower: number; tickUpper: number } {
    return coreGetFullRangeTicks(tickSpacing)
  }
}

// ---------------------------------------------------------------------------
// SqrtPriceMath
// ---------------------------------------------------------------------------

/**
 * sqrtPrice ↔ 价格 / tick 的换算，对齐旧 Solana `SqrtPriceMath` 的调用形状。
 *
 * **本类是整个兼容层最危险的一处**：旧 Solana SDK 的同名方法全是 X64 口径
 * （`sqrtPriceX64 = sqrt(price) * 2^64`），EVM 是 X96（`sqrt(price) * 2^96`），
 * 两者相差 2^32 ≈ 43 亿倍。所以 4 个 `*X64*` 方法在这里**存在但一定抛错**：
 * 保留方法名是为了让旧代码「一调就炸」而不是「编译报 undefined 后被人随手改成同名的 X96 方法」，
 * 抛错文案里直接给出正确的替代方法名。
 */
export class SqrtPriceMath {
  /** sqrtPriceX96 → 人类可读价格「1 token0 = ? token1」（8 位有效数字）。转调核心 `sqrtPriceX96ToPrice` */
  static sqrtPriceX96ToPrice(params: {
    sqrtPriceX96: Numericish
    token0: ITokenInfo
    token1: ITokenInfo
  }): string {
    return coreSqrtPriceX96ToPrice({
      sqrtPriceX96: toBigInt(params.sqrtPriceX96, 'sqrtPriceX96'),
      token0: params.token0,
      token1: params.token1,
    })
  }

  /**
   * 人类可读价格「1 token0 = ? token1」→ sqrtPriceX96（Q64.96）。
   *
   * 走「价格字符串 → 精确分数（核心 `parseDecimalToFraction`）→ 两边补 decimals →
   * v3-sdk `encodeSqrtRatioX96`」这条路，而**不是**「价格 → tick → getSqrtRatioAtTick」：
   * 后者会把价格吸附到 tick 网格上（同一个 tick 内的价格差异被抹平），
   * 用来初始化池子会让开盘价直接偏掉最多一个 tick（0.01%）。
   */
  static priceToSqrtPriceX96(params: {
    price: string | number
    token0: ITokenInfo
    token1: ITokenInfo
  }): bigint {
    const { numerator, denominator } = parseDecimalToFraction(String(params.price))
    // Price(base=token0, quote=token1)：分母是 token0 的原始单位数量，分子是 token1 的
    const rawAmount0 = denominator * 10n ** BigInt(params.token0.decimals)
    const rawAmount1 = numerator * 10n ** BigInt(params.token1.decimals)
    return jsbiToBigInt(encodeSqrtRatioX96(rawAmount1.toString(), rawAmount0.toString()))
  }

  /** tick → sqrtPriceX96。与 {@link TickMath.getSqrtRatioAtTick} 完全等价，只是保留旧类名下的入口 */
  static getSqrtPriceX96FromTick(tick: number): bigint {
    return TickMath.getSqrtRatioAtTick(tick)
  }

  /** sqrtPriceX96 → tick。与 {@link TickMath.getTickAtSqrtRatio} 完全等价 */
  static getTickFromSqrtPriceX96(sqrtPriceX96: Numericish): number {
    return TickMath.getTickAtSqrtRatio(sqrtPriceX96)
  }

  // —— 旧 X64 名字：存在，但一定抛（返回类型 never，调用点后面的代码会被 TS 判成不可达）——

  /** @deprecated EVM 是 X96 定点数，不是 Solana 的 X64。请改用 {@link SqrtPriceMath.getSqrtPriceX96FromTick}。调用必抛。 */
  static getSqrtPriceX64FromTick(_tick: number): never {
    return throwX64Removed('getSqrtPriceX64FromTick', 'getSqrtPriceX96FromTick(tick)')
  }

  /** @deprecated 同上，请改用 {@link SqrtPriceMath.getTickFromSqrtPriceX96}。调用必抛。 */
  static getTickFromSqrtPriceX64(_v: Numericish): never {
    return throwX64Removed('getTickFromSqrtPriceX64', 'getTickFromSqrtPriceX96(sqrtPriceX96)')
  }

  /** @deprecated 同上，请改用 {@link SqrtPriceMath.sqrtPriceX96ToPrice}。调用必抛。 */
  static sqrtPriceX64ToPrice(..._a: unknown[]): never {
    return throwX64Removed(
      'sqrtPriceX64ToPrice',
      'sqrtPriceX96ToPrice({ sqrtPriceX96, token0, token1 })',
    )
  }

  /** @deprecated 同上，请改用 {@link SqrtPriceMath.priceToSqrtPriceX96}。调用必抛。 */
  static priceToSqrtPriceX64(..._a: unknown[]): never {
    return throwX64Removed(
      'priceToSqrtPriceX64',
      'priceToSqrtPriceX96({ price, token0, token1 })',
    )
  }
}

// ---------------------------------------------------------------------------
// LiquidityMath —— 入参类型
// ---------------------------------------------------------------------------

/**
 * `LiquidityMath` 各方法共用的「池子 + 区间」上下文。
 *
 * `poolState` 收 {@link PoolSnapshotish}（核心 `IPoolStateRaw` / 后端接口的 `PoolDetail`
 * / 后端扁平 JSON 三种形状都认），内部统一走 `toPoolStateRaw` 归一化 ——
 * 这三个方法最常见的调用场景就是「拿后端下发的池子快照做输入框联动」，
 * 让调用方先手动转一遍纯属多余的仪式。
 *
 * `tickLower` / `tickUpper` **必须已经按 tickSpacing 对齐**（用 {@link TickMath.nearestUsableTick}
 * 或核心 `getTicksByPercentRange` / `alignTick`）。这里不替调用方悄悄对齐：
 * 对齐会改变区间，而区间是用户明确选定的东西，静默改动等于替用户做主。未对齐时核心会抛。
 */
export interface ICompatLiquidityRangeParams {
  poolState: PoolSnapshotish
  token0: ITokenInfo
  token1: ITokenInfo
  tickLower: number
  tickUpper: number
}

/** {@link LiquidityMath.getAmount1FromAmount0}（旧名 `getAmountBFromAmountA`）的入参 */
export interface ICompatAmount1FromAmount0Params extends ICompatLiquidityRangeParams {
  /** token0 的投入量（最小单位整数） */
  amount0?: Numericish
  /** `amount0` 的旧名。EVM 上 A ≡ token0（池内按地址升序），两者语义完全一致 */
  amountA?: Numericish
}

/** {@link LiquidityMath.getAmount0FromAmount1}（旧名 `getAmountAFromAmountB`）的入参 */
export interface ICompatAmount0FromAmount1Params extends ICompatLiquidityRangeParams {
  /** token1 的投入量（最小单位整数） */
  amount1?: Numericish
  /** `amount1` 的旧名。EVM 上 B ≡ token1 */
  amountB?: Numericish
}

/** {@link LiquidityMath.getAmountsFromLiquidity} 的入参 */
export interface ICompatAmountsFromLiquidityParams extends ICompatLiquidityRangeParams {
  /** 流动性 L（最小单位整数，`uint128`） */
  liquidity: Numericish
}

/** {@link LiquidityMath.getAmountsFromLiquidityWithSlippage} 的入参 */
export interface ICompatAmountsWithSlippageParams extends ICompatAmountsFromLiquidityParams {
  /**
   * 算的是**哪个方向**的下限 —— 必填，兼容层不给默认值。
   *
   * - `'mint'`（开仓 / 加仓）：`amount0Min` = 「价格漂移到最不利的一端时，**最少**也要投进去这么多」；
   * - `'burn'`（减仓 / 关仓）：`amount0Min` = 「撤走这些流动性时，**最少**要拿回这么多本金」。
   *
   * 两个方向的数值不同，用错会导致交易恒 revert（mint 当 burn 用）或者滑点保护形同虚设。
   * 旧 Solana 版靠 `amountMax: boolean` 区分，但那个布尔只表达「上限还是下限」，
   * 没表达「mint 还是 burn」，无法一一映射 —— 所以这里换成语义明确的 `action`，
   * 且做成 TS 必填字段，让漏传在**编译期**就暴露。
   */
  action: 'mint' | 'burn'
  /** 旧口径滑点，小数（0.02 = 2%）。与 `slippageBps` 二选一 */
  slippage?: number
  /** 新口径滑点，基点（200 = 2%）。与 `slippage` 二选一；都不传时用兼容层默认值并 warn 一次 */
  slippageBps?: number
}

// ---------------------------------------------------------------------------
// LiquidityMath
// ---------------------------------------------------------------------------

/**
 * 流动性 ↔ 两边金额的换算，对齐旧 Solana `LiquidityMath` 的调用形状。
 *
 * 与旧版最大的形状差异：旧版是**位置参数 + 裸 sqrtPriceX64**
 * （`getAmountBFromAmountA(startSqrtPriceX64, endSqrtPriceX64, currentSqrtPriceX64, amountA)`），
 * 这里是**具名对象 + 池子快照 + tick 区间**。这不是为了好看：
 * 手工传三个 sqrtPrice 时，「传成了 X64」「上下界传反」「current 用了上一块的值」这三类错误
 * 都不会报错、只会算出一个看起来很合理的错数；改成传池子快照后，这三类错误全部消失。
 */
export class LiquidityMath {
  /**
   * 由 token0 的投入量反推 token1 的投入量与流动性 L（开仓 / 加仓输入框联动）。
   * 对应旧 `LiquidityMath.getAmountBFromAmountA`。
   *
   * 返回的 `amount0` / `amount1` 是 `mintAmounts`（**向上取整的投入量**，mint 时合约要的就是它），
   * 不是 `position.amount0`（向下取整的持仓量）—— 两者可能差 1 wei，用错会让 mint 卡在 1 wei 上。
   *
   * 当前价格在区间外、导致这一边完全用不上时（价格在区间上方而 base 是 token0），
   * 返回 `liquidity = 0n` 而不是抛错：这是输入框联动里的**正常状态**（提示用户换一边输入），
   * 不是异常。判据见核心 `getAmountsFromAmount` 的注释。
   */
  static getAmount1FromAmount0(params: ICompatAmount1FromAmount0Params): IAmountsFromAmountReturn {
    const amount0 = pickAmountAlias(
      params.amount0,
      params.amountA,
      'amount0',
      'amountA',
      'LiquidityMath.getAmount1FromAmount0',
    )
    return getAmountsFromAmount({
      poolState: toPoolStateRaw(params.poolState, 'poolState'),
      token0: params.token0,
      token1: params.token1,
      tickLower: params.tickLower,
      tickUpper: params.tickUpper,
      base: 'Token0',
      baseAmount: amount0,
    })
  }

  /**
   * 由 token1 的投入量反推 token0 的投入量与流动性 L。
   * 对应旧 `LiquidityMath.getAmountAFromAmountB`，其余说明同 {@link LiquidityMath.getAmount1FromAmount0}。
   */
  static getAmount0FromAmount1(params: ICompatAmount0FromAmount1Params): IAmountsFromAmountReturn {
    const amount1 = pickAmountAlias(
      params.amount1,
      params.amountB,
      'amount1',
      'amountB',
      'LiquidityMath.getAmount0FromAmount1',
    )
    return getAmountsFromAmount({
      poolState: toPoolStateRaw(params.poolState, 'poolState'),
      token0: params.token0,
      token1: params.token1,
      tickLower: params.tickLower,
      tickUpper: params.tickUpper,
      base: 'Token1',
      baseAmount: amount1,
    })
  }

  /**
   * 旧名别名，**指向同一个函数**（不是拷贝的实现）。
   * EVM 上 A ≡ token0、B ≡ token1（池内按地址升序固定），所以这个别名是无损的。
   */
  static getAmountBFromAmountA = LiquidityMath.getAmount1FromAmount0

  /** 旧名别名，同 {@link LiquidityMath.getAmount0FromAmount1} */
  static getAmountAFromAmountB = LiquidityMath.getAmount0FromAmount1

  /**
   * 由流动性 L 算出两边的**持仓量**（此刻按现价 burn 掉能拿回的本金，**不含**未领手续费）。
   * 对应旧 `LiquidityMath.getAmountsFromLiquidity`。
   *
   * 口径是**向下取整的持仓量**（`position.amount0/1`），与核心 `getPositionView` 完全一致 ——
   * 减仓预览、仓位卡片上的「当前持仓」都该用这个。
   * 要的是「投进去要花多少」（向上取整）请用 {@link LiquidityMath.getAmount1FromAmount0}。
   *
   * 旧版还有一个 `roundUp: boolean` 开关，这里刻意不提供：一个方法同时承担
   * 「持仓量」与「投入量」两种语义，是旧版被误用最多的地方 —— 两个语义拆成两个方法名更难用错。
   */
  static getAmountsFromLiquidity(params: ICompatAmountsFromLiquidityParams): {
    amount0: bigint
    amount1: bigint
    uiAmount0: string
    uiAmount1: string
  } {
    const poolState = toPoolStateRaw(params.poolState, 'poolState')
    const liquidity = toBigInt(params.liquidity, 'liquidity')
    const view = getPositionView({
      poolState,
      positionState: virtualPositionState(poolState, params.tickLower, params.tickUpper, liquidity),
      token0: params.token0,
      token1: params.token1,
    })
    return {
      amount0: view.amount0,
      amount1: view.amount1,
      uiAmount0: view.uiAmount0,
      uiAmount1: view.uiAmount1,
    }
  }

  /**
   * 由流动性 L 算出带滑点保护的两边**下限**（塞进 calldata 的 `amount0Min` / `amount1Min`）。
   * 对应旧 `LiquidityMath.getAmountsFromLiquidityWithSlippage`。
   *
   * 方向由 `action` 决定（见 {@link ICompatAmountsWithSlippageParams.action}），
   * 分别转调核心的 `getMintAmountsWithSlippage` / `getBurnAmountsWithSlippage`。
   *
   * 注意这不是「把金额线性打个折」：核心走的是 v3-sdk 的
   * `mintAmountsWithSlippage` / `burnAmountsWithSlippage`，按**价格漂移 ±slippage 后的反事实池子**
   * 严格重算。CLMM 里金额与价格不是线性关系，线性打折在窄区间上会给出明显偏松的下限。
   */
  static getAmountsFromLiquidityWithSlippage(params: ICompatAmountsWithSlippageParams): {
    amount0Min: bigint
    amount1Min: bigint
  } {
    const args = {
      poolState: toPoolStateRaw(params.poolState, 'poolState'),
      token0: params.token0,
      token1: params.token1,
      tickLower: params.tickLower,
      tickUpper: params.tickUpper,
      liquidity: toBigInt(params.liquidity, 'liquidity'),
      slippageBps: resolveSlippageBps(params),
    }
    if (params.action === 'mint') return getMintAmountsWithSlippage(args)
    if (params.action === 'burn') return getBurnAmountsWithSlippage(args)
    throw new Error(
      `${COMPAT_ERR_PREFIX} LiquidityMath.getAmountsFromLiquidityWithSlippage 的 action 取值非法：` +
        `收到 ${String(params.action)}。只接受 'mint'（开仓/加仓：最少要投进去多少）` +
        `或 'burn'（减仓/关仓：最少能拿回多少）。`,
    )
  }
}
