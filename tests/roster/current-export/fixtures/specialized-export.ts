import { captureDiscovery, readDiscoveryArtifact } from '../../../support/development-discovery.mjs'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { normalizeUscc } from '../../../../layers/sme-roster/lib/domain'
import { CURRENT_RULE_VERSION } from '../../../../layers/sme-roster/lib/roster/current-qualification-model'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import pg from 'pg'
import { expect } from 'vitest'
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { singlePostgresFixtureRow as single } from '../../../support/isolated-postgres-cases'
import * as s from '../../fixtures/postgres-tables'
import { nativeAppAdapter } from '../../../support/native-app'

export const titleCode = 'specialized_sme'
export const route = '/api/roster/exports/current/specialized-sme'
export const year = new Date().getFullYear()
export type Event = { eventType: 'award'|'review'|'nurture'|'maintain'; year: number|null; decidedYear?: number|null; reviewOutcome?: 'passed'|'failed'|null; batchSeq?: number|null }
export const fresh: Event[] = [{ eventType: 'award', year, batchSeq: 1 }]
export const businessTables = [
  'enterprise', 'enterprise_alias', 'enterprise_fact_revision', 'record', 'record_event', 'record_evidence',
  'difference_reason', 'platform_collection', 'platform_collection_page',
  'platform_query_title_scope', 'platform_business_record', 'platform_business_record_version',
  'platform_business_observation', 'platform_observation_assignment', 'platform_apply_projection',
  'platform_business_projection', 'platform_recognized_projection', 'platform_export_batch', 'platform_export_row',
]

// Synthetic setup only; callers choose real Nitro HTTP or the native workbook writer.
export function specializedExportFixture({ preserveSyntheticUscc = false } = {}) {
  const dir = mkdtempSync(join(process.env.CURRENT_CANDIDATE_READER_EVIDENCE_DIR ?? tmpdir(), 'export-118-'))
  const token = 'synthetic-export-118-token'
  const app = nativeAppAdapter({ dir, token })
  const { headers, url, terminal, prepare } = app
  let starting: Promise<void> | undefined
  function start() { return starting ??= app.start() }
  async function resetBusiness() {
    await starting?.catch(() => {})
    await app.resetBusiness()
    starting = undefined
    await prepare()
  }
  const json = (response: Response): Promise<any> => response.json()
  const submit = async (key: string, extra = {}) => {
    await start()
    return app.request(route, { method: 'POST', body: JSON.stringify({ clientRequestId: key, ...extra }) })
  }
  async function runtimeQuery(statement: string, values: unknown[]) {
    if (!app.postgresUrl) throw new Error('PostgreSQL export fixture has not started')
    const client = new pg.Client({ connectionString: app.postgresUrl })
    await client.connect()
    try { return await client.query(statement, values) }
    finally { await client.end() }
  }
  async function download(job: any) {
    const { response, bytes } = await app.download(job.result.artifact.downloadUrl)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="current-${job.params.titleCode}.xlsx"`)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(bytes as any)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(job.result.artifact.sha256)
    expect(job.result.artifact.size).toBe(bytes.length)
    return { wb, bytes, response }
  }
  async function workbook(key: string, extra = {}) {
    const response = await submit(key, extra); expect(response.status).toBe(202)
    const accepted = await json(response)
    expect(accepted.kind).toBe('current-roster-export')
    expect(response.headers.get('location')).toBe('/api/jobs/' + accepted.jobId)
    const job = await terminal(accepted.jobId); expect(job.state,JSON.stringify(job)).toBe('done')
    expect(job.params.titleCode).toBe(titleCode)
    return { job, ...await download(job) }
  }
  async function candidate(name: string, events = fresh, title = titleCode) {
    await prepare()
    const code = 'SYNTHETIC-118-' + name
    const enterprise = single(await app.db.insert(s.enterprise).values({
      name, nameNorm: name, usccNorm: preserveSyntheticUscc ? code : normalizeUscc(code), district: '鄞州区', city: '宁波市',
    }).returning())
    const record = await addRecord(enterprise.id, name, events, title)
    return { enterprise, record }
  }
  async function addRecord(enterpriseId: number, name: string, events = fresh, title = titleCode) {
    const record = single(await app.db.insert(s.record).values({ enterpriseId, source: 'jxj', titleCode: title, nameRaw: name }).returning())
    for (const item of events) {
      const event = single(await app.db.insert(s.recordEvent).values({ recordId: record.id, ...item }).returning())
      await app.db.insert(s.recordEvidence).values({
        recordEventId: event.id, sourceFile: 'jxj/announcement/synthetic-118.xlsx', attachment: '专精特新中小企业名单', listNo: enterpriseId,
      })
    }
    return record
  }
  async function decision(enterpriseId: number, reasonCode: NonNullable<typeof s.differenceReason.$inferInsert.reasonCode>, extra: Partial<typeof s.differenceReason.$inferInsert> = {}) {
    const now = new Date().toISOString()
    const input: typeof s.differenceReason.$inferInsert = {
      enterpriseId, titleCode, direction: 'extra_in_miit', status: 'confirmed_reason', reasonCode, verificationStatus: 'confirmed',
      lifecycleAction: 'replace', basis: '人工确认合成主体事实', effectiveAt: '2025-01-01T00:00:00Z',
      createdAt: now, recordedAt: now, ...extra,
    }
    if (input.lifecycleAction === 'replace' && input.basis && input.effectiveAt && !input.evidenceQueryId && !input.evidenceRelationId) {
      input.retiredEvidenceValidity = 'valid'
      input.retiredEvidenceReviewed = true
    }
    return single(await app.db.insert(s.differenceReason).values(input).returning())
  }
  async function businessDigest() {
    const contents = await runtimeBusinessRows(businessTables)
    return createHash('sha256').update(JSON.stringify(contents)).digest('hex')
  }
  async function runtimeBusinessRows(tables: readonly string[]) {
    if (!app.postgresUrl) throw new Error('PostgreSQL fixture is not running')
    const client = new pg.Client({ connectionString: app.postgresUrl })
    await client.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const result: unknown[][] = []
      for (const table of tables) {
        if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid fixture table')
        const rows = await client.query(`SELECT to_jsonb(t) AS content FROM business.${table} t ORDER BY to_jsonb(t)::text COLLATE "C"`)
        result.push(rows.rows.map(row => row.content))
      }
      await client.query('COMMIT')
      return result
    } finally { await client.end() }
  }
  return { dir, get processId() { return app.processId }, get exportsDir() { return app.exportsDir }, get postgresUrl() { return app.postgresUrl }, get db() { return app.db }, headers, token, url, json, submit, start, prepare, terminal, download, workbook, candidate, addRecord, decision, resetBusiness, businessDigest, runtimeQuery, runtimeBusinessRows,
    async close() {
      try { await starting?.catch(() => {}); await app.close() }
      finally { if (!process.env.CURRENT_CANDIDATE_READER_EVIDENCE_DIR) rmSync(dir,{recursive:true,force:true}) }
    },
  }
}
export function rows(wb: ExcelJS.Workbook, sheet: string) {
  const target = wb.getWorksheet(sheet)!
  return target.getRows(2,Math.max(0,target.rowCount-1))?.map(row => row.values as any[]) ?? []
}
export function businessIdentity(row: any[]) { return [row[2], row[3]] }
export async function expectedBusinessIdentity(db: NodePgDatabase, id: number) {
  const row = single(await db.select({ name: s.enterprise.name, uscc: s.enterprise.usccNorm }).from(s.enterprise).where(eq(s.enterprise.id, id)))
  return [row.name, row.uscc]
}
export const currentSheetNames = ['有效企业','已到期','已注销（吊销）','已迁出','未认定','口径说明']
export const currentStatusSheets = [['有效企业','effective'],['已到期','expired'],['已注销（吊销）','terminated'],['已迁出','moved_out'],['未认定','unrecognized']] as const
export function expectCounts(wb: ExcelJS.Workbook, job: any, counts: {eligible:number;pending:number;excluded:number}, expectedStatusCounts?: {effective:number;expired:number;terminated:number;moved_out:number;unrecognized:number}) {
  expect(wb.worksheets.map(sheet => sheet.name)).toEqual(currentSheetNames)
  expect(job.result.counts).toEqual(counts)
  expect(counts.pending).toBe(0)
  expect(job.result.total).toBe(counts.eligible + counts.excluded)
  if (expectedStatusCounts) expect(job.result.statusCounts).toEqual(expectedStatusCounts)
  const notes = Object.fromEntries(rows(wb,'口径说明').map(row => [row[1],row[2]]))
  for (const [sheet,key] of currentStatusSheets) {
    expect(rows(wb,sheet)).toHaveLength(job.result.statusCounts[key]); expect(notes[sheet]).toBe(String(job.result.statusCounts[key]))
    expect(rows(wb,sheet).every(row => row[5] === '专精特新中小企业')).toBe(true)
  }
  expect(job.result.statusCounts.effective).toBe(counts.eligible)
  expect(Object.values(job.result.statusCounts).reduce((sum:number,count:any) => sum + count,0)).toBe(job.result.total)
  expect(notes['规则版本']).toBeUndefined()
  expect(notes['数据版本']).toBeUndefined()
  expect(job.result.ruleVersion).toBe(CURRENT_RULE_VERSION)
  expect(job.result.dataVersion).toMatch(/^sha256:/)
  expect(notes['范围']).toContain('未实时采集，不证明全市完整')
}

// Capture real development discovery separately from compiled business requests.
let discoveryPromise: Promise<any> | undefined
export function readDevelopmentDiscovery() {
  return discoveryPromise ??= process.env.TEST_DISCOVERY_ARTIFACT
    ? Promise.resolve(readDiscoveryArtifact(process.env.TEST_DISCOVERY_ARTIFACT))
    : captureDevelopmentDiscovery()
}
async function captureDevelopmentDiscovery() {
  // Single-worker files share only immutable discovery JSON for this runner.
  // Process start time prevents reuse after a PID is recycled.
  const owner = execFileSync('ps', ['-p', String(process.ppid), '-o', 'lstart='], { encoding: 'utf8' })
  const key = createHash('sha256').update(process.cwd() + execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() + process.ppid + owner).digest('hex')
  const cache = join(tmpdir(), `native-discovery-${key}.json`)
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'))
  const spec = (await captureDiscovery()).spec
  const pending = cache + `.${process.pid}`
  writeFileSync(pending, JSON.stringify(spec)); renameSync(pending, cache)
  return spec
}
