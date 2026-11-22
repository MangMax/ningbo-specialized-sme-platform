/**
 * PDF 页图的**纯规则**:磁盘布局、命名、分辨率换算。
 *
 * 渲染本身(pdfium 出像素 + sharp 出 PNG)在 `server/utils/pdf-pages.ts`,
 * 那里依赖原生模块与 wasm,不能进客户端包;本文件**零依赖**,可被路由、测试复用。
 *
 * ── 页图落盘规则 ───────────────────────────────
 *
 *     files/<source>/<kind>/<year>/<batch>/.<文件名>.pages/pNNN.png
 *     files/<source>/<kind>/<year>/<batch>/.<文件名>.pages/.pages.json
 *
 * 即**页图目录 = 源 PDF 同级的隐藏目录**,名字是 `.` + 源文件名 + `.pages`。
 *
 * 前导点标记页图目录为隐藏目录。页图是派生数据，文件登记只关联源 PDF。
 * 目录名取 `.` + 源文件名 + `.pages` 而不是笼统的 `.pages`,是为了**同目录多份 PDF
 * 各归各的**(如 `2024/1/` 下同时有 143 号、58 号、72 号)。
 *
 * 页图**按源文件名派生、放在源文件旁边**(不按内容哈希集中存放):这样人翻开
 * `files/` 目录就能一眼看到「这份 PDF 的页图在哪」,也和 `record_evidence.source_file`
 * 的相对路径口径一致。**换内容不会换路径** —— 重渲染原地覆盖,目录不膨胀;
 * 「同内容不重复写」由清单里的源 sha256 判,见 `server/utils/pdf-pages.ts`。
 */

import { baseName, extensionOf } from './core/file-path'

/** 页图目录后缀(与源文件名拼成 `<文件名>.pages`,再加前导点)。 */
export const PAGES_DIR_SUFFIX = '.pages'

/** 清单文件名。记源 sha256 / 分辨率 / 每页尺寸,是幂等判据的载体。 */
export const PAGES_MANIFEST_NAME = '.pages.json'

/**
 * OCR 默认分辨率。300 DPI 可保留小字细节,也能显著缩小 400 DPI 页图的上传体积;
 * 页图逐页生成、灰度压缩后落盘,
 * 不会把整份 PDF 的位图同时留在内存里。
 */
export const DEFAULT_DPI = 300
/** 分辨率下限(低于 72 DPI 比屏幕还粗,没有意义)。 */
export const MIN_DPI = 72
/** 分辨率上限(600 DPI 下 97 页 A4 约 8 GB 位图,挡住误传)。 */
export const MAX_DPI = 600

/** 位图通道数(PDFium 按 RGBA 出)。 */
export const CHANNELS = 4

/** 是不是 PDF(按扩展名,与文件库同口径)。 */
export function isPdfPath(relPath: string): boolean {
  return extensionOf(baseName(relPath)) === 'pdf'
}

/**
 * 一份 PDF 的页图目录(相对文件库根)。
 *
 * `.` 前缀 + 源文件名 + `.pages`;目录名里的 `.pdf` 后缀**保留** ——
 * `x.pdf` 与同名的 `x.doc` 不会撞进同一个目录。
 */
export function pageDirRelPath(pdfRelPath: string): string {
  const i = pdfRelPath.lastIndexOf('/')
  const dir = i < 0 ? '' : pdfRelPath.slice(0, i + 1)
  const name = i < 0 ? pdfRelPath : pdfRelPath.slice(i + 1)
  return `${dir}.${name}${PAGES_DIR_SUFFIX}`
}

/** 页图文件名。三位补零(`p001.png`),页 1000 起自然变宽但仍按字典序可排。 */
export function pageFileName(pageNo: number): string {
  if (!Number.isInteger(pageNo) || pageNo < 1) {
    throw new Error(`页号必须是正整数:${pageNo}`)
  }
  return `p${String(pageNo).padStart(3, '0')}.png`
}

/** 一页的页图路径(相对文件库根)。 */
export function pageImageRelPath(pdfRelPath: string, pageNo: number): string {
  return `${pageDirRelPath(pdfRelPath)}/${pageFileName(pageNo)}`
}

/** 清单路径(相对文件库根)。 */
export function manifestRelPath(pdfRelPath: string): string {
  return `${pageDirRelPath(pdfRelPath)}/${PAGES_MANIFEST_NAME}`
}

/**
 * 由页图文件名反推页号;不是页图返回 `null`。
 *
 * 只认**清单之外**的 `pNNN.png` —— `.pages.json`、`.tmp` 残留都不是页图。
 */
export function pageNoOf(fileName: string): number | null {
  const m = /^p(\d+)\.png$/.exec(fileName)
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n >= 1 ? n : null
}

/**
 * 目标像素尺寸 = 页尺寸(pt,1/72 英寸)按 DPI 折算。
 *
 * 渲染时**直接给 PDFium 目标像素宽高**(而不是给 scale):像素尺寸由我们算定,
 * 断言与清单里的数字就是确定值,不受引擎内部取整影响。
 */
export function pixelSizeFor(
  widthPt: number,
  heightPt: number,
  dpi: number,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round((widthPt / 72) * dpi)),
    height: Math.max(1, Math.round((heightPt / 72) * dpi)),
  }
}

/**
 * 校验分辨率参数。缺省用 `DEFAULT_DPI`;非整数或越界**抛错**(不静默纠正 ——
 * 静默取整会让人以为「传了 200」而实际按 300 渲染)。
 */
export function normalizeDpi(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_DPI
  const n = Number(raw)
  if (!Number.isInteger(n) || n < MIN_DPI || n > MAX_DPI) {
    throw new Error(`分辨率必须是 ${MIN_DPI}–${MAX_DPI} 之间的整数:${raw}`)
  }
  return n
}
