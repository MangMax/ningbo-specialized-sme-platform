import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { schema, useDb } from '../db'
import { listRecords } from '../lib/query'
import { getRosterEnterpriseDetail } from '../lib/roster/enterprise-roster'
import { parseRecordQuery } from '../server/utils/roster-read-query'

const dir = mkdtempSync(join(tmpdir(), 'spztx-record-query-'))
const db = useDb({ dbPath: join(dir, 'records.db') })

function enterprise(name: string, uscc: string | null): number {
  return db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc, district: '海曙区' })
    .returning({ id: schema.enterprise.id })
    .get().id
}

function record(
  enterpriseId: number,
  source: 'jxj' | 'miit' = 'jxj',
  titleCode = 'specialized_sme',
): number {
  return db
    .insert(schema.record)
    .values({ enterpriseId, titleCode, source, district: '海曙区' })
    .returning({ id: schema.record.id })
    .get().id
}

function event(
  recordId: number,
  input: {
    type: 'award' | 'review' | 'maintain' | 'nurture'
    year: number | null
    decidedYear?: number | null
    reviewOutcome?: 'passed' | 'failed' | null
    seq?: number | null
    sortKey?: number
  },
): number {
  return db
    .insert(schema.recordEvent)
    .values({
      recordId,
      eventType: input.type,
      year: input.year,
      decidedYear: input.decidedYear ?? null,
      reviewOutcome: input.reviewOutcome ?? null,
      batchSeq: input.seq ?? null,
      sortKey: input.sortKey ?? input.decidedYear ?? input.year ?? 0,
    })
    .returning({ id: schema.recordEvent.id })
    .get().id
}

function evidence(recordEventId: number, sourceFile: string, page: number | null = null) {
  db.insert(schema.recordEvidence)
    .values({ recordEventId, sourceFile, attachment: '附件2', listNo: 19, page })
    .run()
}

const reassessed = enterprise('宁波重授科技有限公司', '91330200555001234A')
const reassessedRecord = record(reassessed)
const firstAward = event(reassessedRecord, {
  type: 'award',
  year: 2021,
  decidedYear: 2021,
  seq: 1,
  sortKey: 2021,
})
evidence(firstAward, 'jxj/announcement/2021/award.pdf', 7)
const failedReview = event(reassessedRecord, {
  type: 'review',
  year: 2021,
  decidedYear: 2022,
  reviewOutcome: 'failed',
  seq: 2,
  sortKey: 2022,
})
evidence(failedReview, 'jxj/announcement/2022/review.pdf', 8)
const reaward = event(reassessedRecord, {
  type: 'award',
  year: 2024,
  decidedYear: 2024,
  sortKey: 2024,
})
const reassessedInnovativeRecord = record(reassessed, 'jxj', 'innovative_sme')
const reassessedInnovativeAward = event(reassessedInnovativeRecord, {
  type: 'award',
  year: 2022,
  decidedYear: 2022,
})
evidence(reassessedInnovativeAward, 'jxj/announcement/2022/innovative-award.pdf')
const otherSource = record(reassessed, 'miit')
event(otherSource, { type: 'maintain', year: 2025, seq: 3, sortKey: 2025 })
db.insert(schema.enterpriseAlias)
  .values({
    enterpriseId: reassessed,
    name: '宁波重授旧名有限公司',
    nameNorm: '宁波重授旧名有限公司',
    sourceKind: 'manual',
    sourceRefId: 1,
    verificationStatus: 'confirmed',
  })
  .run()

const passed = enterprise('宁波复核通过企业', '91330200555001235B')
const passedRecord = record(passed)
event(passedRecord, { type: 'award', year: 2021, decidedYear: 2021, seq: 1, sortKey: 2021 })
const passedReview = event(passedRecord, {
  type: 'review',
  year: 2021,
  decidedYear: 2025,
  reviewOutcome: 'passed',
  seq: 2,
  sortKey: 2025,
})
evidence(passedReview, 'jxj/announcement/2025/review.pdf', 14)

const pending = enterprise('宁波待核企业', null)
const pendingRecord = record(pending)
event(pendingRecord, { type: 'award', year: 2021 })
event(pendingRecord, { type: 'review', year: 2021, decidedYear: 2024 })
db.insert(schema.enterpriseAlias)
  .values({
    enterpriseId: pending,
    name: '宁波待核旧名有限公司',
    nameNorm: '宁波待核旧名有限公司',
    sourceKind: 'manual',
    sourceRefId: 2,
    verificationStatus: 'pending',
  })
  .run()

const undatable = enterprise('宁波无法定年企业', null)
const undatableRecord = record(undatable)
event(undatableRecord, { type: 'award', year: null })

const terminated = enterprise('宁波复核未通过企业', null)
const terminatedRecord = record(terminated)
event(terminatedRecord, { type: 'award', year: 2021, decidedYear: 2021, seq: 1 })
event(terminatedRecord, { type: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'failed', seq: 2 })

const nurtureOnly = enterprise('宁波仅培育企业', null)
const nurtureRecord = record(nurtureOnly)
event(nurtureRecord, { type: 'nurture', year: 2024, seq: 1 })

// Legacy rows can contain page numbers for formats without stable pagination.
const legacyDocx = enterprise('宁波旧版 Word 页码企业', null)
const legacyDocxRecord = record(legacyDocx)
const legacyDocxEvent = event(legacyDocxRecord, { type: 'award', year: 2020, seq: 1 })
evidence(legacyDocxEvent, 'jxj/announcement/legacy.docx', 12)
const legacyXlsx = enterprise('宁波旧版 Excel 页码企业', null)
const legacyXlsxRecord = record(legacyXlsx)
const legacyXlsxEvent = event(legacyXlsxRecord, { type: 'award', year: 2020, seq: 1 })
evidence(legacyXlsxEvent, 'jxj/announcement/legacy.xlsx', 9)

let routeQuery: Record<string, unknown> = {}
let routeId: unknown = null
let recordsHandler: (event: unknown) => unknown
let recordsRouteMeta: {
  openAPI?: {
    summary?: string
    parameters?: Array<{
      name: string
      in: string
      style?: string
      explode?: boolean
      schema?: { type?: string; items?: { type?: string; enum?: string[] } }
      description?: string
    }>
    responses?: Record<number, { description?: string }>
  }
}
let rosterEnterprisesRouteMeta: typeof recordsRouteMeta
let rosterRecognitionsRouteMeta: typeof recordsRouteMeta
let rosterExportRouteMeta: typeof recordsRouteMeta
let enterpriseDetailHandler: (event: unknown) => unknown
let queryRecordsTool: { handler: (input: Record<string, unknown>) => unknown }
let rosterEnterprisesHandler: (event: unknown) => unknown
let listEnterprisesTool: {
  handler: (input: Record<string, unknown>) => unknown
  inputSchema: Record<string, { safeParse(value: unknown): { success: boolean } }>
}
let enterpriseDetailTool: { handler: (input: { enterpriseId: number }) => unknown }

beforeAll(async () => {
  vi.stubGlobal('defineRouteMeta', (meta: typeof recordsRouteMeta) => {
    if (meta.openAPI?.summary === '查台账记录') {
      recordsRouteMeta = meta
    }
    if (meta.openAPI?.summary === '跨称号去重企业总表') {
      rosterEnterprisesRouteMeta = meta
    }
    if (meta.openAPI?.summary === '首次认定清单') {
      rosterRecognitionsRouteMeta = meta
    }
    if (meta.openAPI?.summary === '导出企业总表(Excel)') {
      rosterExportRouteMeta = meta
    }
    return meta
  })
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getQuery', () => routeQuery)
  vi.stubGlobal('getRouterParam', () => routeId)
  vi.stubGlobal('createError', (options: { statusCode?: number; statusMessage?: string }) =>
    Object.assign(new Error(options.statusMessage), options),
  )
  vi.doMock('@db', () => ({ useDb: () => db }))
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (definition: unknown) => definition }))
  recordsHandler = (await import('../server/api/records.get')).default as unknown as typeof recordsHandler
  enterpriseDetailHandler = (await import('../server/api/enterprises/[id].get')).default as unknown as typeof enterpriseDetailHandler
  queryRecordsTool = (await import('../server/mcp/tools/query_records')).default as unknown as typeof queryRecordsTool
  rosterEnterprisesHandler =
    (await import('../server/api/roster/enterprises.get')).default as unknown as typeof rosterEnterprisesHandler
  await import('../server/api/roster/recognitions.get')
  await import('../server/api/roster/export.get')
  listEnterprisesTool = (await import('../server/mcp/tools/list_enterprises')).default as unknown as typeof listEnterprisesTool
  enterpriseDetailTool = (await import('../server/mcp/tools/get_enterprise_detail')).default as unknown as typeof enterpriseDetailTool
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('通用记录查询的生命周期投影', () => {
  it('REST OpenAPI 将 firstStatus 声明为逗号分隔的枚举数组', () => {
    const parameter = recordsRouteMeta?.openAPI?.parameters?.find((item) => item.name === 'firstStatus')

    expect(parameter).toMatchObject({
      in: 'query',
      style: 'form',
      explode: false,
      schema: { type: 'array', items: { type: 'string', enum: ['confirmed', 'pending'] } },
    })
  })

  it('首次认定年份在记录、企业总表和导出 OpenAPI 中声明为整数数组', () => {
    for (const routeMeta of [recordsRouteMeta, rosterEnterprisesRouteMeta, rosterExportRouteMeta]) {
      const parameter = routeMeta?.openAPI?.parameters?.find((item) => item.name === 'firstYear')

      expect(parameter).toMatchObject({
        in: 'query',
        style: 'form',
        explode: false,
        schema: { type: 'array', items: { type: 'integer' } },
      })
      expect(parameter?.description).toMatch(/逗号分隔多值/)
    }
  })

  it('企业总表 OpenAPI 将 firstStatus 声明为逗号分隔的枚举数组', () => {
    const parameter = rosterEnterprisesRouteMeta?.openAPI?.parameters?.find(
      (item) => item.name === 'firstStatus',
    )

    expect(parameter).toMatchObject({
      in: 'query',
      style: 'form',
      explode: false,
      schema: { type: 'array', items: { type: 'string', enum: ['confirmed', 'pending'] } },
    })
  })

  it('首次认定清单 OpenAPI 将 status 声明为逗号分隔的枚举数组', () => {
    const parameter = rosterRecognitionsRouteMeta?.openAPI?.parameters?.find((item) => item.name === 'status')

    expect(parameter).toMatchObject({
      in: 'query',
      style: 'form',
      explode: false,
      schema: { type: 'array', items: { type: 'string', enum: ['confirmed', 'pending'] } },
    })
  })

  it('总表导出 OpenAPI 将 firstStatus 声明为数组，并列出对应的 400 错误', () => {
    const parameter = rosterExportRouteMeta?.openAPI?.parameters?.find((item) => item.name === 'firstStatus')

    expect(parameter).toMatchObject({
      in: 'query',
      style: 'form',
      explode: false,
      schema: { type: 'array', items: { type: 'string', enum: ['confirmed', 'pending'] } },
    })
    expect(rosterExportRouteMeta?.openAPI?.responses?.[400]?.description).toContain('firstStatus')
  })

  it('failed review 后重新 award 保留首次认定，并把新认定作为到期锚点', () => {
    const row = listRecords(db, { dueYear: 2027, pageSize: 200 }).rows.find((r) => r.enterpriseId === reassessed)!
    expect(row.lifecycle).toMatchObject({
      firstRecognitionYear: 2021,
      firstRecognitionEventId: firstAward,
      anchorYear: 2024,
      anchorEventId: reaward,
      dueYear: 2027,
      state: 'active',
      status: 'needs_review',
    })
    expect(row.events.map((e) => e.type)).toEqual(['award', 'review', 'award', 'maintain'])
    expect(row.events.map((e) => e.source)).toEqual(['jxj', 'jxj', 'jxj', 'miit'])
    expect(row.events[0]).toMatchObject({
      id: firstAward,
      year: 2021,
      source: 'jxj',
      evidence: [{ sourceFile: 'jxj/announcement/2021/award.pdf', attachment: '附件2', listNo: 19, page: 7 }],
    })
    expect(row.lifecycle.flags.map((flag) => flag.code)).toEqual(['no_batch', 'no_evidence'])
  })

  it('year 筛事件年份，dueYear 筛到期年份，复核通过用结论年份刷新锚点', () => {
    expect(listRecords(db, { year: [2021], pageSize: 200 }).rows.map((r) => r.enterpriseId)).toContain(passed)
    const due = listRecords(db, { dueYear: 2028, pageSize: 200 }).rows.find((r) => r.enterpriseId === passed)!
    expect(due.lifecycle).toMatchObject({
      anchorYear: 2025,
      anchorEventId: passedReview,
      dueYear: 2028,
      status: 'active',
    })
    expect(due.events.find((e) => e.id === passedReview)).toMatchObject({
      year: 2021,
      decidedYear: 2025,
      reviewOutcome: 'passed',
    })
    expect(listRecords(db, { dueYear: 2021 }).total).toBe(0)
    expect(listRecords(db, { dueYear: 2024 }).rows.map((r) => r.enterpriseId)).toContain(pending)
  })

  it('证据缺口和未知复核结论保留在结果里，并给出逐项原因', () => {
    const row = listRecords(db, { dueYear: 2024, pageSize: 200 }).rows.find((r) => r.enterpriseId === pending)!
    expect(row.lifecycle.flags).toEqual([
      { code: 'decided_year_missing', reason: expect.any(String) },
      { code: 'review_outcome_unknown', reason: expect.any(String) },
      { code: 'no_batch', reason: expect.any(String) },
      { code: 'no_evidence', reason: expect.any(String) },
    ])
    expect(row.lifecycle).toMatchObject({ dueYear: 2024, status: 'needs_review' })
    const unresolved = listRecords(db, { pageSize: 200 }).rows.find((r) => r.enterpriseId === undatable)!
    expect(unresolved.lifecycle).toMatchObject({ dueYear: null, status: 'undatable' })
    expect(unresolved.lifecycle.flags.map((flag) => flag.code)).toContain('no_anchor_year')
  })

  it('已明确未通过的复核终止资格；只有培育事件不构成称号生命周期', () => {
    const allRows = listRecords(db, { pageSize: 200 }).rows
    expect(allRows.find((r) => r.enterpriseId === terminated)?.lifecycle).toMatchObject({
      state: 'terminated',
      status: 'terminated',
      dueYear: null,
    })
    expect(allRows.find((r) => r.enterpriseId === nurtureOnly)?.lifecycle).toMatchObject({
      state: 'none',
      status: 'not_applicable',
      dueYear: null,
    })
    expect(listRecords(db, { dueYear: 2024, pageSize: 200 }).rows.map((r) => r.enterpriseId)).not.toContain(terminated)
  })

  it('q 搜现名、已确认曾用名和 USCC，不搜索待核曾用名', () => {
    expect(listRecords(db, { q: '重授旧名', title: ['specialized_sme'] }).rows.map((r) => r.enterpriseId)).toEqual([reassessed])
    expect(listRecords(db, { q: '91330200555001235' }).rows.map((r) => r.enterpriseId)).toEqual([passed])
    expect(listRecords(db, { q: '待核旧名' }).rows).toEqual([])
  })

  it('按事件过滤只选行，不裁掉该企业×称号的其他事件或来源', () => {
    const row = listRecords(db, { eventType: ['award'], q: '重授旧名', title: ['specialized_sme'] }).rows[0]!
    expect(row.sources).toEqual(['jxj', 'miit'])
    expect(row.events.map((e) => e.type)).toEqual(['award', 'review', 'award', 'maintain'])
  })
})

describe('REST / MCP 共用记录查询与企业详情读模型', () => {
  it('firstYear 按首次 award 年筛选且先于分页；事件 year 仍是独立口径', async () => {
    routeQuery = { firstYear: '2021', pageSize: '1' }
    const paged = recordsHandler({}) as { rows: { enterpriseId: number }[]; total: number }
    expect(paged.total).toBe(4)
    expect(paged.rows).toHaveLength(1)

    // 重授企业有 2024 年重新获批事件，但首次认定仍是 2021；过滤不裁掉它的完整历史。
    routeQuery = { year: '2024', firstYear: '2021', q: '重授旧名', pageSize: '5' }
    const rest = recordsHandler({}) as {
      rows: {
        enterpriseId: number
        lifecycle: { firstRecognitionYear: number | null }
        events: { type: string; evidence: { sourceFile: string }[] }[]
      }[]
      total: number
    }
    const mcp = await queryRecordsTool.handler({
      year: [2024],
      firstYear: [2021],
      q: '重授旧名',
      pageSize: 5,
    })
    expect(rest.total).toBe(1)
    expect(rest.rows[0]).toMatchObject({
      enterpriseId: reassessed,
      lifecycle: { firstRecognitionYear: 2021 },
      events: [
        { type: 'award', evidence: [{ sourceFile: 'jxj/announcement/2021/award.pdf' }] },
        { type: 'review', evidence: [{ sourceFile: 'jxj/announcement/2022/review.pdf' }] },
        { type: 'award' },
        { type: 'maintain' },
      ],
    })
    expect(mcp).toEqual(rest)

    // 2024 是事件年份，但不是这组的首次认定年份。
    routeQuery = { year: '2024', firstYear: '2024', q: '重授旧名' }
    expect((recordsHandler({}) as { total: number }).total).toBe(0)
  })

  it('firstStatus 使用首次认定共享判定，并在 REST 与 MCP 中先筛后分页', async () => {
    routeQuery = { firstYear: '2021', firstStatus: 'confirmed', pageSize: '1' }
    const confirmed = recordsHandler({}) as { rows: { enterpriseId: number }[]; total: number }
    expect(confirmed.total).toBe(1)
    expect(confirmed.rows.map((row) => row.enterpriseId)).toEqual([reassessed])

    routeQuery = { firstYear: '2021', firstStatus: 'pending', pageSize: '1' }
    const pending = recordsHandler({}) as { rows: { enterpriseId: number }[]; total: number }
    const pendingMcp = await queryRecordsTool.handler({
      firstYear: [2021],
      firstStatus: ['pending'],
      pageSize: 1,
    })
    expect(pending.total).toBe(3)
    expect(pending.rows).toHaveLength(1)
    expect(pendingMcp).toEqual(pending)

    routeQuery = { firstStatus: 'sure' }
    expect(() => recordsHandler({})).toThrowError(/firstStatus/)

    const inputSchema = (queryRecordsTool as unknown as {
      inputSchema: Record<string, { safeParse(value: unknown): { success: boolean } }>
    }).inputSchema
    expect(inputSchema.firstStatus!.safeParse(['pending']).success).toBe(true)
    expect(inputSchema.firstStatus!.safeParse(['sure']).success).toBe(false)
    expect(inputSchema.firstYear!.safeParse([2021]).success).toBe(true)
  })

  it('list_enterprises MCP 按同一个企业×称号应用首次认定筛选', async () => {
    routeQuery = { title: 'innovative_sme', firstYear: '2021', firstStatus: 'confirmed' }
    const restMiss = rosterEnterprisesHandler({}) as { rows: { enterpriseId: number }[] }
    const mcpMiss = await listEnterprisesTool.handler({
      title: 'innovative_sme',
      firstYear: [2021],
      firstStatus: ['confirmed'],
    }) as { rows: { enterpriseId: number }[] }
    expect(restMiss.rows).toEqual([])
    expect(mcpMiss.rows).toEqual([])

    routeQuery = { title: 'innovative_sme', firstYear: '2022', firstStatus: 'confirmed' }
    const restHit = rosterEnterprisesHandler({}) as { rows: { enterpriseId: number }[]; counts: { total: number } }
    const mcpHit = await listEnterprisesTool.handler({
      title: 'innovative_sme',
      firstYear: [2022],
      firstStatus: ['confirmed'],
    }) as { rows: { enterpriseId: number }[]; counts: { total: number } }
    expect(restHit.rows.map((row) => row.enterpriseId)).toEqual([reassessed])
    expect(mcpHit.rows.map((row) => row.enterpriseId)).toEqual([reassessed])
    expect(mcpHit.counts.total).toBe(restHit.counts.total)
    expect(listEnterprisesTool.inputSchema.firstYear!.safeParse([2022]).success).toBe(true)
    expect(listEnterprisesTool.inputSchema.firstStatus!.safeParse(['pending']).success).toBe(true)
    expect(listEnterprisesTool.inputSchema.firstStatus!.safeParse(['sure']).success).toBe(false)
  })

  it('list_enterprises MCP 与 REST 返回同一完整首次认定读模型', async () => {
    routeQuery = {
      q: '宁波重授旧名有限公司',
      title: 'specialized_sme,innovative_sme',
      firstYear: '2021',
      firstStatus: 'confirmed',
      pageSize: '1',
    }
    const rest = rosterEnterprisesHandler({})
    const mcp = await listEnterprisesTool.handler({
      q: '宁波重授旧名有限公司',
      title: ['specialized_sme', 'innovative_sme'],
      firstYear: [2021],
      firstStatus: ['confirmed'],
      pageSize: 1,
    })

    expect(mcp).toEqual(rest)
    expect(listEnterprisesTool.inputSchema.title!.safeParse('specialized_sme').success).toBe(true)
    expect(listEnterprisesTool.inputSchema.title!.safeParse(['specialized_sme', 'innovative_sme']).success).toBe(true)
    expect(listEnterprisesTool.inputSchema.title!.safeParse(['unknown_title']).success).toBe(false)
  })

  it('共享解析保留 year 与 dueYear 的独立语义，并拒绝多值 dueYear', () => {
    expect(parseRecordQuery({ year: '2021,2024', dueYear: '2028' })).toMatchObject({
      year: [2021, 2024],
      dueYear: 2028,
    })
    expect(() => parseRecordQuery({ dueYear: '2027,2028' })).toThrow(/dueYear/)
    expect(() => parseRecordQuery({ dueYear: '27' })).toThrow(/dueYear/)
  })

  it('GET /api/records 与 query_records 返回完全相同的结果', async () => {
    routeQuery = { dueYear: '2027', q: '重授旧名', pageSize: '20' }
    const rest = recordsHandler({})
    const mcp = await queryRecordsTool.handler({ dueYear: 2027, q: '重授旧名', pageSize: 20 })
    expect(mcp).toEqual(rest)

    routeQuery = { year: '2021', dueYear: '2028' }
    const yearAndDueYearRest = recordsHandler({})
    const yearAndDueYearMcp = await queryRecordsTool.handler({ year: [2021], dueYear: 2028 })
    expect(yearAndDueYearMcp).toEqual(yearAndDueYearRest)
    expect((yearAndDueYearRest as { rows: { enterpriseId: number }[] }).rows.map((r) => r.enterpriseId)).toContain(passed)
  })

  it('详情与 GET /api/records 对 legacy DOCX/XLSX 隐藏不可靠的数字页码', () => {
    routeQuery = {}
    const result = recordsHandler({}) as {
      rows: { enterpriseId: number; events: { evidence: { sourceFile: string; page: number | null }[] }[] }[]
    }
    const docxRecord = result.rows.find((row) => row.enterpriseId === legacyDocx)!
    const xlsxRecord = result.rows.find((row) => row.enterpriseId === legacyXlsx)!
    expect(docxRecord.events.flatMap((item) => item.evidence)).toEqual([
      { sourceFile: 'jxj/announcement/legacy.docx', attachment: '附件2', listNo: 19, page: null },
    ])
    expect(xlsxRecord.events.flatMap((item) => item.evidence)).toEqual([
      { sourceFile: 'jxj/announcement/legacy.xlsx', attachment: '附件2', listNo: 19, page: null },
    ])

    routeId = String(legacyDocx)
    const detail = enterpriseDetailHandler({}) as {
      records: { events: { evidence: { sourceFile: string; page: number | null }[] }[] }[]
    }
    expect(detail.records.flatMap((item) => item.events.flatMap((entry) => entry.evidence))).toEqual([
      { sourceFile: 'jxj/announcement/legacy.docx', attachment: '附件2', listNo: 19, page: null },
    ])
    routeId = String(legacyXlsx)
    const xlsxDetail = enterpriseDetailHandler({}) as typeof detail
    expect(xlsxDetail.records.flatMap((item) => item.events.flatMap((entry) => entry.evidence))).toEqual([
      { sourceFile: 'jxj/announcement/legacy.xlsx', attachment: '附件2', listNo: 19, page: null },
    ])
  })

  it('MCP 输入 schema 暴露 dueYear 与通用查询条件', () => {
    const inputSchema = (queryRecordsTool as unknown as {
      inputSchema: Record<string, { safeParse(value: unknown): { success: boolean } }>
    }).inputSchema
    expect(inputSchema.dueYear!.safeParse(2028).success).toBe(true)
    expect(inputSchema.dueYear!.safeParse(27).success).toBe(false)
    expect(inputSchema.year!.safeParse([2021, 2024]).success).toBe(true)
    expect(inputSchema.q!.safeParse('旧名或统代').success).toBe(true)
  })

  it('MCP 企业详情复用 REST 使用的详情读模型', async () => {
    const restReadModel = getRosterEnterpriseDetail(db, reassessed)
    const mcp = await enterpriseDetailTool.handler({ enterpriseId: reassessed })
    expect(mcp).toEqual(restReadModel)
    await expect(enterpriseDetailTool.handler({ enterpriseId: 999999 })).rejects.toMatchObject({ statusCode: 404 })
  })
})
