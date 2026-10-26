/**
 * 部署注册表的回归测试：只有 test / prod 两套部署，默认 prod；
 * 重点防「占位的零地址被当真地址用」。
 */
import { describe, expect, it } from 'vitest'

import { DEFAULT_PROFILE_ID, DEPLOYMENT_PROFILES, MANTLE_CHAIN_ID, resolveProfileConfig } from './constants.js'
import type { DeploymentProfileId } from './types.js'

const REAL_CONTRACTS = {
  factory: '0x1111111111111111111111111111111111111111',
  positionManager: '0x2222222222222222222222222222222222222222',
  quoter: '0x3333333333333333333333333333333333333333',
  weth: '0x4444444444444444444444444444444444444444',
} as const

describe('DEPLOYMENT_PROFILES', () => {
  it('只有 test / prod 两套，都在 Mantle 上，且 key 与 profileId 一致', () => {
    expect(Object.keys(DEPLOYMENT_PROFILES).sort()).toEqual(['prod', 'test'])
    for (const [id, profile] of Object.entries(DEPLOYMENT_PROFILES)) {
      expect(profile.profileId).toBe(id)
      expect(profile.chainId).toBe(MANTLE_CHAIN_ID)
    }
  })

  it('默认是 prod；prod 上线前是零地址占位', () => {
    expect(DEFAULT_PROFILE_ID).toBe('prod')
    const prod = DEPLOYMENT_PROFILES.prod
    expect(prod.deployed).toBe(false)
    expect(prod.contracts.factory).toBe('0x0000000000000000000000000000000000000000')
    expect(prod.contracts.positionManager).toBe('0x0000000000000000000000000000000000000000')
  })
})

describe('resolveProfileConfig', () => {
  it('test 返回真实地址，且不带 deployed 字段', () => {
    const cfg = resolveProfileConfig('test')

    expect(cfg.profileId).toBe('test')
    expect(cfg.chainId).toBe(MANTLE_CHAIN_ID)
    expect(cfg.contracts.factory).toBe('0xa5864429c7a88853951F6Fa50baeF4685D374267')
    expect(cfg.contracts.positionManager).toBe('0x77704B29BE267ad9a7843fA5F799881ada21b9fa')
    expect('deployed' in cfg).toBe(false)
  })

  it('未知 profileId 报错时列出可选值', () => {
    expect(() => resolveProfileConfig('mantle-test-v2' as DeploymentProfileId)).toThrow(
      /未知的 profileId='mantle-test-v2'，可选值：test \/ prod/,
    )
  })

  it('prod 未部署时拒绝解析，并引导联调使用 test', () => {
    expect(() => resolveProfileConfig('prod')).toThrow(/尚未部署/)
    expect(() => resolveProfileConfig('prod')).toThrow(/profileId: 'test'/)
  })

  it('把真地址整套覆盖进来时，prod 可以用', () => {
    const cfg = resolveProfileConfig('prod', { contracts: REAL_CONTRACTS })

    expect(cfg.profileId).toBe('prod')
    expect(cfg.contracts.factory).toBe(REAL_CONTRACTS.factory)
  })

  // 一半真地址一半零地址占位，绝不能当成「已部署」放行
  it('只覆盖部分必需地址时仍拒绝', () => {
    expect(() => resolveProfileConfig('prod', { contracts: { factory: REAL_CONTRACTS.factory } })).toThrow(
      /尚未部署/,
    )
  })

  it('已部署的 test 被覆盖成零地址同样拒绝', () => {
    expect(() =>
      resolveProfileConfig('test', {
        contracts: { quoter: '0x0000000000000000000000000000000000000000' },
      }),
    ).toThrow(/缺少合约地址：quoter/)
  })

  it('rpcUrl 覆盖生效，multicall3 缺省补齐', () => {
    const cfg = resolveProfileConfig('test', { rpcUrl: 'https://example.invalid' })

    expect(cfg.rpcUrl).toBe('https://example.invalid')
    expect(cfg.contracts.multicall3).toBe('0xcA11bde05977b3631167028862bE2a173976CA11')
  })
})
