/**
 * examples 共用配置：SDK 实例、演示池、钱包与「逐笔发送」工具。
 *
 * 环境变量从仓库根目录的 `.env` 读取（复制 `.env.example` 后填写）：
 * - `PRIVATE_KEY`：写操作示例（03 ~ 08）必填，会真实发送交易上链；
 * - `MANTLE_RPC_URL`：可选，覆盖内置 RPC；
 * - `OWNER`：可选，02 示例要查询的地址（默认取私钥对应地址）；
 * - `TOKEN_ID`：可选，04 ~ 07 要操作的仓位（默认取钱包在演示池里最新的仓位）。
 */
import { existsSync } from 'node:fs'

import { createWalletClient, formatUnits, http, type Address, type Hex, type TransactionReceipt } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mantle } from 'viem/chains'

import { ERC20_ABI, EvmClmmSdk, MANTLE_CHAIN_ID, type ITokenInfo, type IUnsignedTx } from '../src/index.js'

const envFile = new URL('../.env', import.meta.url)
if (existsSync(envFile)) process.loadEnvFile(envFile)

/** USDC（Mantle） */
export const USDC: Address = '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9'
/** TV2D（测试环境专用代币，18 位小数；可用 08_swap 把 USDC 换成 TV2D） */
export const TV2D: Address = '0xF4eeF33D503D0cE642D8c0446EdDcf303944FD7c'
/** 测试环境 USDC/TV2D 池的 tickSpacing（池身份键第三元） */
export const TICK_SPACING = 1

/** 示例连测试环境；生产合约上线后不传 profileId 即为生产 */
export const sdk = new EvmClmmSdk({
  chainId: MANTLE_CHAIN_ID,
  profileId: 'test',
  rpcUrl: process.env.MANTLE_RPC_URL || undefined,
})

/** 演示池地址与两边代币（token0 = USDC，token1 = TV2D） */
export async function loadDemoPool() {
  const poolAddress = await sdk.chain.getPoolAddress({ tokenA: USDC, tokenB: TV2D, tickSpacing: TICK_SPACING })
  const poolState = await sdk.getRawPoolInfoByPoolAddress(poolAddress)
  const [token0, token1] = await sdk.chain.getTokenInfoList([poolState.token0, poolState.token1])
  return { poolAddress, poolState, token0, token1 }
}

/** 私钥对应的钱包。写操作示例才需要 */
export function getWallet() {
  const pk = process.env.PRIVATE_KEY?.trim()
  if (!pk) {
    throw new Error(
      '写操作示例需要私钥：复制 .env.example 为 .env 并填写 PRIVATE_KEY。' +
        '钱包需要少量 MNT（gas）和 USDC；开仓还需要 TV2D，可先运行 08_swap.ts 换一点。',
    )
  }
  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as Hex)
  const walletClient = createWalletClient({ account, chain: mantle, transport: http(sdk.chainConfig.rpcUrl) })
  return { address: account.address, walletClient }
}

/** SDK 返回的未签名交易必须按顺序发送，并逐笔等回执（后一笔可能依赖前一笔的 approve） */
export async function sendTransactions(
  wallet: ReturnType<typeof getWallet>,
  transactions: IUnsignedTx[],
): Promise<TransactionReceipt[]> {
  const receipts: TransactionReceipt[] = []
  for (const [i, tx] of transactions.entries()) {
    console.log(`\n[${i + 1}/${transactions.length}] ${tx.label}`)
    const hash = await wallet.walletClient.sendTransaction({ to: tx.to, data: tx.data, value: tx.value })
    console.log(`  ${sdk.chainConfig.explorer}/tx/${hash}`)
    const receipt = await sdk.publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`交易执行失败：${hash}`)
    receipts.push(receipt)
  }
  return receipts
}

/**
 * 要操作的仓位：优先用 `TOKEN_ID`，否则取 owner 在演示池里 tokenId 最大（最新）的仓位。
 * 03 开仓后直接跑 04 ~ 07 即可，不用手动抄 tokenId。
 */
export async function resolveTokenId(owner: Address): Promise<bigint> {
  if (process.env.TOKEN_ID) return BigInt(process.env.TOKEN_ID)
  const positions = await sdk.chain.getRawPositionInfoListByOwner(owner)
  const inDemoPool = positions.filter(
    (p) =>
      p.token0.toLowerCase() === USDC.toLowerCase() &&
      p.token1.toLowerCase() === TV2D.toLowerCase() &&
      p.tickSpacing === TICK_SPACING,
  )
  if (inDemoPool.length === 0) throw new Error(`${owner} 在演示池里没有仓位，请先运行 03_create_position.ts`)
  const latest = inDemoPool.reduce((a, b) => (b.tokenId > a.tokenId ? b : a))
  console.log(`操作仓位 #${latest.tokenId}（可通过 TOKEN_ID 指定）`)
  return latest.tokenId
}

/** 打印地址的 MNT / USDC / TV2D 余额，方便对比交易前后的变化 */
export async function printBalances(owner: Address, label = '钱包余额'): Promise<void> {
  const [mnt, ...erc20] = await Promise.all([
    sdk.publicClient.getBalance({ address: owner }),
    ...[USDC, TV2D].map((token) =>
      sdk.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }),
    ),
  ])
  const tokens = await sdk.chain.getTokenInfoList([USDC, TV2D])
  console.log(`\n=== ${label}（${owner}）`)
  console.log(`  ${formatUnits(mnt, 18)} MNT`)
  tokens.forEach((token, i) => console.log(`  ${fmt(erc20[i], token)}`))
}

/** 最小单位 → 展示值，例如 `1.5 USDC` */
export function fmt(amount: bigint, token: ITokenInfo): string {
  return `${formatUnits(amount, token.decimals)} ${token.symbol}`
}

/** bigint 友好的 JSON 打印 */
export function print(label: string, value: unknown): void {
  console.log(
    `\n=== ${label}\n` + JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  )
}
