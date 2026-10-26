import { defaultAbiCoder } from '@ethersproject/abi'
import { getCreate2Address } from '@ethersproject/address'
import { keccak256 } from '@ethersproject/solidity'
import invariant from 'tiny-invariant'
import { Token } from '../core/index.js'
import { isValidTickSpacing } from '../constants.js'

/**
 * Computes a pool address
 * @param factoryAddress The factory address that CREATE2-deploys the pool (the BeaconProxy deployer)
 * @param tokenA The first token of the pair, irrespective of sort order
 * @param tokenB The second token of the pair, irrespective of sort order
 * @param tickSpacing The tick spacing of the pool — third element of the pool identity key
 * @param initCodeHash The BeaconProxy init code hash, read from `factory.poolInitCodeHash()` (environment dependent)
 * @returns The pool address
 */
export function computePoolAddress({
  factoryAddress,
  tokenA,
  tokenB,
  tickSpacing,
  initCodeHash
}: {
  factoryAddress: string
  tokenA: Token
  tokenB: Token
  tickSpacing: number
  initCodeHash: string
}): string {
  // Same guard as the `Pool` constructor: `TickSpacing.isValid` is enforced by `pool.initializePool`, so an invalid
  // spacing addresses a pool that can never be deployed — returning a plausible-looking address for it hides bugs.
  invariant(isValidTickSpacing(tickSpacing), 'TICK_SPACING')
  const [token0, token1] = tokenA.sortsBefore(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA] // does safety checks
  return getCreate2Address(
    factoryAddress,
    keccak256(
      ['bytes'],
      // `abi.encode` (3 * 32 bytes), NOT `abi.encodePacked` — matches `PoolAddress.computeAddress`
      [defaultAbiCoder.encode(['address', 'address', 'int24'], [token0.address, token1.address, tickSpacing])]
    ),
    initCodeHash
  )
}
