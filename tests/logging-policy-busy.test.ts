import { afterEach, expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { SQLITE_WORKER } from '../lib/logging/sqlite-worker'
import { LOG_DEFAULTS } from '../lib/logging/contract'
import { defaultLogCollection } from '../lib/logging/policy'
import { safeLogEvent } from '../lib/logging/privacy'

const dirs: string[] = [], workers: Worker[] = [], peers: Database.Database[] = []
const base = { retentionDays: 7, maxBytes: LOG_DEFAULTS.maxBytes }
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.terminate()
  for (const db of peers.splice(0)) { if (db.inTransaction) db.exec('ROLLBACK'); db.close() }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Observation and the snapshot barrier exist only in this test's eval copy.
// No product message/action or workerData debug option is introduced.
function fixture(directory = mkdtempSync(join(tmpdir(), 'policy-busy-')), faultCode?: string, dangling = false) {
  if (!dirs.includes(directory)) dirs.push(directory)
  const barrier = new Int32Array(new SharedArrayBuffer(8))
  const source = SQLITE_WORKER
    .replace('let db\n', 'let opens=0, nativeCode; let db\n')
    .replace('db = new Database(path', 'opens++; db = new Database(path')
    .replace("const row = db.prepare('SELECT collection", `if (Atomics.compareExchange(new Int32Array(workerData.barrier),0,1,2)===1) {
      Atomics.notify(new Int32Array(workerData.barrier),0)
      Atomics.wait(new Int32Array(workerData.barrier),0,2,3000)
    }
    const row = db.prepare('SELECT collection`)
    .replace('  open()\n', `  open()
  if(workerData.faultCode && Atomics.exchange(new Int32Array(workerData.barrier),1,0)===1) {
    if(workerData.dangling) db.exec('BEGIN')
    throw Object.assign(new Error('test fault'),{code:workerData.faultCode})
  }
`)
    .replace('const code = failureCode(error)', 'nativeCode=error.code; const code = failureCode(error)')
    .replace("parentPort.on('message'", `const send=parentPort.postMessage.bind(parentPort)
parentPort.postMessage=message=>send({...message,observation:{opens,nativeCode,inTransaction:db?.inTransaction,open:db?.open}})
parentPort.on('message'`)
  const worker = new Worker(source, { eval: true, workerData: {
    directory, sqliteModule: createRequire(import.meta.url).resolve('better-sqlite3'),
    policy: base, maxEventBytes: LOG_DEFAULTS.maxEventBytes, stdout: true,
    barrier: barrier.buffer, faultCode, dangling,
  }, stdout: true })
  workers.push(worker)
  let output = ''
  worker.stdout!.on('data', chunk => { output += chunk.toString() })
  let id = 0
  return { directory, barrier, output: () => output, async call(action: string, data?: unknown, time = Date.now()): Promise<any> {
    const current = ++id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('worker command timeout')) }, 5000)
      const listener = (message: any) => { if (message.id === current) { cleanup(); resolve(message) } }
      const cleanup = () => { clearTimeout(timer); worker.off('message', listener); worker.off('error', reject) }
      worker.on('message', listener); worker.once('error', reject)
      worker.postMessage({ id: current, action, data, time })
    })
  } }
}
function peer(directory: string) {
  const db = new Database(join(directory, 'events.db'), { timeout: 0 }); peers.push(db); return db
}
const event = (operation: string) => safeLogEvent({ source: 'task', operation, outcome: 'failure', level: 'error' })

it('reads the old committed policy under a real writer lock without pruning or changing counters', async () => {
  const f = fixture()
  expect((await f.call('write', [event('snapshot.expired')])).result.stored).toBe(1)
  const db = peer(f.directory)
  db.exec('BEGIN IMMEDIATE; UPDATE log_policy SET retentionDays=3,pruned=8,cleared=9; UPDATE log_collection SET revision=4')
  const locked = await f.call('policy', undefined, Date.now() + 20 * 86400000)
  expect(locked).toMatchObject({ ok: true, result: { retentionDays: 7, revision: 0, pruned: 0, cleared: 0 }, observation: { opens: 1, inTransaction: false } })
  expect(locked.result.collection).toEqual(defaultLogCollection())
  expect(locked.result.storageBytes).toBeGreaterThan(0)
  db.exec('COMMIT') // Also proves GET released its read snapshot.
  expect((await f.call('policy')).result).toMatchObject({ retentionDays: 3, revision: 4, pruned: 8, cleared: 9 })
  expect(db.prepare('SELECT count(*) n FROM log_events').get()).toEqual({ n: 1 })
  expect((await f.call('maintain', undefined, Date.now() + 20 * 86400000)).ok).toBe(true)
  expect((await f.call('policy')).result).toMatchObject({ revision: 4, pruned: 9, cleared: 9 })
})

it('holds one read snapshot across policy collection revision and counters and releases it', async () => {
  const f = fixture(); await f.call('policy')
  const db = peer(f.directory)
  Atomics.store(f.barrier, 0, 1)
  const pending = f.call('policy')
  try {
    await expect.poll(() => Atomics.load(f.barrier, 0)).toBe(2)
    db.exec('BEGIN IMMEDIATE; UPDATE log_policy SET retentionDays=2,pruned=6,cleared=7')
    const collection = defaultLogCollection(); collection.sources.task.enabled = false
    db.prepare('UPDATE log_collection SET collection=?,revision=5').run(JSON.stringify(collection))
    expect(() => db.exec('COMMIT')).toThrow(/locked/)
  } finally { Atomics.store(f.barrier, 0, 3); Atomics.notify(f.barrier, 0) }
  expect(await pending).toMatchObject({ ok: true, result: { retentionDays: 7, revision: 0, pruned: 0, cleared: 0, collection: { sources: { task: { enabled: true } } } }, observation: { inTransaction: false } })
  db.exec('COMMIT')
  expect((await f.call('policy')).result).toMatchObject({ retentionDays: 2, revision: 5, pruned: 6, cleared: 7, collection: { sources: { task: { enabled: false } } } })
  db.exec('BEGIN EXCLUSIVE; ROLLBACK')
})

it('keeps a healthy hot connection after real BUSY and never authorizes a locked policy change or output', async () => {
  const f = fixture(); await f.call('policy')
  const db = peer(f.directory)
  db.exec('BEGIN IMMEDIATE')
  expect(await f.call('policy', { ...base, collection: { sources: { task: { enabled: false, minLevel: 'debug' } } } })).toMatchObject({ ok: false, observation: { nativeCode: 'SQLITE_BUSY' } })
  expect(await f.call('write', [event('busy.denied')])).toMatchObject({ ok: false, observation: { nativeCode: 'SQLITE_BUSY', inTransaction: false } })
  expect(await f.call('policy')).toMatchObject({ ok: true, result: { revision: 0, collection: { sources: { task: { enabled: true } } } }, observation: { opens: 1, inTransaction: false } })
  db.exec('ROLLBACK')
  expect((await f.call('write', [event('busy.recovered')])).result.stored).toBe(1)
  expect(f.output()).not.toContain('busy.denied')
  expect((await f.call('policy', { ...base, collection: { sources: { task: { enabled: false, minLevel: 'debug' } } } })).result.revision).toBe(1)
  expect((await f.call('write', [event('busy.disabled')])).result).toMatchObject({ stored: 0, filtered: 1 })
  expect(f.output()).not.toContain('busy.disabled')
})

it('discards partial open on real BUSY and retries complete initialization after release', async () => {
  const seed = fixture(); await seed.call('policy'); await seed.call('close')
  const db = peer(seed.directory); db.exec('BEGIN IMMEDIATE')
  const cold = fixture(seed.directory)
  expect(await cold.call('policy')).toMatchObject({ ok: false, observation: { nativeCode: 'SQLITE_BUSY', opens: 1 } })
  db.exec('ROLLBACK')
  expect(await cold.call('policy')).toMatchObject({ ok: true, observation: { opens: 2, inTransaction: false } })
})

it('rolls back a failed read snapshot and fails closed under an exclusive lock', async () => {
  const f = fixture(); await f.call('policy')
  const db = peer(f.directory)
  db.prepare('UPDATE log_collection SET collection=?').run('{')
  expect(await f.call('policy')).toMatchObject({ ok: false, observation: { inTransaction: false } })
  db.exec('BEGIN EXCLUSIVE') // The failed SELECT transaction must have released its lock.
  db.prepare('UPDATE log_collection SET collection=?').run(JSON.stringify(defaultLogCollection()))
  db.exec('COMMIT')
  expect((await f.call('policy')).ok).toBe(true)
  db.exec('BEGIN EXCLUSIVE')
  expect(await f.call('write', [event('exclusive.failclosed')])).toMatchObject({ ok: false, observation: { nativeCode: 'SQLITE_BUSY' } })
  expect(await f.call('policy')).toMatchObject({ ok: false })
  db.exec('ROLLBACK')
  expect(await f.call('policy')).toMatchObject({ ok: true, observation: { opens: 2, inTransaction: false } })
  expect(f.output()).not.toContain('exclusive.failclosed')
})

it('rolls back a real BUSY at write commit before reusing the connection', async () => {
  const f = fixture(); await f.call('policy')
  const db = peer(f.directory)
  db.exec('BEGIN'); db.prepare('SELECT * FROM log_events').all()
  expect(await f.call('write', [event('commit.busy')])).toMatchObject({ ok: false, observation: { nativeCode: 'SQLITE_BUSY', inTransaction: false } })
  db.exec('ROLLBACK')
  expect(db.prepare('SELECT count(*) n FROM log_events').get()).toEqual({ n: 0 })
  expect(await f.call('policy')).toMatchObject({ ok: true, observation: { opens: 1, inTransaction: false } })
  expect((await f.call('write', [event('commit.recovered')])).result.stored).toBe(1)
  expect(db.prepare('SELECT count(*) n FROM log_events').get()).toEqual({ n: 1 })
})

it.each(['SQLITE_BUSY', 'SQLITE_BUSY_RECOVERY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_BUSY_TIMEOUT'])('retains an initialized healthy connection for the explicit busy code %s', async code => {
  const f = fixture(undefined, code); await f.call('policy')
  Atomics.store(f.barrier, 1, 1)
  expect((await f.call('policy')).ok).toBe(false)
  expect(await f.call('policy')).toMatchObject({ ok: true, observation: { opens: 1, inTransaction: false } })
})

it.each(['SQLITE_READONLY', 'SQLITE_FULL', 'SQLITE_IOERR', 'SQLITE_BUSY_UNKNOWN', 'UNKNOWN', 'foreign_database'])('isolates the connection for conservative error code %s', async code => {
  const f = fixture(undefined, code); await f.call('policy')
  Atomics.store(f.barrier, 1, 1)
  expect((await f.call('policy')).ok).toBe(false)
  expect(await f.call('policy')).toMatchObject({ ok: true, observation: { opens: 2, inTransaction: false } })
})

it('discards a connection with a dangling transaction even for BUSY', async () => {
  const f = fixture(undefined, 'SQLITE_BUSY', true); await f.call('policy')
  Atomics.store(f.barrier, 1, 1)
  expect((await f.call('policy')).ok).toBe(false)
  expect(await f.call('policy')).toMatchObject({ ok: true, observation: { opens: 2, inTransaction: false } })
})
