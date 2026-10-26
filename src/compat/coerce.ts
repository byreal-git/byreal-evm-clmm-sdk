/**
 * compat 层的「宽进」转换原语：把 Solana 版 SDK 调用方手里
 * 五花八门的入参（BN / JSBI / Decimal / 十进制串 / 0x 串 / number）收敛成 EVM SDK 的
 * `bigint` + checksum `Address` + `BaseSide`。
 *
 * 设计取向 **宽进严出**：
 * - 入参尽量收（旧枚举名、旧量纲、BN-like 对象都认）；
 * - 一旦收不了，**必须抛一个能直接照着改的中文错误**，绝不猜、绝不静默降级 ——
 *   这一层处理的全是金额与地址，猜错的代价是用户的钱。
 *
 * 依赖边界：本文件只依赖 viem 与核心 SDK 的常量/类型。
 */
import { formatUnits, getAddress, type Address } from 'viem'

import { DEFAULT_SLIPPAGE_BPS } from '../constants.js'
import type { BaseSide } from '../types.js'

// ---------------------------------------------------------------------------
// 公共常量
// ---------------------------------------------------------------------------

/**
 * compat 层所有错误文案的统一前缀。
 * 与核心 SDK 的 `[evm-clmm-sdk]` 刻意区分开：线上报错时一眼能看出问题出在「兼容层的入参转换」
 * 还是「核心 SDK 的链上/数学逻辑」，排查方向完全不同。
 */
export const COMPAT_ERR_PREFIX = '[evm-clmm-sdk/compat]'

/**
 * 兼容层默认滑点 = 200 bps（2%），刻意与 Solana 版 clmm-sdk 的 `slippage = 0.02` 对齐，
 * 而**不是**核心 EVM SDK 的 {@link DEFAULT_SLIPPAGE_BPS}（50 bps）。
 *
 * 理由：兼容层的契约是「同样的调用产生同样的行为」。若这里悄悄收紧到 0.5%，
 * 迁移过来的代码在行情波动时会开始随机 revert，而调用方代码一个字都没改 ——
 * 这种「没改代码却坏了」的失败最难排查。宁可保持旧的宽松默认，让差异显式暴露在文档里。
 *
 * 直接用核心 `EvmClmmSdk` 时仍是 50 bps —— 两个入口默认值不同是**有意为之**，
 * 见 docs/compat.md。新代码请显式传 `slippageBps`，不要依赖任一默认值。
 *
 * ⚠️ 核心 SDK 的写方法在 `slippageBps` 为 `undefined` 时会套用它自己的 50 bps，
 * 所以兼容层的每个写方法**必须显式把这个值传下去**，不能靠「不传」。
 */
export const COMPAT_DEFAULT_SLIPPAGE_BPS = 200

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 能被安全解释成链上整数的输入。
 *
 * `{ toString(): string }` 这一支是给 BN / JSBI / Decimal / anchor 的 BN 用的 ——
 * 兼容层**不 import bn.js**（硬约束），所以只能用结构化鸭子类型接住它们，
 * 拿 `String(v)` 之后再按十进制字符串规则解析。
 */
export type Numericish = bigint | number | string | { toString(): string }

/**
 * 「以哪一边为输入基准」的宽松取值：旧 Solana 枚举名（MintA/MintB）与新 EVM 枚举名
 * （Token0/Token1）以及索引写法（0/1）都认。
 *
 * EVM 池子内 token0/token1 按地址升序固定，A 恒等于 token0，所以这个映射是**无损**的。
 */
export type BaseSideish = 'MintA' | 'MintB' | 'Token0' | 'Token1' | 'token0' | 'token1' | 0 | 1

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * Solana base58 地址的字符集与长度。
 * 用来在**报错时**识别「这人传了个 Solana 地址过来」，给一条专门的迁移提示，
 * 而不是甩一个 viem 的 `Address "xxx" is invalid`。
 */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/** 把任意值渲染成错误文案里可读的形式（错误里必须带原值，否则调用方无从下手） */
function describe(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`
  if (typeof value === 'bigint') return `${value}n`
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'object') {
    const ctor = (value as { constructor?: { name?: string } }).constructor?.name
    return `${safeString(value)}${ctor ? `（${ctor} 实例）` : ''}`
  }
  return String(value)
}

/** `String(v)` 的防御版：`Object.create(null)` 之类没有 toString 的对象不会把这里炸掉 */
function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '[无法字符串化的对象]'
  }
}

/** 「你传的是 Solana 地址」的统一提示（地址位） */
function solanaAddressMessage(field: string, raw: string): string {
  return (
    `${COMPAT_ERR_PREFIX} ${field} 看起来是一个 Solana 地址（"${raw}"）。` +
    `EVM SDK 只接受 0x 开头的 20 字节地址；仓位标识请用 tokenId（uint256），不是 NFT mint。`
  )
}

/** 「你传的是 Solana 地址」的统一提示（数值位，通常是把 nftMint 当 tokenId 传了） */
function solanaIdentifierMessage(field: string, raw: string): string {
  return (
    `${COMPAT_ERR_PREFIX} ${field} 收到的是一个 Solana base58 地址（"${raw}"），无法解析为链上整数。` +
    `EVM 上仓位由 NonfungiblePositionManager 的 tokenId（uint256）标识，不存在 NFT mint 地址；` +
    `请改传 tokenId（数字 / 十进制字符串 / bigint）。`
  )
}

/**
 * 十进制 / 十六进制整数字符串 → bigint。
 *
 * 单独抽出来是因为 string 入参和 BN-like 对象入参共用同一套规则：
 * 对象只是先 `String(v)` 一下，后面的合法性判定与报错分类完全一致。
 *
 * @param raw   待解析的字符串
 * @param origin 原始入参（报错时要展示它，BN 对象和它的字符串形式不是一回事）
 */
function parseIntegerString(raw: string, origin: unknown, field: string): bigint {
  const s = raw.trim()
  const head = `${COMPAT_ERR_PREFIX} ${field} 无法解析为链上整数：收到 ${describe(origin)}`

  if (s === '') {
    throw new Error(`${head}（空字符串）。链上金额必须是最小单位的整数，请传 "0" 或具体数值。`)
  }

  const negative = s.startsWith('-')
  const body = negative ? s.slice(1) : s

  if (/^0[xX][0-9a-fA-F]+$/.test(body)) {
    const v = BigInt(body)
    return negative ? -v : v
  }
  if (/^\d+$/.test(body)) {
    const v = BigInt(body)
    return negative ? -v : v
  }

  // —— 到这里一定是非法输入，按最可能的原因给出可直接照做的修复建议 ——
  // base58 判定必须排在最前面：Solana 地址里几乎必然含 'e'，放到科学计数法分支后面会被它抢走，
  // 报出「含科学计数法」这种驴唇不对马嘴的提示。
  if (BASE58_RE.test(s)) {
    throw new Error(solanaIdentifierMessage(field, s))
  }
  if (body.includes('.')) {
    throw new Error(
      `${head}（含小数点）。链上金额必须是最小单位的整数，请先乘以 10**decimals；` +
        `若手上是 Decimal / BigNumber，请先 .toFixed(0) 再传进来。`,
    )
  }
  if (/[eE]/.test(body)) {
    throw new Error(
      `${head}（含科学计数法）。请传完整的十进制整数字符串（如 "1000000000000000000"）或 bigint，` +
        `科学计数法在大数上会丢精度。`,
    )
  }
  throw new Error(
    `${head}（含非法字符）。只接受十进制整数（可带前导 -）或 0x 前缀的十六进制整数。`,
  )
}

// ---------------------------------------------------------------------------
// 数值
// ---------------------------------------------------------------------------

/**
 * 任意 `Numericish` → `bigint`（链上整数的唯一真相源）。
 *
 * 之所以对 `number` 卡得很死（非安全整数一律抛、浮点一律抛）：
 * `1.5` 这种入参 100% 是调用方把「人类可读金额」当成「最小单位金额」传了，
 * 静默 `Math.floor` 会让用户少投 / 多投资金，报错才是唯一负责任的行为。
 *
 * @param field 出错时要在文案里点名的参数名，务必传业务侧的真实名字（如 'baseAmount'）
 */
export function toBigInt(value: Numericish, field: string): bigint {
  if (typeof value === 'bigint') return value

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      const why = !Number.isFinite(value)
        ? '不是有限数字'
        : Number.isInteger(value)
          ? '超出 Number.MAX_SAFE_INTEGER（2^53-1），精度已经丢了'
          : '是浮点数'
      throw new Error(
        `${COMPAT_ERR_PREFIX} ${field} 无法解析为链上整数：收到 ${describe(value)}（${why}）。` +
          `链上金额必须是最小单位的整数，请先乘以 10**decimals；超过 2^53 时改用 string 或 bigint。`,
      )
    }
    return BigInt(value)
  }

  if (typeof value === 'string') return parseIntegerString(value, value, field)

  if (value !== null && typeof value === 'object') {
    // Solana PublicKey 有 toBase58()：它的 toString() 是 base58，不是数字，单独给迁移提示
    if (typeof (value as { toBase58?: unknown }).toBase58 === 'function') {
      throw new Error(solanaIdentifierMessage(field, safeString(value)))
    }
    if (typeof (value as { toString?: unknown }).toString === 'function') {
      return parseIntegerString(safeString(value), value, field)
    }
  }

  throw new Error(
    `${COMPAT_ERR_PREFIX} ${field} 无法解析为链上整数：收到 ${describe(value)}。` +
      `只接受 bigint / 安全整数 number / 十进制或 0x 字符串 / 带 toString() 的大数对象（BN、JSBI）。`,
  )
}

/**
 * `toBigInt` 的可选版：`undefined` / `null` 原样放行成 `undefined`。
 *
 * 存在的意义是让上层写 `toOptionalBigInt(params.liquidity, 'liquidity')` 一行搞定
 * 「传了就转、没传就不传」，而不是每个可选字段都手写一次三元表达式 —— 少写一次就少一次
 * 把 `undefined` 误转成 `0n` 的机会（`0n` 在减仓语义里是「减 0」，是会静默产生错误交易的值）。
 */
export function toOptionalBigInt(
  value: Numericish | undefined | null,
  field: string,
): bigint | undefined {
  if (value === undefined || value === null) return undefined
  return toBigInt(value, field)
}

// ---------------------------------------------------------------------------
// 地址
// ---------------------------------------------------------------------------

/**
 * 宽松整数 → JS `number`（tick / fee / tickSpacing / decimals / percent 这类**小**整数）。
 *
 * 复用 {@link toBigInt} 的全部宽进规则（string / 0x 串 / BN-like 都认），再确认没越过
 * `Number.MAX_SAFE_INTEGER`。入参声明成 `unknown` 而不是 `Numericish` 是有意的：
 * 这个函数最常见的调用现场是「从一份松散的后端 JSON 里取字段」，那里的值天然是 `unknown`，
 * 强行在每个调用点写 `as Numericish` 只是把类型噪声搬了个地方 ——
 * 真正的守门在运行时，`toBigInt` 对任何垃圾输入都会给出点名到字段的错误。
 */
export function toSmallInt(value: unknown, field: string): number {
  const big = toBigInt(value as Numericish, field)
  const n = Number(big)
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${COMPAT_ERR_PREFIX} ${field} 超出安全整数范围：${big}。`)
  }
  return n
}

/**
 * 两个 EVM 地址是否指向同一个合约 / 账户。
 *
 * 必须走这个函数而不是 `===`：compat 收到的地址有三种大小写形态并存 ——
 * 调用方手抄的全小写、`toAddress()` 出来的 checksum、后端 JSON 里的原样透传。
 * 直接 `===` 会把同一个地址判成两个，进而触发「poolAddress 与快照不一致」这类假报错。
 */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * 任意地址字符串 → checksum 后的 `Address`。
 *
 * 走 viem `getAddress()` 而不是 `toLowerCase()`：checksum 校验能挡住手抄错一位的地址，
 * 而且核心 SDK 内部（`orderTokens`）也是拿 `getAddress()` 的结果做等值比较，
 * 这里保持同一口径才不会出现「地址一样但比不相等」。
 *
 * 对 Solana 地址（base58 字符串 / `PublicKey` 对象）给**专门的**错误，
 * 因为这是迁移期最高频的一类误传，viem 原生报错完全指不出方向。
 */
export function toAddress(value: string, field: string): Address {
  const v = value as unknown

  if (v !== null && typeof v === 'object' && typeof (v as { toBase58?: unknown }).toBase58 === 'function') {
    throw new Error(solanaAddressMessage(field, safeString(v)))
  }
  if (typeof v !== 'string') {
    throw new Error(
      `${COMPAT_ERR_PREFIX} ${field} 必须是 0x 开头的 EVM 地址字符串，收到 ${describe(v)}。`,
    )
  }

  const s = v.trim()
  if (s === '') {
    throw new Error(`${COMPAT_ERR_PREFIX} ${field} 是空字符串，无法解析为 EVM 地址。`)
  }
  if (!/^0[xX]/.test(s) && BASE58_RE.test(s)) {
    throw new Error(solanaAddressMessage(field, s))
  }

  try {
    return getAddress(s)
  } catch (e) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} ${field} 不是合法的 EVM 地址：${describe(value)}。` +
        `需要 0x 开头的 20 字节地址（含大小写 checksum 校验）。原始错误：${(e as Error).message}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

/** `toBaseSide` 报错时列出的全部合法取值（保持与 BaseSideish 同步） */
const BASE_SIDE_LEGAL = `'MintA' | 'MintB' | 'Token0' | 'Token1' | 'token0' | 'token1' | 0 | 1`

/**
 * 旧/新两套「基准边」枚举 → 核心 SDK 的 `BaseSide`。
 *
 * 映射是无损的：EVM 池子里 token0/token1 按地址升序固定，Solana 版的 MintA/MintB
 * 在 EVM 上就是 token0/token1，不存在需要额外排序的情况。
 * 字符串比较大小写不敏感（`'token0'` 与 `'Token0'` 都要认，索性统一放宽）。
 */
export function toBaseSide(value: BaseSideish, field = 'base'): BaseSide {
  if (value === 0) return 'Token0'
  if (value === 1) return 'Token1'
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase()
    if (key === 'minta' || key === 'token0') return 'Token0'
    if (key === 'mintb' || key === 'token1') return 'Token1'
  }
  throw new Error(
    `${COMPAT_ERR_PREFIX} ${field} 取值非法：收到 ${describe(value)}。` +
      `合法取值为 ${BASE_SIDE_LEGAL}（MintA/Token0 是池子里地址较小的那个代币）。`,
  )
}

// ---------------------------------------------------------------------------
// 滑点（本兼容层最危险的一处）
// ---------------------------------------------------------------------------

/**
 * 「未指定滑点」的一次性 warn 标志位。
 *
 * 用模块级布尔而不是每次调用都喊：前端列表页可能一次渲染几十个仓位、每个都算一遍预估，
 * 每次 warn 会把控制台刷爆，反而让人忽略这条真正重要的提示。
 */
let defaultSlippageWarned = false

/**
 * 把「旧口径小数 slippage」与「新口径基点 slippageBps」收敛成**唯一**的基点值。
 *
 * ⚠️ 这是整个兼容层最危险的一处，两个口径**量纲差 10000 倍**：
 * 旧 SDK 的 `slippage: 0.02` = 2%，新 SDK 的 `slippageBps: 50` = 0.5%。
 * 认错一次，用户就会以 200 倍于预期的滑点成交，或者反过来交易恒 revert。
 *
 * 规则（任何一条都宁可抛错也不猜）：
 * - 两个都传 → 抛。哪个优先都是猜，而猜错的后果是资金损失。
 * - 只有 `slippageBps` → 校验 [0, 10000] 整数后原样返回。
 * - 只有 `slippage`   → 校验 (0, 1]，返回 `Math.round(slippage * 10000)`；
 *   `> 1` 时给专门的量纲提示（这是「想传 2% 却写了 2」的经典误用）。
 * - 都不传 → 返回 {@link COMPAT_DEFAULT_SLIPPAGE_BPS}（200 bps = 2%，对齐旧 SDK），
 *   并**整个进程内 warn 一次**：核心 `EvmClmmSdk` 的默认是 50 bps，两个入口默认值不同，
 *   同一份业务代码换个入口结果会变，值得让人知道一次。
 */
export function resolveSlippageBps(
  input: { slippage?: number; slippageBps?: number },
  field = 'slippage',
): number {
  const bps = input?.slippageBps
  const ratio = input?.slippage
  const hasBps = bps !== undefined && bps !== null
  const hasRatio = ratio !== undefined && ratio !== null

  if (hasBps && hasRatio) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} ${field} 与 slippageBps 只能二选一：收到 ${field}=${describe(ratio)}、` +
        `slippageBps=${describe(bps)}。两者量纲不同（${field} 是小数口径 0.02 = 2%，` +
        `slippageBps 是基点 200 = 2%），兼容层不猜哪个优先，请只保留一个。`,
    )
  }

  if (hasBps) {
    if (typeof bps !== 'number' || !Number.isFinite(bps) || !Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      throw new Error(
        `${COMPAT_ERR_PREFIX} slippageBps 必须是 [0, 10000] 之间的整数基点（50 = 0.5%），` +
          `收到 ${describe(bps)}。`,
      )
    }
    return bps
  }

  if (hasRatio) {
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
      throw new Error(
        `${COMPAT_ERR_PREFIX} ${field} 必须是数字（小数口径，0.02 = 2%），收到 ${describe(ratio)}。`,
      )
    }
    if (ratio > 1) {
      const asRatio = ratio / 100
      throw new Error(
        `${COMPAT_ERR_PREFIX} ${field} 是小数口径（0.02 = 2%），收到 ${ratio} —— 你是不是想传 ${ratio}%？` +
          `那应该写 ${field}: ${asRatio}，或改用 slippageBps: ${Math.round(ratio * 100)}。`,
      )
    }
    if (!(ratio > 0)) {
      throw new Error(
        `${COMPAT_ERR_PREFIX} ${field} 必须落在 (0, 1] 之间（小数口径，0.02 = 2%），收到 ${describe(ratio)}。` +
          `确实要零滑点请显式传 slippageBps: 0（并自行承担价格漂移即 revert 的后果）。`,
      )
    }
    const bps = Math.round(ratio * 10_000)
    // 0 bps = 「一分钱都不许滑」，交易几乎必然 revert。
    // 这里不静默取整成 0：调用方写 0.00001 时想表达的是「滑点很小」，不是「零容忍」，
    // 而两者在链上的后果天差地别（后者是交易发不出去）。
    if (bps === 0) {
      throw new Error(
        `${COMPAT_ERR_PREFIX} ${field}=${describe(ratio)} 换算成基点后被取整为 0（小于 0.01% 的滑点无法表示），` +
          '而 0 滑点意味着价格只要动一下交易就 revert。\n' +
          '请传一个 >= 0.0001 的小数（= 1 bps），或改用 slippageBps 精确指定；' +
          '确实要零滑点请显式传 slippageBps: 0。',
      )
    }
    return bps
  }

  if (!defaultSlippageWarned) {
    defaultSlippageWarned = true
    console.warn(
      `${COMPAT_ERR_PREFIX} 未指定滑点，使用兼容层默认 ${COMPAT_DEFAULT_SLIPPAGE_BPS / 100}%` +
        `（${COMPAT_DEFAULT_SLIPPAGE_BPS} bps），与 Solana 版 clmm-sdk 一致。\n` +
        `注意核心 EvmClmmSdk 的默认是 ${DEFAULT_SLIPPAGE_BPS / 100}%（${DEFAULT_SLIPPAGE_BPS} bps）` +
        ' —— 两个入口默认值不同。\n' +
        '建议显式传 slippage（小数）或 slippageBps（基点），不要依赖默认值。',
    )
  }
  return COMPAT_DEFAULT_SLIPPAGE_BPS
}

// ---------------------------------------------------------------------------
// deadline
// ---------------------------------------------------------------------------

/** 小于这个数就当「相对秒数」，大于等于就当「unix 秒级时间戳」（约合 2001-09-09） */
const ABSOLUTE_DEADLINE_THRESHOLD = 1_000_000_000

/** 超过这个数几乎只可能是毫秒时间戳（约合 2001-09-09 的毫秒值） */
const MILLIS_DEADLINE_THRESHOLD = 1_000_000_000_000

/**
 * 把 `deadlineSec`（相对秒数，核心 SDK 的口径）与 `deadline`（旧代码里常见的绝对时间戳）
 * 收敛成核心 SDK 要的**相对秒数**；两个都没传时返回 `undefined`，让核心 SDK 用它自己的默认值
 * （`DEFAULT_DEADLINE_SEC = 1200`）—— 兼容层不复制一份默认值，避免两处漂移。
 *
 * `deadline` 的口径靠数量级判定（这是**唯一**一处允许启发式猜测的地方，因为两种口径
 * 差着 7 个数量级，不存在歧义区间）：
 * - `>= 1e12` → 毫秒时间戳，抛错要求改成秒（合约里的 deadline 是秒，传毫秒会变成 3 万年后，
 *   等于把滑点保护彻底关掉）；
 * - `>= 1e9`  → 秒级时间戳，换算成 `deadline - now`；已过期直接抛；
 * - 否则      → 就当相对秒数（没人会设一个 30 年后的相对 deadline）。
 */
export function resolveDeadlineSec(input: { deadlineSec?: number; deadline?: number }): number | undefined {
  const sec = input?.deadlineSec
  const abs = input?.deadline
  const hasSec = sec !== undefined && sec !== null
  const hasAbs = abs !== undefined && abs !== null

  if (hasSec && hasAbs) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} deadlineSec 与 deadline 只能二选一：收到 deadlineSec=${describe(sec)}、` +
        `deadline=${describe(abs)}。deadlineSec 是「从现在起多少秒」，deadline 是「绝对 unix 秒」，` +
        `兼容层不猜哪个优先，请只保留一个。`,
    )
  }

  if (hasSec) return assertRelativeSec(sec, 'deadlineSec')

  if (hasAbs) {
    if (typeof abs !== 'number' || !Number.isFinite(abs)) {
      throw new Error(`${COMPAT_ERR_PREFIX} deadline 必须是数字（unix 秒级时间戳），收到 ${describe(abs)}。`)
    }
    if (abs >= MILLIS_DEADLINE_THRESHOLD) {
      throw new Error(
        `${COMPAT_ERR_PREFIX} deadline=${abs} 看起来是**毫秒**时间戳。合约里的 deadline 是秒，` +
          `请传 Math.floor(ms / 1000)，或改用 deadlineSec（从现在起多少秒）。`,
      )
    }
    if (abs >= ABSOLUTE_DEADLINE_THRESHOLD) {
      const remain = Math.floor(abs - Date.now() / 1000)
      if (remain <= 0) {
        throw new Error(
          `${COMPAT_ERR_PREFIX} deadline=${abs}（unix 秒）已经过期，交易必定 revert。` +
            `请传一个未来的时间戳，或改用 deadlineSec（从现在起多少秒）。`,
        )
      }
      return remain
    }
    return assertRelativeSec(abs, 'deadline')
  }

  return undefined
}

/** 相对秒数的合法性校验（与核心 `deadlineFromNow` 的约束保持一致：非负有限数） */
function assertRelativeSec(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} ${field} 必须是非负的秒数（从现在起多少秒后过期），收到 ${describe(value)}。`,
    )
  }
  return Math.floor(value)
}

// ---------------------------------------------------------------------------
// 展示值
// ---------------------------------------------------------------------------

/**
 * 最小单位整数 → 人类可读字符串（= viem `formatUnits`）。
 *
 * 包一层而不是让上层直接用 viem，是为了让 compat 的所有 `ui*` 字段都出自同一个函数：
 * 将来若要统一改成「保留 N 位有效数字」或「千分位」，只改这里一处。
 * 注意返回的是**字符串**，绝不返回 number —— 18 位小数的金额进 number 就丢精度了。
 */
export function toUiAmount(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals)
}
