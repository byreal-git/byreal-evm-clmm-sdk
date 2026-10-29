/**
 * RewardClient：本地按合约规则预演账本，再拼 claim / claimBatch。
 * publicClient 只应答前置读那一轮 multicall（paused + claimedAmount × N + balanceOf × M），0 真实 RPC。
 */
import { describe, expect, it } from 'vitest'
import { decodeFunctionData, getAddress, type Address, type Hex, type PublicClient } from 'viem'

import { REWARD_CLAIM_VAULT_ABI } from '../abis.js'
import { Chain } from '../chain/index.js'
import { ExtraFeeClass } from '../raw/index.js'
import type { IClmmContracts, IRewardClaim, ISignedRewardClaim } from '../types.js'
import { RewardClient } from './index.js'

const VAULT = getAddress('0xcD8Ef447b678Dd5aCE1e6BECf578748aD28d605f')
const CONTRACTS: IClmmContracts = {
  factory: '0xa5864429c7a88853951F6Fa50baeF4685D374267',
  positionManager: '0x77704B29BE267ad9a7843fA5F799881ada21b9fa',
  quoter: '0x104dBC505227f705a74837D393d05A43AD22d036',
  weth: '0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8',
  rewardClaimVault: VAULT,
}
const USER = getAddress('0x3333333333333333333333333333333333333333')
const TOKEN_A = getAddress('0x2222222222222222222222222222222222222222')
const TOKEN_B = getAddress('0x4444444444444444444444444444444444444444')
const SIG = `0x${'ab'.repeat(64)}1b` as Hex
const FUTURE = BigInt(Math.floor(Date.now() / 1000) + 3600)

const claim = (overrides: Partial<IRewardClaim> = {}): ISignedRewardClaim => ({
  claim: {
    beneficiary: USER,
    positionTokenId: 42n,
    rewardToken: TOKEN_A,
    syncedAmount: 1500n,
    ruleId: 1n,
    ruleType: 2n,
    epochTime: 1720000000n,
    deadline: FUTURE,
    ...overrides,
  },
  signature: SIG,
})

type Call = { address: Address; functionName: string; args?: readonly unknown[] }

/** 账本按 positionTokenId 查，余额按代币查；记录每轮 multicall 的调用列表 */
function setup(opts: { claimed?: Record<string, bigint>; balances?: Record<string, bigint>; paused?: boolean; contracts?: IClmmContracts } = {}) {
  const { claimed = {}, balances = {}, paused = false, contracts = CONTRACTS } = opts
  const rounds: Call[][] = []
  const publicClient = {
    async multicall(params: { contracts: readonly Call[] }) {
      rounds.push([...params.contracts])
      return params.contracts.map((c) => {
        if (c.functionName === 'paused') return paused
        if (c.functionName === 'claimedAmount') return claimed[String(c.args![0])] ?? 0n
        if (c.functionName === 'balanceOf') return balances[c.address] ?? 10n ** 24n
        throw new Error(`[reward.test] 不该发生的调用：${c.functionName}`)
      })
    },
  } as unknown as PublicClient
  const chain = new Chain({ publicClient, chainId: 5000, contracts, extraFeeClass: ExtraFeeClass.DEX })
  return { client: new RewardClient({ chain }), chain, rounds }
}

describe('RewardClient.claimRewards', () => {
  it('单张凭证：发往金库的 claim，到账额 = syncedAmount − 账本', async () => {
    const { client, rounds } = setup({ claimed: { '42': 500n } })
    const { transactions, main, meta } = await client.claimRewards({ userAddress: USER, claims: [claim()] })

    expect(transactions).toEqual([main])
    expect(main.to).toBe(VAULT)
    expect(main.value).toBe(0n)
    const decoded = decodeFunctionData({ abi: REWARD_CLAIM_VAULT_ABI, data: main.data })
    expect(decoded.functionName).toBe('claim')
    expect(decoded.args).toEqual([claim().claim, SIG])

    expect(meta.items[0]).toMatchObject({ claimedAmount: 500n, claimableAmount: 1000n })
    expect(meta.totals).toEqual([{ rewardToken: TOKEN_A, amount: 1000n }])
    expect(rounds).toHaveLength(1)
    expect(rounds[0].map((c) => c.functionName)).toEqual(['paused', 'claimedAmount', 'balanceOf'])
  })

  it('多张凭证走 claimBatch；同一账本键按 syncedAmount 递增逐张结算，账本只读一次', async () => {
    const { client, rounds } = setup({ claimed: { '42': 100n } })
    const claims = [
      claim({ syncedAmount: 300n }),
      claim({ syncedAmount: 700n }),
      claim({ positionTokenId: 43n, rewardToken: TOKEN_B, syncedAmount: 50n }),
    ]
    const { main, meta } = await client.claimRewards({ userAddress: USER, claims })

    const decoded = decodeFunctionData({ abi: REWARD_CLAIM_VAULT_ABI, data: main.data })
    expect(decoded.functionName).toBe('claimBatch')
    expect(decoded.args[0]).toHaveLength(3)
    expect(meta.items.map((i) => [i.claimedAmount, i.claimableAmount])).toEqual([
      [100n, 200n],
      [300n, 400n],
      [0n, 50n],
    ])
    expect(meta.totals).toEqual([
      { rewardToken: TOKEN_A, amount: 600n },
      { rewardToken: TOKEN_B, amount: 50n },
    ])
    // 2 个去重后的账本键 + 2 种代币余额
    expect(rounds[0].map((c) => c.functionName)).toEqual(['paused', 'claimedAmount', 'claimedAmount', 'balanceOf', 'balanceOf'])
  })

  it('凭证已领过 / 已过时 / 同键未递增都提前报错', async () => {
    const { client } = setup({ claimed: { '42': 1500n } })
    await expect(client.claimRewards({ userAddress: USER, claims: [claim()] })).rejects.toThrow(/已经领过/)
    await expect(client.claimRewards({ userAddress: USER, claims: [claim({ syncedAmount: 1000n })] })).rejects.toThrow(
      /已过时/,
    )
    const fresh = setup()
    await expect(
      fresh.client.claimRewards({ userAddress: USER, claims: [claim({ syncedAmount: 700n }), claim({ syncedAmount: 300n })] }),
    ).rejects.toThrow(/严格递增/)
  })

  it('受益人不是发交易的钱包、凭证过期、签名形状不对时不读链直接报错', async () => {
    const { client, rounds } = setup()
    const other = getAddress('0x5555555555555555555555555555555555555555')
    await expect(client.claimRewards({ userAddress: other, claims: [claim()] })).rejects.toThrow(/受益人/)
    await expect(client.claimRewards({ userAddress: USER, claims: [claim({ deadline: 1n })] })).rejects.toThrow(/已过期/)
    await expect(
      client.claimRewards({ userAddress: USER, claims: [{ ...claim(), signature: '0x1234' }] }),
    ).rejects.toThrow(/65 字节/)
    await expect(client.claimRewards({ userAddress: USER, claims: [claim({ syncedAmount: 0n })] })).rejects.toThrow(
      /必须大于 0/,
    )
    await expect(client.claimRewards({ userAddress: USER, claims: [] })).rejects.toThrow(/不能为空/)
    expect(rounds).toHaveLength(0)
  })

  it('金库暂停或余额不够付时报错', async () => {
    await expect(setup({ paused: true }).client.claimRewards({ userAddress: USER, claims: [claim()] })).rejects.toThrow(
      /已暂停/,
    )
    await expect(
      setup({ balances: { [TOKEN_A]: 1499n } }).client.claimRewards({ userAddress: USER, claims: [claim()] }),
    ).rejects.toThrow(/余额不足/)
  })

  it('未配置金库（或仍是零地址占位）时报错', async () => {
    const zero = '0x0000000000000000000000000000000000000000'
    for (const rewardClaimVault of [undefined, zero] as const) {
      const { client } = setup({ contracts: { ...CONTRACTS, rewardClaimVault } })
      await expect(client.claimRewards({ userAddress: USER, claims: [claim()] })).rejects.toThrow(/未配置奖励金库/)
    }
  })
})

describe('Chain.getRewardClaimedAmountList', () => {
  it('与 keys 一一对应；空列表 0 次读链', async () => {
    const { chain, rounds } = setup({ claimed: { '42': 7n, '43': 9n } })
    expect(await chain.getRewardClaimedAmountList([])).toEqual([])
    expect(rounds).toHaveLength(0)
    const keys = [claim().claim, claim({ positionTokenId: 43n }).claim]
    expect(await chain.getRewardClaimedAmountList(keys)).toEqual([7n, 9n])
    expect(rounds[0][0]).toMatchObject({ address: VAULT, functionName: 'claimedAmount', args: [42n, TOKEN_A, 1n, 2n, 1720000000n] })
  })
})
