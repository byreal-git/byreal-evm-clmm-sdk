import { CurrencyAmount, Ether, Percent, Token, WETH9 } from './core/index.js'
import { Pool } from './entities/pool.js'
import { Position } from './entities/position.js'
import { NonfungiblePositionManager } from './nonfungiblePositionManager.js'
import { encodeSqrtRatioX96 } from './utils/encodeSqrtRatioX96.js'

WETH9[1] = new Token(1, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18, 'WETH', 'Wrapped Ether')

const token0 = new Token(1, '0x0000000000000000000000000000000000000001', 18, 't0', 'token0')
const token1 = new Token(1, '0x0000000000000000000000000000000000000002', 18, 't1', 'token1')

// Pool identity uses tickSpacing; tradeFeeRate remains separate mutable data.
const TICK_SPACING = 60
const TRADE_FEE_RATE = 3000

const pool_0_1 = new Pool(token0, token1, TICK_SPACING, TRADE_FEE_RATE, encodeSqrtRatioX96(1, 1), 0, 0, [])
const pool_1_weth = new Pool(token1, WETH9[1], TICK_SPACING, TRADE_FEE_RATE, encodeSqrtRatioX96(1, 1), 0, 0, [])

const recipient = '0x0000000000000000000000000000000000000003'
const sender = '0x0000000000000000000000000000000000000004'
const spender = '0x0000000000000000000000000000000000000005'
const tokenId = 1
const slippageTolerance = new Percent(1, 100)
const deadline = 123

const permitR = '0x0000000000000000000000000000000000000000000000000000000000000001'
const permitS = '0x0000000000000000000000000000000000000000000000000000000000000002'

// Selectors derived independently with viem `toFunctionSelector`, hard-coded so an ABI drift fails loudly.
const SELECTORS = {
  // MintParams keys on int24 tickSpacing and ends with uint256 followTokenId.
  mint: '0xda28d63d', // mint((address,address,int24,int24,int24,uint256,uint256,uint256,uint256,address,uint256,uint256))
  increaseLiquidity: '0x219f5d17', // increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))
  decreaseLiquidity: '0x0c49ccbe', // decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))
  collect: '0xfc6f7865', // collect((uint256,address,uint128,uint128))
  burn: '0x42966c68', // burn(uint256)
  permit: '0x7ac2ff7b', // permit(address,uint256,uint256,uint8,bytes32,bytes32)
  safeTransferFrom: '0x42842e0e', // safeTransferFrom(address,address,uint256)
  safeTransferFromData: '0xb88d4fde', // safeTransferFrom(address,address,uint256,bytes)
  multicall: '0xac9650d8', // multicall(bytes[])
  unwrapWETH9: '0x49404b7c', // unwrapWETH9(uint256,address)
  sweepToken: '0xdf2ab5bb', // sweepToken(address,uint256,address)
  refundETH: '0x12210e8a', // refundETH()
  selfPermit: '0xf3995c67' // selfPermit(address,uint256,uint256,uint8,bytes32,bytes32)
}

// Full-calldata anchors pin the contract ABI and fail loudly if a selector or struct layout changes.
const GOLDEN = {
  mint:
    '0xda28d63d00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000003cffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc4000000000000000000000000000000000000000000000000000000000000003c00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000007b0000000000000000000000000000000000000000000000000000000000000000',
  mintFollow42:
    '0xda28d63d00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000003cffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc4000000000000000000000000000000000000000000000000000000000000003c00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000007b000000000000000000000000000000000000000000000000000000000000002a',
  mintWeth:
    '0xda28d63d0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000000000000000000000000000000000000000003cffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc4000000000000000000000000000000000000000000000000000000000000003c00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000007b0000000000000000000000000000000000000000000000000000000000000000',
  increase:
    '0x219f5d1700000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007b',
  collect:
    '0xfc6f78650000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000ffffffffffffffffffffffffffffffff00000000000000000000000000000000ffffffffffffffffffffffffffffffff',
  collectEth:
    '0xac9650d8000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000001a00000000000000000000000000000000000000000000000000000000000000084fc6f78650000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ffffffffffffffffffffffffffffffff00000000000000000000000000000000ffffffffffffffffffffffffffffffff00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004449404b7c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064df2ab5bb00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000',
  remove:
    '0xac9650d8000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000a40c49ccbe0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000006400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000084fc6f78650000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000ffffffffffffffffffffffffffffffff00000000000000000000000000000000ffffffffffffffffffffffffffffffff00000000000000000000000000000000000000000000000000000000',
  removePartial:
    '0xac9650d8000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000a40c49ccbe0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000003200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000084fc6f78650000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000ffffffffffffffffffffffffffffffff00000000000000000000000000000000ffffffffffffffffffffffffffffffff00000000000000000000000000000000000000000000000000000000',
  removeEth:
    '0xac9650d80000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000160000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000000a40c49ccbe0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000006400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000084fc6f78650000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ffffffffffffffffffffffffffffffff00000000000000000000000000000000ffffffffffffffffffffffffffffffff00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004449404b7c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064df2ab5bb00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000',
  removePartialEth:
    '0xac9650d80000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000160000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000000a40c49ccbe0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000003200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000084fc6f78650000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ffffffffffffffffffffffffffffffff00000000000000000000000000000000ffffffffffffffffffffffffffffffff00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004449404b7c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064df2ab5bb00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000',
  safeTransferFrom:
    '0x42842e0e000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000001',
  safeTransferFromData:
    '0xb88d4fde000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000009004000000000000000000000000'
}

function positionIn(pool: Pool, liquidity: number): Position {
  return new Position({ pool, tickLower: -TICK_SPACING, tickUpper: TICK_SPACING, liquidity })
}

/** The NPM has a single `multicall(bytes[])`, so its own Interface can unwrap what Multicall produced. */
function subcalls(calldata: string): string[] {
  return NonfungiblePositionManager.INTERFACE.decodeFunctionData('multicall(bytes[])', calldata)[0]
}

describe('NonfungiblePositionManager', () => {
  it('exposes exactly one multicall and no pool-creation entry point', () => {
    expect(NonfungiblePositionManager.INTERFACE.getSighash('multicall(bytes[])')).toBe(SELECTORS.multicall)
    // no `multicall(uint256,bytes[])` overload => the bare name must resolve
    expect(NonfungiblePositionManager.INTERFACE.getSighash('multicall')).toBe(SELECTORS.multicall)
    expect(() => NonfungiblePositionManager.INTERFACE.getFunction('createAndInitializePoolIfNecessary')).toThrow()
    expect(NonfungiblePositionManager).not.toHaveProperty('createCallParameters')
  })

  it('carries the NPM-flavoured (2/3-arg) payments functions, which Payments already encodes', () => {
    expect(NonfungiblePositionManager.INTERFACE.getSighash('unwrapWETH9(uint256,address)')).toBe(SELECTORS.unwrapWETH9)
    expect(NonfungiblePositionManager.INTERFACE.getSighash('sweepToken(address,uint256,address)')).toBe(
      SELECTORS.sweepToken
    )
    expect(NonfungiblePositionManager.INTERFACE.getSighash('refundETH()')).toBe(SELECTORS.refundETH)
    // unlike the router there are no recipient-less / WithFee overloads, so the bare names are unambiguous
    expect(NonfungiblePositionManager.INTERFACE.getSighash('unwrapWETH9')).toBe(SELECTORS.unwrapWETH9)
    expect(NonfungiblePositionManager.INTERFACE.getSighash('sweepToken')).toBe(SELECTORS.sweepToken)
    expect(() => NonfungiblePositionManager.INTERFACE.getFunction('unwrapWETH9WithFee')).toThrow()
    expect(() => NonfungiblePositionManager.INTERFACE.getFunction('sweepTokenWithFee')).toThrow()
  })

  describe('#addCallParameters', () => {
    it('throws if liquidity is 0', () => {
      expect(() =>
        NonfungiblePositionManager.addCallParameters(positionIn(pool_0_1, 0), {
          recipient,
          slippageTolerance,
          deadline
        })
      ).toThrow('ZERO_LIQUIDITY')
    })

    it('throws if pool does not involve ether and useNative is true', () => {
      expect(() =>
        NonfungiblePositionManager.addCallParameters(positionIn(pool_0_1, 1), {
          recipient,
          slippageTolerance,
          deadline,
          useNative: Ether.onChain(1)
        })
      ).toThrow('NO_WETH')
    })

    it('succeeds for mint', () => {
      const { calldata, value } = NonfungiblePositionManager.addCallParameters(positionIn(pool_0_1, 1), {
        recipient,
        slippageTolerance,
        deadline
      })

      expect(calldata).toEqual(GOLDEN.mint)
      expect(value).toEqual('0x00')

      const [params] = NonfungiblePositionManager.INTERFACE.decodeFunctionData('mint', calldata)
      expect(params.token0).toBe(token0.address)
      expect(params.token1).toBe(token1.address)
      expect(params.tickSpacing).toBe(TICK_SPACING)
      expect(params.tickLower).toBe(-TICK_SPACING)
      expect(params.tickUpper).toBe(TICK_SPACING)
      expect(params.amount0Desired.toString()).toBe('1')
      expect(params.amount1Desired.toString()).toBe('1')
      expect(params.amount0Min.toString()).toBe('0')
      expect(params.amount1Min.toString()).toBe('0')
      expect(params.recipient).toBe(recipient)
      expect(params.deadline.toString()).toBe('123')
      // followTokenId defaults to 0 when the option is omitted
      expect(params.followTokenId.toString()).toBe('0')
      // the struct really is 12 fields in the documented order
      expect(params.length).toBe(12)
    })

    it('mint carries the tick spacing, never the trade fee rate', () => {
      const pool_ts10 = new Pool(token0, token1, 10, 500, encodeSqrtRatioX96(1, 1), 0, 0, [])
      const { calldata } = NonfungiblePositionManager.addCallParameters(
        new Position({ pool: pool_ts10, tickLower: -10, tickUpper: 10, liquidity: 1 }),
        { recipient, slippageTolerance, deadline }
      )

      const [params] = NonfungiblePositionManager.INTERFACE.decodeFunctionData('mint', calldata)
      expect(params.tickSpacing).toBe(10)
      expect(JSON.stringify(params)).not.toContain('500')
    })

    it('mint with an explicit followTokenId', () => {
      const { calldata, value } = NonfungiblePositionManager.addCallParameters(positionIn(pool_0_1, 1), {
        recipient,
        slippageTolerance,
        deadline,
        followTokenId: 42
      })

      expect(calldata).toEqual(GOLDEN.mintFollow42)
      expect(value).toEqual('0x00')

      const [params] = NonfungiblePositionManager.INTERFACE.decodeFunctionData('mint', calldata)
      expect(params.followTokenId.toString()).toBe('42')
      // nothing else moved: the two goldens differ only in the last word
      expect(calldata.slice(0, -64)).toBe(GOLDEN.mint.slice(0, -64))
    })

    it('mint accepts a string followTokenId', () => {
      const { calldata } = NonfungiblePositionManager.addCallParameters(positionIn(pool_0_1, 1), {
        recipient,
        slippageTolerance,
        deadline,
        followTokenId: '340282366920938463463374607431768211456'
      })

      const [params] = NonfungiblePositionManager.INTERFACE.decodeFunctionData('mint', calldata)
      expect(params.followTokenId.toString()).toBe('340282366920938463463374607431768211456')
    })

    it('succeeds for increase', () => {
      const { calldata, value } = NonfungiblePositionManager.addCallParameters(positionIn(pool_0_1, 1), {
        tokenId,
        slippageTolerance,
        deadline
      })

      expect(calldata).toEqual(GOLDEN.increase)
      expect(value).toEqual('0x00')

      const [params] = NonfungiblePositionManager.INTERFACE.decodeFunctionData('increaseLiquidity', calldata)
      expect(params.tokenId.toString()).toBe('1')
      expect(params.amount0Desired.toString()).toBe('1')
      expect(params.amount1Desired.toString()).toBe('1')
      expect(params.amount0Min.toString()).toBe('0')
      expect(params.amount1Min.toString()).toBe('0')
      expect(params.deadline.toString()).toBe('123')
      expect(params.length).toBe(6)
    })

    it('prepends the permits, in token0/token1 order', () => {
      const permit = { v: 1 as const, r: permitR, s: permitS, amount: 1, deadline: 123 }
      const { calldata } = NonfungiblePositionManager.addCallParameters(positionIn(pool_0_1, 1), {
        recipient,
        slippageTolerance,
        deadline,
        token0Permit: permit,
        token1Permit: permit
      })

      expect(calldata.slice(0, 10)).toBe(SELECTORS.multicall)
      const calls = subcalls(calldata)
      expect(calls).toHaveLength(3)
      expect(calls[0].slice(0, 10)).toBe(SELECTORS.selfPermit)
      expect(calls[1].slice(0, 10)).toBe(SELECTORS.selfPermit)
      expect(calls[2]).toBe(GOLDEN.mint)
      // the permits target token0 then token1
      const permitted = calls
        .slice(0, 2)
        .map(c => NonfungiblePositionManager.INTERFACE.decodeFunctionData('selfPermit', c).token)
      expect(permitted).toEqual([token0.address, token1.address])
    })

    it('useNative', () => {
      const { calldata, value } = NonfungiblePositionManager.addCallParameters(positionIn(pool_1_weth, 1), {
        recipient,
        slippageTolerance,
        deadline,
        useNative: Ether.onChain(1)
      })

      expect(calldata.slice(0, 10)).toBe(SELECTORS.multicall)
      // WETH sorts after token1, so it is token1 of the pool and amount1Desired is the ETH value
      expect(value).toEqual('0x01')

      const calls = subcalls(calldata)
      expect(calls).toHaveLength(2)
      expect(calls[0]).toBe(GOLDEN.mintWeth)
      expect(calls[1]).toBe(SELECTORS.refundETH)
    })
  })

  describe('#collectCallParameters', () => {
    it('works', () => {
      const { calldata, value } = NonfungiblePositionManager.collectCallParameters({
        tokenId,
        expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(token0, 0),
        expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(token1, 0),
        recipient
      })

      expect(calldata).toEqual(GOLDEN.collect)
      expect(value).toEqual('0x00')

      const [params] = NonfungiblePositionManager.INTERFACE.decodeFunctionData('collect', calldata)
      expect(params.tokenId.toString()).toBe('1')
      expect(params.recipient).toBe(recipient)
      expect(params.amount0Max.toString()).toBe('340282366920938463463374607431768211455')
      expect(params.amount1Max.toString()).toBe('340282366920938463463374607431768211455')
    })

    it('works with eth', () => {
      const { calldata, value } = NonfungiblePositionManager.collectCallParameters({
        tokenId,
        expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(token1, 0),
        expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(Ether.onChain(1), 0),
        recipient
      })

      expect(calldata).toEqual(GOLDEN.collectEth)
      expect(value).toEqual('0x00')

      const calls = subcalls(calldata)
      expect(calls.map(c => c.slice(0, 10))).toEqual([
        SELECTORS.collect,
        SELECTORS.unwrapWETH9,
        SELECTORS.sweepToken
      ])
      // collect sweeps into the NPM itself, then unwrap/sweep forward to the real recipient
      const [params] = NonfungiblePositionManager.INTERFACE.decodeFunctionData('collect', calls[0])
      expect(params.recipient).toBe('0x0000000000000000000000000000000000000000')
      const unwrapped = NonfungiblePositionManager.INTERFACE.decodeFunctionData('unwrapWETH9', calls[1])
      expect(unwrapped.recipient).toBe(recipient)
      const swept = NonfungiblePositionManager.INTERFACE.decodeFunctionData('sweepToken', calls[2])
      expect(swept.token).toBe(token1.address)
      expect(swept.recipient).toBe(recipient)
    })
  })

  describe('#removeCallParameters', () => {
    const collectOptions = {
      expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(token0, 0),
      expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(token1, 0),
      recipient
    }

    it('throws for 0 liquidity', () => {
      expect(() =>
        NonfungiblePositionManager.removeCallParameters(positionIn(pool_0_1, 0), {
          tokenId,
          liquidityPercentage: new Percent(1),
          slippageTolerance,
          deadline,
          collectOptions
        })
      ).toThrow('ZERO_LIQUIDITY')
    })

    it('throws for 0 liquidity from small percentage', () => {
      expect(() =>
        NonfungiblePositionManager.removeCallParameters(positionIn(pool_0_1, 50), {
          tokenId,
          liquidityPercentage: new Percent(1, 100),
          slippageTolerance,
          deadline,
          collectOptions
        })
      ).toThrow('ZERO_LIQUIDITY')
    })

    it('throws for bad burn', () => {
      expect(() =>
        NonfungiblePositionManager.removeCallParameters(positionIn(pool_0_1, 50), {
          tokenId,
          liquidityPercentage: new Percent(99, 100),
          slippageTolerance,
          deadline,
          burnToken: true,
          collectOptions
        })
      ).toThrow('CANNOT_BURN')
    })

    it('works', () => {
      const { calldata, value } = NonfungiblePositionManager.removeCallParameters(positionIn(pool_0_1, 100), {
        tokenId,
        liquidityPercentage: new Percent(1),
        slippageTolerance,
        deadline,
        collectOptions
      })

      expect(calldata).toEqual(GOLDEN.remove)
      expect(value).toEqual('0x00')

      const calls = subcalls(calldata)
      expect(calls.map(c => c.slice(0, 10))).toEqual([SELECTORS.decreaseLiquidity, SELECTORS.collect])
      const [params] = NonfungiblePositionManager.INTERFACE.decodeFunctionData('decreaseLiquidity', calls[0])
      expect(params.tokenId.toString()).toBe('1')
      expect(params.liquidity.toString()).toBe('100')
      expect(params.amount0Min.toString()).toBe('0')
      expect(params.amount1Min.toString()).toBe('0')
      expect(params.deadline.toString()).toBe('123')
      expect(params.length).toBe(5)
    })

    it('works for partial', () => {
      const { calldata, value } = NonfungiblePositionManager.removeCallParameters(positionIn(pool_0_1, 100), {
        tokenId,
        liquidityPercentage: new Percent(1, 2),
        slippageTolerance,
        deadline,
        collectOptions
      })

      expect(calldata).toEqual(GOLDEN.removePartial)
      expect(value).toEqual('0x00')

      const [params] = NonfungiblePositionManager.INTERFACE.decodeFunctionData(
        'decreaseLiquidity',
        subcalls(calldata)[0]
      )
      expect(params.liquidity.toString()).toBe('50')
    })

    it('appends burn when the whole position is exited', () => {
      const { calldata } = NonfungiblePositionManager.removeCallParameters(positionIn(pool_0_1, 100), {
        tokenId,
        liquidityPercentage: new Percent(1),
        slippageTolerance,
        deadline,
        burnToken: true,
        collectOptions
      })

      const calls = subcalls(calldata)
      expect(calls.map(c => c.slice(0, 10))).toEqual([
        SELECTORS.decreaseLiquidity,
        SELECTORS.collect,
        SELECTORS.burn
      ])
      expect(NonfungiblePositionManager.INTERFACE.decodeFunctionData('burn', calls[2])[0].toString()).toBe('1')
    })

    it('prepends the NFT permit', () => {
      const { calldata } = NonfungiblePositionManager.removeCallParameters(positionIn(pool_0_1, 100), {
        tokenId,
        liquidityPercentage: new Percent(1),
        slippageTolerance,
        deadline,
        permit: { v: 1, r: permitR, s: permitS, deadline: 456, spender },
        collectOptions
      })

      const calls = subcalls(calldata)
      expect(calls.map(c => c.slice(0, 10))).toEqual([
        SELECTORS.permit,
        SELECTORS.decreaseLiquidity,
        SELECTORS.collect
      ])
      const decoded = NonfungiblePositionManager.INTERFACE.decodeFunctionData('permit', calls[0])
      expect(decoded.spender).toBe(spender)
      expect(decoded.tokenId.toString()).toBe('1')
      expect(decoded.deadline.toString()).toBe('456')
      expect(decoded.v).toBe(1)
      expect(decoded.r).toBe(permitR)
      expect(decoded.s).toBe(permitS)
    })

    it('works with eth', () => {
      const ethAmount = CurrencyAmount.fromRawAmount(Ether.onChain(1), 0)
      const tokenAmount = CurrencyAmount.fromRawAmount(token1, 0)

      const { calldata, value } = NonfungiblePositionManager.removeCallParameters(positionIn(pool_1_weth, 100), {
        tokenId,
        liquidityPercentage: new Percent(1),
        slippageTolerance,
        deadline,
        collectOptions: {
          expectedCurrencyOwed0: pool_1_weth.token0.equals(token1) ? tokenAmount : ethAmount,
          expectedCurrencyOwed1: pool_1_weth.token0.equals(token1) ? ethAmount : tokenAmount,
          recipient
        }
      })

      expect(calldata).toEqual(GOLDEN.removeEth)
      expect(value).toEqual('0x00')
      expect(subcalls(calldata).map(c => c.slice(0, 10))).toEqual([
        SELECTORS.decreaseLiquidity,
        SELECTORS.collect,
        SELECTORS.unwrapWETH9,
        SELECTORS.sweepToken
      ])
    })

    it('works for partial with eth', () => {
      const ethAmount = CurrencyAmount.fromRawAmount(Ether.onChain(1), 0)
      const tokenAmount = CurrencyAmount.fromRawAmount(token1, 0)

      const { calldata, value } = NonfungiblePositionManager.removeCallParameters(positionIn(pool_1_weth, 100), {
        tokenId,
        liquidityPercentage: new Percent(1, 2),
        slippageTolerance,
        deadline,
        collectOptions: {
          expectedCurrencyOwed0: pool_1_weth.token0.equals(token1) ? tokenAmount : ethAmount,
          expectedCurrencyOwed1: pool_1_weth.token0.equals(token1) ? ethAmount : tokenAmount,
          recipient
        }
      })

      expect(calldata).toEqual(GOLDEN.removePartialEth)
      expect(value).toEqual('0x00')
    })
  })

  describe('#safeTransferFromParameters', () => {
    it('succeeds no data param', () => {
      const { calldata, value } = NonfungiblePositionManager.safeTransferFromParameters({
        sender,
        recipient,
        tokenId
      })

      expect(calldata).toEqual(GOLDEN.safeTransferFrom)
      expect(calldata.slice(0, 10)).toBe(SELECTORS.safeTransferFrom)
      expect(value).toEqual('0x00')

      const decoded = NonfungiblePositionManager.INTERFACE.decodeFunctionData(
        'safeTransferFrom(address,address,uint256)',
        calldata
      )
      expect(decoded.from).toBe(sender)
      expect(decoded.to).toBe(recipient)
      expect(decoded.tokenId.toString()).toBe('1')
    })

    it('succeeds data param', () => {
      const data = '0x0000000000000000000000000000000000009004'
      const { calldata, value } = NonfungiblePositionManager.safeTransferFromParameters({
        sender,
        recipient,
        tokenId,
        data
      })

      expect(calldata).toEqual(GOLDEN.safeTransferFromData)
      expect(calldata.slice(0, 10)).toBe(SELECTORS.safeTransferFromData)
      expect(value).toEqual('0x00')

      const decoded = NonfungiblePositionManager.INTERFACE.decodeFunctionData(
        'safeTransferFrom(address,address,uint256,bytes)',
        calldata
      )
      expect(decoded._data).toBe(data)
    })

    it('throws on an invalid address', () => {
      expect(() =>
        NonfungiblePositionManager.safeTransferFromParameters({ sender, recipient: '0xdead', tokenId })
      ).toThrow('not a valid address')
    })
  })
})
