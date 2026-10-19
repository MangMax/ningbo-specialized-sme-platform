import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { expect } from 'vitest'
import { useDb, schema as s } from '../../db/client'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../scripts/lib/isolated-local-services.mjs'

export const titleCode = 'specialized_sme'
export const route = '/api/roster/exports/current/specialized-sme'
export const year = new Date().getFullYear()
export type Event = { eventType: 'award'|'review'|'nurture'|'maintain'; year: number|null; decidedYear?: number|null; reviewOutcome?: 'passed'|'failed'|null; batchSeq?: number|null }
export const fresh: Event[] = [{ eventType: 'award', year, batchSeq: 1 }]
export const businessTables = ['record_correspondence','difference_reason','platform_relation','platform_query','enterprise_alias','record_evidence','record_event','record','enterprise']

// Synthetic setup only. All assertions on export behavior use actual Nitro HTTP and XLSX bytes.
export function currentExport118Fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'export-118-'))
  const dbPath = join(dir, 'synthetic.db'), db = useDb({ dbPath })
  const token = 'synthetic-export-118-token'
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
  let baseUrl = '', stop: (() => Promise<void>) | undefined
  const url = (path: string) => baseUrl + path
  const json = (response: Response): Promise<any> => response.json()
  const submit = (key: string, extra = {}) => fetch(url(route), { method: 'POST', headers, body: JSON.stringify({ clientRequestId: key, ...extra }) })
  async function start() {
    const cwd = resolve(import.meta.dirname, '../..'), port = await reserveLoopbackPort()
    const child = spawn(process.execPath, [join(cwd,'node_modules/nuxt/bin/nuxt.mjs'),'dev','--host','127.0.0.1','--port',String(port)], {
      cwd, stdio: ['ignore','pipe','pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir,'build'), NUXT_DB_PATH: dbPath, NUXT_API_TOKEN: token, NUXT_FILES_DIR: join(dir,'files'), NUXT_INCOMING_DIR: join(dir,'incoming') },
    })
    let output = ''
    for (const stream of [child.stdout,child.stderr]) stream.on('data', data => { output = (output + data).slice(-12000) })
    baseUrl = `http://127.0.0.1:${port}`; stop = () => stopOwnedChild(child)
    try { await waitForHttp(url('/api/jobs/kinds'), { timeoutMs: 60000, child }) }
    catch (error) { await stop(); throw new Error(String(error) + output) }
  }
  async function terminal(id: string) {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const response = await fetch(url('/api/jobs/' + id)); expect(response.status).toBe(200)
      const job = await json(response)
      if (['done','failed','cancelled'].includes(job.state)) return job
      await new Promise(resolve => setTimeout(resolve,30))
    }
    throw new Error('job did not finish: ' + id)
  }
  async function download(job: any) {
    const response = await fetch(url(job.result.artifact.downloadUrl), { headers })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="current-${job.params.titleCode}.xlsx"`)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const bytes = Buffer.from(await response.arrayBuffer()), wb = new ExcelJS.Workbook()
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
    const enterprise = db.insert(s.enterprise).values({ name, nameNorm:name, usccNorm:'SYNTHETIC-118-' + name, district:'鄞州区', city:'宁波市' }).returning().get()
    const record = addRecord(enterprise.id, name, events, title)
    return { enterprise, record }
  }
  function addRecord(enterpriseId: number, name: string, events = fresh, title = titleCode) {
    const record = db.insert(s.record).values({ enterpriseId, source:'jxj', titleCode:title, nameRaw:name }).returning().get()
    for (const item of events) {
      const event = db.insert(s.recordEvent).values({ recordId:record.id, ...item }).returning().get()
      db.insert(s.recordEvidence).values({ recordEventId:event.id, sourceFile:'jxj/announcement/synthetic-118.xlsx', attachment:'专精特新中小企业名单', listNo:enterpriseId }).run()
    }
    return record
  }
  function decision(enterpriseId: number, reasonCode: 'moved_out'|'moved_in'|'deregistered'|'pending_review'|'other', extra: Record<string,unknown> = {}) {
    return db.insert(s.differenceReason).values({ enterpriseId, titleCode, direction:'extra_in_miit', status:'confirmed_reason', reasonCode, verificationStatus:'confirmed', lifecycleAction:'replace', basis:'人工确认合成主体事实', effectiveAt:'2025-01-01T00:00:00Z', recordedAt:new Date().toISOString(), ...extra } as any).returning().get()
  }
  function resetBusiness() {
    db.$client.pragma('foreign_keys = OFF')
    try { db.$client.transaction(() => { for (const table of businessTables) db.$client.prepare('delete from ' + table).run() })() }
    finally { db.$client.pragma('foreign_keys = ON') }
  }
  function businessDigest() {
    const hash = createHash('sha256')
    for (const table of businessTables) for (const row of db.$client.prepare('select * from ' + table + ' order by id').iterate()) hash.update(JSON.stringify(row))
    return hash.digest('hex')
  }
  return { dir, dbPath, db, headers, token, url, json, submit, start, terminal, download, workbook, candidate, addRecord, decision, resetBusiness, businessDigest,
    async close() { try { await stop?.() } finally { db.$client.close(); rmSync(dir,{recursive:true,force:true}) } },
  }
}
export function rows(wb: ExcelJS.Workbook, sheet: string) {
  const target = wb.getWorksheet(sheet)!
  return target.getRows(2,Math.max(0,target.rowCount-1))?.map(row => row.values as any[]) ?? []
}
export function expectCounts(wb: ExcelJS.Workbook, job: any, counts: {eligible:number;pending:number;excluded:number}) {
  expect(wb.worksheets.map(sheet => sheet.name)).toEqual(['有效企业','待确认','排除明细','口径说明'])
  expect(job.result.counts).toEqual(counts)
  expect(job.result.total).toBe(counts.eligible + counts.pending + counts.excluded)
  const notes = Object.fromEntries(rows(wb,'口径说明').map(row => [row[1],row[2]]))
  for (const [sheet,key] of [['有效企业','eligible'],['待确认','pending'],['排除明细','excluded']] as const) {
    expect(rows(wb,sheet)).toHaveLength(counts[key]); expect(notes[sheet]).toBe(String(counts[key]))
    expect(rows(wb,sheet).every(row => row[8] === '专精特新中小企业')).toBe(true)
  }
  expect(notes['规则版本']).toBe('current-roster-116-v1')
  expect(notes['数据版本']).toBe(job.result.dataVersion)
  expect(notes['范围']).toContain('未实时采集，不证明全市完整')
}
