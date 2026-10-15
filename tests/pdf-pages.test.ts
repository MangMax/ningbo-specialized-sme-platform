import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import {
  DEFAULT_DPI,
  MAX_DPI,
  MIN_DPI,
  isPdfPath,
  manifestRelPath,
  normalizeDpi,
  pageDirRelPath,
  pageFileName,
  pageImageRelPath,
  pageNoOf,
  pixelSizeFor,
} from '../lib/pdf-page'
import {
  listPdfPages,
  pageImagePath,
  removePdfPages,
  renderPdfPages,
  resolveWithinRoot,
} from '../server/utils/pdf-pages'
import { countDarkRuns, markBand, minimalPdf } from './helpers/minimal-pdf'

/**
 * 票 13 的页图渲染。分两层:
 *
 *  1. **纯规则**(路径布局 / 命名 / 分辨率换算)—— 无 IO,断言就是规则本身;
 *  2. **渲染端到端** —— 造一份最小多页 PDF,真跑 pdfium + sharp,断言
 *     「页图数 == 页数」「像素尺寸对得上」「**这张图确实是这一页**」「重跑不写盘」
 *     「换内容 / 换 DPI 原地覆盖不膨胀」。
 *
 * 夹具是自造的(`tests/helpers/minimal-pdf.ts`),不放真件:真件几十 MB,且页内容无法在
 * 断言里表达。真件的验收(12 页的 72 号与 97 页的公布.pdf)走**真实接口**,证据写在票 13 里。
 *
 * 每个用例用 `ensure()` 自己把基线摆好,不依赖同文件里别的用例先跑过。
 */

/** 夹具每页的 pt 尺寸。 */
const PAGE_PT = { width: 400, height: 200 }
/** 测试用的分辨率(比默认 300 低,快;规则与 DPI 无关)。 */
const DPI = 100
/** 夹具在文件库里的相对路径(形状照 `files/README.md`:source/kind/year/batch/名)。 */
const REL = 'jxj/announcement/2024/1/fixture.pdf'

/** sharp writes PNG pixels as RGB when DPI metadata is present; grayscale means R=G=B. */
function isGrayscaleRgb(pixels: Buffer, channels: number): boolean {
  if (channels !== 3) return false
  for (let index = 0; index < pixels.length; index += channels) {
    if (pixels[index] !== pixels[index + 1] || pixels[index + 1] !== pixels[index + 2]) {
      return false
    }
  }
  return true
}

/**
 * 临时文件库根。**建在模块作用域**:下面各 describe 的 `dirAbs` 是模块级常量,
 * 若在 `beforeAll` 里才建,它们会算出相对路径 —— 于是断言比的是 cwd 下的幻影目录。
 */
const root = mkdtempSync(join(tmpdir(), 'pdf-pages-'))

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 往临时文件库里写一份夹具 PDF(目录按文件库规则建)。 */
async function writeFixture(relPath: string, pages: number): Promise<string> {
  const abs = join(root, relPath)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, minimalPdf({ pages, ...PAGE_PT }))
  return abs
}

/** 目录快照(文件名 → 尺寸 @ mtime),用于断言「确实一个字节都没写」。 */
async function snapshot(dirAbs: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of (await readdir(dirAbs)).sort()) {
    const info = await stat(join(dirAbs, name))
    out[name] = `${info.size}@${info.mtimeMs}`
  }
  return out
}

/** 摆好基线:清掉旧页图 → 写夹具 → 渲染。返回渲染结果。 */
async function ensure(relPath: string, pages: number, dpi = DPI) {
  await removePdfPages(root, relPath)
  await writeFixture(relPath, pages)
  return renderPdfPages(root, relPath, { dpi })
}

/** 列目录(排序后),断言页图集合时用。 */
async function names(dirAbs: string): Promise<string[]> {
  return (await readdir(dirAbs)).sort()
}

describe('页图路径与命名(纯规则)', () => {
  it('页图目录 = 源文件同级、`.` + 源文件名 + `.pages`', () => {
    expect(pageDirRelPath('jxj/announcement/2024/1/甬经信中小〔2024〕72号.pdf')).toBe(
      'jxj/announcement/2024/1/.甬经信中小〔2024〕72号.pdf.pages',
    )
    // 没有目录的裸文件名也能落位。
    expect(pageDirRelPath('a.pdf')).toBe('.a.pdf.pages')
  })

  it('页图目录名带前导点 —— 文件库扫描器据此跳过页图', () => {
    // 这是「页图不进 stored_file」的**唯一依据**:`scanFileStore` 跳过以 `.` 开头的名字。
    // 名字若改了,要连带改 `files/README.md` 与扫描器,故在此钉住。
    expect(pageDirRelPath(REL).split('/').pop()?.startsWith('.')).toBe(true)
    expect(pageDirRelPath(REL).endsWith('.pdf.pages')).toBe(true)
  })

  it('页图从 p001 起三位补零,页号是路径的一部分', () => {
    expect(pageFileName(1)).toBe('p001.png')
    expect(pageFileName(12)).toBe('p012.png')
    expect(pageFileName(97)).toBe('p097.png')
    // 1000 页起自然变宽,仍按字典序可排。
    expect(pageFileName(1000)).toBe('p1000.png')
    expect(pageImageRelPath(REL, 7)).toBe(`${pageDirRelPath(REL)}/p007.png`)
    expect(manifestRelPath(REL)).toBe(`${pageDirRelPath(REL)}/.pages.json`)
  })

  it('页号非法直接抛错(0 页、负页、小数页都不存在)', () => {
    expect(() => pageFileName(0)).toThrow()
    expect(() => pageFileName(-1)).toThrow()
    expect(() => pageFileName(1.5)).toThrow()
  })

  it('由文件名反推页号,只认清单之外的 pNNN.png', () => {
    expect(pageNoOf('p001.png')).toBe(1)
    expect(pageNoOf('p097.png')).toBe(97)
    // 清单、临时残留、别的扩展名都不是页图。
    expect(pageNoOf('.pages.json')).toBeNull()
    expect(pageNoOf('p001.png.tmp')).toBeNull()
    expect(pageNoOf('p001.jpg')).toBeNull()
    expect(pageNoOf('001.png')).toBeNull()
    expect(pageNoOf('p0.png')).toBeNull()
  })

  it('像素尺寸 = 页 pt 尺寸按 DPI 折算(整数,四舍五入)', () => {
    // A4 595×842 pt:200 DPI → 1653×2339;300 DPI → 2479×3508;400 DPI → 3306×4678。
    expect(pixelSizeFor(595, 842, 200)).toEqual({ width: 1653, height: 2339 })
    expect(pixelSizeFor(595, 842, 300)).toEqual({ width: 2479, height: 3508 })
    expect(pixelSizeFor(595, 842, 400)).toEqual({ width: 3306, height: 4678 })
    expect(pixelSizeFor(400, 200, 100)).toEqual({ width: 556, height: 278 })
    // 极小页也不会算出 0 像素。
    expect(pixelSizeFor(1, 1, 72)).toEqual({ width: 1, height: 1 })
  })

  it('分辨率:缺省 300,越界或非整数抛错,不静默纠正', () => {
    expect(DEFAULT_DPI).toBe(300)
    expect(normalizeDpi(undefined)).toBe(300)
    expect(normalizeDpi('')).toBe(300)
    expect(normalizeDpi('300')).toBe(300)
    expect(normalizeDpi(300)).toBe(300)
    expect(() => normalizeDpi(MIN_DPI - 1)).toThrow()
    expect(() => normalizeDpi(MAX_DPI + 1)).toThrow()
    expect(() => normalizeDpi(200.5)).toThrow()
    expect(() => normalizeDpi('abc')).toThrow()
  })

  it('只收 PDF(扩展名不分大小写)', () => {
    expect(isPdfPath('a/b.pdf')).toBe(true)
    expect(isPdfPath('a/b.PDF')).toBe(true)
    expect(isPdfPath('a/b.doc')).toBe(false)
    expect(isPdfPath('a/公布.pdf.pages/p001.png')).toBe(false)
  })

  it('锁根:解析后必须仍在根内', () => {
    expect(resolveWithinRoot('/root', 'a/b.pdf')).toBe('/root/a/b.pdf')
    expect(() => resolveWithinRoot('/root', '../etc/passwd')).toThrow('越界')
    expect(() => resolveWithinRoot('/root', 'a/../../x')).toThrow('越界')
    // 前缀相同的兄弟目录不算「在根内」。
    expect(() => resolveWithinRoot('/root', '../root-evil/x.pdf')).toThrow('越界')
  })
})

describe('渲染 4 页夹具(pdfium + sharp 端到端)', () => {
  const dirAbs = join(root, pageDirRelPath(REL))

  it('第一次渲染:页图数 == 页数,命名从 p001 连续', async () => {
    await removePdfPages(root, REL)
    await writeFixture(REL, 4)

    const out = await renderPdfPages(root, REL, { dpi: DPI })
    expect(out.pageCount).toBe(4)
    expect(out.written).toBe(4)
    expect(out.skipped).toBe(0)
    expect(out.removed).toBe(0)
    expect(out.upToDate).toBe(true)

    expect(await names(dirAbs)).toEqual([
      '.pages.json',
      'p001.png',
      'p002.png',
      'p003.png',
      'p004.png',
    ])
    expect(out.pages.map((p) => p.page)).toEqual([1, 2, 3, 4])
    expect(out.pages.map((p) => p.relPath)).toEqual(
      [1, 2, 3, 4].map((n) => pageImageRelPath(REL, n)),
    )
  })

  it('未指定 DPI 时按 300 DPI 输出灰度增强 PNG', async () => {
    await removePdfPages(root, REL)
    await writeFixture(REL, 1)

    const out = await renderPdfPages(root, REL)
    const meta = await sharp(join(root, pageImageRelPath(REL, 1))).metadata()

    expect(out.dpi).toBe(300)
    expect(out.written).toBe(1)
    expect(meta.density).toBe(300)
    expect(meta.channels).toBe(3)
    expect(meta.hasAlpha).toBe(false)
    expect({ width: meta.width, height: meta.height }).toEqual(
      pixelSizeFor(PAGE_PT.width, PAGE_PT.height, 300),
    )
  })

  it('尺寸与 DPI 相符、页图带 DPI 标注,且这张图确实是这一页', async () => {
    await ensure(REL, 4)
    const expectSize = pixelSizeFor(PAGE_PT.width, PAGE_PT.height, DPI)
    const band = markBand(DPI)

    for (const page of [1, 2, 3, 4]) {
      const abs = join(dirAbs, pageFileName(page))
      expect((await stat(abs)).size).toBeGreaterThan(0)

      const image = sharp(await readFile(abs))
      const meta = await image.metadata()
      expect(meta.format).toBe('png')
      expect({ width: meta.width, height: meta.height }).toEqual(expectSize)
      // 页图上写着 DPI,下游(OCR)不必猜。
      expect(meta.density).toBe(DPI)

      // **内容检查**:第 n 页画了 n 个方块 —— 数出来必须是 n,不是「有文件就算过」。
      const { data, info } = await image.raw().toBuffer({ resolveWithObject: true })
      expect(info.channels).toBe(3)
      expect(isGrayscaleRgb(data, info.channels)).toBe(true)
      expect(countDarkRuns(data, info.width, info.channels, band.fromRow, band.toRow)).toBe(page)
    }
  })

  it('清单里记的尺寸/字节与磁盘一致', async () => {
    const out = await ensure(REL, 4)
    for (const page of out.pages) {
      expect((await stat(join(root, page.relPath))).size).toBe(page.bytes)
    }
  })

  it('幂等:同样的源与 DPI 重跑 → 一个字节都不写', async () => {
    await ensure(REL, 4)
    const before = await snapshot(dirAbs)

    const again = await renderPdfPages(root, REL, { dpi: DPI })
    expect(again.written).toBe(0)
    expect(again.skipped).toBe(4)
    expect(again.removed).toBe(0)
    expect(again.upToDate).toBe(true)

    // 连 mtime 都不变 —— 「不重复写」比「不产生新文件」更严。
    expect(await snapshot(dirAbs)).toEqual(before)
  })

  it('再跑第三次仍不动(不是第二次走运)', async () => {
    await ensure(REL, 4)
    const before = await snapshot(dirAbs)
    await renderPdfPages(root, REL, { dpi: DPI })
    expect(await snapshot(dirAbs)).toEqual(before)
  })

  it('换 DPI → 重渲染,原地覆盖同一批路径,目录不膨胀', async () => {
    await ensure(REL, 4)

    const out = await renderPdfPages(root, REL, { dpi: 120 })
    expect(out.written).toBe(4)
    expect(out.skipped).toBe(0)
    expect(out.dpi).toBe(120)
    expect(await names(dirAbs)).toEqual([
      '.pages.json',
      'p001.png',
      'p002.png',
      'p003.png',
      'p004.png',
    ])

    const meta = await sharp(join(dirAbs, 'p001.png')).metadata()
    expect({ width: meta.width, height: meta.height }).toEqual(
      pixelSizeFor(PAGE_PT.width, PAGE_PT.height, 120),
    )
    // 换回 100 DPI:磁盘上现在是 120 的,必须重做。
    expect((await renderPdfPages(root, REL, { dpi: DPI })).written).toBe(4)
  })

  it('源内容换了(页数变少)→ 重渲染并清掉陈旧页图', async () => {
    await ensure(REL, 4)

    await writeFixture(REL, 2)
    const out = await renderPdfPages(root, REL, { dpi: DPI })

    expect(out.pageCount).toBe(2)
    expect(out.written).toBe(2)
    expect(out.skipped).toBe(0)
    expect(out.removed).toBe(2)
    expect(await names(dirAbs)).toEqual(['.pages.json', 'p001.png', 'p002.png'])
    expect(out.pages.map((p) => p.page)).toEqual([1, 2])
  })

  it('force 无视清单,无条件重渲染', async () => {
    await ensure(REL, 4)
    const out = await renderPdfPages(root, REL, { dpi: DPI, force: true })
    expect(out.written).toBe(4)
    expect(out.skipped).toBe(0)
  })

  it('清单记下源哈希与 DPI —— 幂等的权威判据', async () => {
    await ensure(REL, 2)

    const manifest = JSON.parse(await readFile(join(dirAbs, '.pages.json'), 'utf8'))
    expect(manifest.version).toBe(2)
    expect(manifest.file).toBe(REL)
    expect(manifest.dpi).toBe(DPI)
    expect(manifest.colorSpace).toBe('grayscale')
    expect(manifest.enhancement).toBe('white-flatten-grayscale-normalize-sharpen-v1')
    expect(manifest.pageCount).toBe(2)
    expect(manifest.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.sourceBytes).toBe((await stat(join(root, REL))).size)
    expect(manifest.pages).toHaveLength(2)
    expect(Object.keys(manifest.pages[0]).sort()).toEqual([
      'bytes',
      'height',
      'page',
      'relPath',
      'width',
    ])
  })

  it('同一 DPI 的旧版清单会失效,并重渲染为当前增强配置', async () => {
    await ensure(REL, 2)
    const manifestPath = join(dirAbs, '.pages.json')
    const current = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await writeFile(manifestPath, JSON.stringify({ ...current, version: 1 }))

    const stale = await listPdfPages(root, REL, DPI)
    expect(stale.upToDate).toBe(false)
    expect(stale.rendered).toBe(0)

    const rerendered = await renderPdfPages(root, REL, { dpi: DPI })
    expect(rerendered.written).toBe(2)
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).version).toBe(2)
  })

  it('同一进程内并发**完全相同**的请求 → 搭车,只做一次', async () => {
    await removePdfPages(root, REL)
    await writeFixture(REL, 2)

    const [a, b] = await Promise.all([
      renderPdfPages(root, REL, { dpi: DPI }),
      renderPdfPages(root, REL, { dpi: DPI }),
    ])
    // 第二个拿到的是同一个 Promise —— 合计只写一次。
    expect(a.written).toBe(2)
    expect(b.written).toBe(2)
    expect(await names(dirAbs)).toEqual(['.pages.json', 'p001.png', 'p002.png'])
  })

  it('并发**不同参数**的渲染 → 排队(不搭车),后者在磁盘上说了算', async () => {
    await ensure(REL, 4)

    // 参数不同就不能搭车(搭车会拿到另一套参数的结果),但**必须排队**:
    // 两份渲染往同一批 `pNNN.png.tmp` 与同一个 `.pages.json` 写,并行会互相覆盖。
    const [a, b] = await Promise.all([
      renderPdfPages(root, REL, { dpi: DPI, force: true }),
      renderPdfPages(root, REL, { dpi: 120, force: true }),
    ])

    expect(a.dpi).toBe(DPI)
    expect(a.written).toBe(4)
    expect(b.dpi).toBe(120)
    expect(b.written).toBe(4)

    // 没有 `.tmp` 残留 = 没有两份渲染同时写同一批临时文件。
    expect(await names(dirAbs)).toEqual([
      '.pages.json',
      'p001.png',
      'p002.png',
      'p003.png',
      'p004.png',
    ])
    // 后进队列的那份(120 DPI)收尾,清单与像素都必须是它那套 —— 若两者并行,
    // 先跑完的那份可能把清单覆盖回去,这里就会不一致。
    const state = await listPdfPages(root, REL, 120)
    expect(state.upToDate).toBe(true)
    const meta = await sharp(join(dirAbs, 'p001.png')).metadata()
    expect({ width: meta.width, height: meta.height }).toEqual(
      pixelSizeFor(PAGE_PT.width, PAGE_PT.height, 120),
    )
  })
})

describe('页图现状与取页(只读)', () => {
  const REL_LISTED = 'jxj/announcement/2025/2/listed.pdf'
  const dirAbs = join(root, pageDirRelPath(REL_LISTED))
  const size = pixelSizeFor(PAGE_PT.width, PAGE_PT.height, DPI)

  it('未渲染:报出源页数,页图为空,不是错误', async () => {
    await removePdfPages(root, REL_LISTED)
    await writeFixture(REL_LISTED, 3)

    const state = await listPdfPages(root, REL_LISTED, DPI)
    expect(state.pageCount).toBe(3)
    expect(state.rendered).toBe(0)
    expect(state.pages).toEqual([])
    expect(state.upToDate).toBe(false)
    expect(state.manifest).toBeNull()
  })

  it('渲染后可列出:每页有尺寸、字节与预览 URL', async () => {
    const out = await ensure(REL_LISTED, 3)
    const state = await listPdfPages(root, REL_LISTED, DPI)

    expect(state.rendered).toBe(3)
    expect(state.upToDate).toBe(true)
    const first = state.pages[0]
    expect(first).toBeDefined()
    expect(first).toMatchObject({ page: 1, ...size })
    expect(first?.bytes).toBe(out.pages[0]?.bytes)
    // 预览 URL 走既有的文件回吐路由,路径逐段编码。
    expect(first?.url).toContain('/api/files/jxj/announcement/2025/2/')
    expect(first?.url).toContain('.listed.pdf.pages/p001.png')
    expect(state.manifest?.dpi).toBe(DPI)
  })

  it('换一个 DPI 去问 → 已有的页图不算「与请求一致」', async () => {
    await ensure(REL_LISTED, 3)
    const state = await listPdfPages(root, REL_LISTED, 150)
    expect(state.dpi).toBe(DPI) // 磁盘上是 100 DPI 的
    expect(state.upToDate).toBe(false)
  })

  it('按页取:取得到绝对路径;没渲染过的页返回 null', async () => {
    await ensure(REL_LISTED, 3)
    expect(await pageImagePath(root, REL_LISTED, 1)).toBe(join(dirAbs, 'p001.png'))
    expect(await pageImagePath(root, REL_LISTED, 99)).toBeNull()
  })

  it('页图被删掉 → upToDate 立刻变 false,取页也返回 null', async () => {
    await ensure(REL_LISTED, 3)
    await rm(join(dirAbs, 'p002.png'), { force: true })

    expect((await listPdfPages(root, REL_LISTED, DPI)).upToDate).toBe(false)
    expect(await pageImagePath(root, REL_LISTED, 2)).toBeNull()
  })

  it('目录里多出个 p009.png → 也算不一致(不留多余页图)', async () => {
    await ensure(REL_LISTED, 3)
    await writeFile(join(dirAbs, 'p009.png'), 'x')
    expect((await listPdfPages(root, REL_LISTED, DPI)).upToDate).toBe(false)
  })

  it('源 PDF 不在 → 页数读不出,但不抛', async () => {
    const state = await listPdfPages(root, 'jxj/announcement/2025/2/missing.pdf', DPI)
    expect(state.pageCount).toBeNull()
    expect(state.rendered).toBe(0)
  })
})
