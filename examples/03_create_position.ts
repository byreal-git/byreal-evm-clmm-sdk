/**
 * 03 开仓（真实上链，需要 PRIVATE_KEY）
 *
 * 选区间 → 预览两边投入量 → 构建交易（allowance 不足时自动前置 approve）→ 逐笔发送 → 从回执解析 tokenId。
 * 钱包需要 MNT（gas）、USDC 和 TV2D；没有 TV2D 时先运行 08_swap.ts 换一点。
 *
 *   npx tsx examples/03_create_position.ts
 */
import { parseUnits } from 'viem'

import { getAmountsFromAmount, getPositionView, getTicksByPercentRange, parseTokenIdFromReceipt } from '../src/index.js'

import { fmt, getWallet, loadDemoPool, print, printBalances, sdk, sendTransactions } from './config.js'

const wallet = getWallet()
const { poolAddress, poolState, token0, token1 } = await loadDemoPool()

// 1) 价格区间：当前价 -5% ~ +5%，SDK 负责对齐到 tickSpacing
const { tickLower, tickUpper } = getTicksByPercentRange({
  currentTick: poolState.tick,
  tickSpacing: poolState.tickSpacing,
  lowerPercent: 5,
  upperPercent: 5,
})

// 2) 以 token0（USDC）为基准投入 0.5 个；另一边需要多少由本地数学算出（输入框联动同理）
const base = 'Token0' as const
const baseAmount = parseUnits('0.5', token0.decimals)
const preview = getAmountsFromAmount({ poolState, token0, token1, tickLower, tickUpper, base, baseAmount })
print('预计投入', { tickLower, tickUpper, amount0: fmt(preview.amount0, token0), amount1: fmt(preview.amount1, token1) })

// 3) 构建交易：返回按顺序发送的未签名交易（0~2 笔 approve + 1 笔 mint），默认会校验余额
const { transactions, meta } = await sdk.createPosition({
  userAddress: wallet.address,
  poolAddress,
  tickLower,
  tickUpper,
  base,
  baseAmount,
  slippageBps: 100, // 1%
  poolState, // 已经读过池子，传进去省一次 RPC
})
print('交易参数', {
  amount0Desired: fmt(meta.amount0Desired, token0),
  amount1Desired: fmt(meta.amount1Desired, token1),
  amount0Min: fmt(meta.amount0Min, token0),
  amount1Min: fmt(meta.amount1Min, token1),
  approvals: meta.approvals.length,
  transactions: transactions.map((tx) => tx.label),
})

// 4) 逐笔发送；tokenId 只有 mint 上链后才知道，从回执的 ERC-721 Transfer 事件解析
const receipts = await sendTransactions(wallet, transactions)
const tokenId = parseTokenIdFromReceipt(receipts.at(-1)!, { positionManager: sdk.contracts.positionManager })
console.log(`\n开仓成功：tokenId = ${tokenId}`)

const view = getPositionView({
  poolState: await sdk.getRawPoolInfoByPoolAddress(poolAddress),
  positionState: await sdk.chain.getRawPositionInfo(tokenId),
  token0,
  token1,
})
print(`仓位 #${tokenId}`, {
  priceRange: `${view.priceLower} ~ ${view.priceUpper}`,
  liquidity: view.liquidity,
  holdings: [fmt(view.amount0, token0), fmt(view.amount1, token1)],
})
await printBalances(wallet.address)
