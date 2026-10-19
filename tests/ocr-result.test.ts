import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  assembleMarkdown,
  formatPage,
  MAX_PAGE_NO,
  normalizeMarkdownBody,
  pageMarker,
  pageNoOfMarker,
  PAGE_MARKER_RE,
  splitMarkdown,
} from '../lib/ocr-markdown'
import {
  listOcrResults,
  ocrMarkdown,
  ocrPageNumbers,
  pagesFromInput,
  validateOcrPages,
  writeOcrResult,
} from '../server/utils/ocr-result'

/**
 * 票 14 —— OCR 结果入库与 markdown 导出。
 *
 * 这一层测的是**不依赖外网的那半边**:页标记契约、按页落库、幂等、导出/回传闭环。
 * 三个入口(HTTP 路由 / MCP tool / ocr 任务)最终都落在下面这几个函数上,
 * 所以这里把语义钉死,三个入口就都不会各错各的。
 *
 * 通路 a(在线 API)在 `tests/ocr-job.test.ts`,用本地假服务跑完整的提交→轮询→取结果。
 */

// ---------------------------------------------------------------------------
// 1. 页标记契约(纯函数)
// ---------------------------------------------------------------------------

describe('lib/ocr-markdown 页标记', () => {
  it('规范标记是 HTML 注释 —— 渲染时不可见、不占标题层级', () => {
    expect(pageMarker(3)).toBe('<!-- page: 3 -->')
    expect(PAGE_MARKER_RE.test('<!-- page: 3 -->')).toBe(true)
    expect(PAGE_MARKER_RE.test('<!--page:3-->')).toBe(true) // 空格可有可无
    expect(PAGE_MARKER_RE.test('正文里提到 <!-- page: 3 --> 一句')).toBe(false) // 必须整行
  })

  it('两种形态都认:规范注释 + 外部工具常见的 `## 第 3 页` 标题', () => {
    expect(pageNoOfMarker('<!-- page: 1 -->')).toBe(1)
    expect(pageNoOfMarker('## 第 3 页')).toBe(3)
    expect(pageNoOfMarker('### 第12页')).toBe(12)
    // 正文标题里带了别的话就不算标记(否则「第 3 页附表」会被当成分隔符切下去)。
    expect(pageNoOfMarker('## 第 3 页附表')).toBeNull()
    expect(pageNoOfMarker('正文')).toBeNull()
    expect(pageNoOfMarker('<!-- page: 0 -->')).toBeNull() // 页号从 1 起
    expect(pageNoOfMarker(`<!-- page: ${MAX_PAGE_NO + 1} -->`)).toBeNull()
  })

  it('splitMarkdown:按标记切页,页内表格与空行原样保留', () => {
    const md = [
      '<!-- page: 1 -->',
      '',
      '### 附件1',
      '',
      '| 序号 | 企业名称 |',
      '| --- | --- |',
      '| 1 | 宁波甲科技有限公司 |',
      '',
      '<!-- page: 2 -->',
      '',
      '### 附件2',
      '',
      '| 序号 | 企业名称 |',
      '| --- | --- |',
      '| 1 | 宁波乙科技有限公司 |',
    ].join('\n')

    const out = splitMarkdown(md)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.pages.map((p) => p.page)).toEqual([1, 2])
    expect(out.pages[0]!.markdown).toContain('### 附件1')
    expect(out.pages[0]!.markdown).toContain('| 1 | 宁波甲科技有限公司 |')
    expect(out.pages[1]!.markdown).toContain('| 1 | 宁波乙科技有限公司 |')
    // 标记行本身不进正文。
    expect(out.pages[0]!.markdown).not.toContain('<!-- page')
  })

  it('★ 页码乱序**报错**,不自动重排(重排会替调用方猜页序,而页序错了页码就全错)', () => {
    // 这份输入:第 2 页的标记写在第 1 页之前。若「排一下就好」,甲会被标成第 1 页
    // —— 而甲明明是第 2 页。下游按页号升序摊平块,于是页码静默错位。
    const out = splitMarkdown('<!-- page: 2 -->\n\n乙\n\n<!-- page: 1 -->\n\n甲')
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.message).toContain('乱序')
      expect(out.message).toContain('不自动重排')
    }
  })

  it('splitMarkdown:标题式的页码也认,且归一成同一份结果', () => {
    const withHeading = ['## 第 1 页', '', '甲', '', '## 第 2 页', '', '乙'].join('\n')
    const out = splitMarkdown(withHeading)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.pages).toEqual([
      { page: 1, markdown: '甲' },
      { page: 2, markdown: '乙' },
    ])
  })

  it('空页**保留**(空白页也占一个页号 —— 少了它页号就断)', () => {
    const out = splitMarkdown(['<!-- page: 1 -->', '甲', '<!-- page: 2 -->', '', '<!-- page: 3 -->', '丙'].join('\n'))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.pages).toEqual([
      { page: 1, markdown: '甲' },
      { page: 2, markdown: '' },
      { page: 3, markdown: '丙' },
    ])
  })

  it('三种「页号说不清」都**报错**,不猜', () => {
    // 一个标记都没有:整份当成第 1 页存下来是最坏的结果(20 页的文档会变成一个页号)。
    const none = splitMarkdown('### 附件1\n\n| 1 | 甲 |')
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.message).toContain('没有页码标记')

    // 首个标记之前有正文:那段属于哪一页无从判断。
    const preamble = splitMarkdown('这是标题\n\n<!-- page: 1 -->\n甲')
    expect(preamble.ok).toBe(false)
    if (!preamble.ok) expect(preamble.message).toContain('之前')

    // 页号重复:唯一索引会抛底层错误,这里先说人话。
    const dup = splitMarkdown('<!-- page: 1 -->\n甲\n\n<!-- page: 1 -->\n乙')
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.message).toContain('页码重复')
  })

  it('归一:去掉行尾空白与首尾空行,但**不动行内对齐空格**', () => {
    expect(normalizeMarkdownBody('\n\n| a |   b   |   \n\n')).toBe('| a |   b   |')
    expect(normalizeMarkdownBody('a\r\nb')).toBe('a\nb')
  })

  it('★ 导出再传回来,逐字节相同(通路 b 的闭环前提)', () => {
    const pages = [
      { page: 1, markdown: '### 附件1\n\n| 序号 | 企业名称 |\n| --- | --- |\n| 1 | 宁波甲科技有限公司 |' },
      { page: 2, markdown: '' },
      { page: 3, markdown: '### 附件2\n\n正文三' },
    ]
    const exported = assembleMarkdown(pages)
    expect(exported.startsWith('<!-- page: 1 -->')).toBe(true)
    const back = splitMarkdown(exported)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.pages).toEqual(pages)
    // 再拼一次也完全一致(幂等的文本形态)。
    expect(assembleMarkdown(back.pages)).toBe(exported)
    expect(formatPage(pages[0]!)).toBe(`<!-- page: 1 -->\n\n${pages[0]!.markdown}`)
  })
})

// ---------------------------------------------------------------------------
// 2. 入库(库 + 事务)
// ---------------------------------------------------------------------------

let dir: string
let db: ReturnType<(typeof import('../db'))['useDb']>
let schema: typeof import('../db')['schema']

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spztx-ocr-'))
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  const mod = await import('../db')
  db = mod.useDb()
  schema = mod.schema
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  // 每个用例从干净状态起(表在,行不留)。
  db.delete(schema.ocrResult).run()
  db.delete(schema.storedFile).run()
})

/** 登记一个文件 —— 等价于 app 的 `backfillStoredFiles` 写出的那一行。 */
function seedFile(relPath: string): number {
  const base = relPath.split('/').pop()!
  const dot = base.lastIndexOf('.')
  return db
    .insert(schema.storedFile)
    .values({
      relPath,
      filename: base,
      ext: dot > 0 ? base.slice(dot + 1).toLowerCase() : '',
      bytes: 1,
      sha256: '0'.repeat(64),
      source: 'jxj',
      kind: 'announcement',
      categoryState: 'set',
    })
    .returning({ id: schema.storedFile.id })
    .get().id
}

/** 直接读某一页的 `raw`(它不在 `listOcrResults` 的投影里 —— 正文/元数据够用了)。 */
function rawOf(
  db: ReturnType<(typeof import('../db'))['useDb']>,
  fileId: number,
  pageNo: number,
): unknown {
  return (
    db
      .select({ raw: schema.ocrResult.raw })
      .from(schema.ocrResult)
      .where(
        and(eq(schema.ocrResult.fileId, fileId), eq(schema.ocrResult.pageNo, pageNo)),
      )
      .get()?.raw ?? null
  )
}

describe('ocr_result 表(迁移 0005)', () => {
  it('迁移建出 ocr_result,列为票 14 定的那些', () => {
    const cols = db
      .select()
      .from(schema.ocrResult)
      .limit(0)
      .all()
    expect(cols).toEqual([])
    const info = db.$client
      .prepare('PRAGMA table_info(ocr_result)')
      .all() as Array<{ name: string }>
    expect(info.map((c) => c.name).sort()).toEqual(
      [
        'channel',
        'created_at',
        'engine',
        'file_id',
        'id',
        'markdown',
        'model',
        'page_no',
        'page_rel_path',
        'raw',
        'revision',
      ].sort(),
    )
  })

  it('★ 迁移 0005 给 record_evidence 加了 `page` 列(只加列、不改归并)', () => {
    const info = db.$client
      .prepare('PRAGMA table_info(record_evidence)')
      .all() as Array<{ name: string; notnull: number }>
    const page = info.find((c) => c.name === 'page')
    expect(page).toBeDefined()
    // 可空 —— `.docx` 那条通路(票 11)产不出页码,空值优于错误值。
    expect(page!.notnull).toBe(0)
    // 原有的出处列一个都没动。
    expect(info.map((c) => c.name).sort()).toEqual(
      ['attachment', 'id', 'list_no', 'page', 'record_event_id', 'source_file'].sort(),
    )
  })
})

describe('writeOcrResult / listOcrResults', () => {
  it('按页落库,page_no 正确,页图路径按票 13 的规则推出来', () => {
    const fileId = seedFile('jxj/announcement/2024/1/72号.pdf')
    const out = writeOcrResult(db, {
      fileId,
      pages: [
        { page: 1, markdown: '第一页' },
        { page: 2, markdown: '第二页' },
        { page: 3, markdown: '' },
      ],
      channel: 'upload',
      sourceRelPath: 'jxj/announcement/2024/1/72号.pdf',
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.written).toBe(3)
    expect(out.pages).toEqual([1, 2, 3])

    const rows = listOcrResults(db, fileId)
    expect(rows.map((r) => r.page)).toEqual([1, 2, 3])
    expect(rows[2]!.markdown).toBe('')
    expect(rows[0]!.channel).toBe('upload')
    // 页图路径 = 票 13 的 `<目录>/.<文件名>.pages/pNNN.png`。
    expect(rows[0]!.pageRelPath).toBe('jxj/announcement/2024/1/.72号.pdf.pages/p001.png')
    expect(ocrPageNumbers(db, fileId)).toEqual([1, 2, 3])
  })

  it('★ 幂等:同一页写两遍 == 写一遍(同页不重复写,唯一索引兜底)', () => {
    const fileId = seedFile('jxj/announcement/2024/1/幂等.pdf')
    const page = { page: 1, markdown: '第一次' }
    writeOcrResult(db, { fileId, pages: [page], channel: 'upload' })
    writeOcrResult(db, { fileId, pages: [page], channel: 'upload' })
    expect(listOcrResults(db, fileId)).toHaveLength(1)

    // 重写是**覆盖**(换通路、换内容后那一行必须反映最后一次,不是两条并存)。
    writeOcrResult(db, { fileId, pages: [{ page: 1, markdown: '第二次' }], channel: 'mcp' })
    const rows = listOcrResults(db, fileId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.markdown).toBe('第二次')
    expect(rows[0]!.channel).toBe('mcp')
  })

  it('没列出的页**不动** —— 单页重跑不会清掉别的页', () => {
    const fileId = seedFile('jxj/announcement/2024/1/逐页.pdf')
    writeOcrResult(db, {
      fileId,
      pages: [
        { page: 1, markdown: '甲' },
        { page: 2, markdown: '乙' },
      ],
      channel: 'api',
    })
    writeOcrResult(db, { fileId, pages: [{ page: 2, markdown: '乙(重跑)' }], channel: 'api' })
    const rows = listOcrResults(db, fileId)
    expect(rows.map((r) => [r.page, r.markdown])).toEqual([
      [1, '甲'],
      [2, '乙(重跑)'],
    ])
  })

  it('★ `raw` 的保留语义:这次没给原始响应就**留着上一次那份**(通路 a 花过钱的那份)', () => {
    const fileId = seedFile('jxj/announcement/2024/1/raw.pdf')
    // 通路 a:带原始响应。
    writeOcrResult(db, {
      fileId,
      pages: [{ page: 1, markdown: '甲', raw: { rec_texts: ['甲'] } }],
      channel: 'api',
    })
    expect(rawOf(db, fileId, 1)).toEqual({ rec_texts: ['甲'] })

    // 通路 b 重传同一页(没有 raw)—— markdown 与 channel 覆盖,raw **保留**。
    writeOcrResult(db, { fileId, pages: [{ page: 1, markdown: '甲(修)' }], channel: 'upload' })
    expect(listOcrResults(db, fileId)[0]!.markdown).toBe('甲(修)')
    expect(listOcrResults(db, fileId)[0]!.channel).toBe('upload')
    expect(rawOf(db, fileId, 1)).toEqual({ rec_texts: ['甲'] })

    // 显式给了 raw 时才覆盖(那才是「最后写者胜」的本意)。
    writeOcrResult(db, {
      fileId,
      pages: [{ page: 1, markdown: '甲(再修)', raw: { rec_texts: ['甲(再修)'] } }],
      channel: 'api',
    })
    expect(rawOf(db, fileId, 1)).toEqual({ rec_texts: ['甲(再修)'] })
  })

  it('页号非法/重复、空数组 → 报错(不写半截)', () => {
    const fileId = seedFile('jxj/announcement/2024/1/参数.pdf')
    expect(writeOcrResult(db, { fileId, pages: [], channel: 'upload' }).ok).toBe(false)
    const zero = writeOcrResult(db, { fileId, pages: [{ page: 0, markdown: 'x' }], channel: 'upload' })
    expect(zero.ok).toBe(false)
    if (!zero.ok) expect(zero.message).toContain('1–')
    const dup = writeOcrResult(db, {
      fileId,
      pages: [
        { page: 1, markdown: 'a' },
        { page: 1, markdown: 'b' },
      ],
      channel: 'upload',
    })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.message).toContain('页号重复')
    expect(listOcrResults(db, fileId)).toHaveLength(0)
    expect(validateOcrPages([]).ok).toBe(false)
  })

  it('非 PDF 的来源推不出页图路径,`page_rel_path` 留空(不硬凑)', () => {
    const fileId = seedFile('jxj/announcement/2024/1/结果.md')
    writeOcrResult(db, {
      fileId,
      pages: [{ page: 1, markdown: 'x' }],
      channel: 'upload',
      sourceRelPath: 'jxj/announcement/2024/1/结果.md',
    })
    expect(listOcrResults(db, fileId)[0]!.pageRelPath).toBeNull()
  })
})

describe('ocrMarkdown 导出(整份 / 单页)', () => {
  it('整份按页升序带页标记;单页只给那一页(也带自己的页码)', () => {
    const fileId = seedFile('jxj/announcement/2024/1/导出.pdf')
    writeOcrResult(db, {
      fileId,
      pages: [
        { page: 2, markdown: '第二页正文' },
        { page: 1, markdown: '第一页正文' },
      ],
      channel: 'upload',
    })

    const whole = ocrMarkdown(db, fileId)
    expect(whole.ok).toBe(true)
    if (!whole.ok) return
    expect(whole.pages).toEqual([1, 2])
    expect(whole.markdown).toBe(
      ['<!-- page: 1 -->', '', '第一页正文', '', '<!-- page: 2 -->', '', '第二页正文'].join('\n'),
    )

    const one = ocrMarkdown(db, fileId, 2)
    expect(one.ok).toBe(true)
    if (!one.ok) return
    expect(one.markdown).toBe('<!-- page: 2 -->\n\n第二页正文')

    // 没有结果的页给 404 的文案,而不是空串。
    const missing = ocrMarkdown(db, fileId, 9)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.message).toContain('第 9 页还没有 OCR 结果')
  })

  it('一个文件都没有结果时,消息里说清该走哪条通路', () => {
    const fileId = seedFile('jxj/announcement/2024/1/空.pdf')
    const out = ocrMarkdown(db, fileId)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.message).toContain('还没有 OCR 结果')
      expect(out.message).toContain('ocr')
    }
  })
})

// ---------------------------------------------------------------------------
// 3. ★ 通路 b 端到端:上传带页码的 markdown → 入库 → 导出一致(不依赖外网)
// ---------------------------------------------------------------------------

describe('通路 b:上传识别结果(端到端,零外网)', () => {
  const relPath = 'jxj/announcement/2024/1/甬经信中小〔2024〕72号…通知.pdf'
  const uploaded = [
    '<!-- page: 1 -->',
    '',
    '# 宁波市经济和信息化局文件',
    '',
    '甬经信中小〔2024〕72号',
    '',
    '<!-- page: 2 -->',
    '',
    '### 附件1',
    '',
    '2024年度第一批宁波市“专精特新”中小企业名单',
    '',
    '| 序号 | 属地 | 企业名称 |',
    '| --- | --- | --- |',
    '| 1 | 海曙区 | 宁波甲科技有限公司 |',
    '| 2 | 鄞州区 | 宁波乙机械有限公司 |',
    '',
    '<!-- page: 3 -->',
    '',
    '### 附件2',
    '',
    '| 序号 | 属地 | 企业名称 |',
    '| --- | --- | --- |',
    '| 1 | 北仑区 | 宁波丙新材料有限公司 |',
  ].join('\n')

  it('切页 → 落库(page_no 正确)→ 导出与上传一致 → 再传回来仍一致', () => {
    const fileId = seedFile(relPath)

    // 1) 切页(路由与 MCP 都走这一个函数)。
    const parsed = pagesFromInput(uploaded, null)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.pages.map((p) => p.page)).toEqual([1, 2, 3])

    // 2) 落库。
    const written = writeOcrResult(db, {
      fileId,
      pages: parsed.pages.map((p) => ({ page: p.page, markdown: p.markdown })),
      channel: 'upload',
      model: 'PaddleOCR-VL-1.6',
      sourceRelPath: relPath,
    })
    expect(written.ok).toBe(true)
    expect(ocrPageNumbers(db, fileId)).toEqual([1, 2, 3])

    // 3) 导出与上传**逐字节一致**。
    const exported = ocrMarkdown(db, fileId)
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    expect(exported.markdown).toBe(uploaded)

    // 4) 导出的文件再传回来:切出的页与库里的一模一样(闭环)。
    const again = splitMarkdown(exported.markdown)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.pages).toEqual(listOcrResults(db, fileId).map((r) => ({ page: r.page, markdown: r.markdown })))

    // 5) 重传同一份 → 还是 3 行(幂等),内容不变。
    writeOcrResult(db, {
      fileId,
      pages: again.pages.map((p) => ({ page: p.page, markdown: p.markdown })),
      channel: 'upload',
    })
    expect(listOcrResults(db, fileId)).toHaveLength(3)
    expect(ocrMarkdown(db, fileId)).toEqual(exported)
  })

  it('单页输入(没有页标记)必须显式给 page —— 给了就写那一页', () => {
    const fileId = seedFile(relPath)
    const noPage = pagesFromInput('只有正文,没有页标记', null)
    expect(noPage.ok).toBe(false)
    if (!noPage.ok) expect(noPage.message).toContain('page')
    const withPage = pagesFromInput('只有正文,没有页标记', 3)
    expect(withPage.ok).toBe(true)
    if (!withPage.ok) return
    expect(withPage.pages).toEqual([{ page: 3, markdown: '只有正文,没有页标记' }])
    expect(pagesFromInput('x', 0).ok).toBe(false)
  })

  it('★ 给了 page 就**不许**正文再带页标记(否则导出文件传不回自己的上传口)', () => {
    // 照单全收的后果:标记被当正文存进那一页 → 导出后嵌着别的页的标记 →
    // 再 POST /api/ocr-results 会得到「页码重复」。
    const both = pagesFromInput('<!-- page: 1 -->\n\n甲\n\n<!-- page: 2 -->\n\n乙', 3)
    expect(both.ok).toBe(false)
    if (!both.ok) expect(both.message).toContain('不该再带页标记')
    // `## 第 N 页` 这种形态同样不许。
    expect(pagesFromInput('## 第 1 页\n\n甲', 3).ok).toBe(false)
    // 正文里**行内**提到「第 3 页」不算标记(必须是整行的标题)。
    expect(pagesFromInput('详见第 3 页的说明', 3).ok).toBe(true)
  })
})
