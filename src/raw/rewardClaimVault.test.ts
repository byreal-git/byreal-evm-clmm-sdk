import { encodeAbiParameters, encodeFunctionData, hashTypedData as viemHashTypedData, keccak256, parseAbi } from 'viem'
import { rewardClaimVaultAbi } from './abis/index.js'
import { CLAIM_TYPE_STRING, ClaimData, RewardClaimVault } from './rewardClaimVault.js'

const vault = '0x1111111111111111111111111111111111111111'
const token = '0x2222222222222222222222222222222222222222'
const user = '0x3333333333333333333333333333333333333333'
const signature = `0x${'ab'.repeat(64)}1b` as const
const data: ClaimData = {
  beneficiary: user,
  positionTokenId: '42',
  rewardToken: token,
  syncedAmount: '1500',
  ruleId: '1',
  ruleType: '2',
  epochTime: '1720000000',
  deadline: '1893456000'
}
const wire = {
  beneficiary: user,
  rewardToken: token,
  positionTokenId: 42n,
  syncedAmount: 1500n,
  ruleId: 1n,
  ruleType: 2n,
  epochTime: 1720000000n,
  deadline: 1893456000n
} as const
const hashTypedData = (value: ReturnType<typeof RewardClaimVault.getClaimTypedData>) =>
  viemHashTypedData(value as never)
// Independent, explicit Solidity schema: a stale generated ABI must not make this check pass.
const abi = parseAbi([
  'function claim((address beneficiary,uint256 positionTokenId,address rewardToken,uint256 syncedAmount,uint256 ruleId,uint256 ruleType,uint256 epochTime,uint256 deadline) data,bytes signature)'
])

describe('RewardClaimVault', () => {
  it('matches the independently encoded Solidity claim schema', () => {
    expect(RewardClaimVault.claimCallParameters(data, signature).calldata).toBe(
      encodeFunctionData({ abi, functionName: 'claim', args: [wire, signature] })
    )
    expect(RewardClaimVault.claimCallParameters(data, signature).value).toBe('0x00')
    expect(CLAIM_TYPE_STRING).toBe(
      'Claim(address beneficiary,uint256 positionTokenId,address rewardToken,uint256 syncedAmount,uint256 ruleId,uint256 ruleType,uint256 epochTime,uint256 deadline)'
    )
  })

  it('binds every field, the chain and the vault into the signature digest', () => {
    const digest = hashTypedData(RewardClaimVault.getClaimTypedData(5000, vault, data))
    for (const key of ['positionTokenId', 'syncedAmount', 'ruleId', 'ruleType', 'epochTime', 'deadline'] as const)
      expect(hashTypedData(RewardClaimVault.getClaimTypedData(5000, vault, { ...data, [key]: '9' }))).not.toBe(digest)
    expect(hashTypedData(RewardClaimVault.getClaimTypedData(5001, vault, data))).not.toBe(digest)
    expect(hashTypedData(RewardClaimVault.getClaimTypedData(5000, user, data))).not.toBe(digest)
    expect(hashTypedData(RewardClaimVault.getClaimTypedData(5000, vault, { ...data, beneficiary: vault }))).not.toBe(
      digest
    )
    expect(hashTypedData(RewardClaimVault.getClaimTypedData(5000, vault, { ...data, rewardToken: vault }))).not.toBe(
      digest
    )
  })

  it('encodes atomic batches and five-dimensional ledger queries', () => {
    expect(RewardClaimVault.claimBatchCallParameters([data, data], [signature, signature]).calldata).toBe(
      encodeFunctionData({
        abi: rewardClaimVaultAbi,
        functionName: 'claimBatch',
        args: [
          [wire, wire],
          [signature, signature]
        ]
      })
    )
    expect(RewardClaimVault.claimedAmountCallParameters(data).calldata).toBe(
      encodeFunctionData({
        abi: rewardClaimVaultAbi,
        functionName: 'claimedAmount',
        args: [42n, token, 1n, 2n, 1720000000n]
      })
    )
  })

  it('hashes rule dimensions and calculates the payable difference', () => {
    expect(RewardClaimVault.rewardInfoHash(1, 2, 3)).toBe(
      keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1n, 2n, 3n]))
    )
    expect(RewardClaimVault.claimableAmount(150, 100).toString()).toBe('50')
    expect(RewardClaimVault.claimableAmount(100, 150).toString()).toBe('0')
    expect(RewardClaimVault.claimableAmount(100, 100).toString()).toBe('0')
  })

  it('rejects unclaimable input, oversized integers and unsafe JS numbers', () => {
    for (const k of ['positionTokenId', 'syncedAmount', 'ruleId', 'ruleType', 'epochTime', 'deadline'] as const)
      for (const v of ['-1', (2n ** 256n).toString(), Number.MAX_SAFE_INTEGER + 1])
        expect(() => RewardClaimVault.claimCallParameters({ ...data, [k]: v }, signature)).toThrow()
    for (const k of ['positionTokenId', 'syncedAmount'] as const)
      expect(() => RewardClaimVault.claimCallParameters({ ...data, [k]: 0 }, signature)).toThrow('BAD_INPUT')
    for (const sig of ['0x', '0x' + 'ab'.repeat(64), signature + '00'])
      expect(() => RewardClaimVault.claimCallParameters(data, sig)).toThrow('SIGNATURE')
    expect(() => RewardClaimVault.claimBatchCallParameters([], [])).toThrow('EMPTY')
    expect(() => RewardClaimVault.claimBatchCallParameters([data], [])).toThrow('LEN')
    expect(() =>
      RewardClaimVault.claimBatchCallParameters([data, { ...data, beneficiary: vault }], [signature, signature])
    ).toThrow('NOT_BENEFICIARY')
    expect(() =>
      RewardClaimVault.claimCallParameters(
        { ...data, ruleId: 0, ruleType: 0, epochTime: 0, deadline: (2n ** 256n - 1n).toString() },
        signature
      )
    ).not.toThrow()
  })
})
