import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { expect } from 'vitest'
import { reviewCurrentExportDecision } from './current-export-decisions'
import { initializeDb, schema as s } from '../../db/client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../scripts/lib/isolated-local-services.mjs'

export const titleCode = 'specialized_sme'
export const route = '/api/roster/exports/current/specialized-sme'
export const year = new Date().getFullYear()
export type Event = { eventType: 'award'|'review'|'nurture'|'maintain'; year: number|null; decidedYear?: number|null; reviewOutcome?: 'passed'|'failed'|null; batchSeq?: number|null }
export const fresh: Event[] = [{ eventType: 'award', year, batchSeq: 1 }]
export const businessTables = ['enterprise_fact_revision','record_correspondence','difference_reason','platform_observation_assignment','platform_legacy_relation_alias','platform_business_observation','platform_legacy_query_alias','platform_collection','enterprise_alias','record_evidence','record_event','record','enterprise']

// Synthetic setup only. All assertions on export behavior use actual Nitro HTTP and XLSX bytes.
export function currentExport409Fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'export-409-'))
  const dbPath = join(dir, 'synthetic.db'), db = initializeDb({ dbPath, create: true })
  const token = 'synthetic-export-409-token'
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
  let baseUrl = '', stop: (() => Promise<void>) | undefined
  const mode = process.env.ISSUE409_EXPORT_MODE ?? 'source'
  if (mode !== 'source' && mode !== 'compiled') throw new Error('Unsupported 409 acceptance mode')
  function assertCompiledPins() {
    if (mode !== 'compiled') return
    const manifestPath = process.env.ISSUE409_COMPILED_INVENTORY
    const manifestSHA = process.env.ISSUE409_COMPILED_INVENTORY_SHA256
    if (!manifestPath || !manifestSHA || !/^[a-f0-9]{64}$/.test(manifestSHA)) throw new Error('Explicit compiled artifact binding required')
    const raw = readFileSync(manifestPath)
    if (createHash('sha256').update(raw).digest('hex') !== manifestSHA) throw new Error('Compiled manifest changed')
    const inventory = JSON.parse(raw.toString()) as { files: Record<string, { sha256: string }>; entries: { path: string }[] }
    if (inventory.entries.map(entry => entry.path).join('|') !== ['index','enterprise-read-worker','current-export-worker','import-execution-worker'].map(name => '.output/server/' + name + '.mjs').join('|')) throw new Error('Compiled entry binding invalid')
    const cwd = resolve(import.meta.dirname, '../..')
    for (const [file, pin] of Object.entries(inventory.files)) {
      if (!file.startsWith('.output/server/') || file.includes('..') || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error('Compiled artifact path invalid')
      if (createHash('sha256').update(readFileSync(join(cwd, file))).digest('hex') !== pin.sha256) throw new Error('Compiled artifact changed')
    }
  }
  const url = (path: string) => baseUrl + path
  const json = (response: Response): Promise<any> => response.json()
  const submit = (key: string, extra = {}) => fetch(url(route), { method: 'POST', headers, body: JSON.stringify({ clientRequestId: key, ...extra }) })
  async function start() {
    assertCompiledPins()
    const cwd = resolve(import.meta.dirname, '../..'), port = await reserveLoopbackPort()
    if (port === 3480 || port === 3481) throw new Error('Reserved business port refused')
    const emptyDotenv = process.env.ISSUE409_EMPTY_DOTENV ?? join(dir,'empty.env')
    if (!process.env.ISSUE409_EMPTY_DOTENV) writeFileSync(emptyDotenv,'',{ mode: 0o600 })
    const args = mode === 'compiled' ? [join(cwd,'.output/server/index.mjs')] : [join(cwd,'node_modules/nuxt/bin/nuxt.mjs'),'dev','--dotenv',emptyDotenv,'--host','127.0.0.1','--port',String(port)]
    const child = spawn(process.execPath, args, {
      cwd, stdio: ['ignore','pipe','pipe'], env: { ...process.env, ...(mode === 'compiled' ? { HOST: '127.0.0.1', PORT: String(port), NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port) } : {}), NUXT_BUILD_DIR: join(dir,'build'), NUXT_LOG_DIR: join(dir,'logs'), NUXT_DB_PATH: dbPath, NUXT_API_TOKEN: token, NUXT_MCP_TOKEN: token, NUXT_FILES_DIR: join(dir,'files'), NUXT_INCOMING_DIR: join(dir,'incoming') },
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
    const decision = db.insert(s.differenceReason).values({ enterpriseId, titleCode, direction:'extra_in_miit', status:'confirmed_reason', reasonCode, verificationStatus:'confirmed', lifecycleAction:'replace', basis:'人工确认合成主体事实', effectiveAt:'2025-01-01T00:00:00Z', recordedAt:new Date().toISOString(), ...extra } as any).returning().get()
    reviewCurrentExportDecision(db,decision)
    return decision
  }
  function resetBusiness() {
    db.$client.pragma('foreign_keys = OFF')
    try { db.$client.transaction(() => { for (const table of businessTables) db.$client.prepare('delete from ' + table).run() })() }
    finally { db.$client.pragma('foreign_keys = ON') }
  }
  function businessDigest() {
    const hash = createHash('sha256')
    for (const table of businessTables) for (const row of db.$client.prepare('select * from ' + table + ' order by rowid').iterate()) hash.update(JSON.stringify(row))
    return hash.digest('hex')
  }
  return { dir, dbPath, db, headers, token, url, json, submit, start, terminal, download, workbook, candidate, addRecord, decision, resetBusiness, businessDigest,
    async close() { try { await stop?.(); assertCompiledPins() } finally { db.$client.close(); rmSync(dir,{recursive:true,force:true}) } },
  }
}
