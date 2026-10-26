# Compat 参考

`@byreal-io/byreal-evm-clmm-sdk/compat` 沿用 Solana 版 SDK（`@byreal-io/byreal-clmm-sdk`）的调用形状，
用来参考 Solana 接入代码如何迁到 EVM。新接入建议直接使用核心 `EvmClmmSdk`。
两条链的结构性差异 compat 不做掩盖，见下文。

## 目录

- [目标与入口](#目标与入口)
- [高风险差异](#高风险差异)
- [API 映射](#api-映射)
- [入参与返回值](#入参与返回值)
- [常用流程](#常用流程)
- [Compat 无法填平的差异](#compat-无法填平的差异)

## 目标与入口

核心原则：**宽进严出，无法安全转换就立即抛错。**

- 入参接受 `BN` / `JSBI` / 十进制串 / 十六进制串 / `bigint` / 安全整数及旧字段别名。
- 出参中的链上整数统一为 `bigint`，展示值统一为 `ui*` 字符串。
- 不引入 `bn.js` / `decimal.js`，不复刻 Solana X64 定点数。
- 新代码优先使用核心 `EvmClmmSdk`；只有需要复用 Solana 调用形状时使用 compat。

```ts
import { EvmClmmSdk } from '@byreal-io/byreal-evm-clmm-sdk';
import { CompatChain } from '@byreal-io/byreal-evm-clmm-sdk/compat';

const chain = new CompatChain({
  sdk: new EvmClmmSdk({
    chainId: 5000,
    profileId: 'test', // 联调用测试环境；生产不传即可
  }),
});
```

也可以使用 `new ByrealClmmSdk({ chainId, profileId })`；其 `.chain` 是 `CompatChain`，`.sdk` 是核心 SDK。

## 高风险差异

### 滑点口径

- `slippage: 0.02` 表示 2%。
- `slippageBps: 200` 表示 2%。
- 两者只能传一个；`slippage: 2` 会抛错。
- compat 默认 200 bps，核心默认 50 bps。所有业务调用都应显式传 `slippageBps`。

### X64 与 X96

Solana/Raydium 使用 Q64.64，EVM CLMM 使用 Q64.96，两者相差 `2^32`。以下 X64 方法保留了方法名，但调用会直接抛错：

- `getSqrtPriceX64FromTick`
- `getTickFromSqrtPriceX64`
- `sqrtPriceX64ToPrice`
- `priceToSqrtPriceX64`

调用方必须改用对应的 X96 方法。

### 滑点方向

`LiquidityMath.getAmountsFromLiquidityWithSlippage` 必须显式传：

- `action: 'mint'`：开仓或加仓。
- `action: 'burn'`：减仓或关仓。

不能把旧 `amountMax: boolean` 机械映射为 action；mint/burn 用反会导致恒 revert 或失去滑点保护。

### tick 对齐

compat 不会静默调整用户区间。写操作前使用：

```ts
const tickLower = TickMath.nearestUsableTick(rawLower, tickSpacing);
const tickUpper = TickMath.nearestUsableTick(rawUpper, tickSpacing);
```

### 仓位 ID

开仓返回的 `nftAddress` 与 `tokenId` 恒为 `null`。EVM tokenId 只能在 mint 上链后解析：

```ts
const receipt = await publicClient.waitForTransactionReceipt({ hash });
const tokenId = parseTokenIdFromReceipt(receipt, {
  positionManager: sdk.contracts.positionManager,
});
```

依赖 tokenId 的跳转、弹窗、埋点和列表插入必须放到主交易回执之后。

### 金额、地址与未知状态

- 地址必须是 `0x` 开头的 20 字节 EVM 地址；传 Solana base58 或 `PublicKey` 会抛错并说明改法。
- 链上金额必须是最小单位整数；浮点数、带小数点字符串、空串、`null` 会抛错。
- `feeAmount: null` 表示未读取，不要用 `?? 0n` 当成 0。
- `otherAmountMax` 若传入，作为另一侧金额上限：算出的金额超过它会抛错。

## API 映射

### 门面

| Solana 形状                            | Compat                       | 说明                                    |
| -------------------------------------- | ---------------------------- | --------------------------------------- |
| `new Chain({ connection, programId })` | `new CompatChain({ sdk })`   | 合约地址由 `profileId` 决定             |
| `chain.*`                              | `chain.*`                    | 读链版                                  |
| `chain.offchain.*`                     | `chain.offchain.*`           | 快照注入版，保证 0 RPC                  |
| `sdk.chain.*`                          | `ByrealClmmSdk.chain.*`      | 透传 CompatChain                        |
| `sdk.clmmClient.*`                     | `ByrealClmmSdk.clmmClient.*` | 与 chain 共用实例                       |
| `sdk.api`                              | `undefined`                  | 池子/仓位列表直接调用 Byreal 后端接口   |
| `sdk.token`                            | `undefined`                  | 单币信息用 `chain.getTokenInfoByMint()` |

### 写操作

| 兼容方法                             | 短名                                            | 注意                                 |
| ------------------------------------ | ----------------------------------------------- | ------------------------------------ |
| `createPositionInstructions`         | `createPosition`                                | tokenId 上链后解析                   |
| `addLiquidityInstructions`           | `addLiquidity`                                  | 已有仓位需要 position 快照或 tokenId |
| `decreaseLiquidityInstructions`      | `decreaseLiquidity`                             | `liquidity` 与 `percent` 二选一      |
| `decreaseFullLiquidityInstructions`  | `decreaseFullLiquidity` / `removeFullLiquidity` | `closePosition:false` 保留 NFT       |
| `closePositionInstructions`          | `closePosition`                                 | 全撤并 burn NFT                      |
| `collectFeesInstructions`            | `collectFees`                                   | offchain 必须传 `pendingFees`        |
| `collectAllPositionFeesInstructions` | `collectAllFees`                                | NPM multicall，一次签名              |

### 读操作

| 方法                                        | 返回                                                              |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `getRawPoolInfoByPoolId` / `getRawPoolInfo` | `IPoolStateRaw`                                                   |
| `getRawPositionInfoByNftMint`               | `IPositionStateRaw`                                               |
| `getPositionTokenIdListByOwner`             | `bigint[]`                                                        |
| `getPositionInfoByNftMint`                  | `ICompatPositionInfo \| null`                                      |
| `getPositionInfoByNftMints`                 | `Map<string, ICompatPositionInfo \| null>`，key 为 tokenId 字符串  |

`getPositionInfoByNftMint` 默认不读手续费；需要精确费用时显式传 `{ withFees: true }`。

## 入参与返回值

### 字段别名

| 语义         | 接受的字段                                                     |
| ------------ | -------------------------------------------------------------- |
| 用户地址     | `userAddress` / `walletAddress`                                |
| 仓位标识     | `tokenId` / `nftMint`                                          |
| 池地址       | `poolAddress` / `poolId`                                       |
| 池快照       | `poolState` / `rawPoolInfo`                                    |
| 仓位快照     | `positionState` / `rawPositionInfo`                            |
| Token 元数据 | `token0`/`token1` 或 `mintA`/`mintB`                           |
| 滑点         | `slippage` / `slippageBps`                                     |
| 截止时间     | `deadlineSec` / `deadline`                                     |
| 减仓比例     | `percent` / `decreasePercentage` / `percentage`                |
| 跟随母仓位   | `followTokenId` / `refererPosition`（值为母仓位 tokenId）       |
| 基准侧       | `MintA`/`MintB`、`Token0`/`Token1`、`token0`/`token1`、`0`/`1` |

成对别名同时出现且值不一致时会抛错，不猜优先级。EVM 上 A 恒等于 token0、B 恒等于 token1；别名必须引用同一个对象。

### 写操作返回值

```ts
{
  transactions: IUnsignedTx[]
  main: IUnsignedTx
  meta: Record<string, unknown>

  instructions: IUnsignedTx[] // 与 transactions 同一引用
  transaction: IUnsignedTx    // 与 main 同一引用
  signers: undefined
}
```

返回的是可能包含 approve 的未签名交易数组，不是 `TransactionInstruction[]`。不要调用 `makeTransaction`。

## 常用流程

### Offchain 开仓

```ts
// offchain 读不到 allowance，不会插 approve：调用方需先自行授权给 positionManager
const result = await chain.offchain.createPositionInstructions({
  userAddress,
  rawPoolInfo,
  token0, // ITokenInfo（含 decimals），通常来自后端接口
  token1,
  tickLower,
  tickUpper,
  base: 'MintA',
  baseAmount,
  slippageBps: 200,
});

for (const tx of result.transactions) {
  const hash = await walletClient.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (tx === result.main) {
    const tokenId = parseTokenIdFromReceipt(receipt);
  }
}
```

offchain 调用不接收 `programId`、`mintAProgramId`、`mintBProgramId`。合约由 `profileId` 决定，EVM 没有 token program。

### 快照要求

`chain.offchain.*` 必须保持 0 RPC：

- 所有写操作传 `rawPoolInfo` 或 `poolState`。
- 已有仓位操作再传 `rawPositionInfo` 或 `positionState`。
- `collectFeesInstructions` 再传 `pendingFees`。
- Token decimals 需要 `token0/token1` 或可从快照中完整解析。

缺快照时抛错并引导调用方改用读链版 `chain.*`，不能暗中发 RPC。

### 部分减仓与关仓

- 部分减仓接受绝对 `liquidity`，也接受 `percent`；两者二选一。
- `decreaseFullLiquidity({closePosition:false})` 只撤流动性并保留 NFT。
- `closePosition` 或 `closePosition:true` 全撤后 burn NFT。
- `meta.uiExpectedAmount*` 与 `meta.uiAmount*Min` 可直接用于展示。

### 领取手续费

- 单仓位 offchain collect 必须由调用方提供精确 `pendingFees`。
- 多仓位使用 `collectAllPositionFeesInstructions`，它会打包为一笔 NPM multicall。
- 池子 `PAUSE_REMOVE` 置位时 collect 会受影响，UI 应禁用并说明原因。

## Compat 无法填平的差异

这些差异编译通常不会报错，必须改业务流程：

1. **多笔顺序交易**：approve × N + 主交易可能部分成功。实现逐笔进度、失败重试与中断恢复。
2. **仓位 ID 时机**：所有依赖 tokenId 的逻辑移到主交易回执之后。
3. **Allowance 状态**：授权成功但主交易失败是可持续存在的中间态；重试时重新读取 allowance。
4. **无额外 signers**：删除 `VersionedTransaction`、`makeTransaction` 与 signers 流程。
5. **无 rent / tick array 存储费**：删除押金、可退还和 tick 初始化费用 UI；EVM 只有 gas。
6. **无 Solana Pool openTime 语义**：不要把 Initialize 事件时间解释为开放交易时间。
7. **批量读取走 Multicall3**：不要在列表中逐仓位串行发多个 RPC。
8. **同名短方法不会发交易**：已发布的 `@byreal-io/byreal-clmm-sdk` 里 `createPosition` / `addLiquidity` / `decreaseLiquidity` /
   `closePosition` / `collectFees` 等接收 `signerCallback`，内部签名并广播、返回交易签名字符串；
   compat 的同名方法只是 `*Instructions` 的别名，返回未签名交易，不接收 `signerCallback`。
   TS 里用对象字面量传 `signerCallback` 会报多余属性；但参数先存进变量、或在 JS 里调用时既不报错，也**不会发出任何交易**，
   必须改成自己逐笔发送 `transactions`。
9. **Copy Position 从「备注」变成「链上校验」**：Solana 版开仓时 `refererPosition` 只附加一条 `referer_position=` memo，
   后端据此记录母子仓位，区间随意。compat 的开仓方法（读链版与 offchain 版）同样接收 `refererPosition`，
   并翻译成 mint 尾字段 `followTokenId`（与 Byreal web 端的 Copy Position 一致），但有两点必须改：
   - 值要换成母仓位的 **tokenId**（数字 / 十进制串），照搬 Solana 仓位地址会直接抛错并提示；
   - 合约会校验母仓位存在且有流动性、同池、tick 区间完全一致、不是自己，任一不满足整笔 revert，
     所以 tick 区间应直接取母仓位的 `tickLower` / `tickUpper`，不要让用户修改。
