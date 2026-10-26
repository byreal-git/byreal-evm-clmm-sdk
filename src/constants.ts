/**
 * 常量与部署注册表。
 *
 * 内置两套部署，都在 Mantle（chainId 5000）：
 * - `test`：测试环境，联调用；
 * - `prod`：生产环境，不传 `profileId` 时的默认值。
 *
 * ⚠️ 只支持 **Byreal 定制版 Uniswap V3 合约**（池身份键 (token0, token1, tickSpacing)、
 * extraFeeClass 等），与官方 Uniswap V3 的 ABI 不兼容。
 * poolInitCodeHash 不进注册表，运行时从 `factory.poolInitCodeHash()` 读。
 */
import type { Address } from 'viem'
import type { DeploymentProfileId, IChainConfig, IClmmContracts, IDeploymentProfileConfig } from './types.js'

// 便捷 re-export：这些语义常量的唯一事实源是 `src/raw`
export {
  ExtraFeeClass,
  PauseFlags,
  MAX_TRADE_FEE_RATE,
  MAX_EXTRA_TRADE_FEE_RATE,
  FEE_RATE_DENOMINATOR,
  isValidTickSpacing,
} from './raw/index.js'

/** Multicall3 在绝大多数 EVM 链上都是这个确定性地址（与合约无关，viem 批量读用） */
export const MULTICALL3_ADDRESS: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

export const MANTLE_CHAIN_ID = 5000

/** 未部署时的占位地址（解析时会直接报错，不会拿它发交易） */
const PLACEHOLDER_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

/** 两套部署共用的链信息 */
const MANTLE = {
  chainId: MANTLE_CHAIN_ID,
  name: 'Mantle',
  rpcUrl: 'https://rpc.mantle.xyz',
  explorer: 'https://mantlescan.xyz',
  nativeCurrency: { name: 'Mantle', symbol: 'MNT', decimals: 18 },
} as const

/** WMNT（Mantle 原生币包装合约） */
const WMNT: Address = '0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8'

/** 内置部署注册表。NPM 只能用 **proxy** 地址，禁止使用 implementation 地址。 */
export const DEPLOYMENT_PROFILES: Record<DeploymentProfileId, IDeploymentProfileConfig> = {
  test: {
    ...MANTLE,
    profileId: 'test',
    label: 'Mantle 测试环境',
    deployed: true,
    contracts: {
      factory: '0xa5864429c7a88853951F6Fa50baeF4685D374267',
      positionManager: '0x77704B29BE267ad9a7843fA5F799881ada21b9fa',
      quoter: '0x104dBC505227f705a74837D393d05A43AD22d036',
      swapRouter: '0xcB81c75Dafd9183a2Baf82C18B16a84C22d9b791',
      multicall3: MULTICALL3_ADDRESS,
      weth: WMNT,
    },
  },

  /** 生产环境：合约上线前地址全零占位，使用会直接报错 */
  prod: {
    ...MANTLE,
    profileId: 'prod',
    label: 'Mantle 生产环境',
    deployed: false,
    contracts: {
      factory: PLACEHOLDER_ADDRESS,
      positionManager: PLACEHOLDER_ADDRESS,
      quoter: PLACEHOLDER_ADDRESS,
      swapRouter: PLACEHOLDER_ADDRESS,
      multicall3: MULTICALL3_ADDRESS,
      weth: WMNT,
    },
  },
}

/** 不传 `profileId` 时使用的部署 */
export const DEFAULT_PROFILE_ID: DeploymentProfileId = 'prod'

/**
 * 按 `profileId` 解析出完整部署配置（内置注册表 + 覆盖项）。
 *
 * 必需地址（factory / positionManager / quoter / weth）缺失或仍是零地址占位时直接抛错，
 * 避免拿零地址发交易。生产地址未回填前，可通过 `contracts` 成套传入真实地址。
 */
export function resolveProfileConfig(
  profileId: DeploymentProfileId,
  overrides?: { rpcUrl?: string; contracts?: Partial<IClmmContracts> },
): IChainConfig & { contracts: IClmmContracts } {
  const base = DEPLOYMENT_PROFILES[profileId] as IDeploymentProfileConfig | undefined
  if (!base) {
    throw new Error(
      `[evm-clmm-sdk] 未知的 profileId='${String(profileId)}'，可选值：${Object.keys(DEPLOYMENT_PROFILES).join(' / ')}。`,
    )
  }

  const contracts = { ...base.contracts, ...overrides?.contracts }
  const required: Array<keyof IClmmContracts> = ['factory', 'positionManager', 'quoter', 'weth']
  const invalid = required.filter((k) => !isRealAddress(contracts[k]))
  if (invalid.length > 0) {
    if (!base.deployed) {
      throw new Error(
        `[evm-clmm-sdk] ${base.label}（profileId='${profileId}'）尚未部署。` +
          `联调请使用 profileId: 'test'；已拿到生产地址时可通过 contracts 成套传入（${required.join(' / ')}）。`,
      )
    }
    throw new Error(
      `[evm-clmm-sdk] ${base.label}（profileId='${profileId}'）缺少合约地址：${invalid.join(', ')}。`,
    )
  }

  const { deployed: _deployed, ...config } = base
  return {
    ...config,
    rpcUrl: overrides?.rpcUrl || base.rpcUrl,
    contracts: { multicall3: MULTICALL3_ADDRESS, ...contracts } as IClmmContracts,
  }
}

/** 给了、非空串、且不是零地址占位 */
function isRealAddress(value: string | undefined): boolean {
  return typeof value === 'string' && value !== '' && value !== PLACEHOLDER_ADDRESS
}

// ---------------------------------------------------------------------------
// 数值常量
// ---------------------------------------------------------------------------

/** uint128 最大值：collect 传它表示「能领多少领多少」 */
export const MAX_UINT128 = (1n << 128n) - 1n

/** 默认滑点 0.5% */
export const DEFAULT_SLIPPAGE_BPS = 50

/** 默认 deadline：20 分钟 */
export const DEFAULT_DEADLINE_SEC = 1200

/** tick 边界（与 TickMath 一致） */
export const MIN_TICK = -887272
export const MAX_TICK = 887272
