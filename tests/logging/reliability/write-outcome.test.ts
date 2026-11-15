import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { SQLITE_WORKER } from '../../../lib/logging/sqlite-worker'
import type { LogService, LogServiceOptions } from '../../../lib/logging/service'

const roots: string[] = [], services: LogService[] = []
const realSetTimeout = setTimeout
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks()
  for (const service of services.splice(0)) await service.close()
  vi.doUnmock('../../../lib/logging/sqlite-worker'); vi.resetModules()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const anchor = 'try { parentPort.postMessage({ id, ok:true, result:execute(action,data) }) }'
async function fixture(treatment?: string, options: Partial<LogServiceOptions> = {}) {
  if (treatment) {
    expect(SQLITE_WORKER.split(anchor)).toHaveLength(2)
    const modified = SQLITE_WORKER.replace(anchor, treatment)
    expect(modified.replace(treatment, anchor)).toBe(SQLITE_WORKER)
    // Only test worker source is transformed: all transactions and real SQLite
    // I/O are unchanged. No product flags or injectable storage replacement.
    expect(createHash('sha256').update(modified).digest('hex')).not.toBe(createHash('sha256').update(SQLITE_WORKER).digest('hex'))
    vi.doMock('../../../lib/logging/sqlite-worker', () => ({ SQLITE_WORKER: modified }))
  }
  vi.resetModules()
  const { createLogService } = await import('../../../lib/logging/service')
  const root = mkdtempSync(join(tmpdir(), 'logging-write-outcome-180-')); roots.push(root)
  const service = createLogService({ directory: root, ...options }); services.push(service)
  return { service, root }
}
const emit = (service: LogService) => service.emit({ source: 'task', operation: 'task.finished', outcome: 'failure', taskId: 'write-outcome-task' })
function count(root: string, id: string) {
  const db = new Database(join(root, 'events.db'), { readonly: true, fileMustExist: true })
  try { return (db.prepare('SELECT count(*) n FROM log_events WHERE id=?').get(id) as { n: number }).n } finally { db.close() }
}

it('marks a real committed batch with a lost exit acknowledgement unknown and never replays it', async () => {
  const { service, root } = await fixture("try { const result=execute(action,data); if(action==='write') process.exit(0); parentPort.postMessage({id,ok:true,result}) }")
  const id = emit(service)!
  await service.flush()
  expect(count(root, id)).toBe(1)
  expect(service.status()).toMatchObject({ stored: 0, dropped: 0, writeUnknown: 1, queuedEntries: 0, inFlightEntries: 0, pending: 0, unavailable: true })
  expect((await service.list()).rows.map(row => row.id)).toEqual([id])
  await service.flush()
  expect(count(root, id)).toBe(1)
  expect(service.status().writeUnknown).toBe(1)
})

it('marks a real committed batch with a timed out acknowledgement unknown without claiming a drop', async () => {
  const { service, root } = await fixture("try { const result=execute(action,data); if(action==='write') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000); parentPort.postMessage({id,ok:true,result}) }")
  const id = emit(service)!
  await service.flush()
  expect(count(root, id)).toBe(1)
  expect(service.status()).toMatchObject({ stored: 0, dropped: 0, writeUnknown: 1, lastError: 'drain_timeout', pending: 0 })
  await service.close()
  expect(service.status()).toMatchObject({ dropped: 0, writeUnknown: 1, closed: true })
})

it('does not infer noncommit from an error acknowledgement sent after a real commit', async () => {
  const { service, root } = await fixture("try { const result=execute(action,data); if(action==='write') throw new Error('private_ack_failure'); parentPort.postMessage({id,ok:true,result}) }")
  const id = emit(service)!
  await service.flush()
  expect(count(root, id)).toBe(1)
  expect(service.status()).toMatchObject({ stored: 0, dropped: 0, writeUnknown: 1, lastError: 'storage_unavailable' })
})

it('counts a synchronous unsent message as a known drop and clears its pending timer', async () => {
  const { service, root } = await fixture()
  await service.policy() // Warm the actual worker before injecting the transport failure.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const original = Worker.prototype.postMessage
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, value, ...args: any[]) {
    if (value.action === 'write') throw new Error('private_unsent_failure')
    return original.call(this, value, ...args as [any])
  })
  const id = emit(service)!
  await service.flush()
  expect(count(root, id)).toBe(0)
  expect(service.status()).toMatchObject({ stored: 0, dropped: 1, writeUnknown: 0, pending: 0, lastError: 'storage_unavailable' })
  // The failed send did not leave a timer capable of killing a healthy worker.
  const failures = service.status().drainFailures
  await vi.advanceTimersByTimeAsync(2100)
  expect(service.status().drainFailures).toBe(failures)
  vi.useRealTimers()
  expect((await service.policy()).revision).toBe(0)
})

it('keeps confirmed insert rollback failures separate from uncertain acknowledgement failures', async () => {
  const { service, root } = await fixture()
  await service.policy()
  const db = new Database(join(root, 'events.db'))
  try { db.exec("CREATE TRIGGER reject_log BEFORE INSERT ON log_events BEGIN SELECT RAISE(ABORT,'private_abort'); END") } finally { db.close() }
  const id = emit(service)!
  await service.flush()
  expect(count(root, id)).toBe(0)
  expect(service.status()).toMatchObject({ dropped: 1, stored: 0, writeUnknown: 0, unavailable: true })
})

it('classifies the in flight commit at the close deadline as unknown while preserving acknowledged batches', async () => {
  const { service, root } = await fixture("try { const result=execute(action,data); if(action==='write' && data[0]?.operation==='close.second') return; parentPort.postMessage({id,ok:true,result}) }")
  await service.policy()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const original = Worker.prototype.postMessage
  let release: (() => void) | undefined, writes = 0
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, value, ...args: any[]) {
    if (value.action === 'write' && ++writes === 1) { release = () => original.call(this, value, ...args as [any]); return }
    return original.call(this, value, ...args as [any])
  })
  for (let i = 0; i < 64; i++) service.emit({ source: 'task', operation: 'close.first', outcome: 'success', resourceId: i })
  const last = service.emit({ source: 'task', operation: 'close.second', outcome: 'success' })!
  const closing = service.close()
  // Hold the first send until t=1500. Its real SQLite ACK then starts the
  // second call at t=1500, so close(t=3000) wins before call(t=3500).
  await vi.advanceTimersByTimeAsync(1500)
  expect(release).toBeTypeOf('function'); release!()
  const deadline = Date.now() + 3000
  while ((service.status().stored !== 64 || count(root, last) !== 1) && Date.now() < deadline) await new Promise(resolve => realSetTimeout(resolve, 5))
  expect(service.status().stored).toBe(64)
  expect(count(root, last)).toBe(1)
  await vi.advanceTimersByTimeAsync(1500)
  await closing
  expect(service.status()).toMatchObject({ stored: 64, dropped: 0, writeUnknown: 1, queuedEntries: 0, inFlightEntries: 0, pending: 0, closed: true })
})

it('counts a real BEGIN write lock rejection as known noncommit and never replays it after unlocking', async () => {
  const { service, root } = await fixture()
  await service.policy()
  const locker = new Database(join(root, 'events.db'))
  let id: string
  try {
    locker.exec('BEGIN IMMEDIATE')
    id = emit(service)!
    await service.flush()
    expect(service.status()).toMatchObject({ stored: 0, dropped: 1, writeUnknown: 0, pending: 0, unavailable: true })
  } finally { if (locker.inTransaction) locker.exec('ROLLBACK'); locker.close() }
  expect(count(root, id!)).toBe(0)
  await service.flush()
  expect(count(root, id!)).toBe(0)
  const recovered = emit(service)!
  await service.flush()
  expect(count(root, recovered)).toBe(1)
  expect(service.status()).toMatchObject({ stored: 1, dropped: 1, writeUnknown: 0, unavailable: false })
})
