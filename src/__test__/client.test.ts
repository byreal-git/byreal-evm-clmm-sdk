import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'

import { EvmClmmSdk } from '../client.js'
import { ExtraFeeClass } from '../raw/index.js'

const publicClient = {} as PublicClient

const failedResponse = (status: number, statusText: string) =>
  new Response('failed', { status, statusText })

const successResponse = (result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('EvmClmmSdk', () => {
  it('未指定 extraFeeClass 时默认使用 Dex', () => {
    const sdk = new EvmClmmSdk({ chainId: 5000, profileId: 'test', publicClient })

    expect(sdk.extraFeeClass).toBe(ExtraFeeClass.DEX)
    expect(sdk.chain.extraFeeClass).toBe(ExtraFeeClass.DEX)
  })

  it('仍允许显式使用 Alpha 档位', () => {
    const sdk = new EvmClmmSdk({
      chainId: 5000,
      profileId: 'test',
      publicClient,
      extraFeeClass: ExtraFeeClass.ALPHA,
    })

    expect(sdk.extraFeeClass).toBe(ExtraFeeClass.ALPHA)
  })

  describe('部署环境', () => {
    it("profileId: 'test' 使用测试环境地址", () => {
      const sdk = new EvmClmmSdk({ chainId: 5000, profileId: 'test', publicClient })

      expect(sdk.profileId).toBe('test')
      expect(sdk.contracts.positionManager).toBe('0x77704B29BE267ad9a7843fA5F799881ada21b9fa')
    })

    it('不传 profileId 时默认 prod；prod 未部署时报错并引导使用 test', () => {
      expect(() => new EvmClmmSdk({ chainId: 5000, publicClient })).toThrow(/尚未部署[\s\S]*profileId: 'test'/)
    })

    it('prod 自带整套地址时可用', () => {
      const sdk = new EvmClmmSdk({
        chainId: 5000,
        publicClient,
        contracts: {
          factory: '0x1111111111111111111111111111111111111111',
          positionManager: '0x2222222222222222222222222222222222222222',
          quoter: '0x3333333333333333333333333333333333333333',
          weth: '0x4444444444444444444444444444444444444444',
        },
      })

      expect(sdk.profileId).toBe('prod')
    })

    it('chainId 与部署所在链不一致时抛错', () => {
      expect(() => new EvmClmmSdk({ chainId: 1, profileId: 'test', publicClient })).toThrow(
        /与传入的 chainId=1 不一致/,
      )
    })
  })

  it('内建 RPC 的 403 重试恢复不通知调用方', async () => {
    const onRpcHttpError = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(failedResponse(403, 'Forbidden'))
        .mockResolvedValueOnce(successResponse('0x2')),
    )
    const sdk = new EvmClmmSdk({
      chainId: 5000,
      profileId: 'test',
      rpcUrl: 'https://rpc.example.com',
      onRpcHttpError,
    })

    await expect(sdk.publicClient.request({ method: 'eth_blockNumber' })).resolves.toBe('0x2')
    expect(onRpcHttpError).not.toHaveBeenCalled()
  })

  it('内建 RPC 最终返回 503 时通知调用方一次', async () => {
    const onRpcHttpError = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(failedResponse(503, 'Service Unavailable')),
      ),
    )
    const sdk = new EvmClmmSdk({
      chainId: 5000,
      profileId: 'test',
      rpcUrl: 'https://rpc.example.com',
      onRpcHttpError,
    })

    await expect(sdk.publicClient.request({ method: 'eth_blockNumber' })).rejects.toThrow()
    expect(onRpcHttpError).toHaveBeenCalledOnce()
    expect(onRpcHttpError).toHaveBeenCalledWith({
      rpcMethod: 'eth_blockNumber',
      httpStatus: 503,
    })
  })
})
