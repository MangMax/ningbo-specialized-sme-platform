/**
 * RL-09 的 HTTP 面(契约 §7.4):`GET /api/roster/reviews` 与其导出。
 *
 * 这一层测**接口契约本身**:参数怎么解析(必填 / 多值 / 非法值给 400)、响应信封、
 * 分页与计数口径,以及**「导出与页面筛选结果一致」**这条验收。
 * 业务口径(三年锚点、证据不全分层)已在 `tests/roster-reviews.test.ts` 里对着读模型测过,
 * 这里不重复测那些,只保证 HTTP 面没把参数弄丢或把口径改掉。
 *
 * 读接口**不鉴权**,用例里也不带 token。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { schema, useDb } from '../db'

const dir = mkdtempSync(join(tmpdir(), 'spztx-roster-reviews-api-'))
const db = useDb({ dbPath: join(dir, 'api.db') })

interface Row {
  enterpriseId: number
  name: string
  titleCode: string
  anchorYear: number | null
  dueYear: number | null
  basisEventId: number | null
  batchSeq: number | null
  source: string | null
  firstYear: number | null
  evidence: { sourceFile: string; attachment: string | null; listNo: number | null; page: number | null }[]
  reasons?: string[]
  tentativeDueYear?: number | null
}
interface Result {
  year: number
  status: string
  rows: Row[]
  pending: Row[]
  counts: { due: number; pending: number; titles: Record<string, { due: number; pending: number }> }
  page: number
  pageSize: number
}

let handlerReviews: (event: unknown) => Result
let handlerExport: (event: unknown) => Promise<Uint8Array>
let query: Record<string, unknown> = {}
let headers: Record<string, string> = {}

/** 一家企业 + 一条认定事件(带批次与出处)。 */
function seed(
  name: string,
  uscc: string,
  titleCode: 'little_giant' | 'specialized_sme' | 'innovative_sme',
  year: number,
  extra: { batchSeq?: number | null; evidence?: boolean; decidedYear?: number | null } = {},
) {
  const enterpriseId = db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc, district: '鄞州区' })
    .returning({ id: schema.enterprise.id })
    .get().id
  const recordId = db
    .insert(schema.record)
    .values({ enterpriseId, titleCode, source: 'jxj', district: '鄞州区' })
    .returning({ id: schema.record.id })
    .get().id
  const eventId = db
    .insert(schema.recordEvent)
    .values({
      recordId,
      eventType: 'award',
      year,
      batchSeq: extra.batchSeq === undefined ? 1 : extra.batchSeq,
      sortKey: year,
      decidedYear: extra.decidedYear === undefined ? year : extra.decidedYear,
    })
    .returning({ id: schema.recordEvent.id })
    .get().id
  if (extra.evidence !== false) {
    db.insert(schema.recordEvidence)
      .values({ recordEventId: eventId, sourceFile: 'jxj/announcement/2021/第3批.pdf', attachment: '附件一', listNo: 74, page: 74 })
      .run()
  }
  return enterpriseId
}

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getQuery', () => query)
  vi.stubGlobal('setHeader', (_event: unknown, name: string, value: string) => {
    headers[name] = value
  })
  vi.stubGlobal('createError', (opts: { statusMessage?: string; statusCode?: number }) =>
    Object.assign(new Error(opts.statusMessage ?? 'Bad request'), opts),
  )
  vi.doMock('@db', () => ({ useDb: () => db }))

  // 2024 年到期这一批(锚点 2021)
  seed('宁波甲复核有限公司', '91330211AAAAAA201X', 'specialized_sme', 2021)
  seed('宁波乙复核有限公司', '91330211AAAAAA202X', 'specialized_sme', 2021)
  seed('宁波丙小巨人有限公司', '91330211AAAAAA203X', 'little_giant', 2021)
  // 2027 年到期(锚点 2024)
  seed('宁波丁复核有限公司', '91330211AAAAAA204X', 'innovative_sme', 2024)
  // 证据不全:缺批次 ⇒ 待确认
  seed('宁波戊缺批次有限公司', '91330211AAAAAA205X', 'specialized_sme', 2021, { batchSeq: null })
  // 证据不全:缺出处 ⇒ 待确认
  seed('宁波己缺出处有限公司', '91330211AAAAAA206X', 'specialized_sme', 2021, { evidence: false })

  handlerReviews = (await import('../server/api/roster/reviews.get')).default as unknown as typeof handlerReviews
  handlerExport = (await import('../server/api/roster/reviews/export.get')).default as unknown as typeof handlerExport
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** 调一次列表接口。 */
function list(params: Record<string, unknown>): Result {
  query = params
  return handlerReviews({})
}

async function exported(params: Record<string, unknown>) {
  query = params
  headers = {}
  const bytes = await handlerExport({})
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.from(bytes) as never)
  return wb
}

describe('GET /api/roster/reviews 参数与响应信封(契约 §7.4)', () => {
  it('year 是**必填**的到期年份:2021 认定只在 2024(= 2021 + 3)的清单里', () => {
    const y2024 = list({ year: '2024' })
    expect(y2024.year).toBe(2024)
    expect(y2024.status).toBe('due')
    const names = y2024.rows.map((r) => r.name)
    expect(names).toContain('宁波甲复核有限公司')
    expect(names.every((n) => !n.includes('宁波丁'))).toBe(true)

    const y2025 = list({ year: '2025' })
    expect(y2025.rows.map((r) => r.name)).not.toContain('宁波甲复核有限公司')
  })

  it('缺 year / 不是四位公历年 ⇒ 400(不静默退回某一年)', () => {
    expect(() => list({})).toThrowError(/year/i)
    for (const bad of ['27', 'abc', '99999', '1899', '']) {
      expect(() => list({ year: bad })).toThrowError(/year/i)
    }
  })

  it('title 多值命中任一;非法称号 400', () => {
    const only = list({ year: '2024', title: 'little_giant' })
    expect(only.rows.map((r) => r.name)).toEqual(['宁波丙小巨人有限公司'])
    const both = list({ year: '2024', title: 'little_giant,specialized_sme' })
    expect(both.counts.due).toBeGreaterThan(only.counts.due)
    expect(() => list({ year: '2024', title: 'nope' })).toThrowError(/title/i)
  })

  it('status 默认 due;非法取值 400', () => {
    expect(list({ year: '2024' }).status).toBe('due')
    expect(list({ year: '2024', status: 'pending' }).status).toBe('pending')
    expect(() => list({ year: '2024', status: 'nope' })).toThrowError(/status/i)
  })

  it('行上带齐「凭什么进清单」:锚点年份、锚点事件、批次、来源、出处', () => {
    const row = list({ year: '2024', title: 'little_giant' }).rows[0]!
    expect(row.titleCode).toBe('little_giant')
    expect(row.anchorYear).toBe(2021)
    expect(row.dueYear).toBe(2024)
    expect(row.basisEventId).toBeTypeOf('number')
    expect(row.firstYear).toBe(2021)
    expect(row.batchSeq).toBe(1)
    expect(row.source).toBe('jxj')
    expect(row.evidence).toEqual([
      { sourceFile: 'jxj/announcement/2021/第3批.pdf', attachment: '附件一', listNo: 74, page: 74 },
    ])
  })

  it('counts 先于分页、与筛选同口径,且 due + pending 是全覆盖', () => {
    const all = list({ year: '2024', pageSize: '1' })
    expect(all.rows).toHaveLength(1)
    expect(all.page).toBe(1)
    expect(all.pageSize).toBe(1)
    // 计数不受分页影响
    expect(all.counts.due).toBe(3)
    expect(all.counts.pending).toBe(2)
    expect(all.counts.titles.specialized_sme).toEqual({ due: 2, pending: 2 })
    expect(all.counts.titles.little_giant).toEqual({ due: 1, pending: 0 })
  })

  it('翻页取到不同的行,总数不变', () => {
    const p1 = list({ year: '2024', page: '1', pageSize: '2' })
    const p2 = list({ year: '2024', page: '2', pageSize: '2' })
    expect(p1.rows).toHaveLength(2)
    expect(p2.rows).toHaveLength(1)
    expect(p1.rows.map((r) => r.enterpriseId)).not.toEqual(p2.rows.map((r) => r.enterpriseId))
    expect(p1.counts).toEqual(p2.counts)
  })
})

describe('GET /api/roster/reviews?status=pending(待确认清单)', () => {
  it('证据不全的行在这里,并给出可判别的原因与暂定年份', () => {
    const r = list({ year: '2024', status: 'pending', pageSize: '200' })
    expect(r.rows).toHaveLength(0)
    expect(r.pending).toHaveLength(r.counts.pending)
    const byName = new Map(r.pending.map((p) => [p.name, p]))
    expect(byName.get('宁波戊缺批次有限公司')?.reasons).toEqual(['no_batch'])
    expect(byName.get('宁波己缺出处有限公司')?.reasons).toEqual(['no_evidence'])
    // 暂定值给出来,但只在待确认清单里 —— 直接当工作单用是不允许的。
    expect(byName.get('宁波戊缺批次有限公司')?.tentativeDueYear).toBe(2024)
  })

  it('待确认清单**不按目标年份筛** —— 换一年,待确认项一个不少', () => {
    const a = list({ year: '2024', status: 'pending', pageSize: '200' })
    const b = list({ year: '2031', status: 'pending', pageSize: '200' })
    expect(b.pending.map((p) => p.name).sort()).toEqual(a.pending.map((p) => p.name).sort())
  })
})

describe('GET /api/roster/reviews/export(导出与筛选结果一致)', () => {
  it('两个工作表:到期清单 + 待确认清单,并写明口径', async () => {
    const wb = await exported({ year: '2024' })
    expect(wb.worksheets.map((w) => w.name)).toEqual(['到期清单', '待确认清单'])
    const due = wb.getWorksheet('到期清单')!
    expect(String(due.getRow(1).getCell(1).value)).toContain('到期 = 锚点 + 3')
    expect(String(due.getRow(1).getCell(1).value)).toContain('共 3 项')
    expect(due.getRow(2).getCell(1).value).toBe('企业名称')
    expect(due.getRow(2).getCell(5).value).toBe('到期年份')
    const pending = wb.getWorksheet('待确认清单')!
    expect(String(pending.getRow(1).getCell(1).value)).toContain('不按目标年份筛')
    expect(String(pending.getRow(1).getCell(1).value)).toContain('共 2 项')
  })

  it('**导出与列表同筛选**:到期清单的数据行 = 列表接口的行,且不受分页截断', async () => {
    const params = { year: '2024', title: 'specialized_sme' }
    const wb = await exported({ ...params, pageSize: '1', page: '1' })
    const due = wb.getWorksheet('到期清单')!
    // 第 1 行口径、第 2 行表头,数据从第 3 行起。
    const names = []
    for (let r = 3; r <= due.rowCount; r++) names.push(due.getRow(r).getCell(1).value)
    const api = list(params)
    expect(names).toEqual(api.rows.map((row) => row.name))
    expect(names).toHaveLength(2) // 甲、乙(丙是小巨人,被 title 筛掉)
  })

  it('按 status 只导一个分层;文件名带目标年份', async () => {
    const onlyPending = await exported({ year: '2024', status: 'pending' })
    expect(onlyPending.worksheets.map((w) => w.name)).toEqual(['待确认清单'])
    const onlyDue = await exported({ year: '2024', status: 'due' })
    expect(onlyDue.worksheets.map((w) => w.name)).toEqual(['到期清单'])
    await exported({ year: '2024' })
    expect(decodeURIComponent(headers['content-disposition']!)).toContain('复核清单-2024年.xlsx')
  })

  it('导出沿用同一套参数校验:缺 year 同样 400', async () => {
    await expect(exported({})).rejects.toMatchObject({ statusCode: 400 })
  })
})
