/**
 * 02 读仓位信息（只读，不需要私钥）
 *
 * 列出地址持有的仓位 → 一次 multicall 读仓位状态与待领手续费 → 本地算出持仓量、价格区间、是否在区间内。
 *
 *   OWNER=0x... npx tsx examples/02_read_positions.ts     # 查任意地址
 *   npx tsx examples/02_read_positions.ts                 # 查 PRIVATE_KEY 对应的地址；都没配时查最新仓位的持有者
 */
import type { Address } from 'viem'

import { getPositionView, NPM_ABI, type IPoolStateRaw } from '../src/index.js'

import { fmt, getWallet, print, sdk } from './config.js'

/** 只展示 tokenId 最大的若干个仓位，避免仓位很多的地址刷屏 */
const MAX_SHOWN = 10

/** 都没配置时，找最新铸造的仓位 NFT 的持有者做演示 */
async function latestPositionOwner(): Promise<Address> {
  const npm = { address: sdk.contracts.positionManager, abi: NPM_ABI } as const
  const total = await sdk.publicClient.readContract({ ...npm, functionName: 'totalSupply' })
  const tokenId = await sdk.publicClient.readContract({ ...npm, functionName: 'tokenByIndex', args: [total - 1n] })
  return sdk.publicClient.readContract({ ...npm, functionName: 'ownerOf', args: [tokenId] })
}

const owner =
  (process.env.OWNER as Address | undefined) ||
  (process.env.PRIVATE_KEY?.trim() ? getWallet().address : await latestPositionOwner())

// 1) 地址持有的仓位 tokenId（ERC-721 枚举）
const tokenIds = (await sdk.getPositionTokenIdListByOwner(owner)).sort((a, b) => (b > a ? 1 : -1)).slice(0, MAX_SHOWN)
console.log(`${owner} 共展示 ${tokenIds.length} 个仓位（最多 ${MAX_SHOWN} 个）`)
if (tokenIds.length === 0) process.exit(0)

// 2) 仓位状态 + 待领手续费（NPM.collect 的 staticcall 预演），一次 multicall 读完
const { positionStates, pendingFees } = await sdk.chain.getPositionStatesAndPendingFees({
  owner,
  positionStateOf: tokenIds,
  pendingFeesOf: tokenIds,
})

// 3) 仓位所在池子的状态与代币信息（同池只读一次）
const positions = tokenIds.map((id) => positionStates.get(id.toString())!)
const poolAddressOf = new Map<bigint, Address>()
const poolStates = new Map<Address, IPoolStateRaw>()
for (const position of positions) {
  const poolAddress = await sdk.chain.getPoolAddressByPosition(position)
  poolAddressOf.set(position.tokenId, poolAddress)
  if (!poolStates.has(poolAddress)) poolStates.set(poolAddress, await sdk.getRawPoolInfoByPoolAddress(poolAddress))
}
const tokenAddresses = [...new Set(positions.flatMap((p) => [p.token0, p.token1]))]
const tokens = new Map((await sdk.chain.getTokenInfoList(tokenAddresses)).map((t) => [t.address.toLowerCase(), t]))

for (const position of positions) {
  const poolAddress = poolAddressOf.get(position.tokenId)!
  const token0 = tokens.get(position.token0.toLowerCase())!
  const token1 = tokens.get(position.token1.toLowerCase())!
  // 4) 本地数学（0 RPC）：当前持仓量、价格区间、是否在区间内
  const view = getPositionView({ poolState: poolStates.get(poolAddress)!, positionState: position, token0, token1 })
  const fees = pendingFees.get(position.tokenId.toString())!

  print(`仓位 #${position.tokenId}（${token0.symbol}/${token1.symbol}）`, {
    poolAddress,
    priceRange: `${view.priceLower} ~ ${view.priceUpper} ${token1.symbol}/${token0.symbol}`,
    currentPrice: view.currentPrice,
    inRange: view.inRange,
    liquidity: view.liquidity,
    holdings: [fmt(view.amount0, token0), fmt(view.amount1, token1)],
    pendingFees: [fmt(fees.amount0, token0), fmt(fees.amount1, token1)],
  })
}
