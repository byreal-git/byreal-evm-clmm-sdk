import { Ether } from './ether.js'
import { Token } from './token.js'
import { WETH9 } from './weth9.js'

describe('Ether', () => {
  it('static constructor uses cache', () => {
    expect(Ether.onChain(1) === Ether.onChain(1)).toEqual(true)
  })
  it('caches once per chain ID', () => {
    expect(Ether.onChain(1) !== Ether.onChain(2)).toEqual(true)
  })
  it('#equals returns false for diff chains', () => {
    expect(Ether.onChain(1).equals(Ether.onChain(2))).toEqual(false)
  })
  it('#equals returns true for same chains', () => {
    expect(Ether.onChain(1).equals(Ether.onChain(1))).toEqual(true)
  })

  describe('#wrapped', () => {
    const WRAPPED_NATIVE = new Token(1, '0x0000000000000000000000000000000000000006', 18, 'WETH', 'Wrapped Ether')

    afterEach(() => {
      delete WETH9[1]
    })

    it('throws if nothing is registered for the chain', () => {
      expect(() => Ether.onChain(1).wrapped).toThrow('WRAPPED')
    })
    it('returns the token registered for the chain', () => {
      WETH9[1] = WRAPPED_NATIVE
      expect(Ether.onChain(1).wrapped).toEqual(WRAPPED_NATIVE)
    })
  })
})
