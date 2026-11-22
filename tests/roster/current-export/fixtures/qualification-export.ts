import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import pg from 'pg'
import { expect } from 'vitest'
import { reviewCurrentExportDecision } from '../../fixtures/qualification-decisions'
import { schema as s } from '../../../../db/client'
import { nativeAppAdapter } from '../../../support/native-app'

export const titleCode = 'specialized_sme'
export const route = '/api/roster/exports/current/specialized-sme'
export const year = new Date().getFullYear()
export type Event = { eventType: 'award'|'review'|'nurture'|'maintain'; year: number|null; decidedYear?: number|null; reviewOutcome?: 'passed'|'failed'|null; batchSeq?: number|null }
export const fresh: Event[] = [{ eventType: 'award', year, batchSeq: 1 }]
export const businessTables = ['enterprise_fact_revision','record_correspondence','difference_reason','platform_observation_assignment','platform_legacy_relation_alias','platform_business_observation','platform_legacy_query_alias','platform_collection','enterprise_alias','record_evidence','record_event','record','enterprise']

// Synthetic setup only. All assertions on export behavior use actual Nitro HTTP and XLSX bytes.
export function qualificationExportFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'export-409-'))
  const token = 'synthetic-export-409-token'
  const app = nativeAppAdapter({ dir, token })
  const { headers, url, start, terminal, resetBusiness } = app
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
    const enterprise = app.db.insert(s.enterprise).values({ name, nameNorm:name, usccNorm:'SYNTHETIC-118-' + name, district:'鄞州区', city:'宁波市' }).returning().get()
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
    return hash.digest('hex')
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
  return { dir, get dbPath(){return app.dbPath}, get postgresUrl(){return app.postgresUrl}, get db(){return app.db}, headers, token, url, json, submit, start, terminal, download, workbook, candidate, addRecord, decision, resetBusiness, businessDigest, runtimeBusinessRows,
    async close() { try { await app.close();  } finally { rmSync(dir,{recursive:true,force:true}) } },
  }
}
