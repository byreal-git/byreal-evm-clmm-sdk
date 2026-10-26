/**
 * 回执解析：EVM 的仓位 `tokenId` 由 NonfungiblePositionManager 在 mint 交易上链时分配，
 * 发交易前拿不到，只能在交易确认后从回执里解析（本文件）。
 */
import { decodeEventLog, encodeEventTopics, isAddress, zeroAddress, type Hex } from 'viem'

const ERR_PREFIX = '[evm-clmm-sdk]'

/**
 * ERC-721 `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)` 事件片段。
 *
 * 核心 ABI 里只有 SDK 发交易要用的函数、没有事件，所以在这里单独定义并导出：调用方若想自己用 viem 的 `parseEventLogs` 捞全部 mint 事件
 * （比如一笔 multicall 同时开了多个仓位），可以直接复用这份片段，不用自己抄。
 *
 * ⚠️ 与 ERC-20 的 `Transfer` **同名同签名字符串、但 topic 数量不同**：
 * ERC-721 的 `tokenId` 是 indexed（4 个 topic、data 为空），ERC-20 的 `value` 不是 indexed
 * （3 个 topic、值在 data 里）。两者的 `topics[0]` 完全相同 ——
 * 一笔开仓交易里必然同时有 ERC-20 转账日志，所以下面的匹配**必须**靠 topic 数量区分，
 * 只比 `topics[0]` 会把 ERC-20 的转账当成仓位 mint。
 */
export const ERC721_TRANSFER_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
] as const

/** `Transfer(address,address,uint256)` 的 topic0，模块加载时算一次 */
const TRANSFER_TOPIC0 = encodeEventTopics({
  abi: ERC721_TRANSFER_ABI,
  eventName: 'Transfer',
})[0].toLowerCase()

/**
 * 一条日志的最小形状。
 *
 * 刻意只要求 `address` / `topics` / `data` 三个字段且都用宽松类型：
 * viem 的 `TransactionReceipt`、ethers 的 `TransactionReceipt`、后端透传的 JSON
 * 三者都满足这个形状，调用方不用为了对上类型而做一次无意义的 map。
 */
export interface IReceiptLogLike {
  address: string
  topics: readonly string[]
  data: string
}

/** 交易回执的最小形状：只要有 `logs` 就行，其余字段（status/blockNumber…）本函数用不到 */
export interface IReceiptLike {
  logs: readonly IReceiptLogLike[]
}

/**
 * 从 mint 交易回执里解析出新仓位的 `tokenId`。
 *
 * 判据：`NonfungiblePositionManager` 发出的 ERC-721 `Transfer` 事件里
 * `from == 0x0`（= mint）的那一条，`tokenId` 在 `topics[3]`。
 *
 * - 传了 `options.positionManager` 就**按地址过滤**（大小写不敏感）。强烈建议传：
 *   一笔交易里可能夹带别的 NFT mint（空投、积分凭证），不过滤就可能取到不相干的 tokenId。
 *   不传时只按「事件签名 + 4 个 topic + from == 0x0」匹配。
 * - 找不到时**抛**而不是返回 null：调用方在这一步拿到 null 只能一路往下传，
 *   最后在某个 UI 上变成 `#undefined`；当场抛错并说清「这笔回执里没有仓位 mint 事件」定位成本最低。
 * - 找到多条时返回**第一条**并 `console.warn`（一笔 multicall 里 mint 多个仓位是合法的，
 *   但本函数的返回类型只能给一个，需要全部时请用 viem 的 `parseEventLogs` + {@link ERC721_TRANSFER_ABI}）。
 *
 * @param receipt 交易回执（等交易确认后的那个，`waitForTransactionReceipt` 的返回值）
 * @param options.positionManager NonfungiblePositionManager 地址，取自 `sdk.contracts.positionManager`
 */
export function parseTokenIdFromReceipt(
  receipt: IReceiptLike,
  options?: { positionManager?: string },
): bigint {
  const logs = assertLogs(receipt)

  const expectManager = options?.positionManager ? toManagerAddress(options.positionManager) : undefined

  /** 命中的仓位 mint 事件 */
  const hits: Array<{ tokenId: bigint; address: string }> = []
  /** 被 positionManager 过滤掉的 mint 事件来源地址（报错时要告诉调用方，这是最常见的传错地址） */
  const filteredOut = new Set<string>()
  /** 出现过、但不是 mint（from != 0x0）的 ERC-721 Transfer 条数 */
  let nonMintTransfers = 0

  for (const log of logs) {
    const topics = log?.topics
    if (!Array.isArray(topics) || topics.length !== 4) continue
    if (String(topics[0]).toLowerCase() !== TRANSFER_TOPIC0) continue

    let args: { from: string; to: string; tokenId: bigint }
    try {
      args = decodeEventLog({
        abi: ERC721_TRANSFER_ABI,
        eventName: 'Transfer',
        topics: topics as [Hex, Hex, Hex, Hex],
        data: (log.data || '0x') as Hex,
      }).args
    } catch {
      // topic 数量对得上但内容解不开：不是我们要的事件，跳过而不是让整个解析失败
      continue
    }

    if (args.from.toLowerCase() !== zeroAddress) {
      nonMintTransfers += 1
      continue
    }

    const emitter = String(log.address).toLowerCase()
    if (expectManager && emitter !== expectManager) {
      filteredOut.add(emitter)
      continue
    }
    hits.push({ tokenId: args.tokenId, address: emitter })
  }

  if (hits.length === 0) {
    throw new Error(buildNotFoundMessage({ logs, expectManager, filteredOut, nonMintTransfers }))
  }
  if (hits.length > 1) {
    console.warn(
      `${ERR_PREFIX} 这笔回执里有 ${hits.length} 条仓位 mint 事件` +
        `（tokenId: ${hits.map((h) => h.tokenId).join(', ')}），` +
        `parseTokenIdFromReceipt 只返回第一条 ${hits[0].tokenId}。\n` +
        '若这是一笔同时开多个仓位的 multicall，请改用 viem 的 ' +
        "parseEventLogs({ abi: ERC721_TRANSFER_ABI, eventName: 'Transfer', logs }) 自行取全部。",
    )
  }
  return hits[0].tokenId
}

/** positionManager 必须是 EVM 地址（误传 Solana base58 时直接报错，不会悄悄过滤掉所有事件） */
function toManagerAddress(value: string): string {
  if (!isAddress(value, { strict: false })) {
    throw new Error(`${ERR_PREFIX} options.positionManager 不是合法的 EVM 地址：${value}。请传 sdk.contracts.positionManager。`)
  }
  return value.toLowerCase()
}

/** 校验回执形状，并把「传成了 logs 数组」这个高频误用单独拎出来报错 */
function assertLogs(receipt: IReceiptLike): readonly IReceiptLogLike[] {
  const r = receipt as unknown
  if (Array.isArray(r)) {
    throw new Error(
      `${ERR_PREFIX} parseTokenIdFromReceipt 收到的是一个数组，看起来是把 receipt.logs 传进来了。` +
        '请传整个交易回执（形如 { logs: [...] }）。',
    )
  }
  if (r === null || typeof r !== 'object' || !Array.isArray((r as IReceiptLike).logs)) {
    throw new Error(
      `${ERR_PREFIX} parseTokenIdFromReceipt 需要一个带 logs 数组的交易回执，收到 ${String(r)}。` +
        '请传 waitForTransactionReceipt / eth_getTransactionReceipt 的返回值。',
    )
  }
  return (r as IReceiptLike).logs
}

/** 「没找到仓位 mint 事件」的报错文案：把现场信息全摊开，避免调用方靠猜 */
function buildNotFoundMessage(ctx: {
  logs: readonly IReceiptLogLike[]
  expectManager?: string
  filteredOut: Set<string>
  nonMintTransfers: number
}): string {
  const { logs, expectManager, filteredOut, nonMintTransfers } = ctx
  const parts = [
    `${ERR_PREFIX} 这笔交易的回执里没有仓位 mint 事件` +
      `（找不到 from == 0x0 的 ERC-721 Transfer）。共扫描 ${logs.length} 条 log。`,
  ]

  if (filteredOut.size > 0) {
    parts.push(
      `有 ${filteredOut.size} 个其它合约发出过 ERC-721 mint 事件（${[...filteredOut].join(', ')}），` +
        `但都不等于传入的 positionManager=${expectManager} —— ` +
        '请确认 positionManager 传的是本链的 NonfungiblePositionManager（sdk.contracts.positionManager）。',
    )
  } else if (nonMintTransfers > 0) {
    parts.push(
      `回执里有 ${nonMintTransfers} 条 ERC-721 Transfer，但 from 都不是 0x0（是转让而非 mint）—— ` +
        '确认传的是 createPosition 那笔交易的回执，而不是 transfer / approve 的回执。',
    )
  } else {
    parts.push(
      '确认传的是 createPosition（NPM.mint）那笔交易的回执；' +
        '加仓 / 减仓 / collect 都不会 mint 新的仓位 NFT，自然也解不出 tokenId。',
    )
  }
  return parts.join('\n')
}
