/**
 * JSBI 的统一入口：src 内一律从这里导入，不要直接 `import JSBI from 'jsbi'`。
 *
 * jsbi 的类型声明写的是 ESM 默认导出（`export default class JSBI`），但 Node 下实际加载的是
 * CJS（`module.exports = JSBI`）。直接导入时，使用方若用 `moduleResolution: NodeNext` 且关闭
 * skipLibCheck，发布出去的 .d.ts 会报「Cannot use namespace 'JSBI' as a type」。
 * 这里把值和类型都钉成 class 本身，Bundler / NodeNext 两种解析下都成立。
 */
import JSBIModule from 'jsbi'

type JSBIClass = typeof import('jsbi').default

const JSBI = JSBIModule as unknown as JSBIClass
type JSBI = import('jsbi').default

export default JSBI
