/**
 * compat 层「宽进转换 + 快照归一化 + 静态数学 + 回执解析」的测试
 * （用例 1 / 2 / 3 / 4 / 5 / 9 —— 写操作那几条在 offchain.test.ts）。
 *
 * 这些全是纯函数，**不依赖网络**，快照用 Arbitrum WETH/USDC 池的真实形状。
 * 之所以要单独一份：这一层是所有金额与地址进入 SDK 的**唯一入口**，
 * 它放行了错的东西，后面每一层算出来的都是错的，而且报错会指向完全无关的地方。
 */
import { describe, expect, it } from 'vitest'

import {
  COMPAT_DEFAULT_SLIPPAGE_BPS,
  resolveDeadlineSec,
  resolveSlippageBps,
  toAddress,
  toBaseSide,
  toBigInt,
  toSmallInt,
} from './coerce.js'
import { SqrtPriceMath, TickMath } from './math.js'
import { toPoolStateRaw, toPositionStateRaw, toTokenInfo } from './state.js'

const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const POOL = '0xC6962004f452bE9203591991D15f6b388e09E8D0'
/** 真实的 Solana base58 地址，用来验证防呆提示 */
const SOLANA_ADDRESS = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'

// ---------------------------------------------------------------------------
// 用例 1 · toBigInt 的宽进等价性
// ---------------------------------------------------------------------------

describe('toBigInt（用例 1）', () => {
  it('BN-like / 十进制串 / 0x 串 / bigint / 安全整数 五种写法完全等价', () => {
    const expected = 123n
    expect(toBigInt({ toString: () => '123' }, 'v')).toBe(expected)
    expect(toBigInt('123', 'v')).toBe(expected)
    expect(toBigInt('  123  ', 'v')).toBe(expected)
    expect(toBigInt('0x7b', 'v')).toBe(expected)
    expect(toBigInt(123n, 'v')).toBe(expected)
    expect(toBigInt(123, 'v')).toBe(expected)
  })

  it('负数与 0 都是合法的链上整数', () => {
    expect(toBigInt('-196000', 'tick')).toBe(-196000n)
    expect(toBigInt(0, 'v')).toBe(0n)
  })

  it('浮点 number 一律抛，且点破「先乘 10**decimals」', () => {
    expect(() => toBigInt(1.5, 'baseAmount')).toThrow(/baseAmount[\s\S]*10\*\*decimals/)
  })

  it('超过 2^53 的 number 抛（精度已经丢了，不能默默接受）', () => {
    expect(() => toBigInt(2 ** 53 + 2, 'v')).toThrow(/MAX_SAFE_INTEGER/)
  })

  it('含小数点的字符串抛，并提示 Decimal 要先 toFixed(0)', () => {
    expect(() => toBigInt('1.5', 'baseAmount')).toThrow(/含小数点[\s\S]*toFixed\(0\)/)
  })

  it('空串 / null / undefined / 科学计数法 / 乱码 全抛', () => {
    expect(() => toBigInt('', 'v')).toThrow(/空字符串/)
    expect(() => toBigInt(null as never, 'v')).toThrow(/\[evm-clmm-sdk\/compat\]/)
    expect(() => toBigInt(undefined as never, 'v')).toThrow(/\[evm-clmm-sdk\/compat\]/)
    expect(() => toBigInt('1e18', 'v')).toThrow(/科学计数法/)
    expect(() => toBigInt('abc!', 'v')).toThrow(/非法字符/)
  })

  it('错误文案必须同时带上字段名与收到的原值', () => {
    expect(() => toBigInt('1.5', 'baseAmount')).toThrow(/baseAmount/)
    expect(() => toBigInt('1.5', 'baseAmount')).toThrow(/"1\.5"/)
  })

  it('toSmallInt 复用同一套宽进规则，只是多一道安全整数校验', () => {
    expect(toSmallInt('500', 'fee')).toBe(500)
    expect(toSmallInt(-196000n, 'tick')).toBe(-196000)
    expect(() => toSmallInt('99999999999999999999', 'tick')).toThrow(/超出安全整数范围/)
  })
})

// ---------------------------------------------------------------------------
// 用例 2 · Solana 地址防呆
// ---------------------------------------------------------------------------

describe('Solana 地址防呆（用例 2）', () => {
  it('userAddress 传 base58 时错误里必须出现 "Solana"', () => {
    expect(() => toAddress(SOLANA_ADDRESS, 'userAddress')).toThrow(/Solana/)
    expect(() => toAddress(SOLANA_ADDRESS, 'userAddress')).toThrow(/userAddress/)
  })

  it('把 nftMint（base58）当 tokenId 传时，提示要改用 tokenId', () => {
    expect(() => toBigInt(SOLANA_ADDRESS, 'nftMint')).toThrow(/Solana/)
    expect(() => toBigInt(SOLANA_ADDRESS, 'nftMint')).toThrow(/tokenId/)
  })

  it('Solana PublicKey 对象（有 toBase58）走同一条提示', () => {
    const pk = { toBase58: () => SOLANA_ADDRESS, toString: () => SOLANA_ADDRESS }
    expect(() => toAddress(pk as never, 'userAddress')).toThrow(/Solana/)
    expect(() => toBigInt(pk, 'nftMint')).toThrow(/Solana/)
  })

  it('合法 EVM 地址返回 checksum 形式（全小写输入也能过）', () => {
    expect(toAddress(WETH.toLowerCase(), 'token0')).toBe(WETH)
  })
})

// ---------------------------------------------------------------------------
// 用例 3 · 滑点量纲
// ---------------------------------------------------------------------------

describe('resolveSlippageBps（用例 3 —— 兼容层最危险的一处）', () => {
  it('旧口径小数与新口径基点换算一致', () => {
    expect(resolveSlippageBps({ slippage: 0.02 })).toBe(200)
    expect(resolveSlippageBps({ slippageBps: 200 })).toBe(200)
    expect(resolveSlippageBps({ slippage: 1 })).toBe(10_000)
    expect(resolveSlippageBps({ slippageBps: 0 })).toBe(0)
  })

  it('两个都传时抛（不猜哪个优先）', () => {
    expect(() => resolveSlippageBps({ slippage: 0.02, slippageBps: 200 })).toThrow(/只能二选一/)
  })

  it('slippage: 2 抛，且文案点破「小数口径」并给出正确写法', () => {
    expect(() => resolveSlippageBps({ slippage: 2 })).toThrow(/小数口径/)
    expect(() => resolveSlippageBps({ slippage: 2 })).toThrow(/slippageBps: 200/)
  })

  it('slippageBps 越界 / 非整数抛', () => {
    expect(() => resolveSlippageBps({ slippageBps: 10_001 })).toThrow(/\[0, 10000\]/)
    expect(() => resolveSlippageBps({ slippageBps: 12.5 })).toThrow(/整数基点/)
  })

  it('默认值是 200 bps（2%），刻意对齐 Solana 版而非核心 SDK 的 50', () => {
    // 这条断言就是那个决策本身：真要改成 50，必须**显式**改掉这一行，
    // 而不是某次重构里悄悄换掉常量、让迁移过来的代码在波动行情下开始随机 revert。
    expect(COMPAT_DEFAULT_SLIPPAGE_BPS).toBe(200)
    expect(resolveSlippageBps({})).toBe(200)
  })
})

describe('resolveDeadlineSec', () => {
  it('相对秒数原样透传，都不传时返回 undefined（让核心用它自己的默认）', () => {
    expect(resolveDeadlineSec({ deadlineSec: 600 })).toBe(600)
    expect(resolveDeadlineSec({})).toBeUndefined()
  })

  it('毫秒时间戳抛（传毫秒等于把滑点保护关掉）', () => {
    expect(() => resolveDeadlineSec({ deadline: Date.now() })).toThrow(/毫秒/)
  })

  it('已过期的绝对时间戳抛', () => {
    expect(() => resolveDeadlineSec({ deadline: 1_000_000_001 })).toThrow(/已经过期/)
  })

  it('两个都传时抛', () => {
    expect(() => resolveDeadlineSec({ deadlineSec: 60, deadline: 60 })).toThrow(/只能二选一/)
  })
})

describe('toBaseSide', () => {
  it('旧枚举名 / 新枚举名 / 索引写法三套都认', () => {
    for (const v of ['MintA', 'Token0', 'token0', 0] as const) expect(toBaseSide(v)).toBe('Token0')
    for (const v of ['MintB', 'Token1', 'token1', 1] as const) expect(toBaseSide(v)).toBe('Token1')
  })

  it('非法取值抛，且错误里列出全部合法取值', () => {
    expect(() => toBaseSide('MintC' as never)).toThrow(/MintA[\s\S]*MintB/)
  })
})

// ---------------------------------------------------------------------------
// 用例 4 · toPoolStateRaw 三种形状等价
// ---------------------------------------------------------------------------

describe('toPoolStateRaw 三形状等价（用例 4）', () => {
  /**
   * 核心 `IPoolStateRaw` 形状：定制合约的基础费率叫 `tradeFeeRate`（ppm），
   * 后面几个是 Byreal 独有的可变参数（旧快照没有时按安全缺省 0 / false 归一化）。
   */
  const canonical = {
    poolAddress: POOL,
    token0: WETH,
    token1: USDC,
    tickSpacing: 10,
    tradeFeeRate: 500,
    protocolFeeRate: 0,
    pauseFlags: 0,
    swapOpenTime: 0,
    alphaExtraTradeFeeRate: 0,
    dexExtraTradeFeeRate: 0,
    dynamicFeeEnabled: false,
    sqrtPriceX96: 1_234_567_890_123_456_789n,
    tick: -196000,
    liquidity: 987_654_321n,
    feeGrowthGlobal0X128: 111n,
    feeGrowthGlobal1X128: 222n,
  } as const

  /** 后端接口 `PoolDetail`：大整数是 string、链上字段嵌 onchainState、费率叫 feeTier、token 是对象 */
  const apiShape = {
    poolAddress: POOL.toLowerCase(),
    token0: { address: WETH, decimals: 18, symbol: 'WETH' },
    token1: { address: USDC, decimals: 6, symbol: 'USDC' },
    feeTier: '500',
    tickSpacing: '10',
    onchainState: {
      sqrtPriceX96: '1234567890123456789',
      tick: '-196000',
      liquidity: '987654321',
      feeGrowthGlobal0X128: '111',
      feeGrowthGlobal1X128: '222',
    },
  }

  /** 后端下发的扁平 JSON：字段名同合约，值是 string */
  const flatShape = {
    poolAddress: POOL.toLowerCase(),
    token0: WETH.toLowerCase(),
    token1: USDC.toLowerCase(),
    fee: '500',
    tickSpacing: '10',
    sqrtPriceX96: '1234567890123456789',
    tick: '-196000',
    liquidity: '987654321',
    feeGrowthGlobal0X128: '111',
    feeGrowthGlobal1X128: '222',
  }

  it('核心 raw / 后端接口 PoolDetail / 扁平 JSON 归一化后深度相等', () => {
    const a = toPoolStateRaw(canonical)
    const b = toPoolStateRaw(apiShape)
    const c = toPoolStateRaw(flatShape)
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    // 地址一律 checksum，大小写不同的输入不会产出两个「不相等」的池子
    expect(b.poolAddress).toBe(POOL)
    expect(b.token0).toBe(WETH)
  })

  it('基础费率的三个名字同单位互认：tradeFeeRate ← tradeFeeRate ?? fee ?? feeTier', () => {
    // 三个名字都是 ppm，纯改名，安全互认（上面那条等价用例正是靠它成立：
    // canonical 用新名、flatShape 用 fee、apiShape 用 feeTier）
    expect(toPoolStateRaw(canonical).tradeFeeRate).toBe(500)
    expect(toPoolStateRaw(flatShape).tradeFeeRate).toBe(500) // fee: '500'
    expect(toPoolStateRaw(apiShape).tradeFeeRate).toBe(500) // feeTier: '500'
    // 新名优先：同时给且不同值时以 tradeFeeRate 为准（它才是合约上的那个 getter）
    expect(toPoolStateRaw({ ...flatShape, tradeFeeRate: 3000 } as never).tradeFeeRate).toBe(3000)
  })

  it('Byreal 扩展字段给了就收、没给按安全缺省（0 / false）', () => {
    // 没给：缺省成 0 / false，而不是让整份旧快照解析失败
    const bare = toPoolStateRaw(flatShape)
    expect(bare.protocolFeeRate).toBe(0)
    expect(bare.pauseFlags).toBe(0)
    expect(bare.swapOpenTime).toBe(0)
    expect(bare.alphaExtraTradeFeeRate).toBe(0)
    expect(bare.dexExtraTradeFeeRate).toBe(0)
    expect(bare.dynamicFeeEnabled).toBe(false)

    // 给了就收（扁平形状放顶层）
    const flatRich = toPoolStateRaw({
      ...flatShape,
      protocolFeeRate: '25',
      pauseFlags: '3',
      swapOpenTime: '1700000000',
      alphaExtraTradeFeeRate: '100',
      dexExtraTradeFeeRate: '200',
      dynamicFeeEnabled: true,
    } as never)
    expect(flatRich.protocolFeeRate).toBe(25)
    expect(flatRich.pauseFlags).toBe(3)
    expect(flatRich.swapOpenTime).toBe(1_700_000_000)
    expect(flatRich.alphaExtraTradeFeeRate).toBe(100)
    expect(flatRich.dexExtraTradeFeeRate).toBe(200)
    expect(flatRich.dynamicFeeEnabled).toBe(true)

    // 后端接口形状把它们嵌在 onchainState 里，同样要收到
    const nested = toPoolStateRaw({
      ...apiShape,
      onchainState: { ...apiShape.onchainState, pauseFlags: '1', dynamicFeeEnabled: true },
    } as never)
    expect(nested.pauseFlags).toBe(1)
    expect(nested.dynamicFeeEnabled).toBe(true)
  })

  it('缺字段时报错里要列出缺了哪几个，而不是一句 invalid input', () => {
    const { sqrtPriceX96: _s, liquidity: _l, ...broken } = flatShape
    expect(() => toPoolStateRaw(broken as never)).toThrow(/sqrtPriceX96/)
    expect(() => toPoolStateRaw(broken as never)).toThrow(/liquidity/)
    // 顺带告诉调用方兼容层认哪三种形状
    expect(() => toPoolStateRaw(broken as never)).toThrow(/PoolDetail/)
  })

  it('缺费率时报错要把三个认得的名字都列出来（只说 tradeFeeRate 旧调用方会以为得改后端）', () => {
    const { fee: _f, ...noFee } = flatShape
    expect(() => toPoolStateRaw(noFee as never)).toThrow(
      /tradeFeeRate（旧名 fee \/ feeTier 也认）/,
    )
  })

  it('空串算「没给」：别名字段不会被一个空串抢走', () => {
    // 后端把「没有值」序列化成 ""（而不是省略字段）是极常见的，
    // 若把它当成有效值，明明给了 id / feeTier 也会报「poolAddress 是空字符串」
    expect(toPoolStateRaw({ ...flatShape, poolAddress: '', id: POOL } as never).poolAddress).toBe(POOL)
    expect(
      toPoolStateRaw({ ...flatShape, fee: '', feeTier: '500' } as never).tradeFeeRate,
    ).toBe(500)
  })

  it('必填字段传空串仍然失败，但报的是「缺少必需字段」这条更指得出方向的错', () => {
    expect(() => toPoolStateRaw({ ...flatShape, liquidity: '' } as never)).toThrow(
      /缺少必需字段：liquidity/,
    )
  })
})

// ---------------------------------------------------------------------------
// 用例 4 的仓位版：toPositionStateRaw 同样要吃三种形状
// ---------------------------------------------------------------------------

describe('toPositionStateRaw 三形状等价', () => {
  const canonical = {
    tokenId: 123456n,
    nonce: 0n,
    operator: '0x0000000000000000000000000000000000000000',
    token0: WETH,
    token1: USDC,
    // 定制合约的 positions 第 5 项是 tickSpacing（原生 V3 此处是 fee），
    // 它与 token0/token1 一起构成「这个仓位属于哪个池子」的身份键
    tickSpacing: 10,
    tickLower: -197000,
    tickUpper: -195000,
    liquidity: 999_999_999_999n,
    feeGrowthInside0LastX128: 0n,
    feeGrowthInside1LastX128: 0n,
    tokensOwed0: 0n,
    tokensOwed1: 0n,
  } as const

  /** 后端接口的 `PositionDetail`：大整数是 string，池子身份靠 pool 字段带过来 */
  const apiShape = {
    tokenId: '123456',
    tickLower: '-197000',
    tickUpper: '-195000',
    liquidity: '999999999999',
    pool: {
      poolAddress: POOL,
      token0: { address: WETH, decimals: 18, symbol: 'WETH' },
      token1: { address: USDC, decimals: 6, symbol: 'USDC' },
      feeTier: '500',
      tickSpacing: '10',
      onchainState: {
        sqrtPriceX96: '1234567890123456789',
        tick: '-196000',
        liquidity: '1',
        feeGrowthGlobal0X128: '0',
        feeGrowthGlobal1X128: '0',
      },
    },
  }

  /** 后端下发的扁平 JSON：字段名同 `positions()` */
  const flatShape = {
    tokenId: '123456',
    token0: WETH.toLowerCase(),
    token1: USDC.toLowerCase(),
    tickSpacing: '10',
    tickLower: '-197000',
    tickUpper: '-195000',
    liquidity: '999999999999',
  }

  it('核心 raw / 后端接口 PositionDetail / 扁平 JSON 归一化后深度相等', () => {
    const a = toPositionStateRaw(canonical as never)
    expect(toPositionStateRaw(apiShape)).toEqual(a)
    expect(toPositionStateRaw(flatShape)).toEqual(a)
  })

  it('纯记账字段（nonce / operator / feeGrowthInside* / tokensOwed*）缺失时缺省，核心一个都不读', () => {
    const state = toPositionStateRaw(flatShape)
    expect(state.nonce).toBe(0n)
    expect(state.operator).toBe('0x0000000000000000000000000000000000000000')
    expect(state.tokensOwed0).toBe(0n)
    expect(state.feeGrowthInside1LastX128).toBe(0n)
    // 后端把这些字段序列化成空串时同样走缺省，而不是让整份快照解析失败
    expect(toPositionStateRaw({ ...flatShape, operator: '', tokensOwed0: '' })).toEqual(state)
  })

  it('数学必需字段缺失时抛，并列出缺了哪几个', () => {
    const { liquidity: _l, tickUpper: _u, ...broken } = flatShape
    expect(() => toPositionStateRaw(broken as never)).toThrow(/tickUpper/)
    expect(() => toPositionStateRaw(broken as never)).toThrow(/liquidity/)
  })

  it('PositionSummary（只有 poolAddress、没有 token0/token1/tickSpacing）要给出「把池子并进来」的写法', () => {
    const summary = {
      tokenId: '1',
      poolAddress: POOL,
      tickLower: '-197000',
      tickUpper: '-195000',
      liquidity: '1',
    }
    expect(() => toPositionStateRaw(summary)).toThrow(
      /toPositionStateRaw\(\{ \.\.\.position, pool: poolMap\[position\.poolAddress\] \}\)/,
    )
    // 缺的到底是哪几项要说清楚，并给出「直接补齐」这条更简单的出路
    expect(() => toPositionStateRaw(summary)).toThrow(/缺少定位池子所需的字段[\s\S]*tickSpacing/)
    expect(() => toPositionStateRaw(summary)).toThrow(/补齐 token0 \/ token1 \/ tickSpacing/)
  })

  it('旧字段 fee / feeTier 不能兜底 tickSpacing（量纲不同，推导必错）', () => {
    // 池子快照那边 fee / feeTier 与 tradeFeeRate 同单位可以互认；
    // 仓位这边 tickSpacing 是 tick 步长、fee 是 ppm 费率，认了就会反查到别的池子（甚至查不到）
    const { tickSpacing: _ts, ...noSpacing } = flatShape
    expect(() => toPositionStateRaw({ ...noSpacing, fee: '500' } as never)).toThrow(
      /缺少定位池子所需的字段[\s\S]*tickSpacing/,
    )
    expect(() => toPositionStateRaw({ ...noSpacing, feeTier: '500' } as never)).toThrow(
      /fee\/feeTier 不能替代 tickSpacing/,
    )
    // 反证：把 tickSpacing 补回去就能过（说明上面抛的确实只是因为缺它）
    expect(toPositionStateRaw({ ...noSpacing, fee: '500', tickSpacing: '10' } as never).tickSpacing).toBe(10)
  })

  it('tokenId 传 base58 时命中「EVM 请用 tokenId」的专门提示，而不是报「缺 tokenId」', () => {
    expect(() => toPositionStateRaw({ ...flatShape, tokenId: SOLANA_ADDRESS })).toThrow(/Solana/)
  })
})

describe('toTokenInfo', () => {
  it('chainId 由调用方注入；入参自带时以它自己的为准（更具体的信息优先）', () => {
    expect(toTokenInfo({ address: WETH, decimals: '18', symbol: 'WETH' }, 42161)).toEqual({
      chainId: 42161,
      address: WETH,
      decimals: 18,
      symbol: 'WETH',
    })
    expect(toTokenInfo({ address: WETH, decimals: 18, chainId: 5000 }, 42161).chainId).toBe(5000)
    // 空串不该把注入的 chainId 顶掉
    expect(toTokenInfo({ address: WETH, decimals: 18, chainId: '' } as never, 42161).chainId).toBe(42161)
  })

  it('symbol 缺失降级成 UNKNOWN（只影响展示），decimals 缺失一律抛（金额换算全靠它）', () => {
    expect(toTokenInfo({ address: WETH, decimals: 6 }, 42161).symbol).toBe('UNKNOWN')
    expect(() => toTokenInfo({ address: WETH } as never, 42161)).toThrow(/缺少必需字段：decimals/)
    expect(() => toTokenInfo({ decimals: 18 } as never, 42161)).toThrow(/缺少必需字段：address/)
  })

  it('decimals 越界抛（ERC20 的 decimals 是 uint8）', () => {
    expect(() => toTokenInfo({ address: WETH, decimals: 256 }, 42161)).toThrow(/\[0, 255\]/)
  })
})

// ---------------------------------------------------------------------------
// 用例 5 · X64 方法一律抛
// ---------------------------------------------------------------------------

describe('SqrtPriceMath 的 X64 旧方法（用例 5）', () => {
  // 第三列是**这条错误该指向的替代方法**。必须逐条钉死：只断言「文案含 X96」的话，
  // 命中的是四条错误共有的样板段落 —— 把四条的替代方法名全改成同一个（其中三条因此是错的），
  // 测试照样全绿。替代方法名正是调用方唯一会照着改的那部分，它错了整条提示就白给。
  const cases: Array<[string, () => unknown, string]> = [
    ['getSqrtPriceX64FromTick', () => SqrtPriceMath.getSqrtPriceX64FromTick(0), 'getSqrtPriceX96FromTick'],
    ['getTickFromSqrtPriceX64', () => SqrtPriceMath.getTickFromSqrtPriceX64(1n), 'getTickFromSqrtPriceX96'],
    ['sqrtPriceX64ToPrice', () => SqrtPriceMath.sqrtPriceX64ToPrice({}), 'sqrtPriceX96ToPrice'],
    ['priceToSqrtPriceX64', () => SqrtPriceMath.priceToSqrtPriceX64({}), 'priceToSqrtPriceX96'],
  ]

  it.each(cases)('%s 调用必抛，且文案含 X96 与正确的替代方法', (_name, call, replacement) => {
    expect(call).toThrow(/X96/)
    expect(call).toThrow(/Q64\.64/)
    expect(call).toThrow(new RegExp(replacement))
  })

  it('四条错误各自指向不同的替代方法（不是同一段样板）', () => {
    const replacements = cases.map(([, call]) => {
      try {
        call()
      } catch (e) {
        return (e as Error).message
      }
      throw new Error('该调用本应抛错')
    })
    // 四条文案必须两两不同 —— 相同就说明替代方法名被复制粘贴成了同一个
    expect(new Set(replacements).size).toBe(4)
  })

  it('X96 的对位方法能正常工作（抛的只是量纲错的那四个名字）', () => {
    // 2^96：tick 0 处 sqrtPrice = 1，X96 表示就是 2^96
    expect(SqrtPriceMath.getSqrtPriceX96FromTick(0)).toBe(2n ** 96n)
    expect(SqrtPriceMath.getTickFromSqrtPriceX96(2n ** 96n)).toBe(0)
    expect(TickMath.getSqrtRatioAtTick(0)).toBe(2n ** 96n)
  })
})

// ---------------------------------------------------------------------------
// 用例 10 的一半：TickMath 的旧调用形状仍然可用
// ---------------------------------------------------------------------------

describe('TickMath 边界', () => {
  const weth = { chainId: 42161, address: WETH, decimals: 18, symbol: 'WETH' } as const
  const usdc = { chainId: 42161, address: USDC, decimals: 6, symbol: 'USDC' } as const

  it('MIN_TICK / MAX_TICK 与 @uniswap/v3-sdk 对齐，越界 tick 抛可读错误', () => {
    expect(TickMath.MIN_TICK).toBe(-887272)
    expect(TickMath.MAX_TICK).toBe(887272)
    expect(() => TickMath.getSqrtRatioAtTick(TickMath.MAX_TICK + 1)).toThrow(/越界/)
    expect(() => TickMath.getSqrtRatioAtTick(1.5)).toThrow(/必须是整数 tick/)
  })

  it('getSqrtRatioAtTick ↔ getTickAtSqrtRatio 往返精确', () => {
    for (const tick of [TickMath.MIN_TICK, -196000, 0, 200000]) {
      expect(TickMath.getTickAtSqrtRatio(TickMath.getSqrtRatioAtTick(tick))).toBe(tick)
    }
  })

  it('nearestUsableTick 吸附到 tickSpacing 的整数倍', () => {
    expect(TickMath.nearestUsableTick(-196004, 10)).toBe(-196000)
    expect(TickMath.getFullRangeTicks(10)).toEqual({ tickLower: -887270, tickUpper: 887270 })
  })

  it('baseIn: false 给出反向价格（旧版同名开关）', () => {
    const forward = TickMath.getPriceFromTick({ tick: -196000, token0: weth, token1: usdc })
    const backward = TickMath.getPriceFromTick({ tick: -196000, token0: weth, token1: usdc, baseIn: false })
    expect(Number(forward) * Number(backward)).toBeCloseTo(1, 6)
  })

  it('priceToSqrtPriceX96 不被 tick 网格吸附（price=1 精确得到 2^96）', () => {
    const same = { chainId: 42161, address: WETH, decimals: 18, symbol: 'A' } as const
    const other = { chainId: 42161, address: USDC, decimals: 18, symbol: 'B' } as const
    expect(SqrtPriceMath.priceToSqrtPriceX96({ price: '1', token0: same, token1: other })).toBe(2n ** 96n)
    expect(SqrtPriceMath.priceToSqrtPriceX96({ price: '4', token0: same, token1: other })).toBe(2n * 2n ** 96n)
  })
})
