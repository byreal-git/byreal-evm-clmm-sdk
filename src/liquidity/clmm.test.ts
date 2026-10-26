/**
 * mint calldata 的回归测试：定制合约的 mint 结构体
 * 第 3 项是 tickSpacing、尾部带 followTokenId，选择器随签名变为 0xda28d63d。
 * 用「快照注入 + autoApprove:false」的 0-RPC 路径拼真 calldata，再用 viem 反解逐字段核对。
 */
import { describe, expect, it } from 'vitest'
import { decodeFunctionData, getAddress, type PublicClient } from 'viem'

import { ExtraFeeClass, TickMath } from '../raw/index.js'
import { NPM_ABI } from '../abis.js'
import { Chain } from '../chain/index.js'
import type { IClmmContracts, IPoolStateRaw } from '../types.js'
import { CLMMClient } from './clmm.js'

const CONTRACTS: IClmmContracts = {
  factory: '0xa5864429c7a88853951F6Fa50baeF4685D374267',
  positionManager: '0x77704B29BE267ad9a7843fA5F799881ada21b9fa',
  quoter: '0x104dBC505227f705a74837D393d05A43AD22d036',
  weth: '0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8',
}

const TOKEN_A = getAddress('0x0000000000000000000000000000000000000001')
const TOKEN_B = getAddress('0x0000000000000000000000000000000000000002')
const USER = getAddress('0x1111111111111111111111111111111111111111')

/** tick=0 时的精确 sqrtPriceX96，保证 toUniPool 的自洽性断言通过 */
const SQRT_AT_0 = BigInt(TickMath.getSqrtRatioAtTick(0).toString())

const POOL_STATE: IPoolStateRaw = {
  poolAddress: getAddress('0xC6962004f452bE9203591991D15f6b388e09E8D0'),
  token0: TOKEN_A,
  token1: TOKEN_B,
  tickSpacing: 60,
  tradeFeeRate: 3000,
  protocolFeeRate: 10,
  pauseFlags: 0,
  swapOpenTime: 0,
  alphaExtraTradeFeeRate: 0,
  dexExtraTradeFeeRate: 0,
  dynamicFeeEnabled: false,
  sqrtPriceX96: SQRT_AT_0,
  tick: 0,
  liquidity: 10n ** 18n,
  feeGrowthGlobal0X128: 0n,
  feeGrowthGlobal1X128: 0n,
}

/** 只应答 token 元数据那一次 multicall 的 publicClient（其余调用一律炸出可读错误） */
function makeClient(): PublicClient {
  return {
    async multicall(params: { contracts: ReadonlyArray<{ functionName: string }>; allowFailure?: boolean }) {
      const names = params.contracts.map((c) => c.functionName).join('+')
      if (names !== 'decimals+symbol+name+decimals+symbol+name') {
        throw new Error(`[clmm.test] 不该发生的 multicall：${names}`)
      }
      const meta = [18, 'TKA', 'Token A', 6, 'TKB', 'Token B']
      return meta.map((result) => ({ status: 'success', result }))
    },
  } as unknown as PublicClient
}

describe('createPosition：定制合约 mint 结构体', () => {
  async function buildMint(followTokenId?: bigint) {
    const chain = new Chain({ publicClient: makeClient(), chainId: 5000, contracts: CONTRACTS, extraFeeClass: ExtraFeeClass.DEX })
    const client = new CLMMClient({ chain })
    return client.createPosition({
      poolAddress: POOL_STATE.poolAddress,
      userAddress: USER,
      tickLower: -120,
      tickUpper: 120,
      base: 'Token0',
      baseAmount: 10n ** 18n,
      ...(followTokenId === undefined ? {} : { followTokenId }),
      autoApprove: false, // 与 poolState 一起构成 0-RPC 的 offline 分支（token 元数据仍走 mock multicall）
      poolState: POOL_STATE,
    })
  }

  it('选择器为 0xda28d63d，第 3 项是 tickSpacing，followTokenId 缺省 0', async () => {
    const { main } = await buildMint()
    expect(main.to).toBe(CONTRACTS.positionManager)
    expect(main.data.slice(0, 10)).toBe('0xda28d63d')

    const decoded = decodeFunctionData({ abi: NPM_ABI, data: main.data })
    expect(decoded.functionName).toBe('mint')
    const p = decoded.args![0] as {
      token0: string
      token1: string
      tickSpacing: number
      tickLower: number
      tickUpper: number
      recipient: string
      followTokenId: bigint
    }
    expect(p.token0).toBe(TOKEN_A)
    expect(p.token1).toBe(TOKEN_B)
    expect(p.tickSpacing).toBe(60)
    expect(p.tickLower).toBe(-120)
    expect(p.tickUpper).toBe(120)
    expect(p.recipient).toBe(USER)
    expect(p.followTokenId).toBe(0n)
  })

  it('非零 followTokenId 原样进入 calldata', async () => {
    const { main } = await buildMint(7n)
    const decoded = decodeFunctionData({ abi: NPM_ABI, data: main.data })
    expect((decoded.args![0] as { followTokenId: bigint }).followTokenId).toBe(7n)
  })
})
