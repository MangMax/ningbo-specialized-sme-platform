import '../../support/compiled-enterprise-reader'
import { initializeDb } from '../../../db/client'
import { decodeJsonRead } from '../../support/json-read'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { readExportWorkbook } from '../../support/read-workbook'
import { Readable } from 'node:stream'
import { createServer, type Server } from 'node:http'
import { createApp, toNodeListener, getQuery as h3Query, setHeader as h3Header, createError as h3Error } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { schema, useDb } from '../../../db'

/**
 * RL-04 的三个读接口(契约 §7.1 / §7.2 / §7.3)。
 *
 * 这里测的是**接口契约本身**:参数怎么解析(多值 / 缺省 / 非法值给 400)、
 * 错误码(404 / 400)、以及响应信封。业务口径(去重、别名搜索、rosterState、
 * 差异四态)已经在 `tests/roster-enterprises.test.ts` 里对着读模型测过 ——
 * 这一层不重复测那些,只保证「HTTP 面没有把参数弄丢或把口径改掉」。
 *
 * 读接口**不鉴权**(与既有分法一致:读不鉴权,写/任务鉴权),所以用例里也不带 token。
 */

const dir = mkdtempSync(join(tmpdir(), 'spztx-roster-api-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'api.db') })

const USCC = '91330211AAAAAAA001X'
let enterpriseId = 0
let emptyId = 0

function seed(name: string, uscc: string | null, district: string | null, titleCode: string, source: 'jxj' | 'miit', eventType: 'award' | 'review' | 'maintain' | 'nurture') {
  const id = db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc, district })
    .returning({ id: schema.enterprise.id })
    .get().id
  const recordId = db
    .insert(schema.record)
    .values({ enterpriseId: id, titleCode, source })
    .returning({ id: schema.record.id })
    .get().id
  db.insert(schema.recordEvent)
    .values({ recordId, eventType, year: 2021, decidedYear: 2021 })
    .run()
  return id
}

let handlerEnterprises: (event: unknown) => Promise<{
  rows: { enterpriseId: number; name: string; titles: string[]; aliasNames: string[] }[]
  counts: { total: number; titlePairs: number; titles: Record<string, number> }
  page: number
  pageSize: number
}>
let handlerDetail: (event: unknown) => Promise<unknown>
let handlerDifferences: (event: unknown) => Promise<{
  rows: {
    enterpriseId: number
    titleCode: string
    direction: string
    status: string
    reasonCode: string | null
    inCurrentDifference: boolean
    explanationId: number | null
  }[]
  counts: Record<string, Record<string, number>>
  total: number
  page: number
  pageSize: number
}>
let server: Server
let baseUrl: string
let query: Record<string, unknown> = {}
let routerParam: string | undefined
let headers: Record<string, string> = {}
let handlerExport: (event: unknown) => Promise<Uint8Array | Readable>

/** 只有工信部一侧的企业 ⇒ 专精特新上「平台有而公布无」。 */
let sideOnlyId = 0

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('defineRouteMeta', () => undefined)
  vi.stubGlobal('getQuery', (event: Parameters<typeof h3Query>[0]) => event.node ? h3Query(event) : query)
  vi.stubGlobal('getRouterParam', () => routerParam)
  vi.stubGlobal('setHeader', (_event: unknown, name: string, value: string) => {
    headers[name] = value
    if ((_event as Parameters<typeof h3Header>[0]).node) h3Header(_event as Parameters<typeof h3Header>[0], name, value)
  })
  vi.stubGlobal('createError', h3Error)
  vi.doMock('@db', () => ({ useDb: () => db }))

  enterpriseId = seed('宁波接口测试股份有限公司', USCC, '鄞州区', 'specialized_sme', 'jxj', 'award')
  // 两侧都有的记录 ⇒ 不是差异;用来验证筛选不会把非差异混进来。
  const recordId = db
    .insert(schema.record)
    .values({ enterpriseId, titleCode: 'specialized_sme', source: 'miit' })
    .returning({ id: schema.record.id })
    .get().id
  db.insert(schema.recordEvent).values({ recordId, eventType: 'maintain', year: 2025 }).run()
  db.insert(schema.enterpriseAlias)
    .values({
      enterpriseId,
      name: '宁波接口测试厂',
      nameNorm: '宁波接口测试厂',
      sourceKind: 'manual',
      verificationStatus: 'confirmed',
    })
    .run()
  db.insert(schema.differenceReason)
    .values({
      enterpriseId,
      titleCode: 'specialized_sme',
      direction: 'extra_in_miit',
      status: 'confirmed_reason',
      reasonCode: 'moved_out',
      measureCode: 'mark_moved_out',
      verificationStatus: 'confirmed',
      recordedAt: '2026-10-14T00:00:00.000Z',
    })
    .run()
  emptyId = seed('宁波无事件接口企业', '91330211AAAAAAA002X', null, 'innovative_sme', 'miit', 'award')

  // 只有工信部一侧 ⇒ 专精特新上确实是一条差异;带一条**当前**解释。
  sideOnlyId = seed('宁波仅平台接口企业', '91330211AAAAAAA003X', null, 'specialized_sme', 'miit', 'maintain')
  db.insert(schema.differenceReason)
    .values({
      enterpriseId: sideOnlyId,
      titleCode: 'specialized_sme',
      direction: 'extra_in_miit',
      status: 'confirmed_reason',
      reasonCode: 'moved_out',
      measureCode: 'mark_moved_out',
      verificationStatus: 'confirmed',
      recordedAt: '2026-10-14T00:00:00.000Z',
    })
    .run()

  handlerEnterprises = decodeJsonRead((await import('../../../layers/sme-roster/server/api/roster/enterprises.get')).default) as unknown as typeof handlerEnterprises
  handlerDetail = decodeJsonRead((await import('../../../layers/sme-roster/server/api/roster/enterprises/[id].get')).default) as unknown as typeof handlerDetail
  handlerDifferences = (await import('../../../layers/sme-roster/server/api/roster/differences.get')).default as unknown as typeof handlerDifferences
  handlerExport = (await import('../../../layers/sme-roster/server/api/roster/export.get')).default as unknown as typeof handlerExport
  const app = createApp()
  app.use('/api/roster/export', handlerExport as never)
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/roster/enterprises(契约 §7.1)', () => {
  it('不筛 = 全部;响应信封是 rows / counts / page / pageSize', async () => {
    query = {}
    const out = (await handlerEnterprises({}))
    expect(out.rows.length).toBe(3)
    expect(Object.keys(out).sort()).toEqual(['counts', 'page', 'pageSize', 'rows'])
    expect(out.page).toBe(1)
    expect(out.pageSize).toBe(50)
    // 计数口径说清:企业数 + 每称号企业数 + 企业×称号数。
    expect(out.counts.total).toBe(3)
    expect(out.counts.titlePairs).toBe(3)
    expect(out.counts.titles).toMatchObject({ specialized_sme: 2, innovative_sme: 1 })
  })

  it('q 命中现名或**已确认**曾用名', async () => {
    query = { q: '宁波接口测试厂' }
    expect((await handlerEnterprises({})).rows.map((r) => r.enterpriseId)).toEqual([enterpriseId])
    query = { q: '接口测试股份有限公司' }
    expect((await handlerEnterprises({})).rows.map((r) => r.enterpriseId)).toEqual([enterpriseId])
    query = {}
  })

  it('title / district / rosterState 均可筛,title 认逗号分隔与重复参数', async () => {
    query = { title: 'specialized_sme' }
    expect((await handlerEnterprises({})).rows.map((r) => r.enterpriseId).sort()).toEqual([enterpriseId, sideOnlyId].sort())
    query = { title: 'specialized_sme,innovative_sme' }
    expect((await handlerEnterprises({})).rows).toHaveLength(3)
    query = { title: ['specialized_sme', 'innovative_sme'] }
    expect((await handlerEnterprises({})).rows).toHaveLength(3)
    query = { district: '鄞州区' }
    expect((await handlerEnterprises({})).rows.map((r) => r.enterpriseId)).toEqual([enterpriseId])
    query = { rosterState: 'removed_platform_only' }
    expect((await handlerEnterprises({})).rows).toEqual([])
    query = {}
  })

  it('分页参数生效,非法值退回默认而不是报错', async () => {
    query = { pageSize: '1' }
    expect((await handlerEnterprises({})).rows).toHaveLength(1)
    query = { pageSize: '1', page: '3' }
    expect((await handlerEnterprises({})).rows).toHaveLength(1)
    query = { pageSize: 'abc', page: '0' }
    const fallback = (await handlerEnterprises({}))
    expect(fallback.page).toBe(1)
    expect(fallback.pageSize).toBe(50)
    query = {}
  })

  it('unknown title / rosterState ⇒ 400(取值说不清就不猜)', () => {
    query = { title: 'nope' }
    expect(() => handlerEnterprises({})).toThrowError(/title/)
    query = { rosterState: 'gone' }
    expect(() => handlerEnterprises({})).toThrowError(/rosterState/)
    query = {}
  })
})

describe('GET /api/roster/enterprises/:id(契约 §7.2)', () => {
  it('保留原详情字段并独立返回六个称号方向的覆盖决定与有效性评估', async () => {
    routerParam = String(enterpriseId)
    const out = (await handlerDetail({})) as Record<string, unknown>
    expect(Object.keys(out).sort()).toEqual([
      'aliases',
      'businessTimeline',
      'differences',
      'enterprise',
      'events',
      'evidence',
      'platform',
      'publishedPresentation',
      'qualificationAssessment',
      'recognitions',
      'records',
      'titleAssessments',
    ])
    expect((out.businessTimeline as { asOf: string }).asOf).toBe((out.qualificationAssessment as { asOf: string }).asOf)
    expect((out.enterprise as { enterpriseId: number }).enterpriseId).toBe(enterpriseId)
    expect((out.aliases as unknown[]).length).toBe(1)
    expect((out.records as unknown[]).length).toBe(2)
    const assessments = out.titleAssessments as { enterpriseId: number; titleCode: string; direction: string; assessment: string; queryCoverage: unknown; currentDecision: unknown; explanationValidity: unknown }[]
    expect(assessments).toHaveLength(6)
    expect(assessments.map(a => `${a.titleCode}/${a.direction}`).sort()).toEqual([
      'innovative_sme/extra_in_miit', 'innovative_sme/missing_in_miit', 'little_giant/extra_in_miit', 'little_giant/missing_in_miit', 'specialized_sme/extra_in_miit', 'specialized_sme/missing_in_miit',
    ])
    expect(assessments.find(a => a.titleCode === 'specialized_sme' && a.direction === 'extra_in_miit')).toMatchObject({
      enterpriseId, assessment: 'decided', queryCoverage: { status: 'not_queried', sources: [] }, currentDecision: { current: { status: 'confirmed_reason', reasonCode: 'moved_out', measureCode: 'mark_moved_out' } }, explanationValidity: { status: 'unknown', reasons: ['no_evidence_baseline'] },
    })
    expect(assessments.find(a => a.titleCode === 'little_giant' && a.direction === 'missing_in_miit')).toMatchObject({
      enterpriseId, assessment: 'not_queried', queryCoverage: { status: 'not_queried', sources: [] }, currentDecision: { versionId: null, current: null }, explanationValidity: { status: 'not_applicable', reasons: [] },
    })
  })

  it('没有这个企业 ⇒ 404;id 不是数字 ⇒ 400', async () => {
    routerParam = '999999'
    await expect(handlerDetail({})).rejects.toThrowError(/not found/)
    routerParam = 'abc'
    expect(() => handlerDetail({})).toThrowError(/invalid id/)
    routerParam = undefined
  })
})

describe('GET /api/roster/differences(契约 §7.3)', () => {
  it('不筛 = 当前差异 ∪ 已存下来的解释,带 counts / total / 分页', async () => {
    query = {}
    const out = await handlerDifferences({})
    expect(Object.keys(out).sort()).toEqual(['counts', 'page', 'pageSize', 'rows', 'total'])
    expect(out.total).toBe(out.rows.length)
    expect(out.page).toBe(1)
    expect(out.pageSize).toBe(50)
    // 三条坐标:
    //  ① 只有工信部一侧的企业 × 专精特新 × 平台多出(确有差异 + 已确认解释);
    //  ② 只有工信部一侧的企业 × 创新型 × 平台多出(确有差异,**没有**解释 ⇒ 未查询);
    //  ③ 两侧都有的企业 × 专精特新 × 平台多出(**已不是差异**,但解释不丢,仍可查)。
    expect(out.rows.map((r) => `${r.enterpriseId}|${r.titleCode}|${r.direction}`).sort()).toEqual(
      [
        `${sideOnlyId}|specialized_sme|extra_in_miit`,
        `${emptyId}|innovative_sme|extra_in_miit`,
        `${enterpriseId}|specialized_sme|extra_in_miit`,
      ].sort(),
    )
    const stale = out.rows.find((r) => r.enterpriseId === enterpriseId)!
    expect(stale.inCurrentDifference).toBe(false)
    expect(stale.explanationId).not.toBeNull()
    expect(out.rows.find((r) => r.enterpriseId === emptyId)!.inCurrentDifference).toBe(true)
    expect(out.counts.specialized_sme).toEqual({ missing_in_miit: 0, extra_in_miit: 2 })
    expect(out.counts.innovative_sme).toEqual({ missing_in_miit: 0, extra_in_miit: 1 })
  })

  it('title / direction / status / reason 都能筛', async () => {
    query = { title: 'specialized_sme', direction: 'extra_in_miit' }
    expect((await handlerDifferences({})).rows).toHaveLength(2)
    query = { direction: 'missing_in_miit' }
    expect((await handlerDifferences({})).rows).toEqual([])
    query = { status: 'confirmed_reason' }
    expect((await handlerDifferences({})).rows.map((r) => r.enterpriseId).sort()).toEqual([enterpriseId, sideOnlyId].sort())
    query = { status: 'not_queried' }
    expect((await handlerDifferences({})).rows.map((r) => r.enterpriseId)).toEqual([emptyId])
    query = { status: 'confirmed_reason', reason: 'moved_out' }
    expect((await handlerDifferences({})).rows).toHaveLength(2)
    query = { reason: 'deregistered' }
    expect((await handlerDifferences({})).rows).toEqual([])
    query = {}
  })

  it('筛选后的 counts 同步收窄(不报全库口径)', async () => {
    query = { status: 'not_queried' }
    const out = await handlerDifferences({})
    expect(out.counts.specialized_sme).toEqual({ missing_in_miit: 0, extra_in_miit: 0 })
    expect(out.counts.innovative_sme).toEqual({ missing_in_miit: 0, extra_in_miit: 1 })
    query = {}
  })

  it('分页只截返回行,不动 total', async () => {
    query = { pageSize: '1', page: '2' }
    const out = await handlerDifferences({})
    expect(out.rows).toHaveLength(1)
    expect(out.total).toBe(3)
    query = {}
  })

  it('非法筛值 ⇒ 400', () => {
    query = { direction: 'sideways' }
    expect(() => handlerDifferences({})).toThrowError(/direction/)
    query = { status: 'whatever' }
    expect(() => handlerDifferences({})).toThrowError(/status/)
    query = { reason: 'whatever' }
    expect(() => handlerDifferences({})).toThrowError(/reason/)
    query = { title: 'whatever' }
    expect(() => handlerDifferences({})).toThrowError(/title/)
    query = {}
  })
})

describe('GET /api/roster/export(总表导出)', () => {
  it('serves filtered and empty enterprise workbooks over HTTP without page truncation', async () => {
    for (const [search, expectedRows, count] of [
      ['title=innovative_sme&pageSize=1&page=9', 3, 1],
      ['rosterState=removed_platform_only', 2, 0],
      ['q=不存在的企业', 2, 0],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/roster/export?${encodeURI(search)}`)
      expect(response.status).toBe(200)
      const sheet = (await readExportWorkbook(new Uint8Array(await response.arrayBuffer()))).worksheets[0]!
      expect(sheet.rowCount).toBe(expectedRows)
      expect(sheet.getCell('A1').text).toContain(`${count} 家企业`)
      expect(sheet.getCell('A2').value).toBe('企业名称')
    }
  })
  it('serves enterprise HTTP bytes with count grain text types recognition wrapping and validation intact', async () => {
    const response = await fetch(`${baseUrl}/api/roster/export?page=9&pageSize=1`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="roster-enterprises.xlsx"; filename*=UTF-8''${encodeURIComponent('企业总表-3家.xlsx')}`)
    const workbook = await readExportWorkbook(new Uint8Array(await response.arrayBuffer()))
    const sheet = workbook.worksheets[0]!
    expect(sheet.name).toBe('企业总表')
    expect(sheet.rowCount).toBe(5)
    expect(sheet.getCell('A1').text).toContain('3 家企业,合计 3 个「企业 × 称号」')
    expect(sheet.getRow(2).values).toEqual([undefined, '企业名称', '统一社会信用代码', '区县', '城市', '登记状态', '当前总表状态', '称号(一行一家企业,多称号用、分隔)', '曾用名(已确认)', '首次认定', '首次认定出处', '下次复核'])
    const row = [3, 4, 5].find((number) => sheet.getRow(number).getCell(2).value === USCC)!
    expect(row).toBeDefined()
    expect(sheet.getRow(row).getCell(2).type).toBe(ExcelJS.ValueType.String)
    expect(sheet.getRow(row).getCell(9).text).toContain('2021')
    expect(sheet.getRow(row).getCell(10).text).toContain('待确认')
    for (const column of [9, 10]) {
      expect(sheet.getColumn(column).alignment).toEqual({ wrapText: true, vertical: 'top' })
      expect(sheet.getRow(row).getCell(column).alignment).toEqual({ wrapText: true, vertical: 'top' })
    }
    expect(sheet.getColumn(10).width).toBe(60)
    const invalid = await fetch(`${baseUrl}/api/roster/export?title=nope`)
    expect(invalid.status).toBe(400)
    expect((await invalid.json()).statusMessage).toContain('Unknown title')
    expect(invalid.headers.get('content-disposition')).toBeNull()
  })
  async function exported(params: Record<string, unknown>) {
    query = params
    headers = {}
    const result = await handlerExport({})
    const bytes = result instanceof Readable ? await Array.fromAsync(result).then(Buffer.concat) : result
    const wb = await readExportWorkbook(bytes)
    return wb.worksheets[0]!
  }

  it('一行 = 一家企业:称号在单元格内用、分隔,不拆成多行', async () => {
    const ws = await exported({})
    // 第 1 行是口径说明,第 2 行是表头,第 3 行起是数据。
    expect(String(ws.getRow(1).getCell(1).value)).toContain('一行 = 一家企业')
    expect(String(ws.getRow(1).getCell(1).value)).toContain('3 家企业')
    expect(String(ws.getRow(1).getCell(1).value)).toContain('3 个「企业 × 称号」')
    expect(ws.getRow(2).getCell(1).value).toBe('企业名称')
    expect(ws.rowCount).toBe(5) // 说明 + 表头 + 3 家企业
    const names = [3, 4, 5].map((r) => ws.getRow(r).getCell(1).value)
    expect(names).toContain('宁波接口测试股份有限公司')
  })

  it('导出**不受分页截断**(页面只给一页,导出给当前筛选的全部)', async () => {
    const ws = await exported({ pageSize: '1', page: '1' })
    expect(ws.rowCount).toBe(5)
  })

  it('与总表同筛选:title / rosterState 生效,非法值 400', async () => {
    const only = await exported({ title: 'innovative_sme' })
    expect(only.rowCount).toBe(3) // 说明 + 表头 + 1 家
    expect(String(only.getRow(1).getCell(1).value)).toContain('1 家企业')
    const none = await exported({ rosterState: 'removed_platform_only' })
    expect(none.rowCount).toBe(2) // 说明 + 表头,零数据行
    query = { title: 'nope' }
    await expect(handlerExport({})).rejects.toMatchObject({ statusCode: 400 })
    query = {}
  })

  it('文件名带企业数,并写明单位', async () => {
    await exported({})
    expect(decodeURIComponent(headers['content-disposition']!)).toContain('企业总表-3家.xlsx')
  })
})
