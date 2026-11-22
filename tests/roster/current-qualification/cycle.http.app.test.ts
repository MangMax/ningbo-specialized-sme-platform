import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, expect, it } from 'vitest'
import * as s from '../fixtures/postgres-tables'
import { nativeAppAdapter } from '../../support/native-app'
import { eq } from 'drizzle-orm'
import { writePostgresCurrentWorkbook } from '../../../layers/sme-roster/lib/roster/current-workbook-postgres'

const dir = mkdtempSync(join(tmpdir(), 'issue305-cycles-'))
const app = nativeAppAdapter({ dir, token: 'synthetic-cycle-token' })
let db: typeof app.db
const titles = ['little_giant', 'specialized_sme', 'innovative_sme'] as const
type Event = { eventType: 'award' | 'review'; year: number | null; decidedYear: number | null; batchSeq: number | null; reviewOutcome?: 'passed' | 'failed' | null }
const award = (year: number, batchSeq = 1): Event => ({ eventType: 'award', year, decidedYear: year, batchSeq })
const review = (year: number | null, decidedYear: number | null, reviewOutcome: Event['reviewOutcome'], batchSeq: number | null = 1): Event => ({ eventType: 'review', year, decidedYear, reviewOutcome, batchSeq })
const currentYear = new Date().getFullYear()
// Literal business expectations, independent of production adjudication.
const cases = [
  { id: 'failed-pass', events: [award(2020), review(2020, 2023, 'failed'), review(2020, 2024, 'passed')], sheet: '待确认', due: null },
  { id: 'reaward', events: [award(2020), review(2020, 2023, 'failed'), award(currentYear - 1)], sheet: '有效企业', due: currentYear + 2 },
  { id: 'cross-batch', events: [award(currentYear - 2), review(currentYear - 2, currentYear - 1, 'failed'), award(currentYear - 2, 2), review(currentYear - 2, currentYear, 'passed', 2)], sheet: '待确认', due: null },
  { id: 'missing-result', events: [award(currentYear - 2), review(currentYear - 2, currentYear - 1, null)], sheet: '待确认', due: null },
  { id: 'missing-date', events: [award(currentYear - 2), review(currentYear - 2, null, 'passed')], sheet: '待确认', due: null },
  { id: 'missing-batch', events: [award(currentYear - 2), review(currentYear - 2, currentYear - 1, 'passed', null)], sheet: '待确认', due: null },
  { id: 'unknown-origin', events: [award(currentYear - 2), review(null, currentYear - 1, 'passed')], sheet: '待确认', due: null },
  { id: 'same-year-reaward', events: [award(2020), review(2020, currentYear - 1, 'failed'), award(currentYear - 1)], sheet: '待确认', due: null },
  { id: 'terminated', events: [award(2020), review(2020, 2023, 'failed')], sheet: '排除明细', due: null },
  { id: 'passed', events: [award(2020), review(2020, currentYear - 2, 'passed')], sheet: '有效企业', due: currentYear + 1 },
  { id: 'overdue-plan', events: [award(2020)], sheet: '待确认', due: 2023 },
] as const
const base = app.url
const ids = new Map<string, number>()
beforeAll(async () => {
  await app.prepare()
  db = app.db
  for (const title of titles) for (const c of cases) {
    const name = `issue305-${title}-${c.id}`
    const enterprise = (await db.insert(s.enterprise).values({ name, nameNorm: name, usccNorm: name, city: '宁波市' }).returning())[0]!
    ids.set(name, enterprise.id)
    const record = (await db.insert(s.record).values({ enterpriseId: enterprise.id, titleCode: title, source: 'jxj', nameRaw: name }).returning())[0]!
    for (const input of c.events) {
      const event = (await db.insert(s.recordEvent).values({ recordId: record.id, ...input }).returning())[0]!
      await db.insert(s.recordEvidence).values({ recordEventId: event.id, sourceFile: 'issue305/synthetic.pdf', attachment: c.id, listNo: event.id, page: 1 })
    }
  }
  await app.start()
}, 90000)
afterAll(async () => {
  try { await app.close() } finally { rmSync(dir, { recursive: true, force: true }) }
})
async function mcp(name: string, args: object) {
  const response = await fetch(base('/mcp'), {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  expect(response.status).toBe(200)
  const raw = await response.text()
  const wire = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  return wire.result.structuredContent ?? JSON.parse(wire.result.content[0].text)
}
async function get(path: string) {
  const response = await fetch(base(path)); expect(response.status, await response.clone().text()).toBe(200); return response.json()
}

it('keeps failed-pass, cross-batch and unknown facts out of a definite review plan over HTTP and MCP', async () => {
  for (const title of titles) {
    const rest = await get('/api/records?' + new URLSearchParams({ title, pageSize: '200' }))
    const tools = await mcp('query_records', { title: [title], pageSize: 200 })
    expect(rest.rows).toHaveLength(cases.length)
    for (const c of cases) {
      const name = `issue305-${title}-${c.id}`
      for (const rows of [rest.rows, tools.rows]) {
        const row = rows.find((r: any) => r.name === name)
        expect.soft(row.lifecycle.dueYear, name).toBe(c.due)
        expect(row.lifecycle.firstRecognitionYear, name).toBe(c.events[0].year)
        expect(row.events.map((e: any) => [e.type, e.year, e.decidedYear, e.batchSeq, e.reviewOutcome])).toEqual(
          c.events.map(e => [e.eventType, e.year, e.decidedYear, e.batchSeq, e.reviewOutcome ?? null]))
        expect(row.events.every((e: any) => e.id > 0 && e.evidence[0]?.sourceFile === 'issue305/synthetic.pdf')).toBe(true)
        if (c.sheet === '待确认' && c.id !== 'overdue-plan') {
          expect.soft(row.lifecycle.status, name).toBe('needs_review')
          expect(row.lifecycle).toMatchObject({ state: 'none', needsReview: true })
        }
        if (c.id === 'overdue-plan') expect(row.lifecycle).toMatchObject({ state: 'active', needsReview: false, dueYear: 2023 })
        if (c.id === 'terminated') expect(row.lifecycle.state).toBe('terminated')
      }
    }
    const due = await get('/api/records?' + new URLSearchParams({ title, dueYear: String(currentYear + 1), pageSize: '200' }))
    expect.soft(due.rows.map((r: any) => r.name)).toEqual([`issue305-${title}-passed`])
    const failedId = ids.get(`issue305-${title}-failed-pass`)!
    const detail = await get('/api/roster/enterprises/' + failedId)
    expect.soft(detail.records[0].lifecycle.dueYear).toBeNull()
    expect.soft(detail.records[0].lifecycle.needsReview).toBe(true)
  }
})

it('keeps current HTTP and MCP qualification equal to the five current status XLSX partitions', async () => {
  for (const title of titles) {
    const rest = await get('/api/roster/current-enterprises?' + new URLSearchParams({ titleCode: title, pageSize: '200' }))
    const tools = await mcp('list_current_qualified_enterprises', { titleCode: title, pageSize: 200 })
    // Failed-pass cannot revive the original cycle; the distinct new award survives.
    const currentEligible = ['reaward', 'cross-batch', 'missing-result', 'missing-date', 'missing-batch', 'unknown-origin', 'same-year-reaward', 'passed', 'overdue-plan']
    const supportingTitles = title === 'little_giant' ? ['little_giant'] : title === 'specialized_sme' ? ['little_giant', 'specialized_sme'] : [...titles]
    // #739 changes giant cycles only; province/innovative retain their own review rules.
    const ownEligible = (t: string) => t === 'little_giant' ? currentEligible : ['failed-pass', 'reaward', 'cross-batch', 'missing-result', 'missing-date', 'missing-batch', 'unknown-origin', 'passed']
    const expectedNames = supportingTitles.flatMap(t => ownEligible(t).map(id => `issue305-${t}-${id}`))
    const expected = expectedNames.map(name => ids.get(name)).sort((a, b) => a! - b!)
    expect(rest.rows.map((r: any) => r.enterpriseId)).toEqual(expected)
    expect(tools.rows.map((r: any) => r.enterpriseId)).toEqual(expected)
    const file = join(dir, `issue305-${title}.xlsx`)
    const result = await writePostgresCurrentWorkbook(db, title, file, () => {})
    expect(result.counts).toEqual({ eligible: expectedNames.length, pending: 0, excluded: 11 * supportingTitles.length - expectedNames.length })
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file)
    expect(wb.worksheets.map(sheet => sheet.name)).toEqual(['有效企业', '已到期', '已注销（吊销）', '已迁出', '未认定', '口径说明'])
    for (const sheet of ['有效企业', '已到期', '已注销（吊销）', '已迁出', '未认定']) {
      const names: unknown[] = []
      wb.getWorksheet(sheet)!.eachRow((row, index) => { if (index > 1) names.push(row.getCell(2).value) })
      const expectedSheet = sheet === '有效企业' ? expectedNames
        : sheet === '已到期' ? (title === 'little_giant' ? ['failed-pass', 'terminated'] : ['same-year-reaward', 'terminated', 'overdue-plan']).map(id => `issue305-${title}-${id}`)
        : sheet === '未认定' ? supportingTitles.filter(t => t !== title).flatMap(t => (t === 'little_giant' ? ['failed-pass', 'terminated'] : ['same-year-reaward', 'terminated', 'overdue-plan']).map(id => `issue305-${t}-${id}`)) : []
      expect(names.sort()).toEqual(expectedSheet.sort())
    }
    const expired = wb.getWorksheet(title === 'little_giant' ? '已到期' : '有效企业')!.getRows(2, expectedNames.length)!.find(row => row.getCell(2).value === `issue305-${title}-failed-pass`)!
    expect(expired.getCell(7).text).toContain('2023')
    expect(expired.getCell(7).text).toContain('2024')
    expect(expired.getCell(13).text).toBe(title === 'little_giant' ? '已到期' : '有效企业')
  }
}, 90000)

it('retains an old giant award but honors a complete source bound formal interval over HTTP MCP and XLSX', async () => {
  const controls = [
    { id: 'retained-without-interval', through: null, status: 'effective', sheet: '有效企业' },
    { id: 'sourced-current-interval', through: `${currentYear}-12-31`, status: 'effective', sheet: '有效企业' },
    { id: 'sourced-expired-interval', through: `${currentYear - 1}-12-31`, status: 'expired', sheet: '已到期' },
  ] as const
  const seeded = []
  for (const c of controls) {
    const name = `source-bound-giant-${c.id}`
    const enterprise = (await db.insert(s.enterprise).values({ name, nameNorm: name, usccNorm: name, city: '宁波市' }).returning())[0]!
    const record = (await db.insert(s.record).values({ enterpriseId: enterprise.id, titleCode: 'little_giant', source: 'jxj', nameRaw: name }).returning())[0]!
    const event = (await db.insert(s.recordEvent).values({ recordId: record.id, ...award(2020) }).returning())[0]!
    const file = (await db.insert(s.storedFile).values({ relPath: `${name}.pdf`, filename: `${name}.pdf`, ext: 'pdf', createdAt: '2026-01-01T00:00:00Z', sha256: 'a'.repeat(64), bytes: 1n }).returning())[0]!
    const evidence = (await db.insert(s.recordEvidence).values({ recordEventId: event.id, sourceFile: file.relPath, page: 2 }).returning())[0]!
    if (c.through) await db.update(s.recordEvent).set({ formalValidity: JSON.stringify({ evidenceId: evidence.id, sourceSha256: file.sha256, statementPages: [2], interval: { validFrom: '2020-01-01', validThrough: c.through } }) }).where(eq(s.recordEvent.id, event.id))
    seeded.push({ c, name, enterprise, file })
  }
  for (const { c, name, enterprise, file } of seeded) {
    const detail = await get(`/api/roster/enterprises/${enterprise.id}`)
    const giant = detail.qualificationAssessment.titles.find((t: any) => t.titleCode === 'little_giant')
    expect(giant).toMatchObject({ group: c.status === 'effective' ? 'eligible' : 'excluded', effectiveQualification: { status: c.status } })
    if (c.through) {
      const basis = giant.effectiveQualification.presentationBasis.join(' ')
      expect(basis).toContain(c.through)
      expect(basis).toContain(file.relPath)
      expect(basis).toContain('第 2 页')
    }
    const query = { titleCode: 'little_giant', status: c.status, pageSize: 200 }
    const http = await get('/api/roster/current-enterprises?' + new URLSearchParams({ ...query, pageSize: '200' }))
    const tools = await mcp('list_current_qualified_enterprises', query)
    for (const result of [http, tools]) expect(result.rows.filter((r: any) => r.uscc === name).map((r: any) => r.enterpriseId)).toEqual([enterprise.id])
    const path = join(dir, `${name}.xlsx`)
    await writePostgresCurrentWorkbook(db, 'little_giant', path, () => {})
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path)
    const appearances: string[] = []
    for (const sheet of wb.worksheets.slice(0, 5)) sheet.eachRow((row, index) => {
      if (index > 1 && row.getCell(3).text === name) appearances.push(sheet.name)
    })
    expect(appearances).toEqual([c.sheet])
  }
}, 30000)
