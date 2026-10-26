/**
 * 08 Swap（真实上链，需要 PRIVATE_KEY）
 *
 * 链上询价（ByrealQuoter）→ 用报价构造 Trade → 编码 SwapRouter calldata → allowance 不足时先 approve → 发送。
 * 默认把 1 USDC 换成 TV2D；交换 TOKEN_IN / TOKEN_OUT 即可反向。
 *
 *   npx tsx examples/08_swap.ts
 */
import { encodeFunctionData, parseUnits, type Address, type Hex } from 'viem'

import { ERC20_ABI, toUniPool, type IUnsignedTx } from '../src/index.js'
import { CurrencyAmount, Percent, Route, SwapRouter, Trade, TradeType } from '../src/raw/index.js'

import { fmt, getWallet, loadDemoPool, print, printBalances, sdk, sendTransactions, TV2D, USDC } from './config.js'

const TOKEN_IN: Address = USDC
const TOKEN_OUT: Address = TV2D
const AMOUNT_IN = '1'
/** 滑点 0.5%（基点） */
const SLIPPAGE_BPS = 50

const wallet = getWallet()
const swapRouter = sdk.contracts.swapRouter
if (!swapRouter) throw new Error('当前部署没有配置 swapRouter 地址')

const { poolState, token0, token1 } = await loadDemoPool()
const pool = toUniPool({ poolState, token0, token1 })
const tokenIn = TOKEN_IN.toLowerCase() === token0.address.toLowerCase() ? pool.token0 : pool.token1
const tokenOut = tokenIn.equals(pool.token0) ? pool.token1 : pool.token0
const infoIn = tokenIn.equals(pool.token0) ? token0 : token1
const infoOut = tokenIn.equals(pool.token0) ? token1 : token0
const amountIn = parseUnits(AMOUNT_IN, infoIn.decimals)

await printBalances(wallet.address, 'swap 前余额')

// 1) 链上询价：结果已扣除交易费与额外费，动态费率池也只能用这条路径
const quote = await sdk.quoteSwap({ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, tickSpacing: poolState.tickSpacing, amountIn })
print('报价', { amountIn: fmt(amountIn, infoIn), amountOut: fmt(quote.amountOut, infoOut), ticksCrossed: quote.ticksCrossed })

// 2) 用报价构造 Trade（不在本地重算曲线），再编码 swap calldata；deadline 在外层 multicall(deadline, data)
const trade = Trade.createUncheckedTrade({
  route: new Route([pool], tokenIn, tokenOut),
  inputAmount: CurrencyAmount.fromRawAmount(tokenIn, amountIn.toString()),
  outputAmount: CurrencyAmount.fromRawAmount(tokenOut, quote.amountOut.toString()),
  tradeType: TradeType.EXACT_INPUT,
  extraFeeClass: sdk.chain.extraFeeClass,
})
const slippage = new Percent(SLIPPAGE_BPS, 10_000)
const { calldata, value } = SwapRouter.swapCallParameters(trade, {
  slippageTolerance: slippage,
  recipient: wallet.address,
  deadline: Math.floor(Date.now() / 1000) + 1200,
})
console.log(`最少收到：${trade.minimumAmountOut(slippage).toExact()} ${infoOut.symbol}`)

// 3) SwapRouter 从钱包扣 tokenIn，allowance 不足时先 approve（只授权本次用量）
const transactions: IUnsignedTx[] = []
const allowance = await sdk.publicClient.readContract({
  address: TOKEN_IN,
  abi: ERC20_ABI,
  functionName: 'allowance',
  args: [wallet.address, swapRouter],
})
if (allowance < amountIn) {
  transactions.push({
    to: TOKEN_IN,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [swapRouter, amountIn] }),
    value: 0n,
    chainId: sdk.chainId,
    label: `approve ${infoIn.symbol}`,
  })
}
transactions.push({ to: swapRouter, data: calldata as Hex, value: BigInt(value), chainId: sdk.chainId, label: 'swap' })

await sendTransactions(wallet, transactions)
await printBalances(wallet.address, 'swap 后余额')
