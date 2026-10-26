/**
 * compat 层的读操作层：`new CompatChain({ sdk })`，对齐旧 Solana 版的
 * `sdk.chain.*` 调用形状 —— 旧方法名（`*ByNftMint` / `*ByUserAddress`）与 EVM 短名
 * （`*ByTokenId` / `*ByOwner`）**同时**提供，两者是同一份实现。
 *
 * 与核心 `Chain` 的分工：
 * - 核心 `Chain` 只出**链上原始状态**（`IPoolStateRaw` / `IPositionStateRaw`），一律要 `Address` / `bigint`；
 * - `CompatChain` 在它之上做两件事：入参「宽进」（base58 / BN / string 都先过 coerce），
 *   以及把「仓位原始状态 + 池子状态 + 代币元数据」组装成旧版那种**一站式的仓位详情**
 *   （{@link ICompatPositionInfo}，含 ui 字符串、价格区间、inRange）。
 *
 * 写操作全部透传给 {@link CompatCLMMClient}（要求 chain 上也能直接调），
 * 快照注入版（0 RPC）挂在 {@link CompatChain.offchain}。
 */
import type { Address } from 'viem'

import { NPM_ABI } from '../abis.js'
import { getPositionView } from '../calculate.js'
import type { EvmClmmSdk } from '../client.js'
import type { IPendingFees, IPoolStateRaw, IPositionStateRaw, ITokenInfo } from '../types.js'

import { COMPAT_ERR_PREFIX, toAddress, toBigInt, toUiAmount, type Numericish } from './coerce.js'
import { CompatCLMMClient } from './liquidity.js'
import type { ICompatPositionInfo, ICompatPositionSide } from './models.js'
import { CompatOffchain } from './offchain.js'

// ---------------------------------------------------------------------------
// 入参类型
// ---------------------------------------------------------------------------

/**
 * {@link CompatChain.getPositionInfoByNftMint} / {@link CompatChain.getPositionInfoByNftMints} 的选项。
 *
 * `withFees` 默认 **false**：拿手续费要多一次 collect staticcall（每个仓位 1 次 eth_call，
 * 还可能再加 1 次 `ownerOf`），列表页一屏几十个仓位时这笔开销很可观，所以要调用方明确要。
 * 不要它时 `feeAmount` / `uiFeeAmount` 是 `null` 而**不是 0** —— 见 {@link ICompatPositionSide}。
 */
export interface ICompatPositionInfoOptions {
  /** 是否额外读一次链拿精确待领手续费。默认 false（false 时 feeAmount 为 null，不编 0） */
  withFees?: boolean
  /**
   * 仓位持有人。只在 `withFees: true` 时用得上 ——
   * collect staticcall 会过合约的 `isAuthorizedForToken` 检查，`account` 必须是 owner。
   * 不传就现场读一次 `ownerOf(tokenId)`（每个仓位多 1 次 eth_call），
   * 列表页通常本来就知道 owner（就是当前钱包），传进来能省掉这些请求。
   */
  owner?: string
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 判断一次 `positions(tokenId)` 失败是不是「这个仓位不存在」。
 *
 * 约定仓位不存在时返回 `null` 而不是抛（对齐旧版）。但**不能无脑 catch 成 null**：
 * RPC 超时、节点 5xx、合约地址配错也会走到 catch，全部吞成 null 会让前端把
 * 「网络抖了一下」显示成「你的仓位没了」—— 这是比抛错严重得多的误导。
 *
 * 所以这里只把「合约明确 revert」当作不存在（NPM 对无效 tokenId 抛 `Invalid token ID`），
 * 其余原因一律原样抛出去。
 */
function isPositionNotFoundError(e: unknown): boolean {
  const message = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return (
    message.includes('invalid token id') ||
    message.includes('erc721') ||
    message.includes('nonexistent') ||
    message.includes('reverted')
  )
}

// ---------------------------------------------------------------------------
// CompatChain
// ---------------------------------------------------------------------------

/**
 * 读操作层 + 写操作透传，对齐旧 Solana 版的 `sdk.chain.*`：`new CompatChain({ sdk })`。
 *
 * 三件事，其余全部转调核心：
 * 1. **入参宽进**：所有读方法的地址 / 仓位标识都先过 `coerce`，
 *    旧代码里的 base58 / BN / 十进制串传进来能拿到一条指路的错误，而不是 viem 的原始报错；
 * 2. **组装旧形状的仓位详情**：核心只出 `IPositionStateRaw`（纯链上字段），
 *    旧版给的是带 ui 字符串、价格区间、`inRange` 的一站式对象（{@link ICompatPositionInfo}）；
 * 3. **批量优先**：`getPositionInfoByNftMints` 会先把池子与代币去重再打 RPC，
 *    单查只是 N=1 的批量查 —— 只有一份组装逻辑，不存在「列表页和详情页数字对不上」。
 *
 * 快照注入版（0 RPC）挂在 {@link CompatChain.offchain}，读链版写操作挂在
 * {@link CompatChain.clmmClient}，两者都在这个类上直接透传了一份短名。
 */
export class CompatChain {
  /** 原生核心 SDK。逃生口：compat 没包到的能力（quoteSwap、getMintPrerequisites…）从这里直接拿 */
  readonly sdk: EvmClmmSdk

  /**
   * 快照注入版写操作（**0 RPC**）。
   * 挂在 chain 下而不是门面上，是为了对齐旧版 `sdk.chain.offchain.*` 的调用形状。
   */
  readonly offchain: CompatOffchain

  /**
   * 读链版写操作。与门面上的 `ByrealClmmSdk.clmmClient` 是**同一个实例** ——
   * 两处各造一个虽然也能跑，但核心 SDK 的池子/代币缓存挂在 `Chain` 上、两个 compat 客户端
   * 共享同一个 `sdk`，共用实例语义更清楚，也省得将来在 compat 层加状态时出现两份。
   */
  readonly clmmClient: CompatCLMMClient

  constructor(params: { sdk: EvmClmmSdk }) {
    this.sdk = params.sdk
    this.clmmClient = new CompatCLMMClient({ sdk: params.sdk })
    this.offchain = new CompatOffchain({ sdk: params.sdk })
  }

  // =========================================================================
  // 读 · 池子
  // =========================================================================

  /**
   * 读池子的链上原始状态。**旧名**（Solana 版池子标识叫 poolId，EVM 上就是池子合约地址）。
   *
   * RPC：冷启动 1 次 multicall（13 个 call），热路径 1 次 multicall（10 个 call）——
   * 与核心 `chain.getRawPoolInfo` 完全一致，compat 只多做一次地址 checksum 校验。
   */
  async getRawPoolInfoByPoolId(poolAddress: string): Promise<IPoolStateRaw> {
    return this.sdk.chain.getRawPoolInfo(toAddress(poolAddress, 'poolId'))
  }

  /** {@link getRawPoolInfoByPoolId} 的 EVM 短名，实现完全相同（新代码用这个） */
  async getRawPoolInfo(poolAddress: string): Promise<IPoolStateRaw> {
    return this.sdk.chain.getRawPoolInfo(toAddress(poolAddress, 'poolAddress'))
  }

  // =========================================================================
  // 读 · 仓位原始状态
  // =========================================================================

  /**
   * 读单个仓位的链上原始状态（`positions(tokenId)` 原样映射）。
   *
   * 入参叫 `nftMint` 只是沿用旧名，实际必须是 **tokenId（uint256）**；
   * 真传了 base58 地址进来，`toBigInt` 会抛出「EVM 请用 tokenId」的专门提示。
   *
   * RPC：1 次 eth_call。仓位不存在时**抛**（这是原始读，不做兜底）——
   * 要 null 语义请用 {@link getPositionInfoByNftMint}。
   */
  async getRawPositionInfoByNftMint(idish: Numericish): Promise<IPositionStateRaw> {
    const tokenId = toBigInt(idish, 'nftMint')
    try {
      return await this.sdk.chain.getRawPositionInfo(tokenId)
    } catch (e) {
      // 原样漏出 viem 的 `The contract function "positions" reverted with reason: Invalid token ID`
      // 对调用方毫无指引：既没有 compat 前缀（拿去搜文档搜不到），也不说明该怎么办。
      // 「仓位不存在」在这条原始读上是**正常业务状态**（列表里混进一个已 burn 的 tokenId），
      // 只是这个方法按契约要抛而不是给 null，所以至少要抛得能看懂。
      if (isPositionNotFoundError(e)) {
        throw new Error(
          `${COMPAT_ERR_PREFIX} 仓位 #${tokenId} 在链上不存在（可能已被 burn，或 tokenId 不对）。` +
            '这个方法按契约对不存在的仓位抛错；想要 null 语义请改用 ' +
            'getPositionInfoByNftMint(tokenId)，它对同样的情况返回 null。' +
            `原始错误：${(e as Error).message}`,
          { cause: e },
        )
      }
      throw e
    }
  }

  /**
   * 列出某地址名下所有仓位的原始状态。
   * RPC：3 轮（`balanceOf` → multicall(N × `tokenOfOwnerByIndex`) → multicall(N × `positions`)），与仓位数量无关。
   */
  async getRawPositionInfoListByUserAddress(userAddress: string): Promise<IPositionStateRaw[]> {
    return this.sdk.chain.getRawPositionInfoListByOwner(toAddress(userAddress, 'userAddress'))
  }

  /**
   * 列出某地址持有的全部仓位标识。**旧名**。
   *
   * ⚠️ 名字里的 `NftMint` 是 Solana 遗留：EVM 上返回的是 **tokenId（`bigint`）列表**，
   * 不是 base58 mint 地址。方法名保留只为让旧调用点不用改，语义以返回类型为准。
   *
   * RPC：2 次（`balanceOf` + 1 次 multicall）。
   */
  async getPositionNftMintListByUserAddress(userAddress: string): Promise<bigint[]> {
    return this.sdk.chain.getPositionTokenIdListByOwner(toAddress(userAddress, 'userAddress'))
  }

  /** {@link getPositionNftMintListByUserAddress} 的 EVM 短名，实现完全相同（新代码用这个） */
  async getPositionTokenIdListByOwner(owner: string): Promise<bigint[]> {
    return this.sdk.chain.getPositionTokenIdListByOwner(toAddress(owner, 'owner'))
  }

  // =========================================================================
  // 读 · 代币元数据
  // =========================================================================

  /**
   * 读单个 ERC20 的元数据（decimals / symbol / name）。**旧名**里的 `Mint` 即 EVM 的合约地址。
   * RPC：未命中缓存 1 次 multicall（3 个 call），命中则 0 次。
   */
  async getTokenInfoByMint(address: string): Promise<ITokenInfo> {
    const [info] = await this.sdk.chain.getTokenInfoList([toAddress(address, 'mint')])
    return info
  }

  // =========================================================================
  // 读 · 仓位详情（旧 IGetPositionInfoByNftMintReturn 的对位实现）
  // =========================================================================

  /**
   * 一站式仓位详情：本金、价格区间、是否在区间内、（可选）待领手续费。
   *
   * RPC：`positions` 1 次 → Factory 反查 1 次（缓存后 0）→ 池子状态 1 次 multicall →
   * 代币元数据 1 次 multicall（缓存后 0）；`withFees: true` 时再加 1~2 次
   * （collect staticcall，未传 `owner` 时多一次 `ownerOf`）。
   *
   * **仓位不存在返回 `null` 而不是抛**（对齐旧版：列表里混进一个已 burn 的 tokenId 不该让整页崩掉）。
   * 但只有「合约明确 revert」才算不存在，网络类错误照抛 —— 见 {@link isPositionNotFoundError}。
   */
  async getPositionInfoByNftMint(
    idish: Numericish,
    opts: ICompatPositionInfoOptions = {},
  ): Promise<ICompatPositionInfo | null> {
    const tokenId = toBigInt(idish, 'nftMint')
    const map = await this.loadPositionInfos([tokenId], opts)
    return map.get(tokenId.toString()) ?? null
  }

  /**
   * 批量版仓位详情。
   *
   * Map 的 key 是 **`tokenId.toString()`**（旧版 key 是 nftMint 的 base58 字符串，
   * 同样是「字符串化的仓位标识」，语义对齐）。不存在的仓位对应的值是 `null` 且**键仍在**，
   * 调用方遍历 Map 就能知道哪些查空了，不用再拿原始列表去比对。
   *
   * RPC：**不是** N 份单查的简单叠加 —— 这里先按 `(token0, token1, tickSpacing)` 把池子去重、
   * 再把所有代币合并成一次 `getTokenInfoList`。一屏 40 个同池仓位时，
   * 池子状态只读 1 次而不是 40 次（简单地 `Promise.all(map(单查))` 会因为缓存还没写入而全部落空）。
   */
  async getPositionInfoByNftMints(
    list: Numericish[],
    opts: ICompatPositionInfoOptions = {},
  ): Promise<Map<string, ICompatPositionInfo | null>> {
    if (!Array.isArray(list)) {
      throw new Error(
        `${COMPAT_ERR_PREFIX} getPositionInfoByNftMints 的第一个参数必须是数组（tokenId 列表），` +
          `收到 ${String(list)}。单个仓位请用 getPositionInfoByNftMint。`,
      )
    }
    const tokenIds = list.map((v, i) => toBigInt(v, `nftMintList[${i}]`))
    return this.loadPositionInfos(tokenIds, opts)
  }

  // =========================================================================
  // 写 · 全部透传给 CompatCLMMClient（chain 上也要能直接调）
  //
  // 签名一律用 Parameters/ReturnType 从 CompatCLMMClient 上取，而不是在这里重抄一遍：
  // 重抄的那份迟早与真身漂移，而这是产出 calldata 的路径，漂移就是资金风险。
  // =========================================================================

  /** 开仓（旧名）。→ {@link CompatCLMMClient.createPositionInstructions} */
  createPositionInstructions(
    ...args: Parameters<CompatCLMMClient['createPositionInstructions']>
  ): ReturnType<CompatCLMMClient['createPositionInstructions']> {
    return this.clmmClient.createPositionInstructions(...args)
  }

  /** 开仓（短名）。→ {@link CompatCLMMClient.createPosition} */
  createPosition(
    ...args: Parameters<CompatCLMMClient['createPosition']>
  ): ReturnType<CompatCLMMClient['createPosition']> {
    return this.clmmClient.createPosition(...args)
  }

  /** 加仓（旧名）。→ {@link CompatCLMMClient.addLiquidityInstructions} */
  addLiquidityInstructions(
    ...args: Parameters<CompatCLMMClient['addLiquidityInstructions']>
  ): ReturnType<CompatCLMMClient['addLiquidityInstructions']> {
    return this.clmmClient.addLiquidityInstructions(...args)
  }

  /** 加仓（短名）。→ {@link CompatCLMMClient.addLiquidity} */
  addLiquidity(
    ...args: Parameters<CompatCLMMClient['addLiquidity']>
  ): ReturnType<CompatCLMMClient['addLiquidity']> {
    return this.clmmClient.addLiquidity(...args)
  }

  /** 减仓（旧名）。→ {@link CompatCLMMClient.decreaseLiquidityInstructions} */
  decreaseLiquidityInstructions(
    ...args: Parameters<CompatCLMMClient['decreaseLiquidityInstructions']>
  ): ReturnType<CompatCLMMClient['decreaseLiquidityInstructions']> {
    return this.clmmClient.decreaseLiquidityInstructions(...args)
  }

  /** 减仓（短名）。→ {@link CompatCLMMClient.decreaseLiquidity} */
  decreaseLiquidity(
    ...args: Parameters<CompatCLMMClient['decreaseLiquidity']>
  ): ReturnType<CompatCLMMClient['decreaseLiquidity']> {
    return this.clmmClient.decreaseLiquidity(...args)
  }

  /** 撤出全部流动性（旧名）。→ {@link CompatCLMMClient.decreaseFullLiquidityInstructions} */
  decreaseFullLiquidityInstructions(
    ...args: Parameters<CompatCLMMClient['decreaseFullLiquidityInstructions']>
  ): ReturnType<CompatCLMMClient['decreaseFullLiquidityInstructions']> {
    return this.clmmClient.decreaseFullLiquidityInstructions(...args)
  }

  /** 撤出全部流动性（短名）。→ {@link CompatCLMMClient.decreaseFullLiquidity} */
  decreaseFullLiquidity(
    ...args: Parameters<CompatCLMMClient['decreaseFullLiquidity']>
  ): ReturnType<CompatCLMMClient['decreaseFullLiquidity']> {
    return this.clmmClient.decreaseFullLiquidity(...args)
  }

  /** 撤出全部流动性（旧代码里的另一个别名）。→ {@link CompatCLMMClient.removeFullLiquidity} */
  removeFullLiquidity(
    ...args: Parameters<CompatCLMMClient['removeFullLiquidity']>
  ): ReturnType<CompatCLMMClient['removeFullLiquidity']> {
    return this.clmmClient.removeFullLiquidity(...args)
  }

  /** 关仓（旧名）。→ {@link CompatCLMMClient.closePositionInstructions} */
  closePositionInstructions(
    ...args: Parameters<CompatCLMMClient['closePositionInstructions']>
  ): ReturnType<CompatCLMMClient['closePositionInstructions']> {
    return this.clmmClient.closePositionInstructions(...args)
  }

  /** 关仓（短名）。→ {@link CompatCLMMClient.closePosition} */
  closePosition(
    ...args: Parameters<CompatCLMMClient['closePosition']>
  ): ReturnType<CompatCLMMClient['closePosition']> {
    return this.clmmClient.closePosition(...args)
  }

  /** 领取手续费（旧名）。→ {@link CompatCLMMClient.collectFeesInstructions} */
  collectFeesInstructions(
    ...args: Parameters<CompatCLMMClient['collectFeesInstructions']>
  ): ReturnType<CompatCLMMClient['collectFeesInstructions']> {
    return this.clmmClient.collectFeesInstructions(...args)
  }

  /** 领取手续费（短名）。→ {@link CompatCLMMClient.collectFees} */
  collectFees(
    ...args: Parameters<CompatCLMMClient['collectFees']>
  ): ReturnType<CompatCLMMClient['collectFees']> {
    return this.clmmClient.collectFees(...args)
  }

  /** 一次领完多个仓位的手续费（旧名）。→ {@link CompatCLMMClient.collectAllPositionFeesInstructions} */
  collectAllPositionFeesInstructions(
    ...args: Parameters<CompatCLMMClient['collectAllPositionFeesInstructions']>
  ): ReturnType<CompatCLMMClient['collectAllPositionFeesInstructions']> {
    return this.clmmClient.collectAllPositionFeesInstructions(...args)
  }

  /** 一次领完多个仓位的手续费（短名）。→ {@link CompatCLMMClient.collectAllFees} */
  collectAllFees(
    ...args: Parameters<CompatCLMMClient['collectAllFees']>
  ): ReturnType<CompatCLMMClient['collectAllFees']> {
    return this.clmmClient.collectAllFees(...args)
  }

  // =========================================================================
  // 内部：仓位详情的组装流水线
  // =========================================================================

  /**
   * 单查与批量查共用的实现：**单查就是 N=1 的批量查**。
   *
   * 分四步，每一步都先在本地去重再打 RPC：
   * ① 仓位状态（并发 N 次 eth_call，不存在的落 null）
   * ② 池子状态（按 token0/token1/tickSpacing 去重后并发）
   * ③ 代币元数据（所有池子的两边合并成一次 multicall）
   * ④ 待领手续费（仅 `withFees: true`）
   */
  private async loadPositionInfos(
    tokenIds: bigint[],
    opts: ICompatPositionInfoOptions,
  ): Promise<Map<string, ICompatPositionInfo | null>> {
    const result = new Map<string, ICompatPositionInfo | null>()
    // 去重：同一个 tokenId 传两次不该读两次链（Map 里本来也只会留一份）
    const seen = new Set<string>()
    const unique: bigint[] = []
    for (const id of tokenIds) {
      const key = id.toString()
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(id)
    }
    if (unique.length === 0) return result

    // —— ① 仓位状态 ——
    const states = await Promise.all(unique.map((id) => this.tryGetRawPositionInfo(id)))
    const found = unique
      .map((tokenId, i) => ({ tokenId, state: states[i] }))
      .filter((x): x is { tokenId: bigint; state: IPositionStateRaw } => x.state !== null)

    // —— ② 池子状态（按池子身份去重）——
    const poolStateByKey = await this.loadPoolStates(found.map((x) => x.state))

    // —— ③ 代币元数据（一次 multicall 读齐）——
    const tokenInfoByAddress = await this.loadTokenInfos([...poolStateByKey.values()])

    // —— ④ 待领手续费（可选）——
    const feesByTokenId = opts.withFees
      ? await this.loadPendingFees(
          found.map((x) => x.tokenId),
          opts.owner,
        )
      : undefined

    // —— 组装（按传入顺序，查空的显式落 null）——
    for (let i = 0; i < unique.length; i++) {
      const tokenId = unique[i]
      const key = tokenId.toString()
      const positionState = states[i]
      if (positionState === null) {
        result.set(key, null)
        continue
      }
      const poolState = poolStateByKey.get(this.poolKeyOf(positionState))!
      const token0 = tokenInfoByAddress.get(poolState.token0.toLowerCase())!
      const token1 = tokenInfoByAddress.get(poolState.token1.toLowerCase())!
      result.set(
        key,
        this.buildPositionInfo({
          positionState,
          poolState,
          token0,
          token1,
          pendingFees: feesByTokenId?.get(key) ?? null,
        }),
      )
    }
    return result
  }

  /** 读单个仓位状态，「合约说不存在」落成 null，其余错误原样抛（见 {@link isPositionNotFoundError}） */
  private async tryGetRawPositionInfo(tokenId: bigint): Promise<IPositionStateRaw | null> {
    try {
      return await this.sdk.chain.getRawPositionInfo(tokenId)
    } catch (e) {
      if (isPositionNotFoundError(e)) return null
      throw e
    }
  }

  /**
   * 仓位所属池子的身份 key：`token0-token1-tickSpacing`（全小写）。
   * 仓位本身不记 poolAddress，这三项就是它定位池子的**全部**依据
   * （定制合约的池身份键；与核心 `chain.getPoolAddressByPosition` 用的是同一组字段）。
   */
  private poolKeyOf(positionState: IPositionStateRaw): string {
    return `${positionState.token0.toLowerCase()}-${positionState.token1.toLowerCase()}-${positionState.tickSpacing}`
  }

  /** 按池子身份去重后并发读池子状态，返回 `poolKey → IPoolStateRaw` */
  private async loadPoolStates(states: IPositionStateRaw[]): Promise<Map<string, IPoolStateRaw>> {
    const representative = new Map<string, IPositionStateRaw>()
    for (const state of states) {
      const key = this.poolKeyOf(state)
      if (!representative.has(key)) representative.set(key, state)
    }
    const entries = await Promise.all(
      [...representative].map(async ([key, state]) => {
        const poolAddress = await this.sdk.chain.getPoolAddressByPosition(state)
        return [key, await this.sdk.chain.getRawPoolInfo(poolAddress)] as const
      }),
    )
    return new Map(entries)
  }

  /** 把若干池子的 token0/token1 合并去重，一次 multicall 读齐元数据，返回 `小写地址 → ITokenInfo` */
  private async loadTokenInfos(poolStates: IPoolStateRaw[]): Promise<Map<string, ITokenInfo>> {
    const addresses: Address[] = []
    const seen = new Set<string>()
    for (const poolState of poolStates) {
      for (const address of [poolState.token0, poolState.token1]) {
        const key = address.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        addresses.push(address)
      }
    }
    const infos = await this.sdk.chain.getTokenInfoList(addresses)
    return new Map(infos.map((info) => [info.address.toLowerCase(), info]))
  }

  /**
   * 并发取各仓位的精确待领手续费，返回 `tokenId.toString() → IPendingFees`。
   *
   * 这里**失败就抛**，不降级成 `null`：调用方是显式传了 `withFees: true` 才走到这条路的，
   * 悄悄退回 null 会让 UI 显示成「没有手续费可领」——那正是 §4.4 要防的假数据。
   */
  private async loadPendingFees(
    tokenIds: bigint[],
    owner?: string,
  ): Promise<Map<string, IPendingFees>> {
    if (tokenIds.length === 0) return new Map()
    const fixedOwner = owner === undefined ? undefined : toAddress(owner, 'owner')

    const entries = await Promise.all(
      tokenIds.map(async (tokenId) => {
        const ownerAddress = fixedOwner ?? (await this.getPositionOwner(tokenId))
        try {
          const fees = await this.sdk.chain.getPendingFees({ tokenId, owner: ownerAddress })
          return [tokenId.toString(), fees] as const
        } catch (e) {
          throw new Error(
            `${COMPAT_ERR_PREFIX} 读取仓位 #${tokenId} 的待领手续费失败（owner=${ownerAddress}）。` +
              `collect 预演会过合约的 isAuthorizedForToken 检查，owner 必须是该仓位的持有人或被 approve 的 operator；` +
              `若只想看本金，去掉 withFees 即可（feeAmount 会是 null）。原始错误：${(e as Error).message}`,
          )
        }
      }),
    )
    return new Map(entries)
  }

  /**
   * 读仓位持有人（`ownerOf(tokenId)`，1 次 eth_call）。
   *
   * 只在 `withFees: true` 且调用方没传 `owner` 时才走这里。用核心 SDK 的 `NPM_ABI` 直接
   * `readContract` 而不是自己声明 ABI 片段：这是**只读**调用，不产出任何 calldata，
   * 不触碰「compat 只有 collectAllPositionFees 可以自己拼 calldata」那条约束。
   */
  private async getPositionOwner(tokenId: bigint): Promise<Address> {
    return (await this.sdk.publicClient.readContract({
      address: this.sdk.contracts.positionManager,
      abi: NPM_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    })) as Address
  }

  /**
   * 纯本地组装（0 RPC）：仓位快照 + 池子快照 + 代币元数据 → {@link ICompatPositionInfo}。
   *
   * 数学全部委托核心 `getPositionView`（amounts / 价格区间 / inRange / isFullRange），
   * compat 只负责铺 `ui*` 字符串和旧字段别名 —— 兼容层里一行定点数运算都不该有。
   */
  private buildPositionInfo(args: {
    positionState: IPositionStateRaw
    poolState: IPoolStateRaw
    token0: ITokenInfo
    token1: ITokenInfo
    pendingFees: IPendingFees | null
  }): ICompatPositionInfo {
    const { positionState, poolState, pendingFees } = args
    const view = getPositionView({
      poolState,
      positionState,
      token0: args.token0,
      token1: args.token1,
    })

    const side = (info: ITokenInfo, amount: bigint, feeAmount: bigint | null): ICompatPositionSide => ({
      address: info.address,
      decimals: info.decimals,
      symbol: info.symbol,
      amount,
      feeAmount,
      uiAmount: toUiAmount(amount, info.decimals),
      // 拿不到手续费时 uiFeeAmount 同样是 null，绝不落成 "0" ——
      // UI 直接渲染这个字段，一个 "0" 就等于告诉用户「没得领」
      uiFeeAmount: feeAmount === null ? null : toUiAmount(feeAmount, info.decimals),
    })

    const token0 = side(args.token0, view.amount0, pendingFees?.amount0 ?? null)
    const token1 = side(args.token1, view.amount1, pendingFees?.amount1 ?? null)

    return {
      tokenId: view.tokenId,
      poolAddress: view.poolAddress,
      tickLower: view.tickLower,
      tickUpper: view.tickUpper,
      liquidity: view.liquidity,
      inRange: view.inRange,
      isFullRange: view.isFullRange,

      priceLower: view.priceLower,
      priceUpper: view.priceUpper,
      currentPrice: view.currentPrice,
      // 旧字段名，与上面**是同一个字符串**（旧版给 Decimal + ui 两份，口径漂移过，这里只留一个真相源）
      uiPriceLower: view.priceLower,
      uiPriceUpper: view.priceUpper,

      token0,
      token1,
      // 必须是同一个对象引用而不是深拷贝：EVM 上 A 恒等于 token0（池子内按地址升序），
      // 引用相等能让「改了一处另一处没跟上」这种 bug 在结构上不可能发生
      tokenA: token0,
      tokenB: token1,

      rawPositionInfo: positionState,
      rawPoolInfo: poolState,
    }
  }
}
