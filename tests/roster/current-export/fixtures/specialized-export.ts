import { captureDiscovery, readDiscoveryArtifact } from '../../../support/development-discovery.mjs'
import { resetExportRows } from './reset-rows'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { normalizeUscc } from '../../../../layers/sme-roster/lib/domain'
import { CURRENT_RULE_VERSION } from '../../../../layers/sme-roster/lib/roster/current-qualification'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { expect } from 'vitest'
import { reviewCurrentExportDecision } from '../../fixtures/qualification-decisions'
import { type initializeDb, schema as s } from '../../../../db/client'
import { nativeAppAdapter } from '../../../support/native-app'

export const titleCode = 'specialized_sme'
export const route = '/api/roster/exports/current/specialized-sme'
export const year = new Date().getFullYear()
export type Event = { eventType: 'award'|'review'|'nurture'|'maintain'; year: number|null; decidedYear?: number|null; reviewOutcome?: 'passed'|'failed'|null; batchSeq?: number|null }
export const fresh: Event[] = [{ eventType: 'award', year, batchSeq: 1 }]
export const businessTables = ['record_correspondence','difference_reason','platform_observation_assignment','platform_legacy_relation_alias','platform_business_observation','platform_legacy_query_alias','platform_collection','enterprise_alias','record_evidence','record_event','record','enterprise']

// Synthetic setup only; callers choose real Nitro HTTP or the native workbook writer.
export function specializedExportFixture() {
  const dir = mkdtempSync(join(process.env.CURRENT_CANDIDATE_READER_EVIDENCE_DIR ?? tmpdir(), 'export-118-'))
  const token = 'synthetic-export-118-token'
  const app = nativeAppAdapter({ dir, token })
  const { headers, url, terminal } = app
  let started = false
  async function start() { if (!started) { await app.start(); started = true } }
  async function resetBusiness() {
    if (!started) { await app.resetBusiness(); return }
    resetExportRows(app.db.$client)
  }
  const json = (response: Response): Promise<any> => response.json()
  const submit = (key: string, extra = {}) => app.request(route, { method: 'POST', body: JSON.stringify({ clientRequestId: key, ...extra }) })
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
  function candidate(name: string, events = fresh, title = titleCode) {
    const enterprise = app.db.insert(s.enterprise).values({ name, nameNorm:name, usccNorm:normalizeUscc('SYNTHETIC-118-' + name), district:'鄞州区', city:'宁波市' }).returning().get()
    const record = addRecord(enterprise.id, name, events, title)
    return { enterprise, record }
  }
  function addRecord(enterpriseId: number, name: string, events = fresh, title = titleCode) {
    const record = app.db.insert(s.record).values({ enterpriseId, source:'jxj', titleCode:title, nameRaw:name }).returning().get()
    for (const item of events) {
      const event = app.db.insert(s.recordEvent).values({ recordId:record.id, ...item }).returning().get()
      app.db.insert(s.recordEvidence).values({ recordEventId:event.id, sourceFile:'jxj/announcement/synthetic-118.xlsx', attachment:'专精特新中小企业名单', listNo:enterpriseId }).run()
    }
    return record
  }
  function decision(enterpriseId: number, reasonCode: 'moved_out'|'moved_in'|'deregistered'|'pending_review'|'other', extra: Record<string,unknown> = {}) {
    const decision = app.db.insert(s.differenceReason).values({ enterpriseId, titleCode, direction:'extra_in_miit', status:'confirmed_reason', reasonCode, verificationStatus:'confirmed', lifecycleAction:'replace', basis:'人工确认合成主体事实', effectiveAt:'2025-01-01T00:00:00Z', recordedAt:new Date().toISOString(), ...extra } as any).returning().get()
    reviewCurrentExportDecision(app.db,decision)
    return decision
  }
  function businessDigest() {
    const hash = createHash('sha256')
    for (const table of businessTables) for (const row of app.db.$client.prepare('select * from ' + table + ' order by rowid').iterate()) hash.update(JSON.stringify(row))
    for (const { name } of app.db.$client.prepare("select name from sqlite_master where type='table' and name like 'platform_%' order by name").all() as Array<{ name: string }>) {
      hash.update(name)
      for (const row of app.db.$client.prepare(`select * from "${name}" order by rowid`).iterate()) hash.update(JSON.stringify(row))
    }
    return hash.digest('hex')
  }
  return { dir, get processId() { return app.processId }, get dbPath() { return app.dbPath }, get db() { return app.db }, headers, token, url, json, submit, start, terminal, download, workbook, candidate, addRecord, decision, resetBusiness, businessDigest,
    async close() { try { await app.close() } finally { if (!process.env.CURRENT_CANDIDATE_READER_EVIDENCE_DIR) rmSync(dir,{recursive:true,force:true}) } },
  }
}
export function rows(wb: ExcelJS.Workbook, sheet: string) {
  const target = wb.getWorksheet(sheet)!
  return target.getRows(2,Math.max(0,target.rowCount-1))?.map(row => row.values as any[]) ?? []
}
export function businessIdentity(row: any[]) { return [row[2], row[3]] }
export function expectedBusinessIdentity(db: ReturnType<typeof initializeDb>, id: number) {
  const row = db.$client.prepare('select name,uscc_norm as uscc from enterprise where id=?').get(id) as {name:string;uscc:string|null}|undefined
  if (!row) throw new Error('missing synthetic enterprise ' + id)
  return [row.name,row.uscc]
}
export function matchesBusinessIdentity(db: ReturnType<typeof initializeDb>, row: any[], id: number) {
  return JSON.stringify(businessIdentity(row)) === JSON.stringify(expectedBusinessIdentity(db,id))
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
