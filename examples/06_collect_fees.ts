/**
 * 06 领取手续费（真实上链，需要 PRIVATE_KEY）
 *
 * 先读精确的待领额（collect staticcall），再发 NPM.collect 领走。
 * 待领额包含仓位产生的手续费，以及 `collect: false` 减仓后留在仓位里的本金。
 * 新开的仓位要等池子里有成交才会产生手续费，可以先运行 08_swap.ts。
 *
 *   npx tsx examples/06_collect_fees.ts
 *   TOKEN_ID=1234 npx tsx examples/06_collect_fees.ts
 */
import { fmt, getWallet, loadDemoPool, printBalances, resolveTokenId, sdk, sendTransactions } from './config.js'

const wallet = getWallet()
const tokenId = await resolveTokenId(wallet.address)
const { token0, token1 } = await loadDemoPool()

const pending = await sdk.getPendingFees({ tokenId, owner: wallet.address })
console.log(`\n仓位 #${tokenId} 待领：${fmt(pending.amount0, token0)}，${fmt(pending.amount1, token1)}`)
if (pending.amount0 === 0n && pending.amount1 === 0n) {
  // 实际接入时这里通常直接置灰「领取」按钮；示例仍发送一笔，演示完整流程
  console.log('当前待领为 0（新仓位要等池子有成交才产生手续费），仍发送 collect 演示流程。')
}

// 已经读过待领额，传进去省一次 staticcall
const { transactions } = await sdk.collectFees({ userAddress: wallet.address, tokenId, pendingFees: pending })
await sendTransactions(wallet, transactions)

await printBalances(wallet.address, '领取后余额')
