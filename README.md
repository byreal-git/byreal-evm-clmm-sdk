# Byreal EVM CLMM SDK

Byreal EVM CLMM 合约的 TypeScript SDK。负责：

- **链上读取**：池子状态、仓位、待领手续费、链上询价（ByrealQuoter）；
- **本地数学**（0 RPC）：价格 / tick 换算、仓位资产、输入框金额联动、滑点下限、APR；
- **构建未签名交易**：开仓、加仓、减仓、领手续费、关仓（approve 按需前置），签名与广播由调用方完成；
  含 WMNT 的池子可以直接用原生 MNT 投入 / 到账（`useNative` / `receiveNative`）；
- **奖励领取**：凭 Byreal 后端签发的凭证从 RewardClaimVault 领奖励（`claimRewards`）。

SDK **不包含**后端接口客户端：池子列表、仓位列表、奖励凭证等请直接调用 Byreal 后端接口。

> ⚠️ 只支持 Byreal 定制合约（池身份键 `(token0, token1, tickSpacing)`、`extraFeeClass` 等），与官方 Uniswap V3 ABI / SDK 不兼容，不能混用。

## 安装

```bash
npm install @byreal-io/byreal-evm-clmm-sdk viem
```

`viem`（`^2.22.0`）是 peer 依赖，由使用方安装；包是 ESM，Node.js 需 20.19+ 或 22.12+。

## 部署环境

| `profileId` | 说明                                                   |
| ----------- | ------------------------------------------------------ |
| `test`      | 测试环境，联调用                                       |
| `prod`      | 生产环境，**默认值**；合约上线前尚未部署，使用会直接报错 |

联调阶段传 `profileId: 'test'`；生产合约上线后升级 SDK，不传 `profileId` 即为生产。

## 快速开始

```ts
import { EvmClmmSdk, getTicksByPercentRange } from '@byreal-io/byreal-evm-clmm-sdk'

const sdk = new EvmClmmSdk({ chainId: 5000, profileId: 'test' })

// 1) 读池子
const poolAddress = await sdk.chain.getPoolAddress({ tokenA, tokenB, tickSpacing: 1 })
const poolState = await sdk.getRawPoolInfoByPoolAddress(poolAddress)

// 2) 链上询价
const quote = await sdk.quoteSwap({ tokenIn: tokenA, tokenOut: tokenB, tickSpacing: 1, amountIn })

// 3) 开仓：返回按顺序发送的未签名交易（可能含 approve），不会自动发送
const { tickLower, tickUpper } = getTicksByPercentRange({
  currentTick: poolState.tick,
  tickSpacing: poolState.tickSpacing,
  lowerPercent: 10,
  upperPercent: 10,
})
const { transactions, meta } = await sdk.createPosition({
  userAddress,
  poolAddress,
  tickLower,
  tickUpper,
  base: 'Token0',
  baseAmount,
  slippageBps: 50,
  poolState,
})

for (const tx of transactions) {
  const hash = await walletClient.sendTransaction({ to: tx.to, data: tx.data, value: tx.value })
  await publicClient.waitForTransactionReceipt({ hash }) // 多笔交易必须逐笔等待回执
}
```

可选参数：复用已有 viem 客户端传 `publicClient`，覆盖 RPC / 合约地址传 `rpcUrl` / `contracts`。

## 入口

| import                                  | 内容                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `@byreal-io/byreal-evm-clmm-sdk`        | 核心：`EvmClmmSdk`、`Chain`、`CLMMClient`、`RewardClient`、本地数学、ABI、常量与部署注册表 |
| `@byreal-io/byreal-evm-clmm-sdk/compat` | Solana 版 SDK 调用形状兼容层（`ByrealClmmSdk` / `CompatChain` / `chain.offchain.*`）     |
| `@byreal-io/byreal-evm-clmm-sdk/raw`    | 底层：`Pool` / `Position` / `Trade` 实体，NPM / SwapRouter / Quoter / Multicall / RewardClaimVault calldata 编码 |

详细说明见 [docs/core.md](docs/core.md)（核心）与 [docs/compat.md](docs/compat.md)（compat）。

## 与 Solana 版 SDK 的主要差异

| 维度       | Solana（`@byreal-io/byreal-clmm-sdk`） | EVM（本 SDK）                                              |
| ---------- | -------------------------------------- | ---------------------------------------------------------- |
| 写操作返回 | `TransactionInstruction[]` + signers   | `IUnsignedTx[]`（可能含 approve），按顺序发送、逐笔等回执   |
| 仓位标识   | `nftMint`（开仓前即可知）              | `tokenId`（mint 上链后从回执解析）                          |
| 价格定点数 | Q64.64（X64）                          | Q64.96（X96），compat 里的 X64 方法会直接抛错               |
| 存储费用   | rent / tick array 押金                 | 无，只有 gas                                                |
| 滑点       | 小数（0.02 = 2%）                      | 基点 `slippageBps`（200 = 2%），核心默认 50 bps             |
| 授权       | 无                                     | ERC20 `approve`，allowance 不足时前置 approve 交易          |

## 示例

`examples/` 下是可直接运行的完整示例，连 Mantle 测试环境的 USDC/TV2D 池。

| 文件                       | 内容                                                       | 上链 |
| -------------------------- | ---------------------------------------------------------- | ---- |
| `01_read_pool.ts`          | 读池子：价格、流动性、费率、暂停状态                       | 否   |
| `02_read_positions.ts`     | 读仓位：持仓量、价格区间、是否在区间内、待领手续费         | 否   |
| `03_create_position.ts`    | 开仓：approve + mint，从回执解析 tokenId                   | 是   |
| `04_add_liquidity.ts`      | 加仓                                                       | 是   |
| `05_decrease_liquidity.ts` | 减仓 50%，本金与手续费同笔到账                             | 是   |
| `06_collect_fees.ts`       | 领取手续费                                                 | 是   |
| `07_close_position.ts`     | 关仓：撤出全部流动性 + 领取 + 销毁 NFT                     | 是   |
| `08_swap.ts`               | Swap：链上询价 → 构造 calldata → approve（按需）→ 发送     | 是   |

只读示例直接运行：

```bash
npx tsx examples/01_read_pool.ts
OWNER=0x... npx tsx examples/02_read_positions.ts
```

上链示例会用私钥**真实发送交易**：

1. `cp .env.example .env`，填写 `PRIVATE_KEY`（`.env` 已被 git 忽略）；
2. 钱包准备少量 MNT（gas）和几个 USDC；
3. 先跑 `08_swap.ts` 换一点 TV2D（开仓要两种代币），然后按 03 → 07 的顺序运行。

04 ~ 07 默认操作钱包在演示池里最新的仓位，也可以用 `TOKEN_ID=...` 指定。
新开的仓位要等池子有成交才有手续费，在 06 之前再跑一次 08 就能看到手续费到账。

