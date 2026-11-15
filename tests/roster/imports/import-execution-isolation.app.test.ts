import { serialize } from 'node:v8'
import { mkdtempSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { initializeDb } from '../../../db/client'
import { startRosterApi } from './fixtures/import-server'
import type { RosterImportRequest } from '../../../lib/roster-import-client'

const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function input(): RosterImportRequest {
  return { idempotencyKey: 'synthetic:isolation', sourceKind: 'platform_export', sourceIdentity: 'synthetic/isolation.xlsx', payload: { exportSnapshot: {
    titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-20', originalFilename: 'isolation.xlsx', sha256: 'isolation-v1',
    rows: Array.from({ length: 300 }, (_, i) => ({ sourceRowNo: i + 3, rawFields: { original: `  原文🙂\n${i} ` } })),
  } } }
}

it('HTTP import keeps the event loop responsive during native write contention and commits all 300 rows once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-execution-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'roster.db'), db = initializeDb({ create: true,  dbPath: path })
  cleanups.push(() => db.$client.close())
  const api = await startRosterApi({ db, apiToken: 'synthetic-token' })
  cleanups.push(() => api.close())
  const blocker = new Database(path)
  cleanups.push(() => blocker.close())
  blocker.exec('BEGIN IMMEDIATE')
  // A real second writer holds SQLite's lock. Only a live app event loop can
  // release it; no sleep/timeout/busy_timeout production setting is changed.
  let released = false
  const release = setTimeout(() => { blocker.exec('ROLLBACK'); released = true }, 50)
  cleanups.push(() => { clearTimeout(release); if (blocker.inTransaction) blocker.exec('ROLLBACK') })
  const post = () => fetch(`${api.baseUrl}/api/roster/import/commit`, { method: 'POST', headers: { authorization: 'Bearer synthetic-token', 'content-type': 'application/json' }, body: JSON.stringify(input()) })
  const response = await post()
  expect(response.status).toBe(200)
  expect(released).toBe(true)
  const receipt = await response.json()
  expect(receipt).toMatchObject({ status: 'committed', summary: { written: 301, failed: 0 }, items: [{ detail: { rowsWritten: 301, skipped: 0 } }] })
  expect(receipt.items[0].detail.rows).toHaveLength(300)
  expect(await (await post()).json()).toEqual(receipt)
}, 20_000)

it('a worker that dies before readiness fails its admitted request without spawning a retry', async () => {
  const { createImportExecutor } = await import('../../../server/utils/import-execution')
  const { createEnterpriseReadProcess } = await import('../../../server/utils/enterprise-read-process')
  const dir = mkdtempSync(join(tmpdir(), 'import-startup-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const db = initializeDb({ create: true,  dbPath: join(dir, 'roster.db') })
  cleanups.push(() => db.$client.close())
  let starts = 0, allowRecovery = false
  const { createImportExecutionWorker } = await import('../../../server/utils/import-execution-worker-location')
  const executor = createImportExecutor({ createWorker: () => {
    if (++starts > 1 && allowRecovery) return createImportExecutionWorker()
    if (starts > 1) throw Error('No automatic retry may create another worker')
    return createEnterpriseReadProcess(new URL('file:///synthetic-missing-import-worker.mjs'))
  } })
  cleanups.push(() => executor.close())
  await expect(executor.execute(db, 'commit', input())).rejects.toMatchObject({ statusCode: 503, code: 'import_worker_unavailable' })
  expect(starts).toBe(1)
  allowRecovery = true
  await expect(executor.execute(db, 'commit', input())).resolves.toMatchObject({ status: 'committed', summary: { written: 301 } })
  expect(starts).toBe(2)
})

async function isolatedApi(options: Parameters<typeof import('../../../server/utils/import-execution').createImportExecutor>[0] = {}) {
  const { createImportExecutor } = await import('../../../server/utils/import-execution')
  const { handleRosterImportRequest } = await import('../../../server/utils/roster-import-http')
  const { readImportReceipt } = await import('../../../server/utils/import-receipts')
  const { handleRecordCorrespondenceRequest } = await import('../../../server/utils/record-correspondence-api')
  const { startHttpFixture } = await import('../../support/http')
  const dir = mkdtempSync(join(tmpdir(), 'isolated-import-http-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'roster.db'), db = initializeDb({ create: true,  dbPath: path })
  cleanups.push(() => db.$client.close())
  const executor = createImportExecutor(options)
  let requestStarted!: () => void
  const admitted = new Promise<void>(resolve => { requestStarted = resolve })
  const api = await startHttpFixture({ routes: Object.fromEntries(['preflight', 'commit'].map(action => [
    `/api/roster/import/${action}`, async request => {
      requestStarted()
      return handleRosterImportRequest(action as 'preflight' | 'commit', request, { db, apiToken: 'synthetic-token', executeImport: executor.execute })
    },
  ])), getRoutes: {
    '/receipt': request => ({ status: 200, body: readImportReceipt(db, 'get', request.query) }),
    '/history': request => ({ status: 200, body: readImportReceipt(db, 'history', request.query) }),
    '/source': request => handleRecordCorrespondenceRequest({ action: 'source', method: 'GET', kind: 'export_row', id: String(request.query.id) }, { db, apiToken: 'synthetic-token' }),
  } })
  cleanups.push(() => api.close())
  cleanups.push(() => executor.close())
  return { db, path, api, executor, admitted,
    post: (body = input(), signal?: AbortSignal) => fetch(`${api.baseUrl}/api/roster/import/commit`, { method: 'POST', signal, headers: { authorization: 'Bearer synthetic-token', 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    get: async (path: string) => (await fetch(api.baseUrl + path)).json() as Promise<any>,
  }
}

it('a lost response after durable commit returns unknown outcome and same-key HTTP retry never duplicates it', async () => {
  const { EventEmitter } = await import('node:events')
  const { createImportExecutionWorker } = await import('../../../server/utils/import-execution-worker-location')
  let starts = 0
  const service = await isolatedApi({ createWorker: () => {
    const owned = createImportExecutionWorker(), proxy = new EventEmitter(), drop = ++starts === 1
    let pid = 0
    owned.on('message', message => {
      if (message.type === 'ready') pid = message.pid
      // Fault injection at the OS IPC boundary. The real core has COMMITted;
      // deliberately lose that response and kill the process, without retrying it.
      if (drop && message.type === 'result') { process.kill(pid, 'SIGKILL'); return }
      proxy.emit('message', message)
    })
    owned.on('error', error => proxy.emit('error', error))
    owned.on('exit', (...args) => proxy.emit('exit', ...args))
    return Object.assign(proxy, { postMessage: owned.postMessage.bind(owned), ref: owned.ref.bind(owned), unref: owned.unref.bind(owned), terminate: owned.terminate.bind(owned) })
  } })
  const lost = await service.post()
  expect(lost.status).toBe(503)
  expect(await lost.json()).toMatchObject({ error: { code: 'import_outcome_unknown' } })
  expect(await service.get('/receipt?idempotencyKey=synthetic:isolation')).toMatchObject({ status: 'committed', summary: { written: 301, failed: 0 } })
  const retried = await (await service.post()).json()
  expect(retried).toMatchObject({ status: 'committed', summary: { written: 301, failed: 0 } })
  expect(retried.items[0].detail.rows).toHaveLength(300)
  for (const index of [0, 199, 200, 299]) expect(await service.get(`/source?id=${retried.items[0].detail.rows[index]}`)).toMatchObject({ source: { sourceRowNo: index + 3, rawFields: { original: `  原文🙂\n${index} ` } } })
  expect(await service.get('/history?idempotencyKey=synthetic:isolation')).toMatchObject({ total: 1 })
  expect(starts).toBe(2)
}, 20_000)

it('closing admission drains the accepted write without cancellation and rejects overflow before another fork', async () => {
  const { createImportExecutionWorker } = await import('../../../server/utils/import-execution-worker-location')
  let starts = 0
  const service = await isolatedApi({ maxPending: 1, createWorker: () => { starts++; return createImportExecutionWorker() } })
  const blocker = new Database(service.path)
  cleanups.push(() => blocker.close())
  blocker.exec('BEGIN IMMEDIATE')
  const first = service.post()
  await service.admitted
  const overflow = await service.post({ ...input(), idempotencyKey: 'synthetic:overflow' })
  expect(overflow.status).toBe(503)
  expect(await overflow.json()).toMatchObject({ error: { code: 'import_busy' } })
  const closing = service.executor.close()
  const denied = await service.post({ ...input(), idempotencyKey: 'synthetic:closed' })
  expect(denied.status).toBe(503)
  blocker.exec('ROLLBACK')
  expect(await (await first).json()).toMatchObject({ status: 'committed', summary: { written: 301 } })
  await closing
  expect(starts).toBe(1)
  expect(await service.get('/history?idempotencyKey=synthetic:isolation')).toMatchObject({ total: 1 })
}, 20_000)

it('disconnecting an admitted HTTP caller does not cancel or replay its eventual committed write', async () => {
  const service = await isolatedApi()
  const blocker = new Database(service.path)
  cleanups.push(() => blocker.close())
  blocker.exec('BEGIN IMMEDIATE')
  const controller = new AbortController()
  const first = service.post(input(), controller.signal).catch(error => error)
  await service.admitted
  controller.abort()
  await first
  blocker.exec('ROLLBACK')
  let receipt: any
  for (let i = 0; i < 100; i++) {
    receipt = await service.get('/receipt?idempotencyKey=synthetic:isolation')
    if (receipt.status === 'committed') break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(receipt).toMatchObject({ status: 'committed', summary: { written: 301 } })
  expect(await (await service.post()).json()).toMatchObject({ status: 'committed', batchId: receipt.batchId })
  expect(await service.get('/history?idempotencyKey=synthetic:isolation')).toMatchObject({ total: 1 })
}, 20_000)

it('isolated HTTP chunk failure is atomic and corrected same-key retry preserves original row order and raw fields', async () => {
  const service = await isolatedApi()
  service.db.$client.exec("CREATE TRIGGER synthetic_chunk_failure BEFORE INSERT ON platform_export_row WHEN NEW.source_row_no=203 BEGIN SELECT RAISE(ABORT,'synthetic later-chunk failure'); END")
  const failed = await (await service.post()).json()
  expect(failed).toMatchObject({ status: 'failed', summary: { written: 0, failed: 1 }, items: [{ error: { code: 'commit_rolled_back' } }] })
  expect((await fetch(`${service.api.baseUrl}/source?id=1`)).status).toBe(404)
  service.db.$client.exec('DROP TRIGGER synthetic_chunk_failure')
  const committed = await (await service.post()).json()
  expect(committed).toMatchObject({ batchId: failed.batchId, status: 'committed', summary: { written: 301, failed: 0 } })
  for (const index of [0, 199, 200, 299]) expect(await service.get(`/source?id=${committed.items[0].detail.rows[index]}`)).toMatchObject({ source: { sourceRowNo: index + 3, rawFields: { original: `  原文🙂\n${index} ` } } })
  expect(await (await service.post()).json()).toEqual(committed)
  const conflict = await service.post({ ...input(), sourceIdentity: 'synthetic/other.xlsx' })
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ error: { code: 'idempotency_conflict' } })
}, 20_000)

it('binary admission preserves a valid HTTP payload whose JSON representation exceeds its encoded byte bound', async () => {
  const request = input()
  const original = '\u0000_x0001_\ud800\r\n原始🙂' + '中文'.repeat(1024)
  request.payload.exportSnapshot!.rows[0]!.rawFields!.original = original
  const maxBytes = Buffer.byteLength(JSON.stringify(request)) - 1
  expect(serialize(request).byteLength).toBeLessThan(maxBytes)
  const service = await isolatedApi({ maxBytes })
  const response = await service.post(request)
  expect(response.status).toBe(200)
  const receipt = await response.json()
  expect(receipt).toMatchObject({ status: 'committed', summary: { written: 301, failed: 0 } })
  const rowId = receipt.items[0].detail.rows[0]
  expect(await service.get('/source?id=' + rowId)).toMatchObject({ source: { sourceRowNo: 3, rawFields: { original } } })
  expect(await (await service.post(request)).json()).toEqual(receipt)
}, 20_000)

it('an idle executor preflights a valid batch larger than 32MiB without changing the core result', async () => {
  const { preflightRosterImport } = await import('../../../server/utils/roster-import')
  const service = await isolatedApi()
  const legacy = await isolatedApi()
  const request = input()
  request.payload.exportSnapshot!.rows = [{ sourceRowNo: 3, rawFields: { original: 'x'.repeat(32 * 1024 * 1024) } }]
  expect(serialize(request).byteLength).toBeGreaterThan(32 * 1024 * 1024)
  const expected = preflightRosterImport(legacy.db, request)
  const response = await fetch(`${service.api.baseUrl}/api/roster/import/preflight`, {
    method: 'POST', headers: { authorization: 'Bearer synthetic-token', 'content-type': 'application/json' }, body: JSON.stringify(request),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(expected)
  expect(await service.get('/receipt?idempotencyKey=synthetic:isolation')).toMatchObject({ status: 'preflight' })
  // Commit/raw preservation and replay are covered above; oversized admission
  // needs one real HTTP preflight, not three further 32MiB transfers.
}, 20_000)

it.each([
  { lane: 'oversized exclusive batch', maxBytes: 1 },
  { lane: 'combined backlog bytes', maxBytes: 2 * serialize(input()).byteLength - 1 },
])('$lane pressure recovers after the admitted atomic commit', async ({ maxBytes }) => {
  const { createImportExecutionWorker } = await import('../../../server/utils/import-execution-worker-location')
  let starts = 0
  let dispatched!: () => void, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const active = new Promise<void>(resolve => { dispatched = resolve })
  const service = await isolatedApi({ maxBytes, createWorker: () => {
    starts++
    const worker = createImportExecutionWorker(), send = worker.postMessage.bind(worker)
    worker.postMessage = message => { void held.then(() => send(message)); dispatched() }
    return worker
  } })
  // Hold the real process at the IPC boundary to test backlog admission only.
  // SQLite contention has separate coverage above; a held native writer here
  // races deferred-transaction promotion with the HTTP rejection assertions.
  cleanups.push(() => release())
  const first = service.post()
  await active
  const second = { ...input(), idempotencyKey: 'synthetic:byte-pressure' }
  const rejected = await service.post(second)
  expect(rejected.status).toBe(503)
  expect(await rejected.json()).toMatchObject({ error: { code: 'import_busy' } })
  expect((await fetch(`${service.api.baseUrl}/receipt?idempotencyKey=${second.idempotencyKey}`)).status).toBe(404)
  release()
  const committed = await (await first).json()
  expect(committed).toMatchObject({ status: 'committed', summary: { written: 301, failed: 0 } })
  expect(await (await service.post()).json()).toEqual(committed)
  expect(await (await service.post(second)).json()).toMatchObject({ status: 'committed', summary: { written: 0, failed: 0 } })
  expect(await service.get('/history?idempotencyKey=synthetic:isolation')).toMatchObject({ total: 1 })
  expect(starts).toBe(1)
}, 20_000)

it('isolated writes enforce foreign keys and leave no business rows after a trigger violates them', async () => {
  const service = await isolatedApi()
  service.db.$client.exec("CREATE TRIGGER synthetic_fk_failure BEFORE INSERT ON platform_export_row WHEN NEW.source_row_no=203 BEGIN INSERT INTO platform_export_row(batch_id,source_row_no,raw_fields,created_at) VALUES(-999,987654,'{}','2026-10-20'); END")
  const result = await (await service.post()).json()
  expect(result).toMatchObject({ status: 'failed', summary: { written: 0, failed: 1 } })
  expect(result.error).toContain('FOREIGN KEY constraint failed')
  expect((await fetch(`${service.api.baseUrl}/source?id=1`)).status).toBe(404)
})

it.each(['inode', 'schema', 'migration'] as const)('rejects a changed admitted database %s before a business write', async change => {
  const { createImportExecutionWorker } = await import('../../../server/utils/import-execution-worker-location')
  let mutate = () => {}
  const service = await isolatedApi({ createWorker: () => {
    const owned = createImportExecutionWorker(), send = owned.postMessage.bind(owned)
    owned.postMessage = message => { mutate(); send(message) }
    return owned
  } })
  if (change === 'inode') {
    const replacement = join(tmpdir(), `import-replacement-${process.pid}-${Date.now()}.sqlite`)
    cleanups.push(() => rmSync(replacement, { force: true }))
    await service.db.$client.backup(replacement)
    mutate = () => renameSync(replacement, service.path)
  } else if (change === 'schema') mutate = () => service.db.$client.exec('CREATE TABLE synthetic_schema_change(id INTEGER)')
  else mutate = () => { service.db.$client.prepare("UPDATE __drizzle_migrations SET hash='synthetic-changed-receipt' WHERE created_at=(SELECT MAX(created_at) FROM __drizzle_migrations)").run() }
  const response = await service.post()
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: { code: 'import_source_changed' } })
  expect((await fetch(`${service.api.baseUrl}/receipt?idempotencyKey=synthetic:isolation`)).status).toBe(404)
})
