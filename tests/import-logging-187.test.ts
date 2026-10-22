import { EventEmitter } from 'node:events'
import Database from 'better-sqlite3'
import { createImportExecutionWorker } from '../server/utils/import-execution-worker-location'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createImportExecutor } from '../server/utils/import-execution'
import type { RosterImportRequest } from '../lib/roster-import-client'
import { useDb } from '../db/client'
import { handleRosterImportRequest } from '../server/utils/roster-import-http'
import { readImportReceipt } from '../server/utils/import-receipts'
import { applicationLogs, closeApplicationLogging, initializeWorkerLogging } from '../lib/logging'

const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { await closeApplicationLogging(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function fixture(options: Parameters<typeof createImportExecutor>[0] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'import187-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const old = process.env.NUXT_LOG_DIR
  process.env.NUXT_LOG_DIR = join(root, 'logs')
  cleanups.push(() => { if (old === undefined) delete process.env.NUXT_LOG_DIR; else process.env.NUXT_LOG_DIR = old })
  initializeWorkerLogging()
  const db = useDb({ dbPath: join(root, 'roster.db') })
  cleanups.push(() => db.$client.close())
  const executor = createImportExecutor(options)
  cleanups.push(() => executor.close())
  const input = { idempotencyKey: 'PRIVATE_KEY_187', sourceKind: 'platform_export', sourceIdentity: '/PRIVATE_PATH_187.xlsx', payload: { exportSnapshot: {
    titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-20', originalFilename: 'PRIVATE_NAME_187.xlsx', sha256: 'fixture187', rows: [{ sourceRowNo: 3, rawFields: { original: 'PRIVATE_TEXT_187' } }],
  } } } satisfies RosterImportRequest
  const post = (action: 'preflight' | 'commit' | 'replay', body: unknown = input) => handleRosterImportRequest(action, { method: 'POST', headers: { authorization: 'Bearer fixture-token' }, body }, { db, apiToken: 'fixture-token', executeImport: executor.execute, logContext: { requestId: 'req-187', traceId: 'trace-187', taskId: 'task-187' } })
  return { db, input, post, flush: async () => { await executor.close(); await applicationLogs().flush() } }
}

it('same-key commit recovery logs replay without claiming another commit or changing its receipt', async () => {
  const { db, post, flush } = fixture()
  const first = await post('commit')
  expect(first).toMatchObject({ status: 200, body: { status: 'committed', summary: { written: 2, failed: 0 } } })
  const receipt = readImportReceipt(db, 'get', { idempotencyKey: 'PRIVATE_KEY_187' }) as { batchId: number; receiptId: number }
  expect(await post('commit')).toEqual(first)
  expect(readImportReceipt(db, 'history', { idempotencyKey: 'PRIVATE_KEY_187' })).toMatchObject({ total: 1 })
  await flush()
  const commits = await applicationLogs().list({ operation: 'import.commit' })
  const replays = await applicationLogs().list({ operation: 'import.commit.replay' })
  expect(commits.rows).toHaveLength(1)
  expect(replays.rows).toHaveLength(1)
  const details = await Promise.all([...commits.rows, ...replays.rows].map(row => applicationLogs().detail(row.id)))
  expect(details).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'success', batchId: receipt.batchId, receiptId: receipt.receiptId, requestId: 'req-187', traceId: 'trace-187', taskId: 'task-187' })]))
  expect(JSON.stringify(details)).not.toContain('PRIVATE_')
})

it('preflight conflicts and failed batches never emit successful imports and source conflicts stay distinct', async () => {
  const { input, post, flush } = fixture()
  const invalid = { ...input, payload: { exportSnapshot: { ...input.payload.exportSnapshot, titleCode: 'invalid-title' } } }
  expect(await post('preflight', invalid)).toMatchObject({ status: 200, body: { status: 'preflight', preflight: { conflicts: [expect.anything()] } } })
  expect(await post('commit', invalid)).toMatchObject({ status: 200, body: { status: 'failed', summary: { written: 0 } } })
  expect(await post('commit')).toMatchObject({ status: 200, body: { status: 'committed' } })
  expect(await post('commit', { ...input, sourceIdentity: 'PRIVATE_OTHER_PATH' })).toMatchObject({ status: 409, body: { error: { code: 'idempotency_conflict' } } })
  await flush()
  const events = (await applicationLogs().list({ source: 'import' })).rows
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: 'import.preflight', outcome: 'denied' }),
    expect.objectContaining({ operation: 'import.commit', outcome: 'failure' }),
    expect.objectContaining({ operation: 'import.submission.commit', outcome: 'denied' }),
  ]))
  const failed = events.find(row => row.operation === 'import.commit' && row.outcome === 'failure')!
  expect(await applicationLogs().detail(failed.id)).toMatchObject({ errorCode: 'import_conflict', counts: { done: 0, failed: 1 } })
  const preflight = events.find(row => row.operation === 'import.preflight')!
  expect(await applicationLogs().detail(preflight.id)).toMatchObject({ errorCode: 'import_conflict', counts: { failed: 1 } })
  const rejected = events.find(row => row.operation === 'import.submission.commit')!
  expect(await applicationLogs().detail(rejected.id)).toMatchObject({ errorCode: 'idempotency_conflict' })
  expect(JSON.stringify(await Promise.all(events.map(row => applicationLogs().detail(row.id))))).not.toContain('PRIVATE_')
})

it('busy admission and lost IPC remain distinct while durable receipt recovery never repeats the commit', async () => {
  let starts = 0, dispatched!: () => void
  const active = new Promise<void>(resolve => { dispatched = resolve })
  const { db, input, post, flush } = fixture({ maxPending: 1, createWorker: () => {
    const owned = createImportExecutionWorker(), proxy = new EventEmitter(), drop = ++starts === 1
    let pid = 0
    owned.on('message', message => {
      if (message.type === 'ready') pid = message.pid
      if (drop && message.type === 'result') { process.kill(pid, 'SIGKILL'); return }
      proxy.emit('message', message)
    })
    owned.on('error', error => proxy.emit('error', error))
    owned.on('exit', (...args) => proxy.emit('exit', ...args))
    return Object.assign(proxy, { postMessage: (message: unknown) => { owned.postMessage(message); dispatched() }, ref: owned.ref.bind(owned), unref: owned.unref.bind(owned), terminate: owned.terminate.bind(owned) })
  } })
  const blocker = new Database(db.$client.name)
  cleanups.push(() => { if (blocker.inTransaction) blocker.exec('ROLLBACK'); blocker.close() })
  blocker.exec('BEGIN IMMEDIATE')
  const first = post('commit')
  await active
  expect(await post('commit', { ...input, idempotencyKey: 'PRIVATE_BUSY_KEY' })).toMatchObject({ status: 503, body: { error: { code: 'import_busy' } } })
  blocker.exec('ROLLBACK')
  expect(await first).toMatchObject({ status: 503, body: { error: { code: 'import_outcome_unknown' } } })
  expect(readImportReceipt(db, 'get', { idempotencyKey: input.idempotencyKey })).toMatchObject({ status: 'committed', summary: { written: 2 } })
  expect(await post('commit')).toMatchObject({ status: 200, body: { status: 'committed', summary: { written: 2 } } })
  expect(readImportReceipt(db, 'history', { idempotencyKey: input.idempotencyKey })).toMatchObject({ total: 1 })
  await flush()
  const rows = (await applicationLogs().list({ source: 'import' })).rows
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: 'import.admission', outcome: 'denied', taskId: 'task-187' }),
    expect.objectContaining({ operation: 'import.execution', outcome: 'unknown', requestId: 'req-187' }),
    expect.objectContaining({ operation: 'import.commit.replay', outcome: 'success', traceId: 'trace-187' }),
  ]))
  expect(rows.filter(row => row.operation === 'import.execution' && row.outcome === 'success')).toHaveLength(0)
})

it('an enclosing transaction rollback cannot leave a successful commit log for an absent receipt', async () => {
  const { commitRosterImport } = await import('../server/utils/roster-import')
  const { db, input, flush } = fixture()
  expect(() => db.transaction(() => {
    expect(commitRosterImport(db, input)).toMatchObject({ status: 'committed' })
    throw new Error('fixture outer rollback')
  })).toThrow('fixture outer rollback')
  expect(() => readImportReceipt(db, 'get', { idempotencyKey: input.idempotencyKey })).toThrow('Import batch or receipt not found')
  await flush()
  expect((await applicationLogs().list({ operation: 'import.commit', outcome: 'success' })).rows).toHaveLength(0)
})
