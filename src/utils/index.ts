/**
 * SDK 内部用到的小工具（纯函数，0 RPC）。
 * 只保留 SDK 自己会用的两个：写操作的 deadline、按百分比取整。
 * 与流动性管理无关的通用工具（滑点加减 / 地址缩写 / 浏览器链接）由调用方自行实现。
 */
import { DEFAULT_DEADLINE_SEC } from '../constants.js'

/** 生成 deadline（unix 秒）：当前时间 + sec 秒。合约里的 deadline 是 uint256 秒级时间戳，返回 bigint */
export function deadlineFromNow(sec: number = DEFAULT_DEADLINE_SEC): bigint {
  if (!Number.isFinite(sec) || sec < 0) {
    throw new Error(`[evm-clmm-sdk] deadlineSec 必须是非负数，收到 ${sec}`)
  }
  return BigInt(Math.floor(Date.now() / 1000) + Math.floor(sec))
}

/**
 * 取 amount 的 percent%（0 ~ 100，支持小数如 33.33），向下取整。
 * percent=100 时**精确**返回原值，不会因浮点误差少 1 wei（按比例减仓用）。
 */
export function percentOf(amount: bigint, percent: number): bigint {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error(`[evm-clmm-sdk] percent 必须在 [0, 100] 之间，收到 ${percent}`)
  }
  if (percent === 100) return amount
  if (percent === 0) return 0n
  // 放大 1e6 保留 6 位小数精度，再用整数运算，避免 Number 浮点误差
  const SCALE = 1_000_000n
  const scaled = BigInt(Math.round(percent * Number(SCALE)))
  return (amount * scaled) / (100n * SCALE)
}
