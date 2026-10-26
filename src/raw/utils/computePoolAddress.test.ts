import { defaultAbiCoder } from '@ethersproject/abi'
import { keccak256, pack } from '@ethersproject/solidity'
import { getCreate2Address } from '@ethersproject/address'
import { Token } from '../core/index.js'
import { computePoolAddress } from './computePoolAddress.js'

// Golden addresses were derived independently with `viem` (getCreate2Address / keccak256 / encodeAbiParameters),
// i.e. a different library than the @ethersproject stack used by the implementation — a genuine cross-check.
// Reproduce with:
//   salt = keccak256(encodeAbiParameters(parseAbiParameters('address, address, int24'), [t0, t1, ts]))
//   addr = getCreate2Address({ from: FACTORY, salt, bytecodeHash: INIT_CODE_HASH })
describe('#computePoolAddress', () => {
  const factoryAddress = '0x1111111111111111111111111111111111111111'
  // arbitrary 32-byte value: the real hash is environment dependent (embeds the beacon address) and is
  // read from `factory.poolInitCodeHash()`, so it is always an explicit argument here
  const initCodeHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'

  const USDC = new Token(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 18, 'USDC', 'USD Coin')
  const DAI = new Token(1, '0x6B175474E89094C44Da98b954EedeAC495271d0F', 18, 'DAI', 'DAI Stablecoin')
  // 0x6B17... < 0xA0b8..., so token0 = DAI and token1 = USDC
  const token1 = new Token(1, '0x0000000000000000000000000000000000000001', 18, 't1')
  const token2 = new Token(1, '0x0000000000000000000000000000000000000002', 18, 't2')

  it('should correctly compute the pool address for tickSpacing 10', () => {
    expect(computePoolAddress({ factoryAddress, tokenA: USDC, tokenB: DAI, tickSpacing: 10, initCodeHash })).toEqual(
      '0xFD12b9dc4128C561e729Fa4ce1ff05dB8b5516ed'
    )
  })

  it('should correctly compute the pool address for tickSpacing 60', () => {
    expect(computePoolAddress({ factoryAddress, tokenA: USDC, tokenB: DAI, tickSpacing: 60, initCodeHash })).toEqual(
      '0x2F8ac3CAb950fbb7094FC641cB82Fb8265661Fe5'
    )
  })

  it('should correctly compute the pool address for tickSpacing 1', () => {
    expect(
      computePoolAddress({ factoryAddress, tokenA: token1, tokenB: token2, tickSpacing: 1, initCodeHash })
    ).toEqual('0xFE8888D12f8cCe03c8f0037AD29b506A9b85cba3')
  })

  it('is independent of the order of tokenA/tokenB', () => {
    const resultA = computePoolAddress({ factoryAddress, tokenA: USDC, tokenB: DAI, tickSpacing: 60, initCodeHash })
    const resultB = computePoolAddress({ factoryAddress, tokenA: DAI, tokenB: USDC, tickSpacing: 60, initCodeHash })
    expect(resultA).toEqual(resultB)
  })

  it('is part of the identity key: different tickSpacing yields a different pool', () => {
    const ts1 = computePoolAddress({ factoryAddress, tokenA: USDC, tokenB: DAI, tickSpacing: 1, initCodeHash })
    const ts10 = computePoolAddress({ factoryAddress, tokenA: USDC, tokenB: DAI, tickSpacing: 10, initCodeHash })
    expect(ts1).toEqual('0xF4dAEBA2438863D46cD033aA614f7e7CC4e9C217')
    expect(ts1).not.toEqual(ts10)
  })

  it('throws on a pair of identical tokens (sortsBefore safety check)', () => {
    expect(() =>
      computePoolAddress({ factoryAddress, tokenA: USDC, tokenB: USDC, tickSpacing: 60, initCodeHash })
    ).toThrow('ADDRESSES')
  })

  it('throws on an invalid tickSpacing, same as the Pool constructor', () => {
    // an address derived for an illegal spacing can never hold a pool (`pool.initializePool` enforces
    // `TickSpacing.isValid`), so returning a plausible-looking address would only hide the caller's bug
    for (const tickSpacing of [0, -60, 7, 15, 16384, 1.5]) {
      expect(() =>
        computePoolAddress({ factoryAddress, tokenA: USDC, tokenB: DAI, tickSpacing, initCodeHash }),
        `accepted tickSpacing=${tickSpacing}`
      ).toThrow('TICK_SPACING')
    }
    // the legal shapes still work: <= 5 anything, 6..10 even, > 10 multiples of 10 (up to 16380)
    for (const tickSpacing of [1, 5, 6, 10, 20, 16380]) {
      expect(() =>
        computePoolAddress({ factoryAddress, tokenA: USDC, tokenB: DAI, tickSpacing, initCodeHash })
      ).not.toThrow()
    }
  })

  describe('salt encoding', () => {
    // `PoolAddress.computeAddress` uses `keccak256(abi.encode(token0, token1, tickSpacing))`.
    // abi.encode lays out three 32-byte words: left-padded token0, left-padded token1, sign-extended int24.
    const encodedConstructorArgs =
      '0x' +
      '0000000000000000000000006b175474e89094c44da98b954eedeac495271d0f' + // token0 = DAI
      '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' + // token1 = USDC
      '000000000000000000000000000000000000000000000000000000000000000a' //  tickSpacing = 10

    it('matches the 3 x 32-byte abi.encode layout', () => {
      expect(defaultAbiCoder.encode(['address', 'address', 'int24'], [DAI.address, USDC.address, 10])).toEqual(
        encodedConstructorArgs
      )
      // golden salt, also from the viem run
      expect(keccak256(['bytes'], [encodedConstructorArgs])).toEqual(
        '0xfc43c61c8e9cea279d0b0026808a391fa2253b3304ae1e0481f7a1ecf3c541c2'
      )
    })

    it('sign-extends int24 (which is why abi.encode, not abi.encodePacked, is used)', () => {
      // for the tickSpacings we actually use (always positive) int24 and uint24 agree word-for-word...
      expect(defaultAbiCoder.encode(['int24'], [10])).toEqual(defaultAbiCoder.encode(['uint24'], [10]))
      // ...but int24 sign-extends across the whole 32-byte word, unlike a 3-byte packed encoding
      expect(defaultAbiCoder.encode(['int24'], [-10])).toEqual(`0x${'f'.repeat(63)}6`)
    })

    it('differs from an abi.encodePacked salt', () => {
      // encodePacked would produce 20 + 20 + 3 = 43 bytes; make sure we are not accidentally computing that
      const packedSalt = keccak256(
        ['bytes'],
        [pack(['address', 'address', 'uint24'], [DAI.address, USDC.address, 10])]
      )
      const packedAddress = getCreate2Address(factoryAddress, packedSalt, initCodeHash)
      expect(packedAddress).not.toEqual(
        computePoolAddress({ factoryAddress, tokenA: USDC, tokenB: DAI, tickSpacing: 10, initCodeHash })
      )
    })
  })
})
