/**
 * compat 内部共享件：`liquidity.ts`（读链版）与 `offchain.ts`（快照注入版）**两边都要用**
 * 的入参归一化与 meta 组装逻辑。
 *
 * ## 为什么单独开一个文件
 * 这两个写操作客户端是同一套语义的两种数据来源实现（一个去读链、一个吃调用方给的快照），
 * 因此「别名字段的取值与冲突判定」「空表单值怎么算」「另一边上限的断言」「meta 的 `ui*` 铺开」
 * 「按币种汇总」这些**与数据来源无关**的逻辑天然是重复的。并行开发期两边各写了一份，
 * 收口时统一挪到这里 —— 让它们各留一份的代价不是多几行代码，而是
 * **两条路径的行为会慢慢分叉**，而分叉出来的差异极难被发现：
 * - 展示金额分叉（某一边少乘一次 decimals）在界面上只表现为「数字看着有点大」；
 * - 更糟的是**取值口径**分叉 —— 曾经 `percent` 的三个别名取值矛盾时，读链版抛错、
 *   快照版静默挑了第一个，于是「点了减仓 25% 实际减了 50%」这种事只在其中一条路径上发生，
 *   而两条路径收到的入参一模一样。`parity.test.ts` 就是为这类分叉设的岗。
 *
 * ## 为什么不进 barrel
 * `index.ts` **刻意不** `export * from './internal.js'`：这里全是实现细节，
 * 一旦透出去就变成了必须维护的公开契约，将来重构会被外部调用点绑死。
 * 真正对外的东西在 `coerce.ts` / `state.ts` / `models.ts`。
 *
 * 依赖方向：`coerce` → `state` → `models` → **internal** → `liquidity` / `offchain`。
 * 本文件不 import `liquidity.ts` / `offchain.ts`（会成环），
 * 也不依赖任何后端客户端。
 */
import type { Address } from 'viem'

import type { Chain } from '../chain/index.js'
import type { BaseSide, IDecreaseMeta, ILiquidityMeta, IPendingFees, ITokenInfo } from '../types.js'

import { COMPAT_ERR_PREFIX, toAddress, toBigInt, toUiAmount, type Numericish } from './coerce.js'
import type { ICompatDecreaseMeta, ICompatLiquidityMeta, ICompatPendingFees } from './models.js'

// ---------------------------------------------------------------------------
// 字段别名的取值
// ---------------------------------------------------------------------------

/**
 * 「这个值算给了吗」——`undefined` / `null` / **空字符串**都算没给。
 *
 * 空串单独算「没给」是为了前端表单：`<input>` 没填时拿到的是 `''` 而不是 `undefined`，
 * 把它当成有效值传下去，只会在更深的地方炸出一条「地址不合法」之类指不出方向的错误。
 *
 * 写成**类型守卫**而不是普通的 `boolean`：调用点几乎全是「先判断有没有、再往下传」，
 * 返回 boolean 就得在后面补一句 `as string` 把 `undefined` 断言掉 ——
 * 而那种断言一旦判断条件被改坏（比如漏了 `!`），编译期就再也拦不住了。
 */
export function isPresent<T>(value: T): value is Exclude<T, undefined | null | ''> {
  return value !== undefined && value !== null && value !== ''
}

/**
 * 取第一个「给了」的值，空串视作没给（判据见 {@link isPresent}）。
 *
 * 用于**字符串类**的字段别名：`poolAddress` / `poolId`、`userAddress` / `walletAddress`
 * 这类「空着就该回退到下一个来源」的场景。
 */
export function firstPresent<T>(...values: Array<T | undefined | null>): T | undefined {
  for (const v of values) if (isPresent(v)) return v as T
  return undefined
}

/**
 * 取第一个**已定义**的值，`''` / `0` / `false` 都算给了。
 *
 * 与 {@link firstPresent} 并存不是冗余：`percent: 0`、`amount0: 0` 这类字段里
 * **零是一个有意义的取值**，用 {@link firstPresent} 会把它跳过去、悄悄换成下一个别名的值
 * （「减仓 0%」变成「减仓 50%」这种事必须不可能发生）。
 * 两条规则合并成一个函数就必然要在某一类字段上做错事，所以刻意留成两个名字。
 */
export function firstDefined<T>(...values: Array<T | undefined | null>): T | undefined {
  for (const v of values) if (v !== undefined && v !== null) return v as T
  return undefined
}

// ---------------------------------------------------------------------------
// 可空的数值入参
// ---------------------------------------------------------------------------

/**
 * **可选**数值字段的宽进转换：`undefined` / `null` / **空字符串**都算「没给」，返回 `undefined`。
 *
 * 与 `coerce.toOptionalBigInt` 的分工是刻意的，不是重复：
 * - `toOptionalBigInt` 是公开原语，只放行 `undefined` / `null`。它服务于**必填金额**那类字段 ——
 *   那里 `''` 是调用方漏填了一个必须有的数，抛错才对。
 * - 本函数服务于**上限 / 备选**这类字段（`otherAmountMax`、`amount0Max`、减仓的 `liquidity`）：
 *   它们的常见来源是前端表单，用户没填时拿到的就是 `''`，语义明确是「我不设这个值」。
 *   把它当成非法数字抛出去，用户只会看到一条「无法解析为链上整数：收到 ""」——
 *   而他什么都没做错。
 *
 * 两个客户端（读链版 / 快照版）必须用同一个判据：曾经一边宽一边严，
 * 结果是同一个没填的输入框在 offchain 路径上炸、在读链路径上正常。
 */
export function toBlankableBigInt(value: Numericish | undefined | null, field: string): bigint | undefined {
  return isPresent(value) ? toBigInt(value as Numericish, field) : undefined
}

// ---------------------------------------------------------------------------
// 「同一个语义、多个字段名」的收敛（两个客户端共用，避免一边抛错一边静默挑一个）
// ---------------------------------------------------------------------------

/**
 * `userAddress` / `walletAddress` → 一个 checksum 地址；都没给返回 `undefined`。
 *
 * 两个都给且**不是同一个地址**时抛：挑哪个都是在替调用方决定「这笔交易算谁的」，
 * 而 EVM 上 userAddress 同时是余额/授权校验对象与资产默认接收者，挑错就是打给别人。
 * 「缺失」不在这里抛 —— 两个客户端的缺失文案不同（offchain 要点名是哪个方法），
 * 由各自补上更具体的那一条。
 */
export function pickActorAddress(params: {
  userAddress?: string
  walletAddress?: string
}): Address | undefined {
  const a = isPresent(params?.userAddress) ? toAddress(params.userAddress as string, 'userAddress') : undefined
  const b = isPresent(params?.walletAddress)
    ? toAddress(params.walletAddress as string, 'walletAddress')
    : undefined
  if (a && b && a !== b) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} userAddress 与 walletAddress 是同一个字段的两种写法，收到两个不同的地址：` +
        `${a} / ${b}。兼容层不猜哪个优先，请只保留一个。`,
    )
  }
  return a ?? b
}

/**
 * `tokenId` / `nftMint` → 一个 `bigint`；都没给返回 `undefined`。
 *
 * 两个都给且不相等时抛，理由同 {@link pickActorAddress}：这是「对哪个仓位动手」的唯一依据。
 * `nftMint` 传 base58 时由 `toBigInt` 抛出「EVM 请用 tokenId」的专门提示，比在这里
 * 报「缺少 tokenId」有用得多，所以这里不提前拦。
 */
export function pickTokenIdRef(params: { tokenId?: Numericish; nftMint?: Numericish }): bigint | undefined {
  const a = isPresent(params?.tokenId) ? toBigInt(params.tokenId as Numericish, 'tokenId') : undefined
  const b = isPresent(params?.nftMint) ? toBigInt(params.nftMint as Numericish, 'nftMint') : undefined
  if (a !== undefined && b !== undefined && a !== b) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} tokenId 与 nftMint 是同一个字段的两种写法，收到两个不同的值：${a} / ${b}。` +
        '兼容层不猜哪个优先，请只保留一个。',
    )
  }
  return a ?? b
}

/**
 * `followTokenId` / `refererPosition` → 一个 `bigint`；都没给返回 `undefined`（核心落默认 0 = 不跟随）。
 *
 * `refererPosition` 是 Solana 版 Copy Position 的母仓位字段（那边写成 `referer_position=` memo），
 * EVM 上对应 mint 尾字段 `followTokenId`，值是母仓位的 NFT tokenId —— 与 web 端的按链翻译一致。
 * 空串按「不复制」处理，对齐 Solana 版 `refererPosition ? memo : null` 的判断。
 * 两个都给且不相等时抛，理由同 {@link pickTokenIdRef}；传 base58 时由 `toBigInt` 给出「EVM 请用 tokenId」的提示。
 */
export function pickFollowTokenId(params: {
  followTokenId?: Numericish
  refererPosition?: Numericish
}): bigint | undefined {
  const a = isPresent(params?.followTokenId)
    ? toBigInt(params.followTokenId as Numericish, 'followTokenId')
    : undefined
  const b = isPresent(params?.refererPosition)
    ? toBigInt(params.refererPosition as Numericish, 'refererPosition')
    : undefined
  if (a !== undefined && b !== undefined && a !== b) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} followTokenId 与 refererPosition 是同一个字段的两种写法，收到两个不同的值：${a} / ${b}。` +
        '兼容层不猜哪个优先，请只保留一个。',
    )
  }
  return a ?? b
}

/**
 * 百分比的宽进转换：允许小数（旧代码里 `33.33%` 很常见），也允许字符串（表单原样透传）。
 * 区间校验 `(0, 100]` 交给核心，这里只挡住「根本不是数字」。
 */
function toPercentLike(value: number | string, field: string): number {
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n)) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} ${field} 必须是 (0, 100] 之间的数字（百分比口径，50 = 一半），收到 ${String(value)}。`,
    )
  }
  return n
}

/**
 * `percent` 与两个旧别名 `decreasePercentage` / `percentage` → 一个数字；都没给返回 `undefined`。
 *
 * 多个别名同时出现且**取值不同**时抛。这条必须两个客户端都遵守：
 * 静默挑第一个的后果是「用户点了减仓 25%，实际减了 50%」——功能上不报错，
 * 钱少了一半，而且事后从日志里也看不出发生了什么。
 *
 * 注意 `percent: 0` 算「给了」（`isPresent` 只把 `''` 当没填），会被核心以
 * 「percent 必须在 (0, 100] 之间」挡下 —— 这正是想要的：0 是一个明确的、错误的意图，
 * 不该被跳过去换成下一个别名的值。
 */
export function resolvePercentAlias(params: {
  percent?: number | string
  decreasePercentage?: number | string
  percentage?: number | string
}): number | undefined {
  const entries: Array<[string, number]> = []
  for (const key of ['percent', 'decreasePercentage', 'percentage'] as const) {
    const v = params?.[key]
    if (isPresent(v)) entries.push([key, toPercentLike(v as number | string, key)])
  }
  if (entries.length === 0) return undefined

  if (new Set(entries.map(([, v]) => v)).size > 1) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} percent / decreasePercentage / percentage 是同一个字段的三种写法，` +
        `收到不一致的取值：${entries.map(([k, v]) => `${k}=${v}`).join('、')}。请只保留一个。`,
    )
  }
  return entries[0][1]
}

// ---------------------------------------------------------------------------
// 代币元数据
// ---------------------------------------------------------------------------

/**
 * 把两份代币元数据按**地址升序**摆正，返回 `[token0, token1]`。
 *
 * 这条排序不需要读链也不需要快照：Uniswap V3 工厂建池时强制 `token0 < token1`
 * （`UniswapV3Factory.createPool` 会先 sort 再建），所以「谁是 token0」是地址本身决定的。
 * 有了它，调用方把 `token0` / `token1`（或旧名 `mintA` / `mintB`）传反也能救回来 ——
 * 而传反的后果是两边 decimals 互换，展示金额会整体偏 10^n 倍。
 */
export function orderTokenPairByAddress(a: ITokenInfo, b: ITokenInfo): [ITokenInfo, ITokenInfo] {
  const { token0, token1 } = orderTokenPairWithFlag(a, b)
  return [token0, token1]
}

/**
 * {@link orderTokenPairByAddress} 的「带回执」版本：额外告诉调用方**到底换没换位**。
 *
 * 为什么需要这个回执：重排的是**元数据**，但调用方往往还带着一份**与之配对的金额**
 * （`pendingFees.amount0 / amount1`）。只重排元数据、不重排金额，配对就断了 ——
 * 而断掉之后不会有任何报错，只会在界面上显示一个量级完全错误的数字：
 *
 * ```
 * { token0: USDC, token1: WETH, pendingFees: { amount0: 2e6, amount1: 1e15 } }
 *   元数据重排成 [WETH, USDC]，金额没动
 *   → 界面显示「可领 1000000000 USDC」（真实是 2 USDC）
 * ```
 *
 * 配对口径：**`amount0` 恒与调用方声明的 `token0` 配对**，与地址顺序无关。
 * 也就是说调用方只要自己内部一致（元数据和金额来自同一份数据），传反也是安全的；
 * 这正是 {@link orderTokenPairByAddress} 的 JSDoc 承诺的「顺序传反了也不要紧」。
 */
export function orderTokenPairWithFlag(
  a: ITokenInfo,
  b: ITokenInfo,
): { token0: ITokenInfo; token1: ITokenInfo; swapped: boolean } {
  const swapped = a.address.toLowerCase() >= b.address.toLowerCase()
  return swapped ? { token0: b, token1: a, swapped } : { token0: a, token1: b, swapped }
}

/**
 * 按 {@link orderTokenPairWithFlag} 的回执把一对金额跟着换位。
 *
 * 单独抽出来是为了让「元数据换了位、金额必须跟着换」这条约束在代码里**看得见** ——
 * 写成两行内联的 `swapped ? ... : ...` 时，它就只是某个分支里不起眼的三元表达式，
 * 下一个改这段代码的人很容易只动其中一半。
 */
export function orderPendingFeesWithFlag(fees: IPendingFees, swapped: boolean): IPendingFees {
  return swapped ? { amount0: fees.amount1, amount1: fees.amount0 } : fees
}

// ---------------------------------------------------------------------------
// 待领手续费
// ---------------------------------------------------------------------------

/**
 * 待领手续费的宽松形状。
 *
 * `amountA` / `amountB` 是 Solana 侧的叫法，一并认（EVM 上 A ≡ token0、B ≡ token1，
 * 池内按地址升序固定，所以这个别名是无损的）。四个字段都声明成可选，
 * 缺哪一边的报错由 {@link toPendingFees} 统一给 —— 在类型上写成必填只会让旧调用点编译不过，
 * 而兼容层存在的意义恰恰是让它们不用改。
 */
export interface IPendingFeesish {
  amount0?: Numericish
  amount1?: Numericish
  /** `amount0` 的 Solana 旧名 */
  amountA?: Numericish
  /** `amount1` 的 Solana 旧名 */
  amountB?: Numericish
}

/**
 * 宽松的 pendingFees → 核心 `IPendingFees`。**两边都必须给**。
 *
 * 只给一边不做兜底（不补 0）：`amount1` 缺失时补 0 会让 UI 显示「token1 这边没有手续费」，
 * 用户看到就不会去领 —— 这正是最需要避免的那类「会让人损失钱的假数据」。
 */
export function toPendingFees(input: IPendingFeesish, field: string): IPendingFees {
  const amount0 = firstDefined(input?.amount0, input?.amountA)
  const amount1 = firstDefined(input?.amount1, input?.amountB)
  if (amount0 === undefined || amount1 === undefined) {
    throw new Error(
      `${COMPAT_ERR_PREFIX} ${field} 必须同时给出 amount0 与 amount1（也认 amountA / amountB），` +
        `收到的键：${Object.keys(input ?? {}).join('、') || '(空对象)'}。` +
        '只给一边会让另一边的展示值变成 0，UI 上看起来就像「那边没有手续费」。',
    )
  }
  return {
    amount0: toBigInt(amount0, `${field}.amount0`),
    amount1: toBigInt(amount1, `${field}.amount1`),
  }
}

/**
 * {@link toPendingFees} 的可选版：没传就返回 `undefined`，让核心 SDK 去做 collect staticcall。
 *
 * 「没传」与「传了个空对象」在这里是两件事：前者是「我不知道，你去链上问」，
 * 后者是调用方组装数据时漏了字段 —— 后者会走进 {@link toPendingFees} 的报错。
 */
export function toOptionalPendingFees(
  input: IPendingFeesish | undefined | null,
  field: string,
): IPendingFees | undefined {
  if (input === undefined || input === null) return undefined
  return toPendingFees(input, field)
}

// ---------------------------------------------------------------------------
// meta 组装
// ---------------------------------------------------------------------------

/**
 * 核心 `ILiquidityMeta`（开仓 / 加仓）+ token 元数据 + `ui*` + 实际生效滑点。
 *
 * `ui*` 一律由 `toUiAmount` 一个函数产出，且 **decimals 取自传进来的这一对 token**——
 * 调用方必须保证它们已经按池子的链上顺序摆正（见 {@link orderTokenPairByAddress}），
 * 否则小数点会错位。这也是本函数不自己去猜顺序的原因：猜错无声无息，让上游明确。
 */
export function toCompatLiquidityMeta(
  core: ILiquidityMeta,
  token0: ITokenInfo,
  token1: ITokenInfo,
  slippageBps: number,
): ICompatLiquidityMeta {
  return {
    ...core,
    token0,
    token1,
    uiAmount0Desired: toUiAmount(core.amount0Desired, token0.decimals),
    uiAmount1Desired: toUiAmount(core.amount1Desired, token1.decimals),
    uiAmount0Min: toUiAmount(core.amount0Min, token0.decimals),
    uiAmount1Min: toUiAmount(core.amount1Min, token1.decimals),
    slippageBps,
  }
}

/** 核心 `IDecreaseMeta`（减仓 / 关仓）+ token 元数据 + `ui*` + 实际生效滑点 */
export function toCompatDecreaseMeta(
  core: IDecreaseMeta,
  token0: ITokenInfo,
  token1: ITokenInfo,
  slippageBps: number,
): ICompatDecreaseMeta {
  return {
    ...core,
    token0,
    token1,
    uiExpectedAmount0: toUiAmount(core.expectedAmount0, token0.decimals),
    uiExpectedAmount1: toUiAmount(core.expectedAmount1, token1.decimals),
    uiAmount0Min: toUiAmount(core.amount0Min, token0.decimals),
    uiAmount1Min: toUiAmount(core.amount1Min, token1.decimals),
    slippageBps,
  }
}

/**
 * 核心 `IPendingFees`（领费）+ token 元数据 + `ui*`。
 *
 * 这里**没有** `slippageBps`：`NPM.collect` 既不涉及价格也没有 deadline，
 * 给它铺一个滑点字段会让人以为「调一下就能生效」。
 */
export function toCompatPendingFeesMeta(
  core: IPendingFees,
  token0: ITokenInfo,
  token1: ITokenInfo,
): ICompatPendingFees {
  return {
    ...core,
    token0,
    token1,
    uiAmount0: toUiAmount(core.amount0, token0.decimals),
    uiAmount1: toUiAmount(core.amount1, token1.decimals),
  }
}

// ---------------------------------------------------------------------------
// otherAmountMax 断言
// ---------------------------------------------------------------------------

/**
 * 旧签名里 `otherAmountMax`（另一边的**上限**）的断言。
 *
 * EVM 侧另一边是由池价和区间**唯一确定**的，没有可以「取上限」的自由度，
 * 所以这个入参在新签名里没有位置。但直接丢掉是不对的 —— 它承载着调用方
 * 「另一边别超过这个数，否则我不干这笔」的真实意图（旧代码常拿它做一层资金保护）。
 * 这里把它降级成**发交易前的断言**：超了就抛，并把实际需要的数量印在错误里，
 * 让调用方能当场决策。静默丢弃等于悄悄关掉用户自己加的保险。
 *
 * @param args.where 可选的调用现场（如 `offchain.addLiquidityInstructions`）。
 *   同一个页面上读链版与 offchain 版都可能抛这条，点名了才知道该去改哪一处。
 */
export function assertOtherAmountMax(args: {
  otherAmountMax: bigint | undefined
  base: BaseSide
  amount0: bigint
  amount1: bigint
  token0: ITokenInfo
  token1: ITokenInfo
  where?: string
}): void {
  const { otherAmountMax, base, amount0, amount1, token0, token1, where } = args
  if (otherAmountMax === undefined) return

  // base 是 Token0 时「另一边」就是 token1，反之亦然
  const isBase0 = base === 'Token0'
  const actual = isBase0 ? amount1 : amount0
  const other = isBase0 ? token1 : token0
  if (actual <= otherAmountMax) return

  throw new Error(
    `${COMPAT_ERR_PREFIX} ${where ? `${where}：` : ''}另一边实际需要 ${actual}` +
      `（${toUiAmount(actual, other.decimals)} ${other.symbol}），超过了传入的 ` +
      `otherAmountMax=${otherAmountMax}（${toUiAmount(otherAmountMax, other.decimals)} ${other.symbol}）。\n` +
      '当前池价下这个上限不成立，请放宽上限或调整区间 / 金额。' +
      '（EVM 侧另一边由 SDK 按池价算出，otherAmountMax 在这里只作上限断言用。）',
  )
}

// ---------------------------------------------------------------------------
// 批量领费的汇总
// ---------------------------------------------------------------------------

/** {@link sumFeesByToken} 的入参：一条「某仓位领到了多少」的明细（两个客户端的明细类型都满足） */
export interface ICompatFeeItemLike {
  token0: ITokenInfo
  token1: ITokenInfo
  amount0: bigint
  amount1: bigint
}

/**
 * 批量领费的合计，**按代币地址聚合**。
 *
 * 刻意不给 `amount0` / `amount1` 两个「总和」字段：批量领费的仓位可以来自不同池子，
 * A 仓的 token0 是 WETH、B 仓的 token0 是 USDC，把它们相加得到的数没有任何含义 ——
 * 而一个「看起来能用」的数字迟早会被 UI 直接显示出来。按地址聚合是跨池唯一有意义的口径。
 */
export function sumFeesByToken(
  items: readonly ICompatFeeItemLike[],
): Array<{ token: ITokenInfo; amount: bigint; uiAmount: string }> {
  const acc = new Map<string, { token: ITokenInfo; amount: bigint }>()
  const add = (token: ITokenInfo, amount: bigint): void => {
    const key = token.address.toLowerCase()
    const hit = acc.get(key)
    if (hit) hit.amount += amount
    else acc.set(key, { token, amount })
  }
  for (const item of items) {
    add(item.token0, item.amount0)
    add(item.token1, item.amount1)
  }
  return [...acc.values()].map(({ token, amount }) => ({
    token,
    amount,
    uiAmount: toUiAmount(amount, token.decimals),
  }))
}

// ---------------------------------------------------------------------------
// 调用方自带的代币元数据：作用域化注入
// ---------------------------------------------------------------------------

/**
 * 判断一次读链失败是不是「合约明确 revert」（而不是超时 / 5xx / 429 限频之类的网络问题）。
 *
 * viem 的 revert 报错文案统一是 `The contract function "xxx" reverted ...`；
 * 批量预读据此决定要不要退回逐个读链 —— 网络问题退回只会把请求量放大 N 倍。
 */
export function isContractRevertError(e: unknown): boolean {
  const message = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return message.includes('reverted')
}

/**
 * 造一个「优先用调用方给的代币元数据」的 `Chain` 代理，**不写进核心的进程级缓存**。
 *
 * ## 为什么必须作用域化
 * 核心 `Chain` 的 `tokenInfoCache` 是**实例级、跨调用持久**的。早先这里的实现是直接把
 * 调用方给的元数据塞进那个缓存（省掉一次 ERC20 multicall），但那意味着：
 *
 * ```
 * createPosition({ ..., token1: { address: USDC, decimals: 18 } })   // 从别的链抄来的 token list
 *   → 本次金额换算错 10^12 倍（这是调用方自己的锅，认了）
 *   → 之后同一实例上**完全无关**的 chain.getPositionInfoByNftMint() 也跟着错   ← 这个不能忍
 * ```
 *
 * 一次错误输入污染整个 session 的所有读链路径，而且污染是**静默**的：后续调用看起来
 * 一切正常，只是金额少了几个数量级。`offchain.ts` 早就为同样的风险造了作用域代理，
 * 这里对齐同一套做法 —— 同一个兼容层的两半不该对同一个风险给出相反的答案。
 *
 * ## 与 offchain 版代理的区别
 * offchain 那版还会把 `publicClient` 换成「一碰就抛」的哨兵（强制 0 RPC），
 * 并且表里查不到就直接报错。这里是**读链版**：RPC 本来就是允许的，所以表里没有的地址
 * 一律回落到真实的 `chain.getTokenInfoList`，只是不再写共享缓存。
 * 也就是说这层代理**纯粹是省 RPC 的优化，不承载任何正确性保证**。
 *
 * @param tokens 调用方提供的元数据。按各自地址索引，所以 token0/token1 传反也不影响命中。
 */
export function buildTokenScopedChain(chain: Chain, tokens: readonly ITokenInfo[]): Chain {
  if (tokens.length === 0) return chain
  const table = new Map(tokens.map((t) => [t.address.toLowerCase(), t]))

  const getTokenInfoList = async (addresses: Address[]): Promise<ITokenInfo[]> => {
    // 先看调用方给了哪些；剩下的才去读链（一次 multicall 拿齐，不逐个读）
    const missing = addresses.filter((a) => !table.has(a.toLowerCase()))
    const fetched = missing.length > 0 ? await chain.getTokenInfoList(missing) : []
    const byAddress = new Map(fetched.map((t) => [t.address.toLowerCase(), t]))
    return addresses.map((address) => {
      const key = address.toLowerCase()
      const hit = table.get(key) ?? byAddress.get(key)
      if (!hit) {
        // 真实 chain.getTokenInfoList 对读不到的地址会自己抛，走到这里说明它返回了不完整的列表
        throw new Error(
          `${COMPAT_ERR_PREFIX} 内部错误：代币 ${address} 的元数据既不在调用方提供的列表里，` +
            '也没能从链上读到。',
        )
      }
      return hit
    })
  }

  return new Proxy(chain, {
    get(target, prop) {
      if (prop === 'getTokenInfoList') return getTokenInfoList
      const value = Reflect.get(target, prop, target)
      // 绑到 target 而不是 proxy：读链版不需要拦截 publicClient，
      // 绑 proxy 只会让核心内部的自调用多绕一层，没有收益
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
}
