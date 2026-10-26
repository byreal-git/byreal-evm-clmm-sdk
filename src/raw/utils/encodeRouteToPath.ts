import { getAddress } from '@ethersproject/address'
import { pack } from '@ethersproject/solidity'
import invariant from 'tiny-invariant'
import { Currency, Token } from '../core/index.js'
import { isValidTickSpacing } from '../constants.js'
import { Pool } from '../entities/pool.js'
import { Route } from '../entities/route.js'

/** Byte layout mirrored from periphery `Path.sol`: token(20) | tickSpacing(3) | token(20) | ... */
const ADDR_SIZE = 20
const TICK_SPACING_SIZE = 3
const NEXT_OFFSET = ADDR_SIZE + TICK_SPACING_SIZE
const POP_OFFSET = NEXT_OFFSET + ADDR_SIZE

/**
 * Converts a route to a hex encoded path
 * @param route the v3 path to convert to an encoded path
 * @param exactOutput whether the route should be encoded in reverse, for making exact output swaps
 */
export function encodeRouteToPath(route: Route<Currency, Currency>, exactOutput: boolean): string {
  const firstInputToken: Token = route.input.wrapped

  const { path, types } = route.pools.reduce(
    (
      { inputToken, path, types }: { inputToken: Token; path: (string | number)[]; types: string[] },
      pool: Pool,
      index
    ): { inputToken: Token; path: (string | number)[]; types: string[] } => {
      const outputToken: Token = pool.token0.equals(inputToken) ? pool.token1 : pool.token0
      if (index === 0) {
        return {
          inputToken: outputToken,
          types: ['address', 'uint24', 'address'],
          // tickSpacing is always in [1, 16383], so the 3-byte unsigned encoding is byte-identical to the
          // `int24` the contract reads back (`Path.decodeFirstPool`)
          path: [inputToken.address, pool.tickSpacing, outputToken.address]
        }
      } else {
        return {
          inputToken: outputToken,
          types: [...types, 'uint24', 'address'],
          path: [...path, pool.tickSpacing, outputToken.address]
        }
      }
    },
    { inputToken: firstInputToken, path: [], types: [] }
  )

  return exactOutput ? pack(types.reverse(), path.reverse()) : pack(types, path)
}

/**
 * Decodes a hex encoded path back into its tokens and tick spacings
 *
 * The 3-byte middle field is an `int24` on the wire, but every tick spacing a pool can be deployed with is positive
 * and passes `TickSpacing.isValid`. Rather than sign-extend a value that could never address a real pool, any field
 * failing `isValidTickSpacing` is rejected with 'TICK_SPACING' (this also covers the negative int24 range, which
 * always has bits set above 0x003fff).
 *
 * @param path the encoded swap path
 * @returns the checksummed token addresses (n + 1) and the tick spacings between them (n)
 */
export function decodePath(path: string): { tokens: string[]; tickSpacings: number[] } {
  invariant(/^0x([0-9a-fA-F]{2})*$/.test(path), 'HEX')
  const data = path.slice(2)
  const byteLength = data.length / 2
  invariant(byteLength >= POP_OFFSET && (byteLength - ADDR_SIZE) % NEXT_OFFSET === 0, 'PATH_LENGTH')

  const tokens: string[] = [getAddress(`0x${data.slice(0, ADDR_SIZE * 2)}`)]
  const tickSpacings: number[] = []

  for (let offset = ADDR_SIZE * 2; offset < data.length; offset += NEXT_OFFSET * 2) {
    const tickSpacing = parseInt(data.slice(offset, offset + TICK_SPACING_SIZE * 2), 16)
    invariant(isValidTickSpacing(tickSpacing), 'TICK_SPACING')
    tickSpacings.push(tickSpacing)
    tokens.push(getAddress(`0x${data.slice(offset + TICK_SPACING_SIZE * 2, offset + NEXT_OFFSET * 2)}`))
  }

  return { tokens, tickSpacings }
}
