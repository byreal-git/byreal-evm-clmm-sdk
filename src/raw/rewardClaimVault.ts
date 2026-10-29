import JSBI from './jsbi.js'
import invariant from 'tiny-invariant'
import { Interface, defaultAbiCoder } from '@ethersproject/abi'
import { keccak256 } from '@ethersproject/solidity'
import { BigintIsh, MaxUint256, validateAndParseAddress } from './core/index.js'
import { rewardClaimVaultAbi } from './abis/index.js'
import { MethodParameters, toHex } from './utils/calldata.js'

export const CLAIM_EIP712_DOMAIN_NAME = 'ByrealRewardClaimVault'
export const CLAIM_EIP712_DOMAIN_VERSION = '1'
export const CLAIM_TYPE_STRING =
  'Claim(address beneficiary,uint256 positionTokenId,address rewardToken,uint256 syncedAmount,uint256 ruleId,uint256 ruleType,uint256 epochTime,uint256 deadline)'
export interface Eip712Field {
  name: string
  type: string
}
export const CLAIM_TYPE_FIELDS: readonly Eip712Field[] = [
  { name: 'beneficiary', type: 'address' },
  { name: 'positionTokenId', type: 'uint256' },
  { name: 'rewardToken', type: 'address' },
  { name: 'syncedAmount', type: 'uint256' },
  { name: 'ruleId', type: 'uint256' },
  { name: 'ruleType', type: 'uint256' },
  { name: 'epochTime', type: 'uint256' },
  { name: 'deadline', type: 'uint256' }
]
/** The ledger is scoped to a position/token/rule, shared across beneficiaries. */
export interface RewardKey {
  positionTokenId: BigintIsh
  rewardToken: string
  ruleId: BigintIsh
  ruleType: BigintIsh
  epochTime: BigintIsh
}
export interface ClaimData extends RewardKey {
  beneficiary: string
  /** Cumulative entitlement in THIS vault, not the amount paid by this transaction. */
  syncedAmount: BigintIsh
  deadline: BigintIsh
}
export interface ClaimTypedDataDomain {
  name: string
  version: string
  chainId: number
  verifyingContract: string
}
export interface ClaimTypedDataMessage {
  beneficiary: string
  positionTokenId: string
  rewardToken: string
  syncedAmount: string
  ruleId: string
  ruleType: string
  epochTime: string
  deadline: string
}
export interface ClaimTypedData {
  domain: ClaimTypedDataDomain
  types: Record<string, Eip712Field[]>
  primaryType: 'Claim'
  message: ClaimTypedDataMessage
}
const SIGNATURE_REGEX = /^0x[0-9a-fA-F]{130}$/
const ZERO = JSBI.BigInt(0)
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
function uint(value: BigintIsh): JSBI {
  invariant(typeof value !== 'number' || Number.isSafeInteger(value), 'UINT256')
  const n = JSBI.BigInt(value)
  invariant(JSBI.greaterThanOrEqual(n, ZERO) && JSBI.lessThanOrEqual(n, MaxUint256), 'UINT256')
  return n
}
function address(value: string): string {
  const a = validateAndParseAddress(value)
  invariant(a !== ZERO_ADDRESS, 'BAD_INPUT')
  return a
}
function keyArgs(key: RewardKey): string[] {
  const id = uint(key.positionTokenId)
  invariant(JSBI.greaterThan(id, ZERO), 'BAD_INPUT')
  return [
    id.toString(),
    address(key.rewardToken),
    uint(key.ruleId).toString(),
    uint(key.ruleType).toString(),
    uint(key.epochTime).toString()
  ]
}
function message(data: ClaimData): ClaimTypedDataMessage {
  const [positionTokenId, rewardToken, ruleId, ruleType, epochTime] = keyArgs(data)
  const syncedAmount = uint(data.syncedAmount)
  invariant(JSBI.greaterThan(syncedAmount, ZERO), 'BAD_INPUT')
  return {
    beneficiary: address(data.beneficiary),
    positionTokenId,
    rewardToken,
    syncedAmount: syncedAmount.toString(),
    ruleId,
    ruleType,
    epochTime,
    deadline: uint(data.deadline).toString()
  }
}
/**
 * ByrealRewardClaimVault calldata builder (user side only).
 *
 * Vouchers are signed off-chain by a `REWARD_CLAIM_ADMIN_ROLE` signer; the beneficiary's wallet sends the claim.
 * The vault's admin entry points (`withdraw` / `setWithdrawRecipient` / `pause`) are intentionally not wrapped here.
 */
export abstract class RewardClaimVault {
  public static INTERFACE = new Interface(rewardClaimVaultAbi)
  private constructor() {}
  private static parameters(name: string, args: unknown[]): MethodParameters {
    return { calldata: this.INTERFACE.encodeFunctionData(name, args), value: toHex(0) }
  }
  public static getClaimTypedData(chainId: number, vaultAddress: string, claim: ClaimData): ClaimTypedData {
    invariant(Number.isSafeInteger(chainId) && chainId > 0, 'CHAIN_ID')
    return {
      domain: {
        name: CLAIM_EIP712_DOMAIN_NAME,
        version: CLAIM_EIP712_DOMAIN_VERSION,
        chainId,
        verifyingContract: address(vaultAddress)
      },
      types: { Claim: CLAIM_TYPE_FIELDS.map(f => ({ ...f })) },
      primaryType: 'Claim',
      message: message(claim)
    }
  }
  public static claimCallParameters(claim: ClaimData, signature: string): MethodParameters {
    invariant(SIGNATURE_REGEX.test(signature), 'SIGNATURE')
    return this.parameters('claim', [message(claim), signature])
  }
  /** Atomic batch. One caller must be the beneficiary of every voucher. */
  public static claimBatchCallParameters(claims: readonly ClaimData[], signatures: readonly string[]): MethodParameters {
    invariant(claims.length === signatures.length, 'LEN')
    invariant(claims.length > 0, 'EMPTY')
    signatures.forEach(s => invariant(SIGNATURE_REGEX.test(s), 'SIGNATURE'))
    const messages = claims.map(message)
    invariant(
      messages.every(m => m.beneficiary === messages[0].beneficiary),
      'NOT_BENEFICIARY'
    )
    return this.parameters('claimBatch', [messages, [...signatures]])
  }
  public static claimedAmountCallParameters(key: RewardKey): MethodParameters {
    return this.parameters('claimedAmount', keyArgs(key))
  }
  /** keccak256(abi.encode(ruleId, ruleType, epochTime)), matching the on-chain ledger/event. */
  public static rewardInfoHash(ruleId: BigintIsh, ruleType: BigintIsh, epochTime: BigintIsh): string {
    return keccak256(
      ['bytes'],
      [
        defaultAbiCoder.encode(
          ['uint256', 'uint256', 'uint256'],
          [ruleId, ruleType, epochTime].map(v => uint(v).toString())
        )
      ]
    )
  }
  /** Display estimate; actual settlement uses the ledger at transaction execution. */
  public static claimableAmount(syncedAmount: BigintIsh, claimedAmount: BigintIsh): JSBI {
    const synced = uint(syncedAmount),
      claimed = uint(claimedAmount)
    return JSBI.greaterThan(synced, claimed) ? JSBI.subtract(synced, claimed) : ZERO
  }
}
