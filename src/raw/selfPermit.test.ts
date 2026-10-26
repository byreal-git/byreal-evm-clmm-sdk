import JSBI from 'jsbi'
import { Token } from './core/index.js'
import { AllowedPermitArguments, SelfPermit, StandardPermitArguments } from './selfPermit.js'

const token = new Token(1, '0x0000000000000000000000000000000000000001', 18, 't0', 'token0')

const standardPermitOptions: StandardPermitArguments = {
  v: 0,
  r: '0x0000000000000000000000000000000000000000000000000000000000000001',
  s: '0x0000000000000000000000000000000000000000000000000000000000000002',
  amount: JSBI.BigInt(123),
  deadline: JSBI.BigInt(123)
}

const allowedPermitOptions: AllowedPermitArguments = {
  v: 0,
  r: '0x0000000000000000000000000000000000000000000000000000000000000001',
  s: '0x0000000000000000000000000000000000000000000000000000000000000002',
  nonce: JSBI.BigInt(123),
  expiry: JSBI.BigInt(123)
}

// Selectors are keccak256(signature)[0..4] and pin the permit entry points.
const SELF_PERMIT = 'selfPermit(address,uint256,uint256,uint8,bytes32,bytes32)'
const SELF_PERMIT_ALLOWED = 'selfPermitAllowed(address,uint256,uint256,uint8,bytes32,bytes32)'
const SELF_PERMIT_SELECTOR = '0xf3995c67'
const SELF_PERMIT_ALLOWED_SELECTOR = '0x4659a494'

describe('SelfPermit', () => {
  it('the router ABI carries all four selfPermit entry points', () => {
    expect(SelfPermit.INTERFACE.getSighash(SELF_PERMIT)).toBe(SELF_PERMIT_SELECTOR)
    expect(SelfPermit.INTERFACE.getSighash(SELF_PERMIT_ALLOWED)).toBe(SELF_PERMIT_ALLOWED_SELECTOR)
    expect(
      SelfPermit.INTERFACE.getSighash('selfPermitIfNecessary(address,uint256,uint256,uint8,bytes32,bytes32)')
    ).toBe('0xc2e3140a')
    expect(
      SelfPermit.INTERFACE.getSighash('selfPermitAllowedIfNecessary(address,uint256,uint256,uint8,bytes32,bytes32)')
    ).toBe('0xa4a78f0c')
  })

  describe('#encodePermit', () => {
    it('works with StandardPermitArguments', () => {
      const calldata = SelfPermit.encodePermit(token, standardPermitOptions)

      expect(calldata.slice(0, 10)).toBe(SELF_PERMIT_SELECTOR)

      const decoded = SelfPermit.INTERFACE.decodeFunctionData(SELF_PERMIT, calldata)
      expect(decoded.token).toBe(token.address)
      expect(decoded.value.toString()).toBe('123')
      expect(decoded.deadline.toString()).toBe('123')
      expect(decoded.v).toBe(0)
      expect(decoded.r).toBe(standardPermitOptions.r)
      expect(decoded.s).toBe(standardPermitOptions.s)
    })

    it('works with AllowedPermitArguments', () => {
      const calldata = SelfPermit.encodePermit(token, allowedPermitOptions)

      expect(calldata.slice(0, 10)).toBe(SELF_PERMIT_ALLOWED_SELECTOR)

      const decoded = SelfPermit.INTERFACE.decodeFunctionData(SELF_PERMIT_ALLOWED, calldata)
      expect(decoded.token).toBe(token.address)
      expect(decoded.nonce.toString()).toBe('123')
      expect(decoded.expiry.toString()).toBe('123')
      expect(decoded.v).toBe(0)
      expect(decoded.r).toBe(allowedPermitOptions.r)
      expect(decoded.s).toBe(allowedPermitOptions.s)
    })

    it('accepts every BigintIsh form of the amounts', () => {
      const fromJSBI = SelfPermit.encodePermit(token, standardPermitOptions)
      const fromNumber = SelfPermit.encodePermit(token, { ...standardPermitOptions, amount: 123, deadline: 123 })
      const fromString = SelfPermit.encodePermit(token, { ...standardPermitOptions, amount: '123', deadline: '123' })

      expect(fromNumber).toBe(fromJSBI)
      expect(fromString).toBe(fromJSBI)
    })

    it('encodes v = 27 / 28', () => {
      const decoded = SelfPermit.INTERFACE.decodeFunctionData(
        SELF_PERMIT,
        SelfPermit.encodePermit(token, { ...standardPermitOptions, v: 28 })
      )
      expect(decoded.v).toBe(28)
    })
  })
})
