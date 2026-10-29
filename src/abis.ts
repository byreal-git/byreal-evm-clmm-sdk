/**
 * SDK 侧 ABI 出口。
 *
 * Byreal 定制合约的 ABI 统一来自 `src/raw/abis`（由合约 artifacts 生成后落盘，
 * 全量 `as const`，viem 可做类型推导），这里按旧名 re-export，避免手工维护第二份精简副本。
 *
 * 核心层与 compat 都只从这里或 `src/raw` 取 ABI。
 */
export {
  factoryAbi as FACTORY_ABI,
  poolAbi as POOL_ABI,
  nonfungiblePositionManagerAbi as NPM_ABI,
  quoterAbi as QUOTER_ABI,
  rewardClaimVaultAbi as REWARD_CLAIM_VAULT_ABI,
} from './raw/abis/index.js'

// ---------- ERC20（含 WETH / WMNT 的 deposit / withdraw；定制合约仓库不含 ERC20，保留本地精简版）----------
export const ERC20_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  // WETH / WMNT 专有
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
] as const
