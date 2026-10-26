/** `parseTokenIdFromReceipt`：从 mint 回执里解析新仓位 tokenId */
import { pad, toHex, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import { parseTokenIdFromReceipt } from '../receipt.js'

const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'
const SOLANA_ADDRESS = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'

describe('parseTokenIdFromReceipt', () => {
  const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  const NPM = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88'

  /** 一条 ERC-721 mint 日志：4 个 topic（tokenId 是 indexed），from = 0x0 */
  function mintLog(tokenId: bigint, address = NPM) {
    return {
      address,
      topics: [
        TRANSFER_TOPIC0,
        pad(zeroAddress, { size: 32 }),
        pad('0x1111111111111111111111111111111111111111', { size: 32 }),
        pad(toHex(tokenId), { size: 32 }),
      ] as readonly string[],
      data: '0x',
    }
  }

  /** ERC-20 的 Transfer：topic0 完全相同，但只有 3 个 topic、值在 data 里 */
  const erc20Log = {
    address: WETH,
    topics: [
      TRANSFER_TOPIC0,
      pad('0x1111111111111111111111111111111111111111', { size: 32 }),
      pad(NPM, { size: 32 }),
    ] as readonly string[],
    data: pad(toHex(10n ** 18n), { size: 32 }),
  }

  it('能从 mint 回执里解出 tokenId', () => {
    expect(parseTokenIdFromReceipt({ logs: [erc20Log, mintLog(123456n)] })).toBe(123456n)
  })

  it('同一笔交易里的 ERC-20 Transfer 不会被误当成仓位 mint（topic0 相同，靠 topic 数量区分）', () => {
    expect(() => parseTokenIdFromReceipt({ logs: [erc20Log] })).toThrow(/没有仓位 mint 事件/)
  })

  it('传了 positionManager 就按地址过滤，别的 NFT mint 不会被误取', () => {
    const airdrop = mintLog(7n, '0x000000000000000000000000000000000000dEaD')
    expect(parseTokenIdFromReceipt({ logs: [airdrop, mintLog(999n)] }, { positionManager: NPM })).toBe(999n)
    // 只有别的合约 mint 时：错误里要点名那些地址，并提示确认 NPM 传对了
    expect(() => parseTokenIdFromReceipt({ logs: [airdrop] }, { positionManager: NPM })).toThrow(
      /NonfungiblePositionManager/,
    )
  })

  it('无关 log / 空回执抛，并提示「加仓 / 减仓 / collect 不会 mint 新 NFT」', () => {
    expect(() => parseTokenIdFromReceipt({ logs: [] })).toThrow(/createPosition/)
    expect(() =>
      parseTokenIdFromReceipt({ logs: [{ address: WETH, topics: ['0xdead'], data: '0x' }] }),
    ).toThrow(/没有仓位 mint 事件/)
  })

  it('误把 receipt.logs 数组传进来时单独报错，而不是静默接受', () => {
    expect(() => parseTokenIdFromReceipt([mintLog(1n)] as never)).toThrow(/receipt\.logs/)
  })

  it('positionManager 不是 EVM 地址时报错', () => {
    expect(() =>
      parseTokenIdFromReceipt({ logs: [mintLog(1n)] }, { positionManager: SOLANA_ADDRESS }),
    ).toThrow(/不是合法的 EVM 地址/)
  })
})
