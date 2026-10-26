/**
 * CLMM 流动性动作实现（`sdk.clmmClient.*`）：SDK 里唯一产出写操作 calldata 的地方。
 * 每个方法走「前置读 fresh state → 本地算 min → 拼 calldata → 返回未签名交易」四步。
 * 写操作的协议约束见 docs/core.md。
 */
import { encodeFunctionData, formatUnits, type Address, type Hex } from 'viem'

import { ERC20_ABI, NPM_ABI } from '../abis.js'
import type { Chain } from '../chain/index.js'
import {
  alignTick,
  getAmountsFromAmount,
  getBurnAmountsWithSlippage,
  getMintAmountsWithSlippage,
  getPositionView,
} from '../calculate.js'
import { DEFAULT_DEADLINE_SEC, DEFAULT_SLIPPAGE_BPS, MAX_UINT128 } from '../constants.js'
import type {
  IAddLiquidityParams,
  IClosePositionParams,
  ICollectFeesParams,
  ICreatePositionParams,
  IDecreaseLiquidityParams,
  IDecreaseMeta,
  ILiquidityMeta,
  IPendingFees,
  IPoolStateRaw,
  IPositionStateRaw,
  ITokenInfo,
  ITransactionReturn,
  IUnsignedTx,
} from '../types.js'
import { deadlineFromNow, percentOf } from '../utils/index.js'

import { AbstractLiquidityClient, type ICreatePositionMeta } from './abstract.js'

/** uint256 最大值：仅用于「调用方自带快照、跳过前置读」时把余额/授权当作无穷大 */
const UNLIMITED = (1n << 256n) - 1n

/** 前置读拿回来的一组上下文（调用方自带快照时会退化成「无穷余额 + 无穷授权」） */
interface IWriteContext {
  poolState: IPoolStateRaw
  balance0: bigint
  balance1: bigint
  allowance0: bigint
  allowance1: bigint
  /** true = 本次没有读链，余额/授权校验被跳过（责任在调用方） */
  offline: boolean
}

export class CLMMClient extends AbstractLiquidityClient {
  constructor(params: { chain: Chain }) {
    super(params)
  }

  // =========================================================================
  // 14 · 开仓（mint）
  // =========================================================================

  /**
   * 开仓：mint 一个新的仓位 NFT。
   *
   * RPC：**1 次前置 multicall**（slot0 + liquidity + feeGrowth×2 + balance×2 + allowance×2）；
   *      池子不变字段 / 代币元数据未缓存时各多一次 multicall
   *      （冷启动实测 3 次请求，热路径 1 次）。
   * 产出交易：**0~2 笔 approve + 1 笔 `NPM.mint`**，按数组顺序依次发送。
   *
   * 关键点：
   * - tick 先按 tickSpacing 对齐（下界向下取整、上界向上取整，保证区间不被收窄），再校验 lower < upper；
   * - 由 `base` 那一边的金额反推另一边和流动性 L（`Position.fromAmount0/1`，无解方向会被挡住）；
   * - amount0Min/amount1Min 走 `mintAmountsWithSlippage`（按价格漂移严格算，不是金额线性打折）；
   * - approve 只授权本次需要的额度，**不做无限授权**（额度策略交给上层，SDK 不替用户扩大风险敞口）。
   *
   * 原生币（ETH/MNT）开仓不在这里处理：先由调用方把原生币换成 WETH/WMNT
   * 再走本方法，mint 交易的 value 恒为 0，语义最简单。
   *
   * Byreal 定制合约的 mint 结构体与原生 V3 有两处不同（选择器随之变为 0xda28d63d）：
   * 第 3 个字段是 tickSpacing（不再是 fee），尾部多一个 followTokenId（默认 0 = 不跟随；
   * 非 0 时合约对目标仓位做五项强制校验，见 ICreatePositionParams.followTokenId 的说明）。
   */
  async createPosition(params: ICreatePositionParams): Promise<ITransactionReturn<ICreatePositionMeta>> {
    const {
      poolAddress,
      userAddress,
      base,
      baseAmount,
      recipient = userAddress,
      followTokenId = 0n,
      autoApprove = true,
      validateBalance = true,
      slippageBps = DEFAULT_SLIPPAGE_BPS,
      deadlineSec = DEFAULT_DEADLINE_SEC,
    } = params

    if (baseAmount <= 0n) {
      throw new Error(`[evm-clmm-sdk] baseAmount 必须大于 0，收到 ${baseAmount}`)
    }

    // —— ① 前置读：fresh 池子状态 + 余额 + 授权（1 次 multicall）——
    const ctx = await this.loadMintContext({ poolAddress, userAddress, params })
    const { poolState } = ctx
    const [token0, token1] = await this.getTokenInfoPair(poolState.token0, poolState.token1)

    // —— ② 本地数学：对齐 tick → 反推另一边 → 算滑点下限 ——
    const tickLower = alignTick({ tick: params.tickLower, tickSpacing: poolState.tickSpacing, mode: 'down' })
    const tickUpper = alignTick({ tick: params.tickUpper, tickSpacing: poolState.tickSpacing, mode: 'up' })
    if (tickLower >= tickUpper) {
      throw new Error(
        `[evm-clmm-sdk] 区间非法：对齐到 tickSpacing=${poolState.tickSpacing} 后 ` +
          `tickLower(${tickLower}) >= tickUpper(${tickUpper})。请把区间放宽到至少一个 tickSpacing。`,
      )
    }

    const amounts = getAmountsFromAmount({
      poolState,
      token0,
      token1,
      tickLower,
      tickUpper,
      base,
      baseAmount,
    })
    if (amounts.liquidity <= 0n) {
      throw new Error(this.describeNoSolution({ poolState, tickLower, tickUpper, base, token0, token1 }))
    }

    const { amount0Min, amount1Min } = getMintAmountsWithSlippage({
      poolState,
      token0,
      token1,
      tickLower,
      tickUpper,
      liquidity: amounts.liquidity,
      slippageBps,
    })

    // —— ③ 余额校验 + 可选前置 approve ——
    const { transactions, approvals } = this.prepareFunding({
      ctx,
      token0,
      token1,
      amount0: amounts.amount0,
      amount1: amounts.amount1,
      autoApprove,
      validateBalance,
    })

    // —— ④ 拼 mint calldata ——
    const deadline = deadlineFromNow(deadlineSec)
    transactions.push({
      to: this.npm,
      data: encodeFunctionData({
        abi: NPM_ABI,
        functionName: 'mint',
        args: [
          {
            token0: poolState.token0,
            token1: poolState.token1,
            tickSpacing: poolState.tickSpacing,
            tickLower,
            tickUpper,
            amount0Desired: amounts.amount0,
            amount1Desired: amounts.amount1,
            amount0Min,
            amount1Min,
            recipient,
            deadline,
            followTokenId,
          },
        ],
      }),
      // 池子只认 ERC20；用原生币请先 wrap，这里恒为 0
      value: 0n,
      chainId: this.chainId,
      label: `开仓 mint ${token0.symbol}/${token1.symbol} ${poolState.tradeFeeRate / 10000}%（区间 [${tickLower}, ${tickUpper}]）`,
    })

    return this.toReturn(transactions, {
      poolAddress: poolState.poolAddress,
      token0,
      token1,
      tickLower,
      tickUpper,
      liquidity: amounts.liquidity,
      amount0Desired: amounts.amount0,
      amount1Desired: amounts.amount1,
      amount0Min,
      amount1Min,
      deadline,
      approvals,
    })
  }

  // =========================================================================
  // 15 · 加流动性（increaseLiquidity）
  // =========================================================================

  /**
   * 往已有仓位追加流动性。**区间不可改** —— tickLower/tickUpper 一律以链上仓位为准，
   * 想换区间只能「关仓 + 重新开仓」（Uniswap V3 的 NFT 语义如此）。
   *
   * RPC：`positions` 1 次 → （首次）Factory 反查 1 次 → 前置 multicall 1 次，
   *      代币元数据未缓存再多 1 次；热路径实测 2 次请求。
   * 产出交易：**0~2 笔 approve + 1 笔 `NPM.increaseLiquidity`**。
   */
  async addLiquidity(params: IAddLiquidityParams): Promise<ITransactionReturn<ILiquidityMeta>> {
    const {
      tokenId,
      userAddress,
      base,
      baseAmount,
      autoApprove = true,
      slippageBps = DEFAULT_SLIPPAGE_BPS,
      deadlineSec = DEFAULT_DEADLINE_SEC,
    } = params

    if (baseAmount <= 0n) {
      throw new Error(`[evm-clmm-sdk] baseAmount 必须大于 0，收到 ${baseAmount}`)
    }

    // —— ① 前置读：仓位 + 它所属池子的 fresh 状态 + 余额 + 授权 ——
    const { positionState, ctx } = await this.loadModifyContext({
      tokenId,
      userAddress,
      params,
      // 加仓要花钱，除非调用方明确关掉 autoApprove 并自带快照，否则必须读 fresh 余额/授权
      allowOffline: autoApprove === false,
    })
    const { poolState } = ctx
    const [token0, token1] = await this.getTokenInfoPair(poolState.token0, poolState.token1)

    // —— ② 本地数学：沿用仓位既有区间 ——
    const { tickLower, tickUpper } = positionState
    const amounts = getAmountsFromAmount({
      poolState,
      token0,
      token1,
      tickLower,
      tickUpper,
      base,
      baseAmount,
    })
    if (amounts.liquidity <= 0n) {
      throw new Error(this.describeNoSolution({ poolState, tickLower, tickUpper, base, token0, token1 }))
    }

    const { amount0Min, amount1Min } = getMintAmountsWithSlippage({
      poolState,
      token0,
      token1,
      tickLower,
      tickUpper,
      liquidity: amounts.liquidity,
      slippageBps,
    })

    // —— ③ 余额校验 + 可选前置 approve ——
    const { transactions, approvals } = this.prepareFunding({
      ctx,
      token0,
      token1,
      amount0: amounts.amount0,
      amount1: amounts.amount1,
      autoApprove,
    })

    // —— ④ 拼 increaseLiquidity calldata ——
    const deadline = deadlineFromNow(deadlineSec)
    transactions.push({
      to: this.npm,
      data: encodeFunctionData({
        abi: NPM_ABI,
        functionName: 'increaseLiquidity',
        args: [
          {
            tokenId,
            amount0Desired: amounts.amount0,
            amount1Desired: amounts.amount1,
            amount0Min,
            amount1Min,
            deadline,
          },
        ],
      }),
      value: 0n,
      chainId: this.chainId,
      label: `加仓 #${tokenId}（${token0.symbol}/${token1.symbol}）`,
    })

    return this.toReturn(transactions, {
      tickLower,
      tickUpper,
      liquidity: amounts.liquidity,
      amount0Desired: amounts.amount0,
      amount1Desired: amounts.amount1,
      amount0Min,
      amount1Min,
      deadline,
      approvals,
    })
  }

  // =========================================================================
  // 16 · 减仓（decreaseLiquidity [+ collect]）
  // =========================================================================

  /**
   * 减仓：`percent`（0~100）与 `liquidity`（绝对数量）**二选一**，都不传或都传都会报错。
   *
   * RPC：与 addLiquidity 同一套前置读（热路径 2 次；代币元数据未缓存时 3 次）。
   * 产出交易：**1 笔**。
   *
   * ⚠️ 最容易踩的坑：Uniswap 的 `decreaseLiquidity` **只把撤出的本金记进仓位的 tokensOwed**，
   * 资产并不会打回钱包；不跟一次 `collect` 就等于「钱还锁在 NPM 合约里」。
   * 所以 `params.collect !== false`（默认 true）时，这里用
   * `NPM.multicall([decreaseLiquidity, collect(uint128.max)])` 把两步打成**一笔原子交易**，
   * 顺带把这期间累积的手续费一起领走。只有明确传 `collect: false` 才会退化成裸 decrease。
   */
  async decreaseLiquidity(params: IDecreaseLiquidityParams): Promise<ITransactionReturn<IDecreaseMeta>> {
    const {
      tokenId,
      userAddress,
      recipient = userAddress,
      collect = true,
      slippageBps = DEFAULT_SLIPPAGE_BPS,
      deadlineSec = DEFAULT_DEADLINE_SEC,
    } = params

    const hasPercent = params.percent !== undefined
    const hasLiquidity = params.liquidity !== undefined
    if (hasPercent === hasLiquidity) {
      throw new Error(
        '[evm-clmm-sdk] decreaseLiquidity 的 percent 与 liquidity 必须二选一：' +
          `当前 percent=${String(params.percent)}、liquidity=${String(params.liquidity)}。`,
      )
    }
    if (hasPercent && !(params.percent! > 0 && params.percent! <= 100)) {
      throw new Error(`[evm-clmm-sdk] percent 必须在 (0, 100] 之间，收到 ${params.percent}`)
    }

    // —— ① 前置读（减仓不花钱，调用方自带快照时可完全跳过读链）——
    const { positionState, ctx } = await this.loadModifyContext({
      tokenId,
      userAddress,
      params,
      allowOffline: true,
    })
    const { poolState } = ctx

    if (positionState.liquidity <= 0n) {
      throw new Error(`[evm-clmm-sdk] 仓位 #${tokenId} 的流动性已经是 0，无法减仓。`)
    }

    const liquidityToRemove = hasPercent
      ? percentOf(positionState.liquidity, params.percent!)
      : params.liquidity!

    if (liquidityToRemove <= 0n) {
      throw new Error(
        `[evm-clmm-sdk] 计算出的待移除流动性为 0（仓位 L=${positionState.liquidity}，percent=${String(params.percent)}）。` +
          '请提高 percent 或直接指定 liquidity。',
      )
    }
    if (liquidityToRemove > positionState.liquidity) {
      throw new Error(
        `[evm-clmm-sdk] 待移除流动性 ${liquidityToRemove} 超过仓位现有流动性 ${positionState.liquidity}。`,
      )
    }

    // —— ② 本地数学：预计撤回多少本金 + 滑点下限 ——
    const [token0, token1] = await this.getTokenInfoPair(poolState.token0, poolState.token1)
    const { expectedAmount0, expectedAmount1, amount0Min, amount1Min } = this.estimateBurn({
      poolState,
      positionState,
      token0,
      token1,
      liquidity: liquidityToRemove,
      slippageBps,
    })

    // —— ③ 拼 calldata：decrease（+ collect）——
    const deadline = deadlineFromNow(deadlineSec)
    const calls: Hex[] = [
      this.encodeDecrease({ tokenId, liquidity: liquidityToRemove, amount0Min, amount1Min, deadline }),
    ]
    if (collect) {
      // uint128.max = 「能领多少领多少」：刚撤出的本金 + 这期间累积的手续费一次领干净
      calls.push(this.encodeCollect({ tokenId, recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }))
    }

    const transactions: IUnsignedTx[] = [
      {
        to: this.npm,
        data: this.packCalls(calls),
        value: 0n,
        chainId: this.chainId,
        label: collect
          ? `减仓 #${tokenId}（decreaseLiquidity + collect 一笔 multicall）`
          : `减仓 #${tokenId}（仅 decreaseLiquidity，资产留在 tokensOwed，需另行 collect）`,
      },
    ]

    return this.toReturn(transactions, {
      liquidity: liquidityToRemove,
      amount0Min,
      amount1Min,
      expectedAmount0,
      expectedAmount1,
      deadline,
    })
  }

  // =========================================================================
  // 17 · 提取手续费（collect）
  // =========================================================================

  /**
   * 提取手续费（以及之前 decrease 撤出、还没领走的本金）。
   *
   * RPC：**1 次 eth_call** —— 对 `collect` 做 staticcall 拿「精确可领额」填进 meta
   *      （见 chain.getPendingFees：合约会先跑一次结算，所以拿到的是含未结算部分的实时值）；
   *      调用方传了 `pendingFees` 快照时 **0 次**。
   * 产出交易：**1 笔 `NPM.collect`**。
   *
   * amount0Max/amount1Max 默认 uint128.max = 能领多少领多少；传了自定义上限时 meta 会按上限截断。
   *
   * 注意这次 staticcall **只影响 meta，不影响 calldata** —— collect 的入参只有
   * tokenId / recipient / max，跟可领额无关。所以和其它写方法一样留了逃生口：
   * 传 `pendingFees` 即可跳过读链（dry-run 虚拟区块里的仓位还没上链，staticcall 必然失败）。
   *
   * ⚠️ 走读链分支时，staticcall 会过合约的 `isAuthorizedForToken` 检查，所以 `userAddress` 必须是
   * 该仓位的 owner 或被 approve 的 operator，否则这里就会报错（真发交易同样会 revert，提前暴露更好）。
   */
  async collectFees(params: ICollectFeesParams): Promise<ITransactionReturn<IPendingFees>> {
    const {
      tokenId,
      userAddress,
      recipient = userAddress,
      amount0Max = MAX_UINT128,
      amount1Max = MAX_UINT128,
    } = params

    // —— ① 前置读：静态预演一次 collect，拿精确可领额（调用方自带快照时跳过）——
    let pending: IPendingFees
    if (params.pendingFees) {
      pending = params.pendingFees
    } else {
      try {
        pending = await this._chain.getPendingFees({ tokenId, owner: userAddress, recipient })
      } catch (e) {
        throw new Error(
          `[evm-clmm-sdk] 预演 collect 失败（仓位 #${tokenId}，操作人 ${userAddress}）：` +
            `请确认 tokenId 存在且该地址是仓位 owner / 已被 approve；` +
            `若仓位尚未上链（dry-run 预演），请改为传入 pendingFees 快照跳过这次读链。` +
            `原始错误：${(e as Error).message}`,
        )
      }
    }

    // —— ② 本地：按调用方给的上限截断，得到真正能到账的数量 ——
    const amount0 = pending.amount0 < amount0Max ? pending.amount0 : amount0Max
    const amount1 = pending.amount1 < amount1Max ? pending.amount1 : amount1Max

    // —— ③ 拼 collect calldata ——
    const transactions: IUnsignedTx[] = [
      {
        to: this.npm,
        data: this.encodeCollect({ tokenId, recipient, amount0Max, amount1Max }),
        value: 0n,
        chainId: this.chainId,
        label: `提取仓位 #${tokenId} 的手续费 / 已撤本金`,
      },
    ]

    return this.toReturn(transactions, { amount0, amount1 })
  }

  // =========================================================================
  // 16b · 关仓（decrease 全部 + collect + burn，一笔原子交易）
  // =========================================================================

  /**
   * 关仓：撤出**全部**流动性 → 提取本金与手续费 → 销毁仓位 NFT。
   *
   * RPC：与 addLiquidity 同一套前置读（热路径 2 次；代币元数据未缓存时 3 次）。
   * 产出交易：**1 笔** `NPM.multicall([decreaseLiquidity(全部), collect(max), burn])`。
   *
   * 为什么必须打包成一笔：`burn` 要求仓位的 liquidity == 0 **且** tokensOwed 已清空，
   * 分三笔发会有中间状态（撤了没领 / 领了没销毁），用户中断就留下脏仓位。
   * 仓位流动性本来就是 0 时（只剩手续费待领），自动跳过 decrease 那一条。
   */
  async closePosition(params: IClosePositionParams): Promise<ITransactionReturn<IDecreaseMeta>> {
    const {
      tokenId,
      userAddress,
      recipient = userAddress,
      slippageBps = DEFAULT_SLIPPAGE_BPS,
      deadlineSec = DEFAULT_DEADLINE_SEC,
    } = params

    // —— ① 前置读 ——
    const { positionState, ctx } = await this.loadModifyContext({
      tokenId,
      userAddress,
      params,
      allowOffline: true,
    })
    const { poolState } = ctx
    const [token0, token1] = await this.getTokenInfoPair(poolState.token0, poolState.token1)

    // —— ② 本地数学：全部流动性对应的本金与滑点下限 ——
    const liquidity = positionState.liquidity
    const deadline = deadlineFromNow(deadlineSec)
    let expectedAmount0 = 0n
    let expectedAmount1 = 0n
    let amount0Min = 0n
    let amount1Min = 0n

    const calls: Hex[] = []
    if (liquidity > 0n) {
      const est = this.estimateBurn({
        poolState,
        positionState,
        token0,
        token1,
        liquidity,
        slippageBps,
      })
      expectedAmount0 = est.expectedAmount0
      expectedAmount1 = est.expectedAmount1
      amount0Min = est.amount0Min
      amount1Min = est.amount1Min
      calls.push(this.encodeDecrease({ tokenId, liquidity, amount0Min, amount1Min, deadline }))
    }
    // 本金 + 手续费一次领干净，否则下面的 burn 会因 tokensOwed 非 0 而 revert
    calls.push(this.encodeCollect({ tokenId, recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }))
    calls.push(encodeFunctionData({ abi: NPM_ABI, functionName: 'burn', args: [tokenId] }))

    // —— ③ 拼一笔 multicall ——
    const transactions: IUnsignedTx[] = [
      {
        to: this.npm,
        data: this.packCalls(calls),
        value: 0n,
        chainId: this.chainId,
        label:
          `关仓 #${tokenId}（${liquidity > 0n ? 'decreaseLiquidity + ' : ''}collect + burn，` +
          `${calls.length} 步打成一笔 multicall）`,
      },
    ]

    return this.toReturn(transactions, {
      liquidity,
      amount0Min,
      amount1Min,
      expectedAmount0,
      expectedAmount1,
      deadline,
    })
  }

  // =========================================================================
  // 内部：前置读上下文
  // =========================================================================

  /** NonfungiblePositionManager 地址（所有写操作的目标合约，也是 approve 的 spender） */
  private get npm(): Address {
    return this._chain.contracts.positionManager
  }

  private get chainId(): number {
    return this._chain.chainId
  }

  /**
   * 开仓的前置读。
   *
   * 调用方传了 `poolState` **且**明确 `autoApprove: false` 时，说明它已经在别处拿到了快照、
   * 也自己负责授权 —— 这时直接跳过读链（0 次 RPC），余额/授权校验一并跳过（责任在调用方）。
   * 其余情况都必须读 fresh 状态：滑点下限依赖发交易前一刻的价格。
   */
  private async loadMintContext(args: {
    poolAddress: Address
    userAddress: Address
    params: ICreatePositionParams
  }): Promise<IWriteContext> {
    const { poolAddress, userAddress, params } = args
    if (params.poolState && params.autoApprove === false) {
      return this.offlineContext(params.poolState)
    }
    const pre = await this._chain.getMintPrerequisites({ poolAddress, userAddress, spender: this.npm })
    return { ...pre, poolState: params.poolState ?? pre.poolState, offline: false }
  }

  /**
   * 改仓（加仓 / 减仓 / 关仓）的前置读。
   *
   * `allowOffline` 为 true 且调用方同时给了 positionState + poolState 时跳过读链；
   * 加仓因为要花钱，只有在 `autoApprove: false` 时才允许走这条路。
   */
  private async loadModifyContext(args: {
    tokenId: bigint
    userAddress: Address
    params: { poolState?: IPoolStateRaw; positionState?: IPositionStateRaw }
    allowOffline: boolean
  }): Promise<{ positionState: IPositionStateRaw; ctx: IWriteContext }> {
    const { tokenId, userAddress, params, allowOffline } = args

    if (allowOffline && params.poolState && params.positionState) {
      if (params.positionState.tokenId !== tokenId) {
        throw new Error(
          `[evm-clmm-sdk] 传入的 positionState.tokenId=${params.positionState.tokenId} 与参数 tokenId=${tokenId} 不一致。`,
        )
      }
      return { positionState: params.positionState, ctx: this.offlineContext(params.poolState) }
    }

    const pre = await this._chain.getModifyPrerequisites({ tokenId, userAddress, spender: this.npm })
    return {
      positionState: params.positionState ?? pre.positionState,
      ctx: {
        poolState: params.poolState ?? pre.poolState,
        balance0: pre.balance0,
        balance1: pre.balance1,
        allowance0: pre.allowance0,
        allowance1: pre.allowance1,
        offline: false,
      },
    }
  }

  /** 「调用方自带快照」时的上下文：余额与授权当作无穷大，等价于不做校验、不插 approve */
  private offlineContext(poolState: IPoolStateRaw): IWriteContext {
    return {
      poolState,
      balance0: UNLIMITED,
      balance1: UNLIMITED,
      allowance0: UNLIMITED,
      allowance1: UNLIMITED,
      offline: true,
    }
  }

  // =========================================================================
  // 内部：余额校验 + approve
  // =========================================================================

  /**
   * 校验余额，并在授权不足时插入前置 approve 交易。
   *
   * 授权额度**就给本次需要的数量**，不做无限授权：
   * SDK 不替用户扩大风险敞口，要不要 max approve 由上层产品决定。
   *
   * ⚠️ 少数老代币（USDT 等）要求「先把 allowance 置 0 再改成新值」，
   * 本层不自动插那笔 approve(0)（主流交易对不涉及，Uniswap 前端也是按需处理）；
   * 真遇到时上层自己补一笔 approve(0) 放到最前面即可。
   */
  private prepareFunding(args: {
    ctx: IWriteContext
    token0: ITokenInfo
    token1: ITokenInfo
    amount0: bigint
    amount1: bigint
    autoApprove: boolean
    validateBalance?: boolean
  }): { transactions: IUnsignedTx[]; approvals: Array<{ token: Address; amount: bigint }> } {
    const { ctx, token0, token1, amount0, amount1, autoApprove, validateBalance = true } = args
    const transactions: IUnsignedTx[] = []
    const approvals: Array<{ token: Address; amount: bigint }> = []

    const sides: Array<{ token: ITokenInfo; need: bigint; balance: bigint; allowance: bigint }> = [
      { token: token0, need: amount0, balance: ctx.balance0, allowance: ctx.allowance0 },
      { token: token1, need: amount1, balance: ctx.balance1, allowance: ctx.allowance1 },
    ]

    for (const side of sides) {
      if (side.need <= 0n) continue

      // 费用估算只关心交易结构与 Gas，不应被固定模拟金额或钱包余额阻断。
      if (validateBalance && side.balance < side.need) {
        throw new Error(
          `[evm-clmm-sdk] ${side.token.symbol} 余额不足：本次需要 ` +
            `${formatUnits(side.need, side.token.decimals)}，钱包只有 ` +
            `${formatUnits(side.balance, side.token.decimals)}（${side.token.address}）。`,
        )
      }

      if (side.allowance >= side.need) continue

      if (!autoApprove) {
        throw new Error(
          `[evm-clmm-sdk] ${side.token.symbol} 授权额度不足：需要 ` +
            `${formatUnits(side.need, side.token.decimals)}，当前只授权了 ` +
            `${formatUnits(side.allowance, side.token.decimals)}。` +
            `请先 approve 给 NonfungiblePositionManager(${this.npm})，或把 autoApprove 设为 true 让 SDK 自动插入 approve 交易。`,
        )
      }

      transactions.push(this.buildApproveTx(side.token.address, side.need, side.token.symbol))
      approvals.push({ token: side.token.address, amount: side.need })
    }

    return { transactions, approvals }
  }

  // =========================================================================
  // 内部：数学小包装
  // =========================================================================

  /**
   * 撤走 `liquidity` 这么多流动性时，预计拿回的本金（不含手续费）与滑点下限。
   *
   * 预期值走 `getPositionView`（= `position.amount0/1`，向下取整的持仓量），
   * 下限走 `burnAmountsWithSlippage`（按价格漂移严格算）。两者都在 calculate 层，
   * 本文件不碰任何 CLMM 数学。
   */
  private estimateBurn(args: {
    poolState: IPoolStateRaw
    positionState: IPositionStateRaw
    token0: ITokenInfo
    token1: ITokenInfo
    liquidity: bigint
    slippageBps: number
  }): { expectedAmount0: bigint; expectedAmount1: bigint; amount0Min: bigint; amount1Min: bigint } {
    const { poolState, positionState, token0, token1, liquidity, slippageBps } = args
    const { tickLower, tickUpper } = positionState

    // 用「只含待移除那部分流动性」的虚拟仓位来估算，与 Uniswap 合约里按比例结算的口径一致
    const view = getPositionView({
      poolState,
      positionState: { ...positionState, liquidity },
      token0,
      token1,
    })
    const { amount0Min, amount1Min } = getBurnAmountsWithSlippage({
      poolState,
      token0,
      token1,
      tickLower,
      tickUpper,
      liquidity,
      slippageBps,
    })
    return { expectedAmount0: view.amount0, expectedAmount1: view.amount1, amount0Min, amount1Min }
  }

  /** 一边金额在当前价格下无解时的中文提示（告诉用户该换哪一边输入） */
  private describeNoSolution(args: {
    poolState: IPoolStateRaw
    tickLower: number
    tickUpper: number
    base: string
    token0: ITokenInfo
    token1: ITokenInfo
  }): string {
    const { poolState, tickLower, tickUpper, base, token0, token1 } = args
    const where =
      poolState.tick < tickLower
        ? `当前价格在区间**下方**（tick=${poolState.tick} < tickLower=${tickLower}），仓位 100% 由 ${token0.symbol} 构成`
        : poolState.tick >= tickUpper
          ? `当前价格在区间**上方**（tick=${poolState.tick} >= tickUpper=${tickUpper}），仓位 100% 由 ${token1.symbol} 构成`
          : `区间 [${tickLower}, ${tickUpper}] 与当前 tick=${poolState.tick} 的组合算不出有效流动性`
    const suggest =
      poolState.tick < tickLower
        ? `请把 base 改成 'Token0'（${token0.symbol}）`
        : poolState.tick >= tickUpper
          ? `请把 base 改成 'Token1'（${token1.symbol}）`
          : '请检查 baseAmount 是否太小（小到算不出 1 单位流动性）'
    return `[evm-clmm-sdk] base='${base}' 这一边在当前价格下用不上：${where}。${suggest}，或调整价格区间。`
  }

  // =========================================================================
  // 内部：calldata 编码
  // =========================================================================

  private encodeDecrease(args: {
    tokenId: bigint
    liquidity: bigint
    amount0Min: bigint
    amount1Min: bigint
    deadline: bigint
  }): Hex {
    return encodeFunctionData({
      abi: NPM_ABI,
      functionName: 'decreaseLiquidity',
      args: [
        {
          tokenId: args.tokenId,
          liquidity: args.liquidity,
          amount0Min: args.amount0Min,
          amount1Min: args.amount1Min,
          deadline: args.deadline,
        },
      ],
    })
  }

  private encodeCollect(args: {
    tokenId: bigint
    recipient: Address
    amount0Max: bigint
    amount1Max: bigint
  }): Hex {
    return encodeFunctionData({
      abi: NPM_ABI,
      functionName: 'collect',
      args: [
        {
          tokenId: args.tokenId,
          recipient: args.recipient,
          amount0Max: args.amount0Max,
          amount1Max: args.amount1Max,
        },
      ],
    })
  }

  /**
   * 把若干个子调用打包：只有一条时直接用它本身（省掉 multicall 的一层 ABI 开销），
   * 多条时外层再 `encodeFunctionData('multicall', [calls])`。
   *
   * NPM 的 multicall 是 `delegatecall self`，所以子调用里的 msg.sender 仍然是用户本人，
   * 权限检查、代币转账语义与分开发送完全一致，只是变成了原子的一笔。
   */
  private packCalls(calls: Hex[]): Hex {
    if (calls.length === 0) throw new Error('[evm-clmm-sdk] 内部错误：multicall 子调用列表为空')
    if (calls.length === 1) return calls[0]
    return encodeFunctionData({ abi: NPM_ABI, functionName: 'multicall', args: [calls] })
  }

  // =========================================================================
  // 内部：代币元数据 & 返回值组装
  // =========================================================================

  /**
   * 取两种代币的元数据（decimals / symbol），命中缓存则 0 RPC，否则 1 次 multicall。
   * decimals 只影响错误文案与 ui 展示，不影响 liquidity / amounts 的整数运算，
   * 但错了会让用户看到荒谬的数字，所以坚持读真值而不是猜。
   */
  private async getTokenInfoPair(token0: Address, token1: Address): Promise<[ITokenInfo, ITokenInfo]> {
    const [t0, t1] = await this._chain.getTokenInfoList([token0, token1])
    return [t0, t1]
  }

  /**
   * 拼一笔 ERC20 approve（写主干里 0~2 笔前置交易之一）。
   * 只授权本次需要的额度，不做无限授权 —— 额度策略交给上层，SDK 不替用户扩大风险敞口。
   */
  private buildApproveTx(token: Address, amount: bigint, symbol?: string): IUnsignedTx {
    return {
      to: token,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [this.npm, amount] }),
      value: 0n,
      chainId: this._chain.chainId,
      label: `Approving ${symbol || token}`,
    }
  }

  /** 组装 ITransactionReturn：main 恒等于交易列表的最后一笔（前面的都是前置 approve） */
  private toReturn<M>(transactions: IUnsignedTx[], meta: M): ITransactionReturn<M> {
    if (transactions.length === 0) {
      throw new Error('[evm-clmm-sdk] 内部错误：没有产出任何交易')
    }
    return { transactions, main: transactions[transactions.length - 1], meta }
  }
}
