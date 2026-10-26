import JSBI from 'jsbi'
import { Percent, Token } from './core/index.js'
import { Payments } from './payments.js'

const recipient = '0x0000000000000000000000000000000000000003'
const amount = JSBI.BigInt(123)

const feeOptions = {
  fee: new Percent(1, 1000),
  recipient: '0x0000000000000000000000000000000000000009'
}

const token = new Token(1, '0x0000000000000000000000000000000000000001', 18, 't0', 'token0')

// Selectors are keccak256(signature)[0..4] and pin the recipient-bearing overloads.
const UNWRAP_SELECTOR = '0x49404b7c' // unwrapWETH9(uint256,address)
const UNWRAP_WITH_FEE_SELECTOR = '0x9b2c0a37' // unwrapWETH9WithFee(uint256,address,uint256,address)
const SWEEP_SELECTOR = '0xdf2ab5bb' // sweepToken(address,uint256,address)
const SWEEP_WITH_FEE_SELECTOR = '0xe0e189a0' // sweepTokenWithFee(address,uint256,address,uint256,address)
const REFUND_ETH_SELECTOR = '0x12210e8a' // refundETH()

describe('Payments', () => {
  it('the router ABI carries both the recipient-less and the recipient overloads', () => {
    expect(Payments.INTERFACE.getSighash('unwrapWETH9(uint256,address)')).toBe(UNWRAP_SELECTOR)
    expect(Payments.INTERFACE.getSighash('unwrapWETH9(uint256)')).toBe('0x49616997')
    expect(Payments.INTERFACE.getSighash('unwrapWETH9WithFee(uint256,address,uint256,address)')).toBe(
      UNWRAP_WITH_FEE_SELECTOR
    )
    expect(Payments.INTERFACE.getSighash('unwrapWETH9WithFee(uint256,uint256,address)')).toBe('0xd4ef38de')
    expect(Payments.INTERFACE.getSighash('sweepToken(address,uint256,address)')).toBe(SWEEP_SELECTOR)
    expect(Payments.INTERFACE.getSighash('sweepToken(address,uint256)')).toBe('0xe90a182f')
    expect(Payments.INTERFACE.getSighash('sweepTokenWithFee(address,uint256,address,uint256,address)')).toBe(
      SWEEP_WITH_FEE_SELECTOR
    )
    expect(Payments.INTERFACE.getSighash('sweepTokenWithFee(address,uint256,uint256,address)')).toBe('0x3068c554')

    // bare names are ambiguous — encoding must always use an explicit signature
    expect(() => Payments.INTERFACE.getSighash('unwrapWETH9')).toThrow()
    expect(() => Payments.INTERFACE.getSighash('sweepToken')).toThrow()
  })

  describe('#encodeUnwrapWETH9', () => {
    it('works without feeOptions', () => {
      const calldata = Payments.encodeUnwrapWETH9(amount, recipient)

      expect(calldata.slice(0, 10)).toBe(UNWRAP_SELECTOR)

      const decoded = Payments.INTERFACE.decodeFunctionData('unwrapWETH9(uint256,address)', calldata)
      expect(decoded.amountMinimum.toString()).toBe('123')
      expect(decoded.recipient).toBe(recipient)
    })

    it('works with feeOptions', () => {
      const calldata = Payments.encodeUnwrapWETH9(amount, recipient, feeOptions)

      expect(calldata.slice(0, 10)).toBe(UNWRAP_WITH_FEE_SELECTOR)

      const decoded = Payments.INTERFACE.decodeFunctionData(
        'unwrapWETH9WithFee(uint256,address,uint256,address)',
        calldata
      )
      expect(decoded.amountMinimum.toString()).toBe('123')
      expect(decoded.recipient).toBe(recipient)
      // 0.1% == 10 bips
      expect(decoded.feeBips.toString()).toBe('10')
      expect(decoded.feeRecipient).toBe(feeOptions.recipient)
    })

    it('throws on an invalid recipient', () => {
      expect(() => Payments.encodeUnwrapWETH9(amount, '0xdead')).toThrow('not a valid address')
    })
  })

  describe('#encodeSweepToken', () => {
    it('works without feeOptions', () => {
      const calldata = Payments.encodeSweepToken(token, amount, recipient)

      expect(calldata.slice(0, 10)).toBe(SWEEP_SELECTOR)

      const decoded = Payments.INTERFACE.decodeFunctionData('sweepToken(address,uint256,address)', calldata)
      expect(decoded.token).toBe(token.address)
      expect(decoded.amountMinimum.toString()).toBe('123')
      expect(decoded.recipient).toBe(recipient)
    })

    it('works with feeOptions', () => {
      const calldata = Payments.encodeSweepToken(token, amount, recipient, feeOptions)

      expect(calldata.slice(0, 10)).toBe(SWEEP_WITH_FEE_SELECTOR)

      const decoded = Payments.INTERFACE.decodeFunctionData(
        'sweepTokenWithFee(address,uint256,address,uint256,address)',
        calldata
      )
      expect(decoded.token).toBe(token.address)
      expect(decoded.amountMinimum.toString()).toBe('123')
      expect(decoded.recipient).toBe(recipient)
      expect(decoded.feeBips.toString()).toBe('10')
      expect(decoded.feeRecipient).toBe(feeOptions.recipient)
    })

    it('throws on an invalid fee recipient', () => {
      expect(() =>
        Payments.encodeSweepToken(token, amount, recipient, { fee: new Percent(1, 1000), recipient: '0xdead' })
      ).toThrow('not a valid address')
    })
  })

  describe('feeBips bounds', () => {
    // `require(feeBips > 0 && feeBips <= 100)` in both WithFee variants (PeripheryPaymentsWithFee.sol:23/:44)
    const bipsOf = (fee: Percent): string => {
      const calldata = Payments.encodeSweepToken(token, amount, recipient, { fee, recipient: feeOptions.recipient })
      return Payments.INTERFACE.decodeFunctionData(
        'sweepTokenWithFee(address,uint256,address,uint256,address)',
        calldata
      ).feeBips.toString()
    }

    it('accepts the whole legal window, 1 to 100 bips', () => {
      expect(bipsOf(new Percent(1, 10_000))).toBe('1') // 0.01%, one bip
      expect(bipsOf(new Percent(5, 1000))).toBe('50') // 0.5%
      expect(bipsOf(new Percent(1, 100))).toBe('100') // 1%, the cap
    })

    it('rejects a zero fee', () => {
      expect(() => bipsOf(new Percent(0, 100))).toThrow('FEE_BIPS')
    })

    it('rejects a fee below one bip, which would truncate to 0', () => {
      expect(() => bipsOf(new Percent(5, 100_000))).toThrow('FEE_BIPS') // 0.005% -> floor(0.5) == 0
    })

    it('rejects 101 bips and anything above', () => {
      expect(() => bipsOf(new Percent(101, 10_000))).toThrow('FEE_BIPS') // 1.01%
      // 15% used to encode as 1500 bips and was accepted here; on chain it always reverts
      expect(() => bipsOf(new Percent(15, 100))).toThrow('FEE_BIPS')
    })

    it('rejects a negative fee', () => {
      expect(() => bipsOf(new Percent(-1, 100))).toThrow('FEE_BIPS')
    })

    it('applies to unwrapWETH9WithFee as well', () => {
      expect(() =>
        Payments.encodeUnwrapWETH9(amount, recipient, { fee: new Percent(15, 100), recipient: feeOptions.recipient })
      ).toThrow('FEE_BIPS')
      expect(() =>
        Payments.encodeUnwrapWETH9(amount, recipient, { fee: new Percent(0, 100), recipient: feeOptions.recipient })
      ).toThrow('FEE_BIPS')
    })
  })

  it('#encodeRefundETH', () => {
    expect(Payments.encodeRefundETH()).toBe(REFUND_ETH_SELECTOR)
  })
})
