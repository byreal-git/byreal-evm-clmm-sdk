/**
 * 快照归一化的布尔兼容性回归测试：
 * 后端常把布尔序列化成字符串，`Boolean('false') === true` 会把关着的动态费率误判成开启，
 * 让本应可用的离线报价路径错误地 fail-closed。这里钉死显式解析规则。
 */
import { describe, expect, it } from 'vitest'
import { toPoolStateRaw } from './state.js'

/** 最小合法扁平池快照（tick=0 与 sqrtPriceX96 的自洽性由核心 toUniPool 校验，这里不要求） */
const base = {
  poolAddress: '0xC6962004f452bE9203591991D15f6b388e09E8D0',
  token0: '0x0000000000000000000000000000000000000001',
  token1: '0x0000000000000000000000000000000000000002',
  tradeFeeRate: '3000',
  tickSpacing: '60',
  sqrtPriceX96: '79228162514264337593543950336',
  tick: '0',
  liquidity: '1',
  feeGrowthGlobal0X128: '0',
  feeGrowthGlobal1X128: '0',
}

describe('toPoolStateRaw：dynamicFeeEnabled 的字符串宽进', () => {
  it(`字符串 'false' / '0' 解析为 false（不许用 Boolean() 把它们变成 true）`, () => {
    expect(toPoolStateRaw({ ...base, dynamicFeeEnabled: 'false' }).dynamicFeeEnabled).toBe(false)
    expect(toPoolStateRaw({ ...base, dynamicFeeEnabled: '0' }).dynamicFeeEnabled).toBe(false)
  })

  it(`字符串 'true' / '1' 与原生 boolean 解析为 true`, () => {
    expect(toPoolStateRaw({ ...base, dynamicFeeEnabled: 'true' }).dynamicFeeEnabled).toBe(true)
    expect(toPoolStateRaw({ ...base, dynamicFeeEnabled: '1' }).dynamicFeeEnabled).toBe(true)
    expect(toPoolStateRaw({ ...base, dynamicFeeEnabled: true }).dynamicFeeEnabled).toBe(true)
  })

  it('缺省 false；嵌在 onchainState 里同样生效', () => {
    expect(toPoolStateRaw(base).dynamicFeeEnabled).toBe(false)
    const nested = { ...base, onchainState: { ...base, dynamicFeeEnabled: 'false' } }
    expect(toPoolStateRaw(nested as never).dynamicFeeEnabled).toBe(false)
  })

  it('认不出的写法抛错而不是猜', () => {
    expect(() => toPoolStateRaw({ ...base, dynamicFeeEnabled: 'yes' as never })).toThrow(/无法解析为布尔值/)
  })
})

