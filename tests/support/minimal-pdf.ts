/**
 * 造一份**最小多页 PDF**:每页画若干个黑色方块,方块个数 == 页号。
 *
 * 为什么要自己造而不是拿 `files/` 里的真件当夹具:
 *
 *  - 测试要断言**页图的像素**属于**这一页**(而不是「有文件就算过」)。真件的页内容
 *    我无法在断言里表达;这里的方块数是**可数的**,渲染出来数一遍列就知道是第几页。
 *  - 页尺寸固定(默认 400×200 pt),于是目标像素尺寸能**精确算出**,不受引擎取整影响。
 *  - 不压缩、无字体、无外部依赖 —— 生成过程完全确定,几 KB,进仓库没有负担。
 *
 * 结构是最朴素的 PDF 1.7:对象 1 = Catalog,2 = Pages 树,之后每页两个对象
 * (Page / Contents)。交叉引用表按**真实字节偏移**生成(latin1 计数,纯 ASCII),
 * 不依赖任何 PDF 库,也不用 pdfium 的容错重建。
 */

export interface MinimalPdfOptions {
  /** 页数。 */
  pages: number
  /** 页宽(pt)。 */
  widthPt?: number
  /** 页高(pt)。 */
  heightPt?: number
}

/** 一个方块的边长(pt)。 */
export const MARK_SIZE_PT = 20
/** 相邻方块的间隔(pt)。 */
export const MARK_GAP_PT = 10
/** 方块行距页顶的距离(pt)。 */
const MARK_TOP_PT = 20

/** 生成一份最小多页 PDF 的字节。 */
export function minimalPdf({ pages, widthPt = 400, heightPt = 200 }: MinimalPdfOptions): Buffer {
  if (!Number.isInteger(pages) || pages < 1) throw new Error('pages 必须是正整数')

  const chunks: Buffer[] = []
  let offset = 0
  const put = (text: string): void => {
    // latin1:一字符一字节,偏移量才不会因为中文/高位字符算错。本文件只吐 ASCII。
    const buf = Buffer.from(text, 'latin1')
    chunks.push(buf)
    offset += buf.length
  }

  /** 每页占用两个对象:Page = 3+2i,Contents = 4+2i。 */
  const pageObj = (i: number): number => 3 + i * 2
  const contentObj = (i: number): number => 4 + i * 2
  const objectCount = 2 + pages * 2

  const bodies = new Map<number, string>()
  bodies.set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  const kids = Array.from({ length: pages }, (_, i) => `${pageObj(i)} 0 R`).join(' ')
  bodies.set(2, `<< /Type /Pages /Count ${pages} /Kids [${kids}] >>`)
  for (let i = 0; i < pages; i += 1) {
    bodies.set(
      pageObj(i),
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] ` +
        `/Resources << >> /Contents ${contentObj(i)} 0 R >>`,
    )
    // 第 i 页(i 从 0 起)画 i+1 个方块 —— 渲染后数方块就知道是第几页。
    const marks = Array.from(
      { length: i + 1 },
      (_, k) => `${20 + k * (MARK_SIZE_PT + MARK_GAP_PT)} ${heightPt - MARK_TOP_PT - MARK_SIZE_PT} ${MARK_SIZE_PT} ${MARK_SIZE_PT} re`,
    ).join('\n')
    // PDF 的 y 轴向上,所以方块贴的是 MediaBox 的**上**边。
    const stream = `0 0 0 rg\n${marks}\nf\n`
    bodies.set(contentObj(i), `<< /Length ${stream.length} >>\nstream\n${stream}endstream`)
  }

  put('%PDF-1.7\n')

  const offsets = new Map<number, number>()
  for (let n = 1; n <= objectCount; n += 1) {
    offsets.set(n, offset)
    put(`${n} 0 obj\n${bodies.get(n)}\nendobj\n`)
  }

  const xrefOffset = offset
  put(`xref\n0 ${objectCount + 1}\n`)
  put('0000000000 65535 f \n')
  for (let n = 1; n <= objectCount; n += 1) {
    put(`${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`)
  }
  put(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)

  return Buffer.concat(chunks)
}

/**
 * 标记行在**页图**里的行范围(从页顶往下数)。两端各收 1 px,避开抗锯齿的边。
 */
export function markBand(dpi: number): { fromRow: number; toRow: number } {
  // PDF 的 y 轴向上:方块贴页顶 MARK_TOP_PT,占 MARK_SIZE_PT 高。
  return {
    fromRow: Math.ceil((MARK_TOP_PT / 72) * dpi) + 1,
    toRow: Math.max(
      Math.ceil((MARK_TOP_PT / 72) * dpi) + 1,
      Math.floor(((MARK_TOP_PT + MARK_SIZE_PT) / 72) * dpi) - 1,
    ),
  }
}

/**
 * 数一张页图**顶部标记行**里有几个黑方块。
 *
 * 逐列判断「这一列在标记行范围内有没有暗像素」,再数暗列的**连续段数**。
 * 一张正确的页图,段数应当等于该页的页号(方块之间有空隙,不会连成一段)。
 */
export function countDarkRuns(
  pixels: Uint8Array,
  width: number,
  channels: number,
  fromRow: number,
  toRow: number,
  threshold = 128,
): number {
  const darkColumn = new Uint8Array(width)
  for (let y = fromRow; y <= toRow && y * width * channels < pixels.length; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // 只取红通道即可:方块是纯黑(0,0,0),背景纯白。
      if ((pixels[(y * width + x) * channels] ?? 255) < threshold) darkColumn[x] = 1
    }
  }
  let runs = 0
  for (let x = 0; x < width; x += 1) {
    if (darkColumn[x] === 1 && darkColumn[x - 1] !== 1) runs += 1
  }
  return runs
}
