/**
 * 05 减仓（真实上链，需要 PRIVATE_KEY）
 *
 * 按比例撤出流动性。默认 decrease + collect 打成一笔 multicall，撤出的本金和已产生的手续费直接回到钱包；
 * 传 `collect: false` 时只记账到仓位，之后需要再 collect（06）才会到账。
 *
 *   npx tsx examples/05_decrease_liquidity.ts
 *   TOKEN_ID=1234 npx tsx examples/05_decrease_liquidity.ts
 */
import { fmt, getWallet, loadDemoPool, print, printBalances, resolveTokenId, sdk, sendTransactions } from './config.js'

const wallet = getWallet()
const tokenId = await resolveTokenId(wallet.address)
const { token0, token1 } = await loadDemoPool()

await printBalances(wallet.address, '减仓前余额')

const { transactions, meta } = await sdk.decreaseLiquidity({
  userAddress: wallet.address,
  tokenId,
  percent: 50,
  slippageBps: 100,
})
print('交易参数', {
  removedLiquidity: meta.liquidity,
  expectedAmount0: fmt(meta.expectedAmount0, token0),
  expectedAmount1: fmt(meta.expectedAmount1, token1),
  amount0Min: fmt(meta.amount0Min, token0),
  amount1Min: fmt(meta.amount1Min, token1),
})

await sendTransactions(wallet, transactions)

const after = await sdk.chain.getRawPositionInfo(tokenId)
console.log(`\n仓位 #${tokenId} 剩余流动性：${after.liquidity}`)
await printBalances(wallet.address, '减仓后余额')
