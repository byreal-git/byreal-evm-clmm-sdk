import {
  ADDRESS_THIS,
  ADDRESS_ZERO,
  ExtraFeeClass,
  FEE_RATE_DENOMINATOR,
  MAX_EXTRA_TRADE_FEE_RATE,
  MAX_TRADE_FEE_RATE,
  MSG_SENDER,
  PauseFlags,
  isValidTickSpacing
} from './constants.js'

describe('constants', () => {
  it('sentinel addresses', () => {
    expect(ADDRESS_ZERO).toBe('0x0000000000000000000000000000000000000000')
    expect(MSG_SENDER).toBe('0x0000000000000000000000000000000000000001')
    expect(ADDRESS_THIS).toBe('0x0000000000000000000000000000000000000002')
  })

  it('rate constants', () => {
    expect(FEE_RATE_DENOMINATOR).toBe(1_000_000)
    // the two bounds are NOT the same number: the trade fee feeds the `1e6 - feePips` denominator (1e6 would
    // divide by zero), the extra fees are skimmed before the curve and may legally be 100%
    expect(MAX_TRADE_FEE_RATE).toBe(999_999)
    expect(MAX_EXTRA_TRADE_FEE_RATE).toBe(1_000_000)
    expect(MAX_TRADE_FEE_RATE).toBe(FEE_RATE_DENOMINATOR - 1)
  })

  it('ExtraFeeClass', () => {
    expect(ExtraFeeClass.ALPHA).toBe(0)
    expect(ExtraFeeClass.DEX).toBe(1)
  })

  it('PauseFlags is a bitmap', () => {
    expect(PauseFlags.SWAP).toBe(1)
    expect(PauseFlags.ADD).toBe(2)
    expect(PauseFlags.REMOVE).toBe(4)
    expect(PauseFlags.COLLECT).toBe(8)
    expect(PauseFlags.FLASH).toBe(16)
    expect(PauseFlags.SWAP | PauseFlags.ADD | PauseFlags.REMOVE | PauseFlags.COLLECT | PauseFlags.FLASH).toBe(31)
  })

  describe('#isValidTickSpacing', () => {
    it('accepts every value in 1..5', () => {
      for (const ts of [1, 2, 3, 4, 5]) {
        expect(isValidTickSpacing(ts)).toBe(true)
      }
    })

    it('accepts only even values in 6..10', () => {
      expect(isValidTickSpacing(6)).toBe(true)
      expect(isValidTickSpacing(7)).toBe(false)
      expect(isValidTickSpacing(8)).toBe(true)
      expect(isValidTickSpacing(9)).toBe(false)
      expect(isValidTickSpacing(10)).toBe(true)
    })

    it('accepts only multiples of 10 above 10', () => {
      expect(isValidTickSpacing(15)).toBe(false)
      expect(isValidTickSpacing(20)).toBe(true)
      expect(isValidTickSpacing(16380)).toBe(true)
    })

    it('accepts the classic v3 tick spacings', () => {
      for (const ts of [1, 10, 60, 200]) {
        expect(isValidTickSpacing(ts)).toBe(true)
      }
    })

    it('rejects values outside 0 < ts < 16384', () => {
      expect(isValidTickSpacing(0)).toBe(false)
      expect(isValidTickSpacing(-10)).toBe(false)
      expect(isValidTickSpacing(16384)).toBe(false)
      expect(isValidTickSpacing(16390)).toBe(false)
    })

    it('rejects non-integers', () => {
      expect(isValidTickSpacing(1.5)).toBe(false)
      expect(isValidTickSpacing(NaN)).toBe(false)
      expect(isValidTickSpacing(Infinity)).toBe(false)
    })
  })
})
