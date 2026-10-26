import JSBI from 'jsbi'
import { MaxUint256 } from './core/index.js'
import { isValidDeadline, Multicall } from './multicall.js'

// selectors are keccak256(signature)[0..4] of the router's three multicall overloads
const MULTICALL_SELECTOR = '0xac9650d8' // multicall(bytes[])
const MULTICALL_DEADLINE_SELECTOR = '0x5ae401dc' // multicall(uint256,bytes[])

const calldataA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const calldataB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('Multicall', () => {
  it('resolves all three multicall overloads from the router ABI', () => {
    expect(Multicall.INTERFACE.getSighash('multicall(bytes[])')).toBe(MULTICALL_SELECTOR)
    expect(Multicall.INTERFACE.getSighash('multicall(uint256,bytes[])')).toBe(MULTICALL_DEADLINE_SELECTOR)
    expect(Multicall.INTERFACE.getSighash('multicall(bytes32,bytes[])')).toBe('0x1f0464d1')
    // the bare name is ambiguous — encoding must always use an explicit signature
    expect(() => Multicall.INTERFACE.getSighash('multicall')).toThrow()
  })

  describe('#encodeMulticall without deadline', () => {
    it('works for string', () => {
      expect(Multicall.encodeMulticall('0x01')).toBe('0x01')
    })

    it('works for string array with length 1', () => {
      expect(Multicall.encodeMulticall(['0x01'])).toBe('0x01')
    })

    it('works for string array with length >1', () => {
      const calldata = Multicall.encodeMulticall([calldataA, calldataB])

      expect(calldata.slice(0, 10)).toBe(MULTICALL_SELECTOR)

      const [data] = Multicall.INTERFACE.decodeFunctionData('multicall(bytes[])', calldata)
      expect([...data]).toEqual([calldataA, calldataB])
    })
  })

  describe('#encodeMulticall with deadline', () => {
    it('wraps a single calldata instead of eliding the wrapper', () => {
      const calldata = Multicall.encodeMulticall(calldataA, 123)

      expect(calldata.slice(0, 10)).toBe(MULTICALL_DEADLINE_SELECTOR)

      const [deadline, data] = Multicall.INTERFACE.decodeFunctionData('multicall(uint256,bytes[])', calldata)
      expect(deadline.toString()).toBe('123')
      expect([...data]).toEqual([calldataA])
    })

    it('works for a string array', () => {
      const calldata = Multicall.encodeMulticall([calldataA, calldataB], 123)

      expect(calldata.slice(0, 10)).toBe(MULTICALL_DEADLINE_SELECTOR)

      const [deadline, data] = Multicall.INTERFACE.decodeFunctionData('multicall(uint256,bytes[])', calldata)
      expect(deadline.toString()).toBe('123')
      expect([...data]).toEqual([calldataA, calldataB])
    })

    it('accepts every BigintIsh form of the deadline', () => {
      const fromNumber = Multicall.encodeMulticall([calldataA], 1700000000)
      const fromString = Multicall.encodeMulticall([calldataA], '1700000000')
      const fromJSBI = Multicall.encodeMulticall([calldataA], JSBI.BigInt(1700000000))

      expect(fromString).toBe(fromNumber)
      expect(fromJSBI).toBe(fromNumber)

      const [deadline] = Multicall.INTERFACE.decodeFunctionData('multicall(uint256,bytes[])', fromNumber)
      expect(deadline.toString()).toBe('1700000000')
    })

    it('rejects a deadline that cannot be enforced', () => {
      // 0 is not "no deadline": `require(_blockTimestamp() <= deadline)` can never hold for it
      const overUint256 = JSBI.add(MaxUint256, JSBI.BigInt(1))
      for (const bad of [null, 0, '0', -1, '-1', 1.5, '', 'soon', NaN, Infinity, overUint256]) {
        expect(() => Multicall.encodeMulticall([calldataA], bad as any)).toThrow('DEADLINE')
      }

      // the uint256 boundary is legal
      expect(() => Multicall.encodeMulticall([calldataA], MaxUint256)).not.toThrow()
      expect(isValidDeadline(MaxUint256)).toBe(true)
      expect(isValidDeadline(1)).toBe(true)
    })

    it('an omitted deadline still selects the deadline-less behaviour (the NPM path)', () => {
      // `undefined` is not validated — the NonfungiblePositionManager structs carry their own deadline
      expect(Multicall.encodeMulticall([calldataA], undefined)).toBe(calldataA)
      expect(isValidDeadline(undefined)).toBe(false)
    })
  })
})
