/**
 * 07 关仓（真实上链，需要 PRIVATE_KEY）
 *
 * 一笔原子 multicall：撤出全部流动性 + 领走本金与手续费 + 销毁仓位 NFT。
 *
 *   npx tsx examples/07_close_position.ts
 *   TOKEN_ID=1234 npx tsx examples/07_close_position.ts
 */
import { fmt, getWallet, loadDemoPool, print, printBalances, resolveTokenId, sdk, sendTransactions } from './config.js'

const wallet = getWallet()
const tokenId = await resolveTokenId(wallet.address)
const { token0, token1 } = await loadDemoPool()

const { transactions, meta } = await sdk.closePosition({ userAddress: wallet.address, tokenId, slippageBps: 100 })
print('交易参数', {
  expectedAmount0: fmt(meta.expectedAmount0, token0),
  expectedAmount1: fmt(meta.expectedAmount1, token1),
  amount0Min: fmt(meta.amount0Min, token0),
  amount1Min: fmt(meta.amount1Min, token1),
})

await sendTransactions(wallet, transactions)

const remaining = await sdk.getPositionTokenIdListByOwner(wallet.address)
console.log(`\n仓位 #${tokenId} 已关闭（NFT 已销毁：${!remaining.includes(tokenId)}）`)
await printBalances(wallet.address, '关仓后余额')
