# 核心 SDK 参考

## 目录

- [入口](#入口)
- [部署环境](#部署环境)
- [协议差异](#协议差异)
- [状态与单位](#状态与单位)
- [交易与报价](#交易与报价)
- [原生币（MNT）](#原生币mnt)
- [奖励领取](#奖励领取)

## 入口

| import                                   | 职责                                                     |
| ---------------------------------------- | -------------------------------------------------------- |
| `@byreal-io/byreal-evm-clmm-sdk`         | `EvmClmmSdk`：链上读取、未签名交易、本地数学             |
| `@byreal-io/byreal-evm-clmm-sdk/compat`  | Solana SDK 调用形状兼容层；细节见 [compat.md](compat.md) |
| `@byreal-io/byreal-evm-clmm-sdk/raw`     | `Pool`、`Position`、`Trade`、`RewardClaimVault`、calldata builder 与底层数学 |

- 核心入口不导出 compat，compat 是可选的独立入口。
- SDK 不内置后端客户端：池子列表、仓位列表等从 Byreal 后端接口获取，
  再以快照形式喂给本地数学或 compat 的 `chain.offchain.*`。

## 部署环境

| `profileId` | 说明                                                   |
| ----------- | ------------------------------------------------------ |
| `test`      | 测试环境，联调用                                       |
| `prod`      | 生产环境，**默认值**；合约上线前尚未部署，使用会直接报错 |

```ts
new EvmClmmSdk({ chainId: 5000, profileId: 'test' }) // 联调
new EvmClmmSdk({ chainId: 5000 })                    // 生产（合约上线后可用）
```

- 两套部署都在 Mantle（chainId 5000），`chainId` 与部署不一致时构造直接报错。
- 换 RPC 或合约地址时传 `rpcUrl` / `contracts`。
- 合约地址可从 `DEPLOYMENT_PROFILES` 读取；`poolInitCodeHash` 运行时从 factory 读，不需要配置。

## 协议差异

本 SDK 只支持 **Byreal 定制版 Uniswap V3 合约**，不要混用官方 Uniswap V3 的 ABI 或 SDK。

| 维度            | Byreal 定制合约约束                                              |
| --------------- | ---------------------------------------------------------------- |
| 池身份          | `(token0, token1, tickSpacing)`                                  |
| 交易费率        | `tradeFeeRate`，ppm，可由治理修改                                |
| 协议费          | `protocolFeeRate`，百分比 `0~100`，来自 slot0 第 6 项            |
| 额外费档        | swap/quote 必带 `extraFeeClass`：Alpha=0、Dex=1                  |
| Quoter          | struct 使用 `tickSpacing + extraFeeClass`                        |
| NPM mint        | 第 3 项是 `tickSpacing`，尾部包含 `followTokenId`                |
| Router deadline | deadline 在外层 `multicall(deadline, data)`，不在 swap struct 中 |
| NPM deadline    | deadline 在操作 struct 中，NPM multicall 不带 deadline           |
| 动态费率        | 开启时离线报价会拒绝，需走 Quoter                                |
| 暂停            | `pauseFlags` 与 `swapOpenTime` 控制路径；REMOVE 会影响 collect   |

不要建立 `fee -> tickSpacing` 映射。`positions()` 第 5 项是 `tickSpacing`，不是 fee。

## 状态与单位

- `tradeFeeRate`、`alphaExtraTradeFeeRate`、`dexExtraTradeFeeRate`：ppm，除以 `1_000_000` 得比例。
- `protocolFeeRate`：百分比整数，除以 `100` 得比例。
- 链上金额使用最小单位整数（`bigint`），展示值使用格式化字符串（`ui*`）。
- `tradeFeeRate` 是可变状态，只用于展示或计算，不要当作池身份或缓存键。
- `feeAmount: null` 表示未读取，`0n` 才表示已读取且确实为零。
- `/raw` 使用 `JSBI | string | number` 形状的 `BigintIsh`，核心的 `bigint` 传进去时要 `.toString()`。

## 交易与报价

```ts
import { EvmClmmSdk } from '@byreal-io/byreal-evm-clmm-sdk'

const sdk = new EvmClmmSdk({ chainId: 5000, profileId: 'test' })

const pool = await sdk.getRawPoolInfoByPoolAddress(poolAddress)
const quote = await sdk.quoteSwap({
  tokenIn,
  tokenOut,
  tickSpacing: pool.tickSpacing,
  amountIn,
})
```

- 默认使用 Dex 档位（`ExtraFeeClass.DEX`）；需要 Alpha 档位时在构造参数或单次报价参数里传 `extraFeeClass`。
- 池子开启 `dynamicFeeEnabled` 时，不要用 `Pool.quote` 或本地输出算滑点下限，以 ByrealQuoter 的链上结果为准。
- 写操作返回未签名交易。allowance 不足时会在主交易前插入 approve，多笔交易要按顺序发送并逐笔等回执。
- `createPosition({ followTokenId })` 传非零值时，合约会校验目标仓位存在、有流动性、同池、区间一致、不是自己的仓位，不满足则 revert。

## 原生币（MNT）

池子含 WMNT（`contracts.weth`，与 NPM 的 `WETH9()` 一致）时，可以直接用原生 MNT 投入或到账，不用先 wrap / 事后 unwrap：

| 方法                                                  | 参数                  | 主交易                                                       |
| ----------------------------------------------------- | --------------------- | ------------------------------------------------------------ |
| `createPosition` / `addLiquidity`                     | `useNative: true`     | `multicall([mint 或 increaseLiquidity, refundETH])`，value = WMNT 一侧投入量 |
| `decreaseLiquidity` / `collectFees` / `closePosition` | `receiveNative: true` | collect 先留在 NPM，同笔 `unwrapWETH9 + sweepToken` 转给 recipient |

```ts
// WMNT/USDC 池：WMNT 一侧用 MNT 支付，只对 USDC 前置 approve
const { transactions } = await sdk.createPosition({ ...params, useNative: true })

// 关仓：WMNT 一侧以 MNT 到账
await sdk.closePosition({ userAddress, tokenId, receiveNative: true })
```

- 发送时把 `tx.value` 一并带上；合约只 wrap 实际用掉的部分，多余的同笔 `refundETH` 退回。
- `useNative` 的余额校验改查原生币，但只覆盖投入量本身：MNT 还要付 gas，请留余量。
- 价格在区间外、WMNT 一侧投入为 0 时退化成普通调用，value 为 0。
- `receiveNative` 不能与 `decreaseLiquidity({ collect: false })` 同时使用；`collectFees` 需要知道仓位的两种代币，
  不传 `positionState` 时会多读 1 次 `positions`。
- 池子不含 WMNT 时两个参数都会直接报错。compat 层暂不透传这两个参数。

## 奖励领取

奖励从独立的 ByrealRewardClaimVault 领取，与 NPM 的 `collect`（仓位手续费）无关。流程：

1. 从 Byreal 后端拿到奖励凭证（8 个字段 + 65 字节签名）。字段原样使用，签名后任何字段都不能改；
   uint256 用十进制字符串传输，进 SDK 前转成 `bigint`，不要经过 JS Number。
2. `sdk.getRewardClaimedAmountList(keys)` 读链上账本，`syncedAmount − claimedAmount` 即可领额（UI 展示用）。
   RPC 失败会抛错，不要把失败当成 0。
3. `sdk.claimRewards({ userAddress, claims })` 产出 1 笔发往金库 proxy 的交易（1 张 `claim`，多张 `claimBatch`）。

```ts
const { main, meta } = await sdk.claimRewards({
  userAddress,
  claims: vouchers.map((v) => ({ claim: v.claim, signature: v.signature })),
})
// meta.items[i].claimableAmount：每张凭证的到账额；meta.totals：按奖励代币汇总
await walletClient.sendTransaction({ to: main.to, data: main.data, value: main.value })
```

- 账本键是 `(positionTokenId, rewardToken, ruleId, ruleType, epochTime)`，`syncedAmount` 是**累计**应得额，
  到账额 = 新累计额 − 账本。beneficiary 不在键内，NFT 转让不会清零；合约也不校验 NFT 归属。
- 只有 beneficiary 本人能发 claim；不需要 approve，金库从自身余额付款。
- SDK 发送前在本地按合约规则预演并报错：受益人不符、凭证过期（按本机时钟）、已领过或凭证过时、金库暂停、金库余额不足。
  **签名是否有效只有链上能判断**：发送前的 gas 估算会以 `BAD_SIGNER` revert 暴露。
- `claimBatch` 是原子的，任一张失败整批回滚。同一账本键的多张凭证须按 `syncedAmount` 严格递增排列，
  一般只保留累计额最高的一张即可。
- 金库地址取 `sdk.contracts.rewardClaimVault`（test 环境已内置）；未配置时奖励方法直接报错。EIP-712 domain 是
  `name=ByrealRewardClaimVault, version=1, chainId, verifyingContract=金库 proxy`，凭证必须是针对同一个金库签的。
- 需要自己拼 calldata、计算 typed data 或对齐事件的 `rewardInfoHash` 时，用 `/raw` 的 `RewardClaimVault`。
