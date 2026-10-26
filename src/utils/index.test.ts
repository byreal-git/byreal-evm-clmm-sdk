import { describe, expect, it } from 'vitest'

import { deadlineFromNow, percentOf } from './index.js'

describe('percentOf', () => {
  it('100% 精确返回原值（不掉 1 wei）', () => {
    const big = 123_456_789_987_654_321n
    expect(percentOf(big, 100)).toBe(big)
  })
  it('0% 返回 0', () => {
    expect(percentOf(999n, 0)).toBe(0n)
  })
  it('50% 向下取整', () => {
    expect(percentOf(101n, 50)).toBe(50n)
  })
  it('支持小数百分比', () => {
    // 1_000_000 * 33.33% = 333300
    expect(percentOf(1_000_000n, 33.33)).toBe(333_300n)
  })
  it('越界抛错', () => {
    expect(() => percentOf(1n, -1)).toThrow()
    expect(() => percentOf(1n, 100.1)).toThrow()
  })
})

describe('deadlineFromNow', () => {
  it('返回 bigint 且大于当前时间', () => {
    const now = BigInt(Math.floor(Date.now() / 1000))
    const d = deadlineFromNow(1200)
    expect(typeof d).toBe('bigint')
    expect(d).toBeGreaterThanOrEqual(now + 1199n)
    expect(d).toBeLessThanOrEqual(now + 1202n)
  })
  it('负数抛错', () => {
    expect(() => deadlineFromNow(-1)).toThrow()
  })
})
