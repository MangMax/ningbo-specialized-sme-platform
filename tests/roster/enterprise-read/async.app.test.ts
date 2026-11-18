import '../../support/compiled-enterprise-reader'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { setTimeout as pause } from 'node:timers/promises'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { initializeDb, schema } from '../../../db/client'
import { createEnterpriseReadExecutor } from '../../../layers/sme-roster/server/utils/enterprise-read'
import { startHttpFixture } from '../../support/http'
import { writeNewCollectionTarget, type NewCollectionTargetCommand } from '../../../lib/platform/collection-target-command'
import { platformResultToImport } from '../../../lib/platform/recognized-evidence'
import type { PlatformRawRow } from '../../../lib/platform/adapter'
import type { PlatformLiveQueryResult } from '../../../lib/platform/live-query'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'enterprise-async-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'test.db'), db = initializeDb({ dbPath: path, create:true })
  cleanup.push(() => db.$client.close())
  const enterprise = db.insert(schema.enterprise).values({ name: '合成企业', nameNorm: '合成企业' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
  db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).run()
  const reads = createEnterpriseReadExecutor()
  cleanup.push(() => reads.close())
  return { path, db, enterprise, reads }
}
function recognizedRows(f:ReturnType<typeof fixture>, entries:{enterpriseId:number|null;rawFields:PlatformRawRow}[]) {
  f.db.update(schema.enterprise).set({usccNorm:'913302007000000001'}).run()
  const raw=entries.map(entry=>entry.rawFields)
  const typed=raw.some(row=>Object.values(row).some(value=>typeof value!=='string'))
  const rows=raw.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value==null?'':typeof value==='string'?value:typeof value==='object'?JSON.stringify(value):String(value)])))
  const evidence:PlatformLiveQueryResult={source:'queryBusList',status:'success',effectiveConditions:{name:'合成企业',combination:'and'},
    titleScope:{mode:'selected',rdjb:['2']},queriedAt:'2026-10-19T00:00:00Z',completedAt:'2026-10-19T00:01:00Z',rows,
    ...(typed?{dataRows:raw}:{}),pages:[{source:'queryBusList',rdjb:'2',page:1,maxPage:1,status:'success',fetchedCount:rows.length,declaredTotal:rows.length,error:null}],
    fetchedCount:rows.length,declaredTotal:rows.length,completeness:'complete',fullRange:true,unfinished:[],error:null,
    limits:{maxRequests:100,maxRows:5000,maxDurationMs:60000,pageSize:50}}
  writeNewCollectionTarget(f.db,{queryText:JSON.stringify(platformResultToImport(evidence)),evidenceText:JSON.stringify(evidence),createdAt:'2026-10-19T00:01:00Z',
    assignments:entries.map<NewCollectionTargetCommand['assignments'][number]>(entry=>({enterpriseId:entry.enterpriseId,nameRaw:null,usccRaw:null,matchBasis:entry.enterpriseId===null?'none':'uscc',
      verificationStatus:entry.enterpriseId===null?'pending':'confirmed',origin:'command',actor:{type:'agent',id:'source-worker-test'},basis:'explicit synthetic assignment'}))})
}
it('serves HTTP health while a real native SQLite enterprise read waits for a separate writer', async () => {
  const f = fixture()
  // DELETE mode deliberately permits an exclusive lock to block native reads.
  // The independent writer releases it without depending on the app event loop.
  f.db.$client.pragma('journal_mode=DELETE')
  const app = await startHttpFixture({ routes: {
    '/enterprises': async () => ({ status: 200, body: await f.reads.list(f.path) }),
    '/health': () => ({ status: 200, body: { ok: true } }),
  } })
  cleanup.push(() => app.close())
  expect((await (await fetch(app.baseUrl + '/enterprises')).json()).counts.total).toBe(1)
  const worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const Database=require(workerData.driver); const db=new Database(workerData.path);
    db.exec('BEGIN EXCLUSIVE');parentPort.postMessage('locked');
    parentPort.once('message',()=>setTimeout(()=>{db.exec('ROLLBACK');db.close();parentPort.close()},600));
  `, { eval: true, workerData: { driver: createRequire(import.meta.url).resolve('better-sqlite3'), path: f.path } })
  cleanup.push(() => worker.terminate())
  await once(worker, 'message')
  worker.postMessage('releaseLater')
  const before = performance.now()
  const pending = fetch(app.baseUrl + '/enterprises')
  await pause(25)
  const health = await fetch(app.baseUrl + '/health')
  expect(health.status).toBe(200)
  expect(performance.now() - before).toBeLessThan(300)
  const response = await pending
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ counts: { total: 1 }, rows: [{ enterpriseId: f.enterprise.id, name: '合成企业' }] })
})

describe('cold detail diagnostics after worker readiness', () => {
  let f: ReturnType<typeof fixture>
  beforeAll(async () => { f = fixture(); await f.reads.start() })
  it('reports connection and SQL work separately from encoding', async () => {
    const { channel } = await import('node:diagnostics_channel')
    const results: Record<string, number>[] = []
    const observe = (message: any) => { if (message.phase === 'result') results.push(message) }
    channel('ningbo.enterprise-read').subscribe(observe)
    try {
      expect(await f.reads.detail(f.path, f.enterprise.id)).toMatchObject({ enterprise: { enterpriseId: f.enterprise.id } })
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({ connectionMs: expect.any(Number), sqlMs: expect.any(Number), sqlCalls: expect.any(Number), projectionMs: expect.any(Number), serializeMs: expect.any(Number) })
      expect(results[0]!.connectionMs).toBeGreaterThanOrEqual(0)
      expect(results[0]!.sqlMs).toBeGreaterThan(0)
      expect(results[0]!.sqlCalls).toBeGreaterThan(0)
      expect(results[0]!.projectionMs).toBeGreaterThanOrEqual(results[0]!.sqlMs!)
    } finally { channel('ningbo.enterprise-read').unsubscribe(observe) }
  })
})

it('recovers after worker startup failure and rejects a closed executor without retaining queued work', async () => {
  const { createEnterpriseWorker } = await import('../../../layers/sme-roster/server/utils/enterprise-read-worker-location')
  const f = fixture()
  let starts = 0
  const reads = createEnterpriseReadExecutor({ createWorker: () => ++starts === 1
    ? new Worker("throw new Error('synthetic startup failure')", { eval: true, execArgv: [] })
    : createEnterpriseWorker() })
  cleanup.push(() => reads.close())
  await expect(reads.list(f.path)).rejects.toMatchObject({ code: 'worker_failed', statusCode: 503 })
  expect(await reads.list(f.path)).toMatchObject({ counts: { total: 1 }, rows: [{ enterpriseId: f.enterprise.id }] })
  await reads.close()
  await expect(reads.list(f.path)).rejects.toMatchObject({ code: 'executor_closed', statusCode: 503 })
})

it('bounds admission, removes queued aborts, terminates running reads and restarts for the remaining queue', async () => {
  const { channel } = await import('node:diagnostics_channel')
  const f = fixture()
  f.db.$client.pragma('journal_mode=DELETE')
  const reads = createEnterpriseReadExecutor({ maxPending: 1 })
  cleanup.push(() => reads.close())
  await reads.list(f.path)
  const lock = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const Database=require(workerData.driver),db=new Database(workerData.path);
    db.exec('BEGIN EXCLUSIVE');parentPort.postMessage('locked');
    parentPort.on('message',()=>{db.exec('ROLLBACK');db.close();parentPort.close()});
  `, { eval: true, execArgv: [], workerData: { driver: createRequire(import.meta.url).resolve('better-sqlite3'), path: f.path } })
  cleanup.push(() => lock.terminate())
  await once(lock, 'message')
  const a = new AbortController(), b = new AbortController()
  const started = new Promise<void>(resolve => {
    const observer = (message: any) => { if (message.phase === 'start') { channel('ningbo.enterprise-read').unsubscribe(observer); resolve() } }
    channel('ningbo.enterprise-read').subscribe(observer)
  })
  const running = reads.list(f.path, {}, a.signal)
  const runningRejected = expect(running).rejects.toMatchObject({ name: 'AbortError' })
  await started
  const queued = reads.list(f.path, {}, b.signal)
  const queuedRejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
  await expect(reads.list(f.path)).rejects.toMatchObject({ code: 'enterprise_read_busy', statusCode: 503 })
  b.abort(); await queuedRejected
  // Reclaimed capacity admits this request. Running cancellation must not drop it.
  const retained = reads.detail(f.path, f.enterprise.id)
  a.abort(); await runningRejected
  lock.postMessage('release')
  expect(await retained).toMatchObject({ enterprise: { enterpriseId: f.enterprise.id } })
  await expect(reads.list(f.path, { q: 'x'.repeat(65536) })).rejects.toMatchObject({ code: 'enterprise_read_busy' })
  expect(await reads.list(f.path)).toMatchObject({ counts: { total: 1 } })
})

it('opens independent committed snapshots, sees subsequent commits and preserves complete detail payloads after an error', async () => {
  const f = fixture()
  const Database = createRequire(import.meta.url)('better-sqlite3')
  const writer = new Database(f.path)
  cleanup.push(() => writer.close())
  writer.exec('BEGIN IMMEDIATE')
  writer.prepare("update enterprise set name='提交后企业' where id=?").run(f.enterprise.id)
  expect(await f.reads.list(f.path)).toMatchObject({ rows: [{ name: '合成企业' }], counts: { total: 1 } })
  writer.exec('ROLLBACK')
  expect(await f.reads.list(f.path)).toMatchObject({ rows: [{ name: '合成企业' }] })
  writer.prepare("update enterprise set name='提交后企业' where id=?").run(f.enterprise.id)
  expect(await f.reads.list(f.path)).toMatchObject({ rows: [{ name: '提交后企业' }] })
  const rawFields = { original: '完整𠀀原文'.repeat(100000) }
  recognizedRows(f,[{enterpriseId:f.enterprise.id,rawFields:{original:'首行',tyshxydm:'913302007000000001'}},{enterpriseId:null,rawFields}])
  const result = await f.reads.detail(f.path, f.enterprise.id)
  expect(result?.platform.relations.map(row => [row.sequenceNo, row.enterpriseId, row.rawFields])).toEqual([[1, f.enterprise.id, { original: '首行',tyshxydm:'913302007000000001' }], [2, null, rawFields]])
  await expect(f.reads.list(join(tmpdir(), 'missing-enterprise-r1', 'absent.db'))).rejects.toMatchObject({ statusCode: 503 })
  expect(await f.reads.detail(f.path, 999999)).toBeNull()
  expect(await f.reads.list(f.path)).toMatchObject({ counts: { total: 1 } })
})

it('keeps aggregate counts and hydrated rows in one snapshot during independent atomic commits', async () => {
  const f = fixture()
  f.db.$client.transaction(() => {
    const insert = f.db.$client.prepare('insert into enterprise(name,name_norm) values(?,?)')
    for (let i=0; i<5000; i++) insert.run(`无关${i}`, `无关${i}`)
    f.db.$client.prepare('update enterprise set name=? where id=?').run('代数5001', f.enterprise.id)
  })()
  const writer = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const Database=require(workerData.driver),db=new Database(workerData.path);
    const insert=db.prepare("insert into enterprise(name,name_norm) values('新增','新增')");
    const update=db.prepare('update enterprise set name=? where id=?');
    const count=db.prepare('select count(*) n from enterprise');
    const commit=db.transaction(()=>{insert.run();update.run('代数'+count.get().n,workerData.owner)});
    const timer=setInterval(commit,2);parentPort.postMessage('writing');
    parentPort.once('message',()=>{clearInterval(timer);db.close();parentPort.close()});
  `, { eval: true, execArgv: [], workerData: { driver: createRequire(import.meta.url).resolve('better-sqlite3'), path: f.path, owner: f.enterprise.id } })
  cleanup.push(() => writer.terminate())
  await once(writer, 'message')
  const seen = new Set<number>()
  try {
    for (let round=0; round<15; round++) {
      const response = await f.reads.list(f.path, { pageSize: 1 })
      expect(response.rows[0]?.enterpriseId).toBe(f.enterprise.id)
      expect(response.rows[0]?.name).toBe(`代数${response.counts.total}`)
      seen.add(response.counts.total)
    }
    expect(seen.size).toBeGreaterThan(1)
  } finally { writer.postMessage('stop'); await once(writer, 'exit') }
})

it('isolates different source files and reopens a replaced file after all writers close', async () => {
  const { renameSync } = await import('node:fs')
  const f = fixture(), other = fixture()
  other.db.$client.prepare("update enterprise set name='另一数据库' where id=?").run(other.enterprise.id)
  expect(await f.reads.list(f.path)).toMatchObject({ rows: [{ name: '合成企业' }] })
  expect(await f.reads.list(other.path)).toMatchObject({ rows: [{ name: '另一数据库' }] })
  expect(await f.reads.list(f.path)).toMatchObject({ rows: [{ name: '合成企业' }] })
  f.db.$client.pragma('wal_checkpoint(TRUNCATE)')
  other.db.$client.pragma('wal_checkpoint(TRUNCATE)')
  f.db.$client.close(); other.db.$client.close()
  renameSync(other.path, f.path)
  expect(await f.reads.list(f.path)).toMatchObject({ counts: { total: 1 }, rows: [{ name: '另一数据库' }] })
})

it('preserves raw strings across JSON and IPC chunk boundaries including escapes and lone surrogates', async () => {
  const f = fixture()
  const original = 'x'.repeat(16383) + '𠀀' + '\\"\n\t\u0000' + '\ud840' + '末尾' + '\udc00' + '🙂'.repeat(40000)
  recognizedRows(f,[{enterpriseId:null,rawFields:{original,empty:'',values:[null,true,0]}}])
  const result = await f.reads.json(f.path, { operation: 'detail', enterpriseId: f.enterprise.id })
  expect(result.found).toBe(true)
  expect(JSON.parse(result.body.toString()).platform.relations[0]).toMatchObject({ enterpriseId: null, rawFields: { original, empty: '', values: [null, true, 0] } })
  expect(await f.reads.list(f.path)).toMatchObject({ counts: { total: 1 } })
})
