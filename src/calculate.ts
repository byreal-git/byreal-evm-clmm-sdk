/**
 * SDK 本地数学层：纯函数、**0 RPC**。吃链上原始 state（自读或后端透传），
 * 本地算出仓位资产 / 价格区间 / 输入框联动 / 滑点下限。
 *
 * 约束：不出现任何 RPC；CLMM 数学一律委托 `src/raw` 的实体，不手写定点数；对外一律 bigint。
 */
import Decimal from 'decimal.js-light'
import { formatUnits, getAddress } from 'viem'
import {
  Pool,
  Position,
  TickMath,
  Token,
  Price,
  Percent,
  nearestUsableTick,
  tickToPrice as uniTickToPrice,
  priceToClosestTick,
} from './raw/index.js'

import { MIN_TICK, MAX_TICK } from './constants.js'
import type {
  BaseSide,
  AprScene,
  IAmountsFromAmountReturn,
  ICalculateAprParams,
  IEstimateAprParams,
  IPoolStateRaw,
  IPositionStateRaw,
  IPositionView,
  ITokenInfo,
} from './types.js'

// ---------------------------------------------------------------------------
// 内部小工具
// ---------------------------------------------------------------------------

/** JSBI / CurrencyAmount.quotient → bigint（v3-sdk 内部是 JSBI，边界处统一用字符串过渡） */
function toBigInt(v: { toString(): string }): bigint {
  return BigInt(v.toString())
}

/** 价格字符串统一保留 8 位有效数字 */
const PRICE_SIG_DIGITS = 8

/** 2^192，sqrtPriceX96 平方后的分母 */
const Q192 = 2n ** 192n

/** 校验 tick 区间合法（顺序 / 边界 / 对齐），不合法时给出可读的中文错误 */
function assertTickRange(tickLower: number, tickUpper: number, tickSpacing: number): void {
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper)) {
    throw new Error(`[evm-clmm-sdk] tick 必须是整数：tickLower=${tickLower}, tickUpper=${tickUpper}`)
  }
  if (tickLower >= tickUpper) {
    throw new Error(`[evm-clmm-sdk] tickLower(${tickLower}) 必须小于 tickUpper(${tickUpper})`)
  }
  if (tickLower < MIN_TICK || tickUpper > MAX_TICK) {
    throw new Error(
      `[evm-clmm-sdk] tick 越界：[${tickLower}, ${tickUpper}] 超出 [${MIN_TICK}, ${MAX_TICK}]`,
    )
  }
  if (tickLower % tickSpacing !== 0 || tickUpper % tickSpacing !== 0) {
    throw new Error(
      `[evm-clmm-sdk] tick 未对齐到 tickSpacing=${tickSpacing}：[${tickLower}, ${tickUpper}]。` +
        `请先用 alignTick() / getTicksByPercentRange() 对齐。`,
    )
  }
}

/** 把 bps（基点）转成 Percent；50 = 0.5% */
function bpsToPercent(slippageBps: number): Percent {
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`[evm-clmm-sdk] slippageBps 必须在 [0, 10000] 之间，收到 ${slippageBps}`)
  }
  return new Percent(Math.round(slippageBps), 10_000)
}

/**
 * 按 poolState.token0/token1 的**链上顺序**把传进来的两个 ITokenInfo 排好。
 * 调用方顺序传反了也能救回来（Pool 实体要求 token0 < token1）。
 */
function orderTokens(
  poolState: IPoolStateRaw,
  token0: ITokenInfo,
  token1: ITokenInfo,
): [ITokenInfo, ITokenInfo] {
  const onchain0 = getAddress(poolState.token0)
  const a = getAddress(token0.address)
  const b = getAddress(token1.address)
  if (a === onchain0) return [token0, token1]
  if (b === onchain0) return [token1, token0]
  throw new Error(
    `[evm-clmm-sdk] 传入的 token 与池子不匹配：池子 token0=${onchain0}，收到 ${a} / ${b}`,
  )
}

/**
 * 解析人类可读的十进制价格字符串为精确分数（支持 "1234.56" 与 "1.2e-8" 两种写法）。
 * 用分数而不是 Number，避免浮点误差影响 priceToClosestTick。
 *
 * 导出仅为便于单元测试；业务侧一律通过 priceToTick 间接使用。
 */
export function parseDecimalToFraction(value: string): { numerator: bigint; denominator: bigint } {
  const s = String(value).trim()
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s)
  if (!m) {
    throw new Error(`[evm-clmm-sdk] 非法的价格字符串："${value}"（只接受非负十进制，如 "3200.5" 或 "1.2e-8"）`)
  }
  const intPart = m[1]
  const fracPart = m[2] ?? ''
  const exp = m[3] ? Number(m[3]) : 0
  let numerator = BigInt(intPart + fracPart)
  let denominator = 1n
  // 小数位数 - 科学计数法指数 = 最终要除掉的 10 的幂次
  const shift = fracPart.length - exp
  if (shift >= 0) denominator = 10n ** BigInt(shift)
  else numerator *= 10n ** BigInt(-shift)
  if (numerator === 0n) {
    throw new Error(`[evm-clmm-sdk] 价格必须大于 0，收到 "${value}"`)
  }
  return { numerator, denominator }
}

// ---------------------------------------------------------------------------
// 实体转换：我们的 EVM 原始字段 → v3-sdk 实体
// ---------------------------------------------------------------------------

/** ITokenInfo → Token 实体（后续所有 CLMM 数学都基于它） */
export function toUniToken(token: ITokenInfo): Token {
  return new Token(
    token.chainId,
    getAddress(token.address),
    token.decimals,
    token.symbol,
    token.name ?? token.symbol,
  )
}

/**
 * 池子原始 state → Byreal SDK 的 Pool 实体。
 * Pool 封装了 CLMM 的全部数学（价格、tick、amount0/1），是本层的地基。
 *
 * 定制合约的 Pool 身份键是 (token0, token1, tickSpacing)，tickSpacing 是构造函数的一等参数，
 * 原先针对 v3-sdk 全局 TICK_SPACINGS 表的运行时补登记 hack 已随之退役。
 * 快照里的费率/暂停/动态费参数会注入 PoolExtraState——这样若上层拿这个 Pool 做离线报价，
 * 动态费开启的池子会正确地 fail-closed（抛 DYNAMIC_FEE），而不是给出错误的输出上界。
 */
export function toUniPool(params: {
  poolState: IPoolStateRaw
  token0: ITokenInfo
  token1: ITokenInfo
}): Pool {
  const { poolState } = params
  const [info0, info1] = orderTokens(poolState, params.token0, params.token1)

  const t0 = toUniToken(info0)
  const t1 = toUniToken(info1)

  // Pool 构造函数会用 PRICE_BOUNDS 断言 sqrtPriceX96 落在 [tick, tick+1) 对应的区间内。
  // 后端透传的 state 若不自洽（sqrtPriceX96 与 tick 来自不同块），这里提前给可读报错。
  const lo = toBigInt(TickMath.getSqrtRatioAtTick(poolState.tick))
  const hi = toBigInt(TickMath.getSqrtRatioAtTick(poolState.tick + 1))
  if (poolState.sqrtPriceX96 < lo || poolState.sqrtPriceX96 > hi) {
    throw new Error(
      `[evm-clmm-sdk] poolState 不自洽：sqrtPriceX96=${poolState.sqrtPriceX96} 不在 tick=${poolState.tick} ` +
        `对应的区间 [${lo}, ${hi}] 内。通常是 sqrtPriceX96 与 tick 取自不同块，请重新拉取快照。`,
    )
  }

  return new Pool(
    t0,
    t1,
    poolState.tickSpacing,
    poolState.tradeFeeRate,
    poolState.sqrtPriceX96.toString(),
    poolState.liquidity.toString(),
    poolState.tick,
    undefined,
    {
      protocolFeeRate: poolState.protocolFeeRate,
      pauseFlags: poolState.pauseFlags,
      swapOpenTime: poolState.swapOpenTime,
      alphaExtraTradeFeeRate: poolState.alphaExtraTradeFeeRate,
      dexExtraTradeFeeRate: poolState.dexExtraTradeFeeRate,
      dynamicFeeEnabled: poolState.dynamicFeeEnabled,
    },
  )
}

/** 池子 state + 仓位 state → Position 实体 */
export function toUniPosition(params: {
  poolState: IPoolStateRaw
  positionState: IPositionStateRaw
  token0: ITokenInfo
  token1: ITokenInfo
}): Position {
  const { poolState, positionState } = params
  const pool = toUniPool({ poolState, token0: params.token0, token1: params.token1 })
  assertTickRange(positionState.tickLower, positionState.tickUpper, poolState.tickSpacing)
  return new Position({
    pool,
    liquidity: positionState.liquidity.toString(),
    tickLower: positionState.tickLower,
    tickUpper: positionState.tickUpper,
  })
}

// ---------------------------------------------------------------------------
// 核心：仓位视图
// ---------------------------------------------------------------------------

/**
 * 由「池子快照 + 仓位快照」本地算出前端展示所需的一切：
 * 当前持仓量、价格区间、是否在区间内、是否全区间。
 *
 * 注意：amount0/amount1 用的是 `position.amount0/amount1`（**当前持仓量**，
 * 即此刻按现价 burn 掉能拿回的本金），**不含**未领取的手续费——
 * 手续费要走 collect staticcall（`getPendingFees`）或后端的 pendingFee 字段。
 */
export function getPositionView(params: {
  poolState: IPoolStateRaw
  positionState: IPositionStateRaw
  token0: ITokenInfo
  token1: ITokenInfo
}): IPositionView {
  const { poolState, positionState } = params
  const [info0, info1] = orderTokens(poolState, params.token0, params.token1)
  const position = toUniPosition({ poolState, positionState, token0: info0, token1: info1 })

  const amount0 = toBigInt(position.amount0.quotient)
  const amount1 = toBigInt(position.amount1.quotient)

  const { tickLower, tickUpper } = positionState

  return {
    tokenId: positionState.tokenId,
    poolAddress: poolState.poolAddress,
    tickLower,
    tickUpper,
    liquidity: positionState.liquidity,
    amount0,
    amount1,
    uiAmount0: formatUnits(amount0, info0.decimals),
    uiAmount1: formatUnits(amount1, info1.decimals),
    priceLower: tickToPrice({ tick: tickLower, token0: info0, token1: info1 }),
    priceUpper: tickToPrice({ tick: tickUpper, token0: info0, token1: info1 }),
    currentPrice: sqrtPriceX96ToPrice({
      sqrtPriceX96: poolState.sqrtPriceX96,
      token0: info0,
      token1: info1,
    }),
    // 与 Uniswap 合约口径一致：左闭右开，tick == tickUpper 时已经出区间
    inRange: poolState.tick >= tickLower && poolState.tick < tickUpper,
    isFullRange: isFullRange({ tickLower, tickUpper, tickSpacing: poolState.tickSpacing }),
  }
}

// ---------------------------------------------------------------------------
// 输入框联动：由一边金额反推另一边 + 流动性
// ---------------------------------------------------------------------------

/** 全 0 返回（区间外那一边输入无效时用） */
function emptyAmounts(info0: ITokenInfo, info1: ITokenInfo): IAmountsFromAmountReturn {
  return {
    liquidity: 0n,
    amount0: 0n,
    amount1: 0n,
    uiAmount0: formatUnits(0n, info0.decimals),
    uiAmount1: formatUnits(0n, info1.decimals),
  }
}

/**
 * 开仓 / 加仓输入框联动：用户在一边输入金额，算出流动性 L 和**另一边需要的金额**。
 *
 * 返回的 amount0/amount1 取自 `position.mintAmounts`（向上取整的**投入量**），
 * 而不是 `position.amount0`（向下取整的持仓量）——mint 时合约要的是前者。
 *
 * 三种价格位置：
 * - `tick < tickLower`：价格在区间下方，仓位 100% 是 token0 →
 *   base=Token1 无解（token1 一分钱都用不上），返回 liquidity=0 提示前端切换基准边；
 * - `tickLower <= tick < tickUpper`：区间内，两边都要投，正常反推；
 * - `tick >= tickUpper`：价格在区间上方，仓位 100% 是 token1 → base=Token0 无解，同上返回 0。
 *
 * 之所以必须自己挡住无解分支：v3-sdk 的 Position.fromAmount0/fromAmount1 内部会把
 * 另一边当作 MaxUint256 传给 maxLiquidityForAmounts，在无解方向上会算出一个天文数字的 L，
 * 不报错但结果完全错误。
 */
export function getAmountsFromAmount(params: {
  poolState: IPoolStateRaw
  token0: ITokenInfo
  token1: ITokenInfo
  tickLower: number
  tickUpper: number
  base: BaseSide
  baseAmount: bigint
}): IAmountsFromAmountReturn {
  const { poolState, tickLower, tickUpper, base, baseAmount } = params
  const [info0, info1] = orderTokens(poolState, params.token0, params.token1)
  assertTickRange(tickLower, tickUpper, poolState.tickSpacing)

  if (baseAmount <= 0n) return emptyAmounts(info0, info1)

  const pool = toUniPool({ poolState, token0: info0, token1: info1 })
  const tick = poolState.tick

  const belowRange = tick < tickLower // 价格在区间下方：全 token0
  const aboveRange = tick >= tickUpper // 价格在区间上方：全 token1

  if ((aboveRange && base === 'Token0') || (belowRange && base === 'Token1')) {
    // 这一边的代币在当前价格下完全用不上，无解 → liquidity=0，交给 UI 提示用户换一边输入
    return emptyAmounts(info0, info1)
  }

  const position =
    base === 'Token0'
      ? Position.fromAmount0({
          pool,
          tickLower,
          tickUpper,
          amount0: baseAmount.toString(),
          // useFullPrecision: 按 core 理论上限算 L（开仓走 NPM，用得到全精度）
          useFullPrecision: true,
        })
      : Position.fromAmount1({
          pool,
          tickLower,
          tickUpper,
          amount1: baseAmount.toString(),
        })

  const mint = position.mintAmounts
  const amount0 = toBigInt(mint.amount0)
  const amount1 = toBigInt(mint.amount1)

  return {
    liquidity: toBigInt(position.liquidity),
    amount0,
    amount1,
    uiAmount0: formatUnits(amount0, info0.decimals),
    uiAmount1: formatUnits(amount1, info1.decimals),
  }
}

// ---------------------------------------------------------------------------
// 滑点下限
// ---------------------------------------------------------------------------

/**
 * 开仓 / 加仓的 amount0Min / amount1Min。
 * 语义：价格在 ±slippage 内漂移时，**最少**也要投进去这么多——低于它说明池子价格已经跑偏，交易 revert。
 */
export function getMintAmountsWithSlippage(params: {
  poolState: IPoolStateRaw
  token0: ITokenInfo
  token1: ITokenInfo
  tickLower: number
  tickUpper: number
  liquidity: bigint
  slippageBps: number
}): { amount0Min: bigint; amount1Min: bigint } {
  const { poolState, tickLower, tickUpper, liquidity, slippageBps } = params
  const [info0, info1] = orderTokens(poolState, params.token0, params.token1)
  assertTickRange(tickLower, tickUpper, poolState.tickSpacing)
  if (liquidity <= 0n) return { amount0Min: 0n, amount1Min: 0n }

  const pool = toUniPool({ poolState, token0: info0, token1: info1 })
  const position = new Position({ pool, liquidity: liquidity.toString(), tickLower, tickUpper })
  const mins = position.mintAmountsWithSlippage(bpsToPercent(slippageBps))
  return { amount0Min: toBigInt(mins.amount0), amount1Min: toBigInt(mins.amount1) }
}

/**
 * 减仓 / 关仓的 amount0Min / amount1Min。
 * 语义：撤走这些流动性时，**最少**要拿回这么多本金（不含手续费）。
 */
export function getBurnAmountsWithSlippage(params: {
  poolState: IPoolStateRaw
  token0: ITokenInfo
  token1: ITokenInfo
  tickLower: number
  tickUpper: number
  liquidity: bigint
  slippageBps: number
}): { amount0Min: bigint; amount1Min: bigint } {
  const { poolState, tickLower, tickUpper, liquidity, slippageBps } = params
  const [info0, info1] = orderTokens(poolState, params.token0, params.token1)
  assertTickRange(tickLower, tickUpper, poolState.tickSpacing)
  if (liquidity <= 0n) return { amount0Min: 0n, amount1Min: 0n }

  const pool = toUniPool({ poolState, token0: info0, token1: info1 })
  const position = new Position({ pool, liquidity: liquidity.toString(), tickLower, tickUpper })
  const mins = position.burnAmountsWithSlippage(bpsToPercent(slippageBps))
  return { amount0Min: toBigInt(mins.amount0), amount1Min: toBigInt(mins.amount1) }
}

// ---------------------------------------------------------------------------
// 价格 / tick 换算（口径统一为「1 token0 = ? token1」）
// ---------------------------------------------------------------------------

/**
 * sqrtPriceX96 → 人类可读价格「1 token0 = ? token1」。
 * 直接用 Price 实体（分子 sqrtPriceX96²、分母 2^192）保证精度，
 * 不先转 tick 再换算（那样会丢掉 tick 内部的小数部分）。decimals 由 Price 实体自动处理。
 */
export function sqrtPriceX96ToPrice(params: {
  sqrtPriceX96: bigint
  token0: ITokenInfo
  token1: ITokenInfo
}): string {
  const t0 = toUniToken(params.token0)
  const t1 = toUniToken(params.token1)
  const price = new Price(
    t0,
    t1,
    Q192.toString(),
    (params.sqrtPriceX96 * params.sqrtPriceX96).toString(),
  )
  return price.toSignificant(PRICE_SIG_DIGITS)
}

/** tick → 人类可读价格「1 token0 = ? token1」（走 v3-sdk 的 tickToPrice，自动处理 decimals） */
export function tickToPrice(params: { tick: number; token0: ITokenInfo; token1: ITokenInfo }): string {
  const t0 = toUniToken(params.token0)
  const t1 = toUniToken(params.token1)
  return uniTickToPrice(t0, t1, params.tick).toSignificant(PRICE_SIG_DIGITS)
}

/**
 * 人类可读价格「1 token0 = ? token1」→ tick。
 * 传了 tickSpacing 就顺手对齐到最近的可用 tick（前端输入框失焦时通常要这么做）。
 */
export function priceToTick(params: {
  price: string
  token0: ITokenInfo
  token1: ITokenInfo
  tickSpacing?: number
}): number {
  const t0 = toUniToken(params.token0)
  const t1 = toUniToken(params.token1)
  const { numerator, denominator } = parseDecimalToFraction(params.price)

  // Price(base=token0, quote=token1, denominator=token0 的原始单位, numerator=token1 的原始单位)
  const rawAmount0 = denominator * 10n ** BigInt(params.token0.decimals)
  const rawAmount1 = numerator * 10n ** BigInt(params.token1.decimals)

  let tick: number
  try {
    tick = priceToClosestTick(new Price(t0, t1, rawAmount0.toString(), rawAmount1.toString()))
  } catch (e) {
    throw new Error(
      `[evm-clmm-sdk] 价格 "${params.price}" 超出可表示范围（tick 必须落在 [${MIN_TICK}, ${MAX_TICK}]）：${
        (e as Error).message
      }`,
    )
  }
  if (params.tickSpacing === undefined) return tick
  return alignTick({ tick, tickSpacing: params.tickSpacing, mode: 'nearest' })
}

/**
 * 把任意 tick 对齐到 tickSpacing 的整数倍，并夹在 [MIN_TICK, MAX_TICK] 内。
 * - nearest：四舍五入（走 v3-sdk 的 nearestUsableTick）
 * - down / up：向下 / 向上取整（做区间时用，保证区间不被收窄）
 */
export function alignTick(params: {
  tick: number
  tickSpacing: number
  mode?: 'nearest' | 'down' | 'up'
}): number {
  const { tick, tickSpacing, mode = 'nearest' } = params
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error(`[evm-clmm-sdk] tickSpacing 必须是正整数，收到 ${tickSpacing}`)
  }
  const clamped = Math.min(Math.max(Math.round(tick), MIN_TICK), MAX_TICK)
  let aligned: number
  if (mode === 'down') aligned = Math.floor(clamped / tickSpacing) * tickSpacing
  else if (mode === 'up') aligned = Math.ceil(clamped / tickSpacing) * tickSpacing
  else aligned = nearestUsableTick(clamped, tickSpacing)

  // 取整后可能越过 MIN/MAX_TICK，收回到 tickSpacing 的合法极值
  const minUsable = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing
  const maxUsable = Math.floor(MAX_TICK / tickSpacing) * tickSpacing
  return Math.min(Math.max(aligned, minUsable), maxUsable)
}

// ---------------------------------------------------------------------------
// 区间预设（±N% / 全区间）
// ---------------------------------------------------------------------------

const LN_1_0001 = Math.log(1.0001)

/**
 * 价格倍率 → tick 偏移量（tick 与价格是 1.0001^tick 的关系，decimals 在比值里被约掉）。
 *
 * `mode` 必须由调用方按「区间的哪一端」指定，**不能用 Math.round**：
 * 精确偏移量几乎总是小数（例如 +20% = 1823.307 个 tick），四舍五入会把上界往回收 0.307 tick。
 * 平时后面那步 alignTick('up') 会顺手把它推回去，掩盖了问题；但当
 * `currentTick + round(offset)` 恰好已经是 tickSpacing 的整数倍时（tickSpacing=10 时约 10% 的
 * 概率，且随行情漂移随机命中），alignTick 不再上推，最终区间就比用户要的**窄**——
 * 这违背了本模块「实际区间只会更宽，不会更窄」的承诺，属于随机复现的脏 bug。
 * 所以下界一律 floor、上界一律 ceil，让误差方向恒定朝「变宽」。
 */
function priceRatioToTickOffset(ratio: number, mode: 'floor' | 'ceil'): number {
  const exact = Math.log(ratio) / LN_1_0001
  return mode === 'floor' ? Math.floor(exact) : Math.ceil(exact)
}

/**
 * 以当前 tick 为中心，按「当前价 -lowerPercent% ~ +upperPercent%」生成一个对齐好的 tick 区间。
 * 两个百分比都传**正数幅度**（±5% 就传 5 / 5），传负数按绝对值处理。
 *
 * 对齐策略：下界向下取整、上界向上取整——保证实际区间不比用户要的窄。
 */
export function getTicksByPercentRange(params: {
  currentTick: number
  tickSpacing: number
  lowerPercent: number
  upperPercent: number
}): { tickLower: number; tickUpper: number } {
  const { currentTick, tickSpacing } = params
  const lowerPercent = Math.abs(params.lowerPercent)
  const upperPercent = Math.abs(params.upperPercent)
  if (!Number.isFinite(lowerPercent) || !Number.isFinite(upperPercent)) {
    throw new Error('[evm-clmm-sdk] lowerPercent / upperPercent 必须是有限数字')
  }

  // 跌幅 >= 100% 意味着价格下界为 0 → 直接用全区间下界
  const tickLower =
    lowerPercent >= 100
      ? getFullRangeTicks(tickSpacing).tickLower
      : alignTick({
          // 下界：先 floor 再向下对齐，两步误差方向一致（都朝更低的价格）
          tick: currentTick + priceRatioToTickOffset(1 - lowerPercent / 100, 'floor'),
          tickSpacing,
          mode: 'down',
        })

  const tickUpper = alignTick({
    // 上界：先 ceil 再向上对齐，两步误差方向一致（都朝更高的价格）
    tick: currentTick + priceRatioToTickOffset(1 + upperPercent / 100, 'ceil'),
    tickSpacing,
    mode: 'up',
  })

  // 极窄区间（percent 太小）对齐后可能塌成一个点，至少留一个 tickSpacing
  if (tickLower >= tickUpper) {
    const full = getFullRangeTicks(tickSpacing)
    if (tickUpper + tickSpacing <= full.tickUpper) return { tickLower, tickUpper: tickLower + tickSpacing }
    return { tickLower: full.tickUpper - tickSpacing, tickUpper: full.tickUpper }
  }
  return { tickLower, tickUpper }
}

/** 全区间：把 MIN_TICK / MAX_TICK 对齐到 tickSpacing（Uniswap 前端「Full Range」按钮的口径） */
export function getFullRangeTicks(tickSpacing: number): { tickLower: number; tickUpper: number } {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error(`[evm-clmm-sdk] tickSpacing 必须是正整数，收到 ${tickSpacing}`)
  }
  return {
    tickLower: nearestUsableTick(MIN_TICK, tickSpacing),
    tickUpper: nearestUsableTick(MAX_TICK, tickSpacing),
  }
}

// ---------------------------------------------------------------------------
// APR（手续费与奖励共用同一套年化公式）
// ---------------------------------------------------------------------------

/** 按场景计算用户在池子活跃流动性中的占比。 */
function calculateLiquidityShare(params: {
  scene: AprScene
  userLiquidity: Decimal
  poolLiquidity: Decimal
  existLiquidity: Decimal
}): Decimal {
  const { scene, userLiquidity, poolLiquidity, existLiquidity } = params
  if (scene === 'create') {
    return userLiquidity.div(poolLiquidity.plus(userLiquidity))
  }
  if (scene === 'add') {
    return existLiquidity.plus(userLiquidity).div(poolLiquidity.plus(userLiquidity))
  }
  return userLiquidity.div(poolLiquidity)
}

/**
 * 由用户活跃流动性计算 APR，返回百分比数值（例如 50 表示 50%）。
 * `fee24hUsdValue` 既可传 24h 手续费，也可传 24h 奖励 USD，二者口径相同。
 */
function calculateAprFromLiquidity(params: {
  fee24hUsdValue: number
  positionUsdValue: number
  userLiquidity: Decimal
  poolState: IPoolStateRaw
  tickLower: number
  tickUpper: number
  scene: AprScene
  existLiquidity: bigint
}): number {
  const {
    fee24hUsdValue,
    positionUsdValue,
    userLiquidity,
    poolState,
    tickLower,
    tickUpper,
    scene,
    existLiquidity,
  } = params

  const isInRange = poolState.tick >= tickLower && poolState.tick < tickUpper
  if (!isInRange || poolState.liquidity === 0n) return 0

  const positionUsd = new Decimal(positionUsdValue)
  if (positionUsd.lte(0) || userLiquidity.lte(0)) return 0

  const liquidityShare = calculateLiquidityShare({
    scene,
    userLiquidity,
    poolLiquidity: new Decimal(poolState.liquidity.toString()),
    existLiquidity: new Decimal(existLiquidity.toString()),
  })

  return new Decimal(fee24hUsdValue)
    .div(positionUsd)
    .mul(liquidityShare)
    .mul(365)
    .mul(100)
    .toNumber()
}

/**
 * 未输入确切双边金额时，以一个完整 token0（必要时 token1）为基准推导流动性，
 * 再按目标仓位 USD 价值等比放大并估算 APR。全程为本地纯数学，0 RPC。
 */
export function estimateApr(params: IEstimateAprParams): number {
  const {
    fee24hUsdValue,
    token0PriceUsd,
    token1PriceUsd,
    poolState,
    token0,
    token1,
    tickLower,
    tickUpper,
    positionUsdValue = 1,
    scene = 'create',
    existLiquidity = 0n,
  } = params

  let result = getAmountsFromAmount({
    poolState,
    token0,
    token1,
    tickLower,
    tickUpper,
    base: 'Token0',
    baseAmount: 10n ** BigInt(token0.decimals),
  })

  if (result.liquidity === 0n) {
    result = getAmountsFromAmount({
      poolState,
      token0,
      token1,
      tickLower,
      tickUpper,
      base: 'Token1',
      baseAmount: 10n ** BigInt(token1.decimals),
    })
  }

  const unitCostUsd = new Decimal(result.amount0.toString())
    .div(new Decimal(10).pow(token0.decimals))
    .mul(token0PriceUsd)
    .plus(
      new Decimal(result.amount1.toString())
        .div(new Decimal(10).pow(token1.decimals))
        .mul(token1PriceUsd),
    )
  if (unitCostUsd.lte(0)) return 0

  const userLiquidity = new Decimal(result.liquidity.toString()).mul(
    new Decimal(positionUsdValue).div(unitCostUsd),
  )
  return calculateAprFromLiquidity({
    fee24hUsdValue,
    positionUsdValue,
    userLiquidity,
    poolState,
    tickLower,
    tickUpper,
    scene,
    existLiquidity,
  })
}

/**
 * 根据确切 token0/token1 最小单位金额计算 APR，返回百分比数值（例如 50 表示 50%）。
 * 手续费 APR 与奖励 APR 都调用此函数，仅 `fee24hUsdValue` 的来源不同。
 */
export function calculateApr(params: ICalculateAprParams): number {
  const {
    fee24hUsdValue,
    positionUsdValue,
    amount0,
    amount1,
    tickLower,
    tickUpper,
    poolState,
    token0,
    token1,
    scene = 'exist',
    existLiquidity = 0n,
  } = params

  let result = getAmountsFromAmount({
    poolState,
    token0,
    token1,
    tickLower,
    tickUpper,
    base: 'Token0',
    baseAmount: amount0,
  })
  if (result.liquidity === 0n && amount1 > 0n) {
    result = getAmountsFromAmount({
      poolState,
      token0,
      token1,
      tickLower,
      tickUpper,
      base: 'Token1',
      baseAmount: amount1,
    })
  }

  return calculateAprFromLiquidity({
    fee24hUsdValue,
    positionUsdValue,
    userLiquidity: new Decimal(result.liquidity.toString()),
    poolState,
    tickLower,
    tickUpper,
    scene,
    existLiquidity,
  })
}

// tradeFeeRate 与 tickSpacing 完全解耦；tickSpacing 是池身份键，必须直接从 poolState 读取。

/** 判断一个区间是不是「全区间」仓位（用于 UI 上打 Full Range 标签） */
export function isFullRange(params: {
  tickLower: number
  tickUpper: number
  tickSpacing: number
}): boolean {
  const full = getFullRangeTicks(params.tickSpacing)
  return params.tickLower <= full.tickLower && params.tickUpper >= full.tickUpper
}

/** tick → sqrtPriceX96（bigint），直接委托 v3-sdk 的 TickMath */
export function getSqrtPriceX96FromTick(tick: number): bigint {
  return toBigInt(TickMath.getSqrtRatioAtTick(tick))
}
