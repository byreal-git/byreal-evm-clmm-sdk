// 发布前自检：用原生 Node ESM 按包名加载 dist 的三个入口（走 package.json 的 exports），
// 相对 import 漏了 .js 后缀、exports 指错文件、缺导出都会在这里失败。全程 0 RPC。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// JSBI 只能经 src/raw/jsbi.ts 导入，否则 NodeNext 使用方的类型检查会报错（原因见该文件注释）
const distDir = fileURLToPath(new URL('../dist', import.meta.url))
const directJsbi = readdirSync(distDir, { recursive: true })
  .filter((f) => /\.(js|d\.ts)$/.test(f) && !/^raw\/jsbi\./.test(f))
  .filter((f) => /^\s*(import|export)\b[^\n]*from 'jsbi'/m.test(readFileSync(join(distDir, f), 'utf8')))
if (directJsbi.length) throw new Error(`以下文件直接导入了 'jsbi'，请改为从 raw/jsbi.js 导入：${directJsbi.join(', ')}`)

// exports 里声明的每个文件都必须存在
for (const [subpath, target] of Object.entries(pkg.exports)) {
  const files = typeof target === 'string' ? [target] : Object.values(target)
  for (const file of files) {
    if (!existsSync(new URL(`../${file}`, import.meta.url))) {
      throw new Error(`exports["${subpath}"] 指向的 ${file} 不存在，请先 npm run build`)
    }
  }
}

const core = await import(pkg.name)
const compat = await import(`${pkg.name}/compat`)
const raw = await import(`${pkg.name}/raw`)

const expectExports = (mod, label, names) => {
  const missing = names.filter((n) => mod[n] === undefined)
  if (missing.length) throw new Error(`${label} 缺少导出：${missing.join(', ')}`)
}
expectExports(core, '.', ['EvmClmmSdk', 'Chain', 'CLMMClient', 'RewardClient', 'REWARD_CLAIM_VAULT_ABI', 'DEPLOYMENT_PROFILES', 'tickToPrice', 'getTicksByPercentRange'])
expectExports(compat, './compat', ['ByrealClmmSdk', 'CompatChain', 'parseTokenIdFromReceipt'])
expectExports(raw, './raw', ['Pool', 'Position', 'Trade', 'NonfungiblePositionManager', 'SwapRouter', 'SwapQuoter', 'TickMath', 'RewardClaimVault', 'rewardClaimVaultAbi'])

// 构造 + 本地数学（覆盖 JSBI / decimal.js-light 等 CJS 依赖在 Node ESM 下的互操作）
const sdk = new core.EvmClmmSdk({ chainId: 5000, profileId: 'test' })
if (sdk.profileId !== 'test') throw new Error('profileId 解析异常')
const token = (address, decimals) => ({ chainId: 5000, address, decimals, symbol: 'T' })
const price = core.tickToPrice({
  tick: 0,
  token0: token('0x0000000000000000000000000000000000000001', 18),
  token1: token('0x0000000000000000000000000000000000000002', 18),
})
if (price !== '1') throw new Error(`tickToPrice(0) 应为 1，实际 ${price}`)
if (raw.TickMath.getSqrtRatioAtTick(0).toString() !== (2n ** 96n).toString()) throw new Error('TickMath 异常')

console.log(`dist OK：${pkg.name}@${pkg.version}（. / ./compat / ./raw 均可在 Node ESM 下加载）`)
