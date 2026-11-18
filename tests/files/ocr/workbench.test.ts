import { createClassifiedFile } from '../../../layers/sme-roster/server/utils/roster-file-classification'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assembleMarkdown, splitMarkdown } from '../../../layers/core/lib/ocr-markdown'
import {
  buildWorkbenchRows,
  confirmWrittenPage,
  guardImportedPageCount,
  guardTargetPage,
  pageReviewState,
  pendingLabel,
  reviewBreakdown,
  workbenchCounts,
} from '../../../layers/core/lib/ocr-workbench'
import { decodeOcrImport } from '../../../layers/core/server/utils/ocr-import'
import type { OcrProvenance } from '../../../layers/core/server/utils/ocr-provenance'
import { listOcrResults, ocrPageNumbers, removeOcrPage, writeOcrResult } from '../../../layers/core/server/utils/ocr-result'

/**
 * OCR 清理工作台的规则层(2026-10-15)。
 *
 * 覆盖三件事,对应这条能力的三个风险点:
 *
 *  1. **页码映射** —— 行由「文件页码 / 页图清单」定,OCR 结果只是挂上去的
 *     (`buildWorkbenchRows`);整份 JSONL 的页号来自行序,所以必须与源页数核对
 *     (`guardImportedPageCount`、`guardTargetPage`)。
 *  2. **逐页 CRUD** —— 写/覆盖走 `writeOcrResult`(票 14 已测),这里补**按页读回**
 *     与**按页删除**;以及「保存空结果」这条允许的情形。
 *  3. **删除保护** —— 删一页**只**删那一页(`removeOcrPage`),不是 `removeOcrResults`
 *     那种整份清空;文件与页图一概不动。
 *
 * 路由级的分支(400 / 404 / 415)靠 `decodeOcrImport` + `guard*` 这两个纯函数测住 ——
 * 路由本身只是把它们串起来,与票 14 的分法一致(见票 14「三个 OCR 路由没有路由级单测」)。
 */

// ---------------------------------------------------------------------------
// 1. 页码映射:行由文件页码定,结果挂上去
// ---------------------------------------------------------------------------

describe('buildWorkbenchRows —— 行以**页码**为准', () => {
  const image = (page: number) => ({
    page,
    relPath: `x/.a.pdf.pages/p00${page}.png`,
    url: `/api/files/x/.a.pdf.pages/p00${page}.png`,
    width: 100,
    height: 200,
    bytes: 1,
  })
  const result = (page: number, markdown: string) => ({
    page,
    markdown,
    pageRelPath: null,
    engine: 'paddleocr',
    model: null,
    channel: 'upload',
    createdAt: '2026-10-15T00:00:00.000Z',
  })

  it('页数读得出来时,每一页都有一行 —— 没页图、没结果也是行', () => {
    const rows = buildWorkbenchRows({
      pageCount: 3,
      images: [image(1), image(2)],
      results: [result(2, '乙')],
    })
    expect(rows.map((r) => r.page)).toEqual([1, 2, 3])
    expect(rows[0]!.image?.page).toBe(1)
    expect(rows[0]!.result).toBeNull()
    expect(rows[1]!.result?.markdown).toBe('乙')
    // 第 3 页:既没渲染也没识别,但**必须在** —— 否则用户没法给它贴文本。
    expect(rows[2]!.image).toBeNull()
    expect(rows[2]!.result).toBeNull()
  })

  it('★ 库里有结果但页图还没渲染时,那一页照常出现(不把已有数据藏起来)', () => {
    const rows = buildWorkbenchRows({
      pageCount: null, // 源页数读不出来(文件坏了/被移走)
      images: [image(1)],
      results: [result(1, '甲'), result(5, '第五页的旧结果')],
    })
    expect(rows.map((r) => r.page)).toEqual([1, 5])
    expect(rows[1]!.image).toBeNull()
    expect(rows[1]!.result?.markdown).toBe('第五页的旧结果')
  })

  it('页数读不出来时不编页数 —— 只按已存在的页图/结果铺行', () => {
    const rows = buildWorkbenchRows({ pageCount: null, images: [image(2)], results: [] })
    expect(rows.map((r) => r.page)).toEqual([2])
  })

  it('页号乱序传入也按升序输出(行的顺序 = 页序)', () => {
    const rows = buildWorkbenchRows({
      pageCount: 4,
      images: [image(4), image(2)],
      results: [result(3, '丙'), result(1, '甲')],
    })
    expect(rows.map((r) => r.page)).toEqual([1, 2, 3, 4])
    expect(rows.map((r) => r.result?.markdown ?? null)).toEqual(['甲', null, '丙', null])
  })

  it('★ 状态是**三档**不是两档:空结果不能和「有文本」共用一个词', () => {
    // 独立评审:「空结果」原先也标「已识别」,徽章与紧挨着的正文互相拆台,
    // 文件条的计数还把空结果算进「已识别」——那个数字就不再等于「有文本的页数」。
    expect(pageReviewState(null)).toBe('none')
    expect(pageReviewState({ markdown: '' })).toBe('empty')
    expect(pageReviewState({ markdown: '   \n ' })).toBe('empty')
    expect(pageReviewState({ markdown: '甲' })).toBe('text')
  })

  it('计数按页数一遍,三项之和 == 行数;待校对只数没结果的那些', () => {
    const rows = buildWorkbenchRows({
      pageCount: 4,
      images: [image(1), image(2), image(3), image(4)],
      results: [result(1, '甲'), result(2, ''), result(4, '丁')],
    })
    const counts = workbenchCounts(rows)
    expect(counts).toEqual({ text: 2, empty: 1, none: 1 })
    expect(counts.text + counts.empty + counts.none).toBe(rows.length)
    expect(pendingLabel(counts)).toBe('待校对 1 页')
    // 空结果为 0 时不出现「空结果 0」这种恒为零的词。
    expect(reviewBreakdown(counts)).toBe('有文本 2 · 空结果 1')
    expect(reviewBreakdown({ text: 3, empty: 0, none: 0 })).toBe('有文本 3')
  })

  it('源页数读不出来时,计数只数列出来的行(不编一个总数出来)', () => {
    const rows = buildWorkbenchRows({ pageCount: null, images: [image(1)], results: [] })
    expect(workbenchCounts(rows)).toEqual({ text: 0, empty: 0, none: 1 })
    expect(pendingLabel(workbenchCounts(rows))).toBe('待校对 1 页')
  })
})

// ---------------------------------------------------------------------------
// 2. 导入的页码护栏
// ---------------------------------------------------------------------------

describe('guardImportedPageCount —— 整份结果的页号来自行序,必须与文件核对', () => {
  it('页数与源 PDF 一致 ⇒ 放行', () => {
    expect(guardImportedPageCount({ imported: 12, pageCount: 12, rendered: 12 })).toEqual({
      ok: true,
      warning: null,
    })
  })

  it('★ 与源 PDF 页数不符 ⇒ **拒绝**(那时按 1..N 落库得到的是一批看起来确定却错的页码)', () => {
    const out = guardImportedPageCount({ imported: 11, pageCount: 12, rendered: 12 })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.message).toContain('11')
    expect(out.message).toContain('12')
    expect(out.message).toContain('行序')
    // 必须给出「怎么办」,否则用户只能反复试。
    expect(out.message).toContain('按页单独导入')
  })

  it('源页数读不出来 ⇒ 拒绝,而不是按 1..N 猜(空值优于错误值)', () => {
    const out = guardImportedPageCount({ imported: 3, pageCount: null, rendered: 0 })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).toContain('无法核对页码')
  })

  it('一页都没有 ⇒ 拒绝(空 JSONL 不该被当成「成功写入 0 页」)', () => {
    const out = guardImportedPageCount({ imported: 0, pageCount: 12, rendered: 0 })
    expect(out.ok).toBe(false)
  })

  it('页图数对不上只是**提示**,不影响写入(页图是可有可无的派生缓存)', () => {
    const out = guardImportedPageCount({ imported: 12, pageCount: 12, rendered: 3 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.warning).toContain('页图数')
    // 没渲染过(0)或探测不出(null)都不是问题。
    expect(guardImportedPageCount({ imported: 12, pageCount: 12, rendered: 0 }).ok).toBe(true)
    expect(guardImportedPageCount({ imported: 12, pageCount: 12, rendered: null })).toEqual({
      ok: true,
      warning: null,
    })
  })
})

describe('guardTargetPage —— 单页写入的页号核对', () => {
  it('越出这份 PDF 的页数 ⇒ 拒绝(页号来自页图清单,不该越界)', () => {
    const out = guardTargetPage(13, 12)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).toContain('12')
  })

  it('页数读不出来时不拦(页号是调用方显式给的,没有可核对的依据)', () => {
    expect(guardTargetPage(13, null)).toEqual({ ok: true })
    expect(guardTargetPage(1, 12)).toEqual({ ok: true })
  })

  it('非正整数一律拒绝', () => {
    expect(guardTargetPage(0, 12).ok).toBe(false)
    expect(guardTargetPage(1.5, 12).ok).toBe(false)
  })
})

describe('confirmWrittenPage —— 写入后读回核对', () => {
  it('归一后一致即算写入成功(落库会去掉行尾空白与首尾空行)', () => {
    const out = confirmWrittenPage('| a |   b   |   \n\n', '| a |   b   |')
    expect(out.ok).toBe(true)
    expect(out.message).toContain('读回一致')
  })

  it('读回不一致 / 读不到 ⇒ 明确报出来,不假装成功', () => {
    expect(confirmWrittenPage('甲', '乙').ok).toBe(false)
    expect(confirmWrittenPage('甲', null).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. 导入解码:三种装法各自的页号语义
// ---------------------------------------------------------------------------

describe('decodeOcrImport —— 页号一律不从正文里猜', () => {
  const jsonl = (texts: string[]) =>
    texts
      .map((t) => JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: t } }] } }))
      .join('\n')

  it('★ JSONL 按**行序**定页号(第 i 段就是第 i 页)', () => {
    const out = decodeOcrImport({ jsonl: jsonl(['第一页', '', '第三页']) })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.source).toBe('jsonl')
    expect(out.pages.map((p) => [p.page, p.markdown])).toEqual([
      [1, '第一页'],
      [2, ''], // 空白页照样占一个页号(少了它就断号)
      [3, '第三页'],
    ])
  })

  it('JSONL 里一行的多个 layoutParsingResults 会被摊平(与 ocr-api 同一形状)', () => {
    const line = JSON.stringify({
      result: { layoutParsingResults: [{ markdown: { text: '甲' } }, { markdown: { text: '乙' } }] },
    })
    const out = decodeOcrImport({ jsonl: line })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.pages.map((p) => [p.page, p.markdown])).toEqual([
      [1, '甲'],
      [2, '乙'],
    ])
  })

  it('形状不对的 JSONL ⇒ 报错并保留具体原因(第几行、缺什么)', () => {
    const bad = decodeOcrImport({ jsonl: '{"foo":1}' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.message).toContain('第 1 行')

    const notJson = decodeOcrImport({ jsonl: '这不是 JSON' })
    expect(notJson.ok).toBe(false)
    if (!notJson.ok) expect(notJson.message).toContain('合法 JSONL')
  })

  it('markdown + page ⇒ 单页写入;不给 page ⇒ 必须自带页标记', () => {
    const single = decodeOcrImport({ markdown: '只有正文', page: 3 })
    expect(single.ok).toBe(true)
    if (!single.ok) return
    expect(single.source).toBe('markdown')
    expect(single.pages).toEqual([{ page: 3, markdown: '只有正文' }])

    const noMarker = decodeOcrImport({ markdown: '只有正文' })
    expect(noMarker.ok).toBe(false)
    if (!noMarker.ok) expect(noMarker.message).toContain('没有页码标记')

    const marked = decodeOcrImport({ markdown: '<!-- page: 1 -->\n\n甲\n\n<!-- page: 2 -->\n\n乙' })
    expect(marked.ok).toBe(true)
    if (!marked.ok) return
    expect(marked.pages.map((p) => p.page)).toEqual([1, 2])
  })

  it('给了 page 就不许正文再带页标记(否则导出文件传不回自己的上传口)', () => {
    const both = decodeOcrImport({ markdown: '<!-- page: 1 -->\n\n甲', page: 3 })
    expect(both.ok).toBe(false)
    if (!both.ok) expect(both.message).toContain('不该再带页标记')
  })

  it('★ JSONL 的**原始响应**一并带上 —— raw 不在这条入口上丢', () => {
    // JSONL 里那一段 `layoutParsingResults` 项就是原始响应,与通路 a 落的 `raw` 是同一个东西;
    // 用户要的「API 原始响应保留」在导入这条入口上同样成立。
    const item = { markdown: { text: '甲' }, layoutBox: { x: 1, y: 2 } }
    const out = decodeOcrImport({ jsonl: JSON.stringify({ result: { layoutParsingResults: [item] } }) })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.pages[0]!.raw).toEqual(item)
  })

  it('markdown 那两条**不带** raw(本次没给 ⇒ `writeOcrResult` 会保留库里上一次的)', () => {
    const single = decodeOcrImport({ markdown: '只有正文', page: 3 })
    expect(single.ok).toBe(true)
    if (!single.ok) return
    expect(single.pages[0]!.raw).toBeUndefined()

    const whole = decodeOcrImport({ markdown: '<!-- page: 1 -->\n\n甲' })
    expect(whole.ok).toBe(true)
    if (!whole.ok) return
    expect(whole.pages[0]!.raw).toBeUndefined()
  })

  it('`jsonl` 给了非字符串要说「必须是字符串」,不是「不能是空字符串」', () => {
    const out = decodeOcrImport({ jsonl: 123 })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).toContain('必须是字符串')
  })

  it('两种输入一起给 ⇒ 拒绝(页号语义打架)', () => {
    const out = decodeOcrImport({ jsonl: jsonl(['甲']), markdown: '<!-- page: 1 -->\n\n甲' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).toContain('只能给一个')
  })

  it('什么都没给 / 空内容 ⇒ 拒绝', () => {
    expect(decodeOcrImport({}).ok).toBe(false)
    expect(decodeOcrImport({ markdown: '' }).ok).toBe(false)
    const empty = decodeOcrImport({ jsonl: '   ' })
    expect(empty.ok).toBe(false)
  })
})

/**
 * **为什么页面的正文不能走「整份导出 → 按页标记反切」**(独立代码审核 B2 的证据)。
 *
 * 页面原先就是这么读正文的:拿 `GET /api/ocr-results/markdown` 的整份文本,再用
 * `splitMarkdown` 切回按页。这三条钉住那条路的失败形状 —— 它们既是 B2 的确定性证据,
 * 也防着有人把「一次请求拿全份文本再切」重新接回读路径。
 *
 * 关键在于**页体自带整行页标记是真会发生的**:通路 a(`jobs/ocr.ts`)直写模型返回的
 * markdown,不检查里面有没有 `## 第 N 页` 这样的行,而模型完全可能把页码当标题输出。
 * 所以这不是「脏数据才有的边角」。
 */
describe('assembleMarkdown → splitMarkdown 不是可靠的「按页读回」(B2 的证据)', () => {
  it('★ 页体自带整行 `## 第 1 页` ⇒ **整份**反切失败(于是每一页都会读成空)', () => {
    const pages = [
      { page: 1, markdown: '甲' },
      { page: 2, markdown: '乙' },
      { page: 3, markdown: '## 第 1 页\n\n丙' },
    ]
    const back = splitMarkdown(assembleMarkdown(pages))
    expect(back.ok).toBe(false)
    if (!back.ok) expect(back.message).toContain('页码重复')
  })

  it('★ 页体自带整行 `<!-- page: 4 -->` ⇒ 反切**成功但串页**(第 3 页读成空,正文挂到不存在的第 4 页)', () => {
    const pages = [
      { page: 1, markdown: '甲' },
      { page: 2, markdown: '乙' },
      { page: 3, markdown: '<!-- page: 4 -->\n\n丙' },
    ]
    const back = splitMarkdown(assembleMarkdown(pages))
    expect(back.ok).toBe(true)
    if (!back.ok) return
    // 丙 本来属于第 3 页 —— 这里它跑到第 4 页去了,而第 3 页成了空结果。
    expect(back.pages).toEqual([
      { page: 1, markdown: '甲' },
      { page: 2, markdown: '乙' },
      { page: 3, markdown: '' },
      { page: 4, markdown: '丙' },
    ])
  })

  it('**行内**提到页码不受影响:判据是整行,不是子串', () => {
    const pages = [
      { page: 1, markdown: '甲' },
      { page: 3, markdown: '详见第 3 页的说明' },
    ]
    const back = splitMarkdown(assembleMarkdown(pages))
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.pages).toEqual(pages)
  })
})

// ---------------------------------------------------------------------------
// 4. 逐页 CRUD + 删除保护(库层)
// ---------------------------------------------------------------------------

let dir: string
let db: ReturnType<(typeof import('../../../db'))['useDb']>
let schema: typeof import('../../../db')['schema']

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spztx-ocrwb-'))
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  const mod = await import('../../../db')
  db = mod.initializeDb({ create: true })
  schema = mod.schema
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  db.delete(schema.ocrResult).run()
  db.delete(schema.storedFile).run()
})

/** 直接读某一页的 `raw`(它不在 `listOcrResults` 的投影里)。 */
function rawOf(
  db: ReturnType<(typeof import('../../../db'))['useDb']>,
  fileId: number,
  pageNo: number,
): unknown {
  return (
    db
      .select({ raw: schema.ocrResult.raw })
      .from(schema.ocrResult)
      .where(and(eq(schema.ocrResult.fileId, fileId), eq(schema.ocrResult.pageNo, pageNo)))
      .get()?.raw ?? null
  )
}

/** 登记一个文件(等价于 app 回填写出的那一行)。 */
function seedFile(relPath: string): number {
  const base = relPath.split('/').pop()!
  const dot = base.lastIndexOf('.')
  return createClassifiedFile(db, { relPath, filename: base, ext: dot > 0 ? base.slice(dot + 1).toLowerCase() : '', bytes: 1, sha256: '0'.repeat(64) }, { source: 'jxj', kind: 'announcement', categoryState: 'set' }).id
}

describe('逐页增删改查', () => {
  const relPath = 'jxj/announcement/2024/1/工作台.pdf'

  it('新增(含空结果)→ 读回 → 修改 → 再读回:只有那一页被改', () => {
    const fileId = seedFile(relPath)

    // 新增:允许**空结果**(空白页也要占一行,页号不能断)。
    expect(
      writeOcrResult(db, {
        fileId,
        pages: [{ page: 2, markdown: '' }],
        channel: 'upload',
        sourceRelPath: relPath,
      }).ok,
    ).toBe(true)
    expect(listOcrResults(db, fileId).map((r) => [r.page, r.markdown])).toEqual([[2, '']])

    // 另两页也写上,验证「修改某一页不动别的页」。
    writeOcrResult(db, {
      fileId,
      pages: [
        { page: 1, markdown: '第一页' },
        { page: 3, markdown: '第三页' },
      ],
      channel: 'upload',
      sourceRelPath: relPath,
    })

    // 修改第 2 页。
    writeOcrResult(db, {
      fileId,
      pages: [{ page: 2, markdown: '第二页(人工改过)' }],
      channel: 'upload',
      sourceRelPath: relPath,
    })
    expect(listOcrResults(db, fileId).map((r) => [r.page, r.markdown])).toEqual([
      [1, '第一页'],
      [2, '第二页(人工改过)'],
      [3, '第三页'],
    ])
    // 页图路径按票 13 的规则跟着页号走(供页面把图与文本并排)。
    expect(listOcrResults(db, fileId)[1]!.pageRelPath).toBe(
      'jxj/announcement/2024/1/.工作台.pdf.pages/p002.png',
    )
  })

  it('★ 删除保护:删一页**只**删那一页,其余与文件本身都不动', () => {
    const fileId = seedFile(relPath)
    writeOcrResult(db, {
      fileId,
      pages: [
        { page: 1, markdown: '甲' },
        { page: 2, markdown: '乙' },
        { page: 3, markdown: '丙' },
      ],
      channel: 'api',
      sourceRelPath: relPath,
    })

    expect(removeOcrPage(db, fileId, 2)).toBe(1)
    expect(ocrPageNumbers(db, fileId)).toEqual([1, 3])

    // 幂等:再删一次删 0 行,不报错。
    expect(removeOcrPage(db, fileId, 2)).toBe(0)
    expect(ocrPageNumbers(db, fileId)).toEqual([1, 3])

    // 文件行还在(删除不碰 stored_file / 页图 —— 页图是派生缓存,重渲染就有了)。
    const files = db.select().from(schema.storedFile).all()
    expect(files).toHaveLength(1)
    expect(files[0]!.relPath).toBe(relPath)
    expect(files[0]!.removedAt).toBeNull()
  })

  it('★ JSONL 导入把原始响应落进 raw;之后再走 markdown 通路不会把它抹掉', () => {
    const fileId = seedFile(relPath)
    const expectedOriginalRaw = { markdown: { text: '第 1 页' }, layoutBox: { page: 1 } }
    const decoded = decodeOcrImport({
      jsonl: JSON.stringify({ result: { layoutParsingResults: [expectedOriginalRaw] } }),
    })
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.source).toBe('jsonl')
    expect(decoded.pages).toHaveLength(1)
    expect(decoded.pages[0]).toStrictEqual({
      page: 1,
      markdown: '第 1 页',
      raw: expectedOriginalRaw,
    })

    expect(
      writeOcrResult(db, {
        fileId,
        pages: decoded.pages,
        channel: 'upload',
        sourceRelPath: relPath,
      }),
    ).toStrictEqual({ ok: true, written: 1, pages: [1] })
    const initialRows = listOcrResults(db, fileId)
    expect(initialRows).toHaveLength(1)
    const initialRow = initialRows[0]!
    expect(initialRow).toMatchObject({
      page: 1,
      markdown: '第 1 页',
      channel: 'upload',
      engine: 'paddleocr',
      model: null,
    })
    expect(new Date(initialRow.createdAt).toISOString()).toBe(initialRow.createdAt)

    const expectedInitialCapture = {
      raw: expectedOriginalRaw,
      markdown: '第 1 页',
      source: {
        channel: 'upload',
        engine: 'paddleocr',
        model: null,
        createdAt: initialRow.createdAt,
      },
    }
    const expectedInitialRevision = {
      markdown: '第 1 页',
      channel: 'upload',
      engine: 'paddleocr',
      model: null,
      createdAt: initialRow.createdAt,
      capture: 0,
    }
    const initialRaw = rawOf(db, fileId, 1) as OcrProvenance
    expect(initialRaw).toStrictEqual({
      format: 'ocr-provenance-v1',
      captures: [expectedInitialCapture],
      revisions: [expectedInitialRevision],
    })
    const retainedCaptures = structuredClone(initialRaw.captures)
    const retainedRevisions = structuredClone(initialRaw.revisions)

    // 通路 b(markdown,没有原始响应)重传同一页:文本换掉,`raw` **保留** ——
    // 这正是 `writeOcrResult` 那条「本次没给就留着上一次」的语义,补上 raw 之后依然成立。
    expect(
      writeOcrResult(db, {
        fileId,
        pages: [{ page: 1, markdown: '第 1 页(人工改过)' }],
        channel: 'upload',
        sourceRelPath: relPath,
      }),
    ).toStrictEqual({ ok: true, written: 1, pages: [1] })
    const revisedRows = listOcrResults(db, fileId)
    expect(revisedRows).toHaveLength(1)
    const revisedRow = revisedRows[0]!
    expect(revisedRow).toMatchObject({
      page: 1,
      markdown: '第 1 页(人工改过)',
      channel: 'upload',
      engine: 'paddleocr',
      model: null,
    })
    expect(new Date(revisedRow.createdAt).toISOString()).toBe(revisedRow.createdAt)

    const expectedTextRevision = {
      markdown: '第 1 页(人工改过)',
      channel: 'upload',
      engine: 'paddleocr',
      model: null,
      createdAt: revisedRow.createdAt,
      capture: 0,
    }
    const revisedRaw = rawOf(db, fileId, 1) as OcrProvenance
    expect(revisedRaw.captures[0]!.raw).toStrictEqual(expectedOriginalRaw)
    expect(revisedRaw.captures).toStrictEqual(retainedCaptures)
    expect(revisedRaw.revisions[0]).toStrictEqual(retainedRevisions[0])
    expect(revisedRaw).toStrictEqual({
      format: 'ocr-provenance-v1',
      captures: [expectedInitialCapture],
      revisions: [expectedInitialRevision, expectedTextRevision],
    })
  })

  it('删一页不会误伤同文件之外的其它页(边界:只按 (file_id, page_no) 删)', () => {
    const a = seedFile('jxj/announcement/2024/1/甲.pdf')
    const b = seedFile('jxj/announcement/2024/1/乙.pdf')
    writeOcrResult(db, { fileId: a, pages: [{ page: 1, markdown: '甲的1' }], channel: 'upload' })
    writeOcrResult(db, { fileId: b, pages: [{ page: 1, markdown: '乙的1' }], channel: 'upload' })

    expect(removeOcrPage(db, a, 1)).toBe(1)
    expect(ocrPageNumbers(db, a)).toEqual([])
    expect(ocrPageNumbers(db, b)).toEqual([1])
  })
})
