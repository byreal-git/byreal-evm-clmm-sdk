/**
 * 01 读池子信息（只读，不需要私钥）
 *
 * 按池身份键 (token0, token1, tickSpacing) 找到池地址 → 读链上状态 → 本地换算价格与费率。
 *
 *   npx tsx examples/01_read_pool.ts
 */
import { sqrtPriceX96ToPrice, tickToPrice } from '../src/index.js'

import { loadDemoPool, print } from './config.js'

const { poolAddress, poolState, token0, token1 } = await loadDemoPool()

/** pauseFlags 位图含义 */
const PAUSE_BITS: Record<number, string> = { 1: 'SWAP', 2: 'ADD', 4: 'REMOVE', 8: 'COLLECT', 16: 'FLASH' }
const paused = Object.entries(PAUSE_BITS)
  .filter(([bit]) => (poolState.pauseFlags & Number(bit)) !== 0)
  .map(([, name]) => name)

print('池子', {
  poolAddress,
  token0: `${token0.symbol}（${token0.address}，${token0.decimals} 位小数）`,
  token1: `${token1.symbol}（${token1.address}，${token1.decimals} 位小数）`,
  tickSpacing: poolState.tickSpacing,
})

print('价格与流动性', {
  [`1 ${token0.symbol} = ? ${token1.symbol}`]: sqrtPriceX96ToPrice({ sqrtPriceX96: poolState.sqrtPriceX96, token0, token1 }),
  // tickToPrice 按传入顺序给出「1 base = ? quote」，交换两个代币即得反向价格
  [`1 ${token1.symbol} = ? ${token0.symbol}`]: tickToPrice({ tick: poolState.tick, token0: token1, token1: token0 }),
  tick: poolState.tick,
  liquidity: poolState.liquidity,
})

print('费率与开关', {
  // 费率字段是 ppm：除以 10_000 得百分比
  tradeFee: `${poolState.tradeFeeRate / 10_000}%`,
  dexExtraFee: `${poolState.dexExtraTradeFeeRate / 10_000}%`,
  alphaExtraFee: `${poolState.alphaExtraTradeFeeRate / 10_000}%`,
  // protocolFeeRate 是百分比整数：交易手续费里归协议的比例
  protocolFeeShare: `${poolState.protocolFeeRate}%`,
  dynamicFeeEnabled: poolState.dynamicFeeEnabled,
  paused: paused.length ? paused : '无',
  swapOpenTime: poolState.swapOpenTime ? new Date(poolState.swapOpenTime * 1000).toISOString() : '不限',
})
