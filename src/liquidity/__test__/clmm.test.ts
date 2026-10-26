import { describe, expect, it, vi } from 'vitest'
import { getAddress, type PublicClient } from 'viem'

import { ExtraFeeClass, TickMath } from '../../raw/index.js'
import { Chain } from '../../chain/index.js'
import type { IClmmContracts, IPoolStateRaw } from '../../types.js'
import { CLMMClient } from '../clmm.js'

const CONTRACTS: IClmmContracts = {
  factory: '0xa5864429c7a88853951F6Fa50baeF4685D374267',
  positionManager: '0x77704B29BE267ad9a7843fA5F799881ada21b9fa',
  quoter: '0x104dBC505227f705a74837D393d05A43AD22d036',
  weth: '0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8',
}

const TOKEN_0 = getAddress('0x0000000000000000000000000000000000000001')
const TOKEN_1 = getAddress('0x0000000000000000000000000000000000000002')
const USER = getAddress('0x1111111111111111111111111111111111111111')

const POOL_STATE: IPoolStateRaw = {
  poolAddress: getAddress('0xC6962004f452bE9203591991D15f6b388e09E8D0'),
  token0: TOKEN_0,
  token1: TOKEN_1,
  tickSpacing: 60,
  tradeFeeRate: 3000,
  protocolFeeRate: 10,
  pauseFlags: 0,
  swapOpenTime: 0,
  alphaExtraTradeFeeRate: 0,
  dexExtraTradeFeeRate: 0,
  dynamicFeeEnabled: false,
  sqrtPriceX96: BigInt(TickMath.getSqrtRatioAtTick(0).toString()),
  tick: 0,
  liquidity: 10n ** 18n,
  feeGrowthGlobal0X128: 0n,
  feeGrowthGlobal1X128: 0n,
}

const TOKENS = [
  { chainId: 5000, address: TOKEN_0, decimals: 18, symbol: 'TK0', name: 'Token 0' },
  { chainId: 5000, address: TOKEN_1, decimals: 18, symbol: 'TK1', name: 'Token 1' },
] as const

const createClient = () => {
  const chain = new Chain({
    publicClient: {} as PublicClient,
    chainId: 5000,
    contracts: CONTRACTS,
    extraFeeClass: ExtraFeeClass.DEX,
  })

  vi.spyOn(chain, 'getMintPrerequisites').mockResolvedValue({
    poolState: POOL_STATE,
    balance0: 0n,
    balance1: 0n,
    allowance0: 0n,
    allowance1: 0n,
  })
  vi.spyOn(chain, 'getTokenInfoList').mockResolvedValue([...TOKENS])

  return new CLMMClient({ chain })
}

const params = {
  poolAddress: POOL_STATE.poolAddress,
  userAddress: USER,
  tickLower: -120,
  tickUpper: 120,
  base: 'Token0' as const,
  baseAmount: 10n ** 18n,
}

describe('CLMMClient createPosition 余额校验', () => {
  it('真实开仓默认拒绝余额不足的钱包', async () => {
    await expect(createClient().createPosition(params)).rejects.toThrow(/余额不足/)
  })

  it('费用估算可跳过余额校验，并保留所需 approve 交易', async () => {
    const result = await createClient().createPosition({
      ...params,
      validateBalance: false,
    })

    expect(result.meta.approvals).toHaveLength(2)
    expect(result.transactions).toHaveLength(3)
  })
})
