/**
 * 奖励领取（`sdk.rewardClient.*`）：只产出未签名的 claim 交易，凭证由 Byreal 后端签发。
 * 与流动性写操作同一套四步：「前置读 fresh 账本 → 本地按合约规则结算 → 拼 calldata → 返回未签名交易」。
 *
 * 奖励与 NPM 的 `collect` 无关：collect 领的是仓位手续费，奖励从独立的 ByrealRewardClaimVault 领。
 * 接入约束见 docs/core.md「奖励领取」。
 */
import { encodeFunctionData, getAddress, type Address } from 'viem'

import { REWARD_CLAIM_VAULT_ABI } from '../abis.js'
import type { Chain } from '../chain/index.js'
import type { IClaimRewardsMeta, IClaimRewardsParams, IRewardClaim, IRewardKey, ITransactionReturn } from '../types.js'

const SIGNATURE_REGEX = /^0x[0-9a-fA-F]{130}$/
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

export class RewardClient {
  /** 链上直读层：账本、暂停状态、金库余额都从这里读 */
  protected _chain: Chain

  constructor(params: { chain: Chain }) {
    this._chain = params.chain
  }

  /**
   * 领取奖励：1 张凭证走 `claim`，多张走 `claimBatch`（原子，任一张失败整批回滚）。
   *
   * RPC：**1 次 multicall**（暂停状态 + 每个账本键的 `claimedAmount` + 金库对每种奖励代币的余额）。
   * 产出交易：**1 笔**，发往金库 proxy，value 恒为 0；不需要 approve，金库从自身余额付款。
   *
   * 本地按合约 `_claim` / `_settle` 的规则逐张预演，能提前拦下的都在这里报错：
   * 受益人不是 userAddress、凭证过期（按本机时钟）、累计额没有超过账本（已领过 / 凭证过时）、
   * 金库暂停、金库余额不够付。**签名是否有效、签发者是否仍有权限只有链上能判断**，
   * 发送前的 gas 估算会以 `BAD_SIGNER` revert 暴露出来。
   */
  async claimRewards(params: IClaimRewardsParams): Promise<ITransactionReturn<IClaimRewardsMeta>> {
    const { userAddress, claims } = params
    if (claims.length === 0) {
      throw new Error('[evm-clmm-sdk] claims 不能为空。')
    }

    // —— ① 本地校验：只依赖凭证本身的规则（对应合约 _claim 的第 1~3 步）——
    const now = BigInt(Math.floor(Date.now() / 1000))
    claims.forEach(({ claim, signature }, i) => {
      const where = `第 ${i + 1} 张凭证（仓位 #${claim.positionTokenId}，奖励代币 ${claim.rewardToken}）`
      if (!SIGNATURE_REGEX.test(signature)) {
        throw new Error(`[evm-clmm-sdk] ${where}的签名不是 65 字节的十六进制串：${signature}`)
      }
      if (getAddress(claim.beneficiary) !== getAddress(userAddress)) {
        throw new Error(
          `[evm-clmm-sdk] ${where}的受益人是 ${claim.beneficiary}，与发交易的钱包 ${userAddress} 不一致；` +
            '合约只允许受益人本人领取，请切换钱包。',
        )
      }
      if (claim.positionTokenId <= 0n || claim.syncedAmount <= 0n || getAddress(claim.rewardToken) === ZERO_ADDRESS) {
        throw new Error(`[evm-clmm-sdk] ${where}无效：positionTokenId、syncedAmount 必须大于 0，rewardToken 不能是零地址。`)
      }
      if (claim.deadline < now) {
        throw new Error(
          `[evm-clmm-sdk] ${where}已过期（deadline=${claim.deadline}，当前 ${now}），请向签发服务重新获取凭证。`,
        )
      }
    })

    // —— ② 前置读：一次 multicall 拿齐账本、暂停状态与金库余额 ——
    const keyIds = [...new Set(claims.map(({ claim }) => rewardKeyId(claim)))]
    const keyById = new Map(claims.map(({ claim }) => [rewardKeyId(claim), claim]))
    const rewardTokens = [...new Set(claims.map(({ claim }) => getAddress(claim.rewardToken)))]
    const pre = await this._chain.getRewardClaimPrerequisites({
      keys: keyIds.map((id) => keyById.get(id)!),
      rewardTokens,
    })
    if (pre.paused) {
      throw new Error(`[evm-clmm-sdk] 奖励金库 ${pre.vault} 已暂停领取，请稍后再试。`)
    }

    // —— ③ 本地按合约 _settle 逐张结算：到账额 = syncedAmount − 账本，结算后账本推进到 syncedAmount ——
    const ledger = new Map(keyIds.map((id, i) => [id, pre.claimedAmounts[i]]))
    const totals = new Map<Address, bigint>(rewardTokens.map((token) => [token, 0n]))
    const items = claims.map(({ claim }, i) => {
      const id = rewardKeyId(claim)
      const claimedAmount = ledger.get(id)!
      if (claim.syncedAmount <= claimedAmount) {
        throw new Error(
          `[evm-clmm-sdk] 第 ${i + 1} 张凭证没有可领额度（仓位 #${claim.positionTokenId}）：` +
            `凭证累计额 ${claim.syncedAmount}，账本已领 ${claimedAmount}。` +
            (claim.syncedAmount === claimedAmount
              ? '这张凭证已经领过。'
              : '凭证已过时（链上已按更高的累计额结算过），请刷新凭证。') +
            (claims.length > 1 ? '同一账本键的多张凭证须按 syncedAmount 严格递增排列。' : ''),
        )
      }
      const claimableAmount = claim.syncedAmount - claimedAmount
      ledger.set(id, claim.syncedAmount)
      const token = getAddress(claim.rewardToken)
      totals.set(token, totals.get(token)! + claimableAmount)
      return { claim, claimedAmount, claimableAmount }
    })

    rewardTokens.forEach((token, i) => {
      const need = totals.get(token)!
      const balance = pre.vaultBalances[i]
      if (balance < need) {
        throw new Error(
          `[evm-clmm-sdk] 奖励金库 ${pre.vault} 的 ${token} 余额不足：本次需要 ${need}，金库只有 ${balance}` +
            `（最小单位）。请联系 Byreal 补充奖励资金后再领。`,
        )
      }
    })

    // —— ④ 拼 calldata ——
    const wire = claims.map(({ claim }) => toClaimData(claim))
    const signatures = claims.map(({ signature }) => signature)
    const data =
      claims.length === 1
        ? encodeFunctionData({ abi: REWARD_CLAIM_VAULT_ABI, functionName: 'claim', args: [wire[0], signatures[0]] })
        : encodeFunctionData({ abi: REWARD_CLAIM_VAULT_ABI, functionName: 'claimBatch', args: [wire, signatures] })

    const main = {
      to: pre.vault,
      data,
      value: 0n,
      chainId: this._chain.chainId,
      label:
        claims.length === 1
          ? `领取奖励（仓位 #${claims[0].claim.positionTokenId}，${items[0].claimableAmount} 最小单位的 ${rewardTokens[0]}）`
          : `批量领取 ${claims.length} 张奖励凭证（claimBatch，原子执行）`,
    }
    return {
      transactions: [main],
      main,
      meta: {
        vault: pre.vault,
        items,
        totals: rewardTokens.map((rewardToken) => ({ rewardToken, amount: totals.get(rewardToken)! })),
      },
    }
  }
}

/** 账本键的去重 id（地址统一小写，数值统一十进制） */
function rewardKeyId(key: IRewardKey): string {
  return [key.positionTokenId, key.rewardToken.toLowerCase(), key.ruleId, key.ruleType, key.epochTime].join('-')
}

/** 只取合约 ClaimData 的 8 个字段，避免调用方对象上的多余属性干扰编码 */
function toClaimData(claim: IRewardClaim) {
  return {
    beneficiary: claim.beneficiary,
    positionTokenId: claim.positionTokenId,
    rewardToken: claim.rewardToken,
    syncedAmount: claim.syncedAmount,
    ruleId: claim.ruleId,
    ruleType: claim.ruleType,
    epochTime: claim.epochTime,
    deadline: claim.deadline,
  }
}
