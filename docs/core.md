# 核心 SDK 参考

## 目录

- [入口](#入口)
- [部署环境](#部署环境)
- [协议差异](#协议差异)
- [状态与单位](#状态与单位)
- [交易与报价](#交易与报价)

## 入口

| import                                   | 职责                                                     |
| ---------------------------------------- | -------------------------------------------------------- |
| `@byreal-io/byreal-evm-clmm-sdk`         | `EvmClmmSdk`：链上读取、未签名交易、本地数学             |
| `@byreal-io/byreal-evm-clmm-sdk/compat`  | Solana SDK 调用形状兼容层；细节见 [compat.md](compat.md) |
| `@byreal-io/byreal-evm-clmm-sdk/raw`     | `Pool`、`Position`、`Trade`、calldata builder 与底层数学 |

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
