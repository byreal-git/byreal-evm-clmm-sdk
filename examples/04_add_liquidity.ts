/**
 * 04 加仓（真实上链，需要 PRIVATE_KEY）
 *
 * 往已有仓位追加流动性。区间以链上仓位为准不能改，只需给出一边的投入量。
 * 默认操作钱包在演示池里最新的仓位，也可用 TOKEN_ID 指定。
 *
 *   npx tsx examples/04_add_liquidity.ts
 *   TOKEN_ID=1234 npx tsx examples/04_add_liquidity.ts
 */
import { parseUnits } from 'viem'

import { getPositionView } from '../src/index.js'

import { fmt, getWallet, loadDemoPool, print, resolveTokenId, sdk, sendTransactions } from './config.js'

const wallet = getWallet()
const tokenId = await resolveTokenId(wallet.address)
const { poolAddress, poolState, token0, token1 } = await loadDemoPool()
const positionState = await sdk.chain.getRawPositionInfo(tokenId)

// 以 token0（USDC）为基准追加 0.2 个，另一边由 SDK 按仓位区间与当前价算出
const { transactions, meta } = await sdk.addLiquidity({
  userAddress: wallet.address,
  tokenId,
  base: 'Token0',
  baseAmount: parseUnits('0.2', token0.decimals),
  slippageBps: 100,
  poolState,
  positionState,
})
print('交易参数', {
  amount0Desired: fmt(meta.amount0Desired, token0),
  amount1Desired: fmt(meta.amount1Desired, token1),
  addedLiquidity: meta.liquidity,
  transactions: transactions.map((tx) => tx.label),
})

await sendTransactions(wallet, transactions)

const view = getPositionView({
  poolState: await sdk.getRawPoolInfoByPoolAddress(poolAddress),
  positionState: await sdk.chain.getRawPositionInfo(tokenId),
  token0,
  token1,
})
print(`加仓后仓位 #${tokenId}`, {
  liquidity: `${positionState.liquidity} → ${view.liquidity}`,
  holdings: [fmt(view.amount0, token0), fmt(view.amount1, token1)],
})
