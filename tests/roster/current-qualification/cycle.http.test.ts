import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { initializeDb, schema as s } from '../../../db/client'
import { enterpriseReads } from '../../../server/utils/enterprise-read'
import { writeCurrentWorkbook } from '../../../lib/roster/current-workbook'
import { createCurrentCandidateReader } from '../../../lib/roster/current-qualification'
import { qualificationCasesR4 } from '../../fixtures/current-qualification-r4'
import { qualificationCasesR5 } from '../../fixtures/current-qualification-r5'

const active = vi.hoisted(() => ({ db: null as ReturnType<typeof initializeDb> | null }))
vi.mock('@db', () => ({ useDb: () => active.db }))
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
const dir = mkdtempSync(join(tmpdir(), 'issue305-cycles-'))
const db = initializeDb({ create: true,  dbPath: join(dir, 'issue305.sqlite') }); active.db = db
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
let server: ReturnType<typeof createServer>, base: string
let recordsTool: any, currentTool: any
const ids = new Map<string, number>()
beforeAll(async () => {
  for (const [key, value] of Object.entries(h3)) vi.stubGlobal(key, value)
  vi.stubGlobal('useRuntimeConfig', () => ({ filesDir: dir }))
  for (const title of titles) for (const c of cases) {
    const name = `issue305-${title}-${c.id}`
    const enterprise = db.insert(s.enterprise).values({ name, nameNorm: name, usccNorm: name, city: '宁波市' }).returning().get()
    ids.set(name, enterprise.id)
    const record = db.insert(s.record).values({ enterpriseId: enterprise.id, titleCode: title, source: 'jxj', nameRaw: name }).returning().get()
    for (const input of c.events) {
      const event = db.insert(s.recordEvent).values({ recordId: record.id, ...input }).returning().get()
      db.insert(s.recordEvidence).values({ recordEventId: event.id, sourceFile: 'issue305/synthetic.pdf', attachment: c.id, listNo: event.id, page: 1 }).run()
    }
  }
  const records = (await import('../../../server/api/records.get')).default
  const current = (await import('../../../server/api/roster/current-enterprises.get')).default
  const detail = (await import('../../../server/api/roster/enterprises/[id].get')).default
  recordsTool = (await import('../../../server/mcp/tools/query_records')).default
  currentTool = (await import('../../../server/mcp/tools/list_current_qualified_enterprises')).default
  server = createServer(h3.toNodeListener(h3.createApp().use(h3.createRouter()
    .get('/api/records', records).get('/api/roster/current-enterprises', current).get('/api/roster/enterprises/:id', detail))))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await enterpriseReads.close(); db.$client.close(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true })
})
async function get(path: string) {
  const response = await fetch(base + path); expect(response.status).toBe(200); return response.json()
}

it('keeps failed-pass, cross-batch and unknown facts out of a definite review plan over HTTP and MCP', async () => {
  for (const title of titles) {
    const rest = await get('/api/records?' + new URLSearchParams({ title, pageSize: '200' }))
    const mcp = await recordsTool.handler({ title: [title], pageSize: 200 })
    expect(rest.rows).toHaveLength(cases.length)
    for (const c of cases) {
      const name = `issue305-${title}-${c.id}`
      for (const rows of [rest.rows, mcp.rows]) {
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
    const mcp = JSON.parse(await currentTool.handler({ titleCode: title, pageSize: 200 }))
    const currentEligible = ['failed-pass', 'reaward', 'cross-batch', 'missing-result', 'missing-date', 'missing-batch', 'unknown-origin', 'passed']
    const expected = cases.filter(c => currentEligible.includes(c.id)).map(c => ids.get(`issue305-${title}-${c.id}`)).sort((a, b) => a! - b!)
    expect(rest.rows.map((r: any) => r.enterpriseId)).toEqual(expected)
    expect(mcp.rows.map((r: any) => r.enterpriseId)).toEqual(expected)
    const file = join(dir, `issue305-${title}.xlsx`)
    const result = await writeCurrentWorkbook(db.$client, title, file, () => {})
    expect(result.counts).toEqual({ eligible: 8, pending: 0, excluded: 3 })
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file)
    expect(wb.worksheets.map(sheet => sheet.name)).toEqual(['有效企业', '已到期', '已注销（吊销）', '已迁出', '未认定', '口径说明'])
    for (const sheet of ['有效企业', '已到期', '已注销（吊销）', '已迁出', '未认定']) {
      const names: unknown[] = []
      wb.getWorksheet(sheet)!.eachRow((row, index) => { if (index > 1) names.push(row.getCell(2).value) })
      const selected = sheet === '有效企业' ? cases.filter(c => currentEligible.includes(c.id))
        : sheet === '已到期' ? cases.filter(c => !currentEligible.includes(c.id)) : []
      expect(names.sort()).toEqual(selected.map(c => `issue305-${title}-${c.id}`).sort())
    }
    const recovered = wb.getWorksheet('有效企业')!.getRows(2, 8)!.find(row => row.getCell(2).value === `issue305-${title}-failed-pass`)!
    expect(recovered.getCell(7).text).toContain('2023')
    expect(recovered.getCell(7).text).toContain('2024')
    expect(recovered.getCell(13).text).toBe('有效企业')
  }
}, 30000)

it('preserves the existing R4 and R5 qualification decisions with real SQLite facts', () => {
  const year = new Date().getFullYear()
  const expectedGroup = { 有效企业: 'eligible', 待确认: 'pending', 排除明细: 'excluded' }
  for (const title of titles) for (const c of [...qualificationCasesR4(year), ...qualificationCasesR5(year)]) {
    const name = `issue305-history-${title}-${c.id}`
    const enterprise = db.insert(s.enterprise).values({ name, nameNorm: name, usccNorm: name, city: '宁波市' }).returning().get()
    const record = db.insert(s.record).values({ enterpriseId: enterprise.id, titleCode: title, source: 'jxj', nameRaw: name }).returning().get()
    for (const [index, input] of c.events.entries()) {
      const event = db.insert(s.recordEvent).values({ recordId: record.id, ...input }).returning().get()
      if (!c.missing?.includes(index)) db.insert(s.recordEvidence).values({ recordEventId: event.id, sourceFile: 'issue305/historical.pdf', attachment: c.id, listNo: event.id, page: 1 }).run()
    }
    // R4/R5 are the frozen historical contract, rather than the default current consumer.
    const actual = createCurrentCandidateReader(db.$client)(enterprise.id, title, year, Date.now(), undefined, false, true, { assessmentVersion: 'enterprise-qualification-407-v1' })
    expect.soft(actual.group, name).toBe(expectedGroup[c.sheet])
    expect.soft(actual.firstYear, name).toBe(c.first)
    if (c.note) expect.soft(actual.notes.join('\n'), name).toContain(c.note)
  }
})
