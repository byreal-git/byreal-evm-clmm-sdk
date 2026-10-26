import { Ether, Token, WETH9 } from '../core/index.js'
import { Pool } from '../entities/pool.js'
import { Route } from '../entities/route.js'
import { decodePath, encodeRouteToPath } from './encodeRouteToPath.js'
import { encodeSqrtRatioX96 } from './encodeSqrtRatioX96.js'

// Golden hex is derived by hand from the `Path.sol` layout: 20-byte address, then the pool tickSpacing as a
// 3-byte big-endian value, then the next 20-byte address, and so on. tickSpacing 60 -> `00003c`,
// tickSpacing 10 -> `00000a`.
describe('#encodeRouteToPath', () => {
  const ETHER = Ether.onChain(1)
  const token0 = new Token(1, '0x0000000000000000000000000000000000000001', 18, 't0', 'token0')
  const token1 = new Token(1, '0x0000000000000000000000000000000000000002', 18, 't1', 'token1')
  const token2 = new Token(1, '0x0000000000000000000000000000000000000003', 18, 't2', 'token2')

  // this SDK ships no address book, so the wrapped native token is registered by the consumer
  const weth = new Token(1, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18, 'WETH', 'Wrapped Ether')
  WETH9[1] = weth

  // Use two distinct tick spacings to verify each hop is encoded from pool identity.
  const pool_0_1_medium = new Pool(token0, token1, 60, 3000, encodeSqrtRatioX96(1, 1), 0, 0, [])
  const pool_1_2_low = new Pool(token1, token2, 10, 500, encodeSqrtRatioX96(1, 1), 0, 0, [])
  const pool_0_weth = new Pool(token0, weth, 60, 3000, encodeSqrtRatioX96(1, 1), 0, 0, [])
  const pool_1_weth = new Pool(token1, weth, 60, 3000, encodeSqrtRatioX96(1, 1), 0, 0, [])

  const route_0_1 = new Route([pool_0_1_medium], token0, token1)
  const route_0_1_2 = new Route([pool_0_1_medium, pool_1_2_low], token0, token2)

  const route_0_weth = new Route([pool_0_weth], token0, ETHER)
  const route_0_1_weth = new Route([pool_0_1_medium, pool_1_weth], token0, ETHER)
  const route_weth_0 = new Route([pool_0_weth], ETHER, token0)
  const route_weth_0_1 = new Route([pool_0_weth, pool_0_1_medium], ETHER, token1)

  it('packs them for exact input single hop', () => {
    expect(encodeRouteToPath(route_0_1, false)).toEqual(
      '0x000000000000000000000000000000000000000100003c0000000000000000000000000000000000000002'
    )
  })

  it('packs them correctly for exact output single hop', () => {
    expect(encodeRouteToPath(route_0_1, true)).toEqual(
      '0x000000000000000000000000000000000000000200003c0000000000000000000000000000000000000001'
    )
  })

  it('packs them correctly for multihop exact input', () => {
    expect(encodeRouteToPath(route_0_1_2, false)).toEqual(
      '0x000000000000000000000000000000000000000100003c000000000000000000000000000000000000000200000a0000000000000000000000000000000000000003'
    )
  })

  it('packs them correctly for multihop exact output', () => {
    expect(encodeRouteToPath(route_0_1_2, true)).toEqual(
      '0x000000000000000000000000000000000000000300000a000000000000000000000000000000000000000200003c0000000000000000000000000000000000000001'
    )
  })

  it('wraps ether input for exact input single hop', () => {
    expect(encodeRouteToPath(route_weth_0, false)).toEqual(
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc200003c0000000000000000000000000000000000000001'
    )
  })
  it('wraps ether input for exact output single hop', () => {
    expect(encodeRouteToPath(route_weth_0, true)).toEqual(
      '0x000000000000000000000000000000000000000100003cc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
    )
  })
  it('wraps ether input for exact input multihop', () => {
    expect(encodeRouteToPath(route_weth_0_1, false)).toEqual(
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc200003c000000000000000000000000000000000000000100003c0000000000000000000000000000000000000002'
    )
  })
  it('wraps ether input for exact output multihop', () => {
    expect(encodeRouteToPath(route_weth_0_1, true)).toEqual(
      '0x000000000000000000000000000000000000000200003c000000000000000000000000000000000000000100003cc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
    )
  })

  it('wraps ether output for exact input single hop', () => {
    expect(encodeRouteToPath(route_0_weth, false)).toEqual(
      '0x000000000000000000000000000000000000000100003cc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
    )
  })
  it('wraps ether output for exact output single hop', () => {
    expect(encodeRouteToPath(route_0_weth, true)).toEqual(
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc200003c0000000000000000000000000000000000000001'
    )
  })
  it('wraps ether output for exact input multihop', () => {
    expect(encodeRouteToPath(route_0_1_weth, false)).toEqual(
      '0x000000000000000000000000000000000000000100003c000000000000000000000000000000000000000200003cc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
    )
  })
  it('wraps ether output for exact output multihop', () => {
    expect(encodeRouteToPath(route_0_1_weth, true)).toEqual(
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc200003c000000000000000000000000000000000000000200003c0000000000000000000000000000000000000001'
    )
  })

  it('round-trips through decodePath', () => {
    expect(decodePath(encodeRouteToPath(route_0_1_2, false))).toEqual({
      tokens: [token0.address, token1.address, token2.address],
      tickSpacings: [60, 10]
    })
    expect(decodePath(encodeRouteToPath(route_0_1_2, true))).toEqual({
      tokens: [token2.address, token1.address, token0.address],
      tickSpacings: [10, 60]
    })
  })
})

describe('#decodePath', () => {
  // mirrors the contract repo's `test/periphery/shared/path.ts#encodePath`
  function encodePath(tokens: string[], tickSpacings: number[]): string {
    let encoded = '0x'
    for (let i = 0; i < tickSpacings.length; i++) {
      encoded += tokens[i].slice(2)
      encoded += tickSpacings[i].toString(16).padStart(6, '0')
    }
    encoded += tokens[tokens.length - 1].slice(2)
    return encoded.toLowerCase()
  }

  const addr = (i: number): string => `0x${i.toString(16).padStart(40, '0')}`

  it('decodes a hand-written single hop path', () => {
    // 0x...01 | 00003c | 0x...02 — same bytes the golden encode tests assert
    expect(decodePath('0x000000000000000000000000000000000000000100003c0000000000000000000000000000000000000002')).toEqual(
      { tokens: [addr(1), addr(2)], tickSpacings: [60] }
    )
  })

  it('returns checksummed addresses', () => {
    const path = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc200003c0000000000000000000000000000000000000001'
    expect(decodePath(path).tokens[0]).toEqual('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
  })

  it('round-trips any number of hops', () => {
    // tickSpacing is a 3-byte field; 16380 is the largest value `isValidTickSpacing` allows (< 16384 and a
    // multiple of 10), so this covers both ends of the legal range
    const allTickSpacings = [1, 10, 60, 200, 16380, 2, 5, 100]
    for (let hops = 1; hops <= allTickSpacings.length; hops++) {
      const tokens = Array.from({ length: hops + 1 }, (_, i) => addr(i + 1))
      const tickSpacings = allTickSpacings.slice(0, hops)
      const decoded = decodePath(encodePath(tokens, tickSpacings))
      expect(decoded.tokens).toEqual(tokens)
      expect(decoded.tickSpacings).toEqual(tickSpacings)
    }
  })

  it('decodes the largest legal tickSpacing, which needs all three bytes', () => {
    // 16380 = 0x3ffc -> `003ffc`
    expect(decodePath(`${addr(1)}003ffc${addr(2).slice(2)}`).tickSpacings).toEqual([16380])
  })

  it('rejects a 3-byte field that is not a legal tickSpacing', () => {
    const hop = (hex: string) => `${addr(1)}${hex}${addr(2).slice(2)}`

    // 0 (no pool), 7 (odd and > 5), 15 (> 10, not a multiple of 10), 16383 / 16384 (>= the hard bound)
    for (const hex of ['000000', '000007', '00000f', '003fff', '004000']) {
      expect(() => decodePath(hop(hex)), `accepted 0x${hex}`).toThrow('TICK_SPACING')
    }
    // 0xffffff is int24 -1 on the wire — a real pool can never have it, so it is rejected rather than
    // sign-extended into a negative tickSpacing
    expect(() => decodePath(hop('ffffff'))).toThrow('TICK_SPACING')
    // and the same check applies to the second hop, not just the first
    expect(() =>
      decodePath(`${addr(1)}00000a${addr(2).slice(2)}000007${addr(3).slice(2)}`)
    ).toThrow('TICK_SPACING')
  })

  it('throws on a non-hex string', () => {
    expect(() => decodePath('not hex')).toThrow('HEX')
    expect(() => decodePath('000000000000000000000000000000000000000100003c0000000000000000000000000000000000000002')).toThrow(
      'HEX'
    )
  })

  it('throws on a truncated or misaligned path', () => {
    expect(() => decodePath('0x')).toThrow('PATH_LENGTH')
    expect(() => decodePath(addr(1))).toThrow('PATH_LENGTH')
    // one token + tickSpacing but no closing token
    expect(() => decodePath(`${addr(1)}00003c`)).toThrow('PATH_LENGTH')
    // a trailing byte past a valid single hop
    expect(() =>
      decodePath('0x000000000000000000000000000000000000000100003c000000000000000000000000000000000000000200')
    ).toThrow('PATH_LENGTH')
  })
})
