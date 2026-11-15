import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import Database from 'better-sqlite3'
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { SQLITE_WORKER } from '../../../lib/logging/sqlite-worker'
import { createLogService, validatePolicy, type LogService } from '../../../lib/logging/service'
import { LOG_DEFAULTS, LOG_LEVELS, type LogInput, type LogPolicyPatch } from '../../../lib/logging/contract'
import { LOG_FIELD_PROFILES, defaultFieldControls } from '../../../lib/logging/field-controls'
import { defaultLogCollection } from '../../../lib/logging/policy'
import { safeLogEvent } from '../../../lib/logging/privacy'

const workers: Worker[] = []
const dirs: string[] = [], services: LogService[] = [], children: ChildProcess[] = []
const base = { retentionDays: 7, maxBytes: LOG_DEFAULTS.maxBytes }
const fields = LOG_FIELD_PROFILES[0].fields.map(f => f.key)
const origin = { runtime: 'node', integration: 'nuxt-nitro', capture: 'framework' } as const
const input = (operation = 'field.event', level: typeof LOG_LEVELS[number] = 'info'): LogInput => ({ source: 'http', operation, outcome: 'failure', level, httpMethod: 'GET', httpRoute: '/api/health', statusCode: 503, durationMs: 0, errorCode: 'upstream_failed', counts: { done: 0 }, origin })
const patch = (fieldControls: unknown) => ({ ...base, fieldControls }) as LogPolicyPatch
function fixture(directory = mkdtempSync(join(tmpdir(), 'field-policy-')), maxEventBytes?: number) {
  if (!dirs.includes(directory)) dirs.push(directory)
  const service = createLogService({ directory, flushIntervalMs: 100, maxEventBytes }); services.push(service)
  return { service, directory }
}
function edit(directory: string, change: (db: Database.Database) => void) {
  const db = new Database(join(directory, 'events.db')); try { change(db) } finally { db.close() }
}
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.terminate()
  for (const c of children.splice(0)) { c.kill('SIGKILL'); await new Promise<void>(r => c.exitCode !== null || c.signalCode !== null ? r() : c.once('exit', () => r())) }
  for (const s of services.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
async function childWriter(directory: string, maxEventBytes: number = LOG_DEFAULTS.maxEventBytes) {
  const script = join(directory, 'field-child.mjs')
  const jiti = createRequire(import.meta.resolve('nuxt/package.json')).resolve('jiti')
  writeFileSync(script, `
import {createRequire} from 'node:module'
const {createJiti}=createRequire(import.meta.url)(${JSON.stringify(jiti)})
const {createLogService}=await createJiti(import.meta.url).import(${JSON.stringify(resolve('lib/logging/service.ts'))})
const service=createLogService({directory:${JSON.stringify(directory)},stdout:true,flushIntervalMs:100,maxEventBytes:${maxEventBytes}})
process.on('message',async m=>{
 try {
  let result
  if(m.type==='emit') { result=service.emit(m.input); if(!m.queue) await service.flush() }
  if(m.type==='flush') await service.flush()
  if(m.type==='policy') result=await service.policy()
  if(m.type==='close') await service.close()
  process.send({id:m.id,result,status:service.status()})
 } catch(e) {process.send({id:m.id,error:e.code})}
})
process.send({ready:true})
`)
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child)
  let output = '', errors = '', serial = 0
  child.stdout!.on('data', c => { output += c.toString() }); child.stderr!.on('data', c => { errors += c.toString() })
  await new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error(errors))) })
  return { output: () => output, errors: () => errors, async send(type: string, payload: Record<string, unknown> = {}): Promise<any> {
    const id = ++serial
    return new Promise((resolve, reject) => {
      const listener = (m: any) => { if (m.id === id) { clearTimeout(timer); child.off('message', listener); resolve(m) } }
      const timer = setTimeout(() => { child.off('message', listener); reject(new Error('field child timeout: ' + errors)) }, 5000)
      child.on('message', listener); child.send({ id, type, ...payload })
    })
  } }
}

it('publishes HTTP complete defaults and preserves identity history restart and old PATCH preferences', async () => {
  const { service, directory } = fixture()
  expect(await service.policy()).toMatchObject({ fieldControls: defaultFieldControls(LOG_FIELD_PROFILES), catalog: { profiles: LOG_FIELD_PROFILES } })
  const id = service.emit(input())!; await service.flush()
  const historical = await service.detail(id)
  expect(historical).not.toHaveProperty('fieldCapture')
  expect(await service.setPolicy(patch({ http: { info: { httpRoute: false } } }))).toMatchObject({ catalog: { profiles: LOG_FIELD_PROFILES }, fieldControls: { http: { info: { httpRoute: false } } } })
  await service.setPolicy({ ...base, retentionDays: 3 })
  expect(await service.policy()).toMatchObject({ revision: 2, fieldControls: { http: { info: { httpRoute: false } } } })
  expect(await service.detail(id)).toEqual(historical)
  expect((await service.list({ source: 'http' })).rows[0]).toEqual(historical)
  await service.close()
  const next = fixture(directory).service
  expect(await next.policy()).toMatchObject({ revision: 2, retentionDays: 3, fieldControls: { http: { info: { httpRoute: false } } } })
  expect(await next.detail(id)).toEqual(historical)
})

for (const level of LOG_LEVELS) it(`writer ${level} persists and outputs each disabled field with identical capture`, async () => {
  const { service, directory } = fixture(); await service.policy()
  const child = await childWriter(directory)
  for (const field of fields) {
    const controls = Object.fromEntries(fields.map(key => [key, key !== field]))
    await service.setPolicy(patch({ http: { [level]: controls } }))
    const revision = (await service.policy()).revision
    const emitted = await child.send('emit', { input: input(`field.${field.toLowerCase()}`, level) })
    const detail = await service.detail(emitted.result)
    expect(detail).not.toHaveProperty(field)
    for (const other of fields.filter(key => key !== field)) expect(detail).toHaveProperty(other, input()[other])
    expect(detail).toMatchObject({ id: emitted.result, level, outcome: 'failure', errorCode: 'upstream_failed', counts: { done: 0 }, origin, fieldCapture: { profile: 'http', revision, disabled: [field] } })
    expect((await service.list({ operation: `field.${field.toLowerCase()}` })).rows[0]).toEqual(detail)
    await expect.poll(() => child.output().split('\n').filter(Boolean).map(line => JSON.parse(line)).find(e => e.id === emitted.result)).toEqual(detail)
  }
  await child.send('close')
})

it('applies AND before field capture and authorizes old queues using latest policy', async () => {
  const { service, directory } = fixture(); await service.policy()
  const child = await childWriter(directory)
  await child.send('emit', { input: input('queue.latest'), queue: true })
  await service.setPolicy(patch({ http: { info: { httpRoute: false, durationMs: false } } }))
  await child.send('flush')
  const latest = (await service.list({ operation: 'queue.latest' })).rows[0]
  expect(latest).not.toHaveProperty('httpRoute'); expect(latest).not.toHaveProperty('durationMs')
  expect(latest).toMatchObject({ fieldCapture: { revision: 1, disabled: ['httpRoute', 'durationMs'] } })
  for (const dimension of ['sources', 'integrations'] as const) {
    const key = dimension === 'sources' ? 'http' : 'nuxt-nitro'
    await service.setPolicy({ ...base, collection: { [dimension]: { [key]: { enabled: false, minLevel: 'debug' } } } })
    const result = await child.send('emit', { input: input(`and.${dimension}`) })
    expect(result.status).toMatchObject({ filtered: dimension === 'sources' ? 1 : 2, dropped: 0, oversized: 0 })
    expect((await service.list({ operation: `and.${dimension}` })).rows).toEqual([])
    expect(child.output()).not.toContain(`and.${dimension}`)
    await service.setPolicy({ ...base, collection: { [dimension]: { [key]: { enabled: true, minLevel: 'debug' } } } })
  }
  for (const dimension of ['sources', 'integrations'] as const) {
    const key = dimension === 'sources' ? 'http' : 'nuxt-nitro'
    await service.setPolicy({ ...base, collection: { [dimension]: { [key]: { enabled: true, minLevel: 'warn' } } } })
    const result = await child.send('emit', { input: input(`threshold.${dimension}`) })
    expect(result.status).toMatchObject({ filtered: dimension === 'sources' ? 3 : 4, dropped: 0, oversized: 0 })
    expect((await service.list({ operation: `threshold.${dimension}` })).rows).toEqual([])
    expect(child.output()).not.toContain(`threshold.${dimension}`)
    await service.setPolicy({ ...base, collection: { [dimension]: { [key]: { enabled: true, minLevel: 'debug' } } } })
  }
  await child.send('close')
})

it('merges distinct concurrent leaves and orders same leaf writes with one shared revision', async () => {
  const { service, directory } = fixture(); const peer = fixture(directory).service
  await service.policy(); await peer.policy()
  await Promise.all([service.setPolicy(patch({ http: { info: { httpRoute: false } } })), peer.setPolicy(patch({ http: { info: { statusCode: false }, warn: { durationMs: false } } }))])
  expect(await peer.policy()).toMatchObject({ revision: 2, fieldControls: { http: { info: { httpRoute: false, statusCode: false }, warn: { durationMs: false } } } })
  await service.setPolicy(patch({ http: { info: { httpRoute: true } } }))
  await peer.setPolicy(patch({ http: { info: { httpRoute: false } } }))
  expect(await service.policy()).toMatchObject({ revision: 4, fieldControls: { http: { info: { httpRoute: false, statusCode: false } } } })
})

it('migrates legacy under concurrent first opens preserving revision and management preferences', async () => {
  const { service, directory } = fixture(); await service.policy(); await service.close()
  const collection = defaultLogCollection(); collection.sources.http.minLevel = 'warn'; collection.integrations.application.enabled = false
  edit(directory, db => db.prepare('UPDATE log_collection SET collection=?,revision=19').run(JSON.stringify(collection)))
  const first = fixture(directory).service, second = fixture(directory).service
  const snapshots = await Promise.all([first.policy(), second.policy()])
  for (const snapshot of snapshots) expect(snapshot).toMatchObject({ revision: 19, collection, fieldControls: defaultFieldControls(LOG_FIELD_PROFILES) })
  await Promise.all([first.setPolicy(patch({ http: { error: { httpRoute: false } } })), second.setPolicy(patch({ http: { warn: { statusCode: false } } }))])
  expect(await first.policy()).toMatchObject({ revision: 21, collection, fieldControls: { http: { error: { httpRoute: false }, warn: { statusCode: false } } } })
  edit(directory, db => { const saved = JSON.parse((db.prepare('SELECT collection FROM log_collection').get() as any).collection); expect(saved.version).toBe(2); expect(saved.collection).toEqual(collection); expect(saved.fieldControls.http.error.httpRoute).toBe(false) })
})

it('strips forged capture at public emit and records disabled missing fields as configuration only', async () => {
  const { service } = fixture()
  const forged = { ...input(), fieldCapture: { profile: 'http', revision: 900, disabled: ['httpRoute'] } }
  expect(safeLogEvent(forged)).not.toHaveProperty('fieldCapture')
  const id = service.emit(forged)!; await service.flush()
  expect(await service.detail(id)).not.toHaveProperty('fieldCapture')
  await service.setPolicy(patch({ http: { info: { httpRoute: false } } }))
  const missing = service.emit({ source: 'http', operation: 'missing.fields', outcome: 'success' })!; await service.flush()
  expect(await service.detail(missing)).toMatchObject({ id: missing, fieldCapture: { profile: 'http', revision: 1, disabled: ['httpRoute'] } })
  const mcp = service.emit({ ...forged, source: 'mcp' })!; await service.flush()
  expect(await service.detail(mcp)).toMatchObject({ httpRoute: input().httpRoute }); expect(await service.detail(mcp)).not.toHaveProperty('fieldCapture')
})

it('permits only projected bounded stdout after real storage ABORT and ROLLBACK and suppresses unreadable policy', async () => {
  const { service, directory } = fixture(); await service.setPolicy(patch({ http: { info: { httpRoute: false } } }))
  const child = await childWriter(directory)
  await child.send('policy')
  for (const action of ['ABORT', 'ROLLBACK']) {
    edit(directory, db => db.exec(`CREATE TRIGGER fail_event BEFORE INSERT ON log_events BEGIN SELECT RAISE(${action},'test'); END`))
    const sent = await child.send('emit', { input: input(`storage.${action.toLowerCase()}`) })
    expect(sent.status).toMatchObject({ unavailable: true, stored: 0, dropped: action === 'ABORT' ? 1 : 2 })
    expect(await service.detail(sent.result)).toBeNull()
    expect((await service.list({ operation: `storage.${action.toLowerCase()}` })).rows).toEqual([])
    await expect.poll(() => child.output().split('\n').filter(Boolean).map(line => JSON.parse(line)).find(e => e.id === sent.result)).toMatchObject({ fieldCapture: { revision: 1, disabled: ['httpRoute'] } })
    expect(child.output()).not.toContain('/api/health')
    edit(directory, db => db.exec('DROP TRIGGER fail_event'))
  }
  edit(directory, db => db.prepare('UPDATE log_collection SET collection=?').run('{'))
  const failed = await child.send('emit', { input: input('policy.corrupt') })
  expect(failed.status.dropped).toBe(3)
  expect(child.output()).not.toContain('policy.corrupt')
  await child.send('close')
})

for (const corruption of ['missing controls', 'missing profile', 'missing level', 'missing field', 'missing version', 'extra envelope key', 'missing integration', 'missing source', 'invalid revision', 'unknown version', 'unknown profile', 'invalid leaf'] as const) it(`fails closed for persisted ${corruption}`, async () => {
  const { service, directory } = fixture(); await service.policy(); await service.close()
  const stored: any = { version: 2, collection: defaultLogCollection(), fieldControls: defaultFieldControls(LOG_FIELD_PROFILES) }
  if (corruption === 'missing controls') delete stored.fieldControls
  if (corruption === 'missing profile') delete stored.fieldControls.http
  if (corruption === 'missing level') delete stored.fieldControls.http.info
  if (corruption === 'missing version') delete stored.version
  if (corruption === 'extra envelope key') stored.extra = true
  if (corruption === 'missing integration') delete stored.collection.integrations.drizzle
  if (corruption === 'missing source') delete stored.collection.sources.http
  if (corruption === 'missing field') delete stored.fieldControls.http.info.httpRoute
  if (corruption === 'unknown version') stored.version = 99
  if (corruption === 'unknown profile') stored.fieldControls.future = {}
  if (corruption === 'invalid leaf') stored.fieldControls.http.info.httpRoute = null
  edit(directory, db => db.prepare('UPDATE log_collection SET collection=?').run(JSON.stringify(stored)))
  if (corruption === 'invalid revision') edit(directory, db => db.exec('UPDATE log_collection SET revision=-1'))
  const next = fixture(directory).service
  await expect(next.policy()).rejects.toThrow('storage_unavailable')
  next.emit(input('corrupt.event')); await next.flush()
  expect(next.status()).toMatchObject({ stored: 0, dropped: 1, unavailable: true })
  const child = await childWriter(directory)
  const sent = await child.send('emit', { input: input('corrupt.stdout') })
  expect(sent.status).toMatchObject({ stored: 0, dropped: 1, unavailable: true })
  await child.send('close'); expect(child.output()).toBe('')
})

it('validates closed partial field arguments and serialized policy budget without accepting accessors', () => {
  expect(validatePolicy(patch({ http: { info: { httpRoute: false } } }))).toEqual(patch({ http: { info: { httpRoute: false } } }))
  for (const controls of [{ future: {} }, { http: { trace: {} } }, { http: { info: { httpRoute: 0 } } }, null, []]) expect(() => validatePolicy(patch(controls))).toThrow('invalid_log_input')
  expect(() => validatePolicy({ ...patch({}), extra: 'x'.repeat(5000) })).toThrow('invalid_log_input')
  const maximal = { ...base, collection: defaultLogCollection(), fieldControls: defaultFieldControls(LOG_FIELD_PROFILES) }
  expect(Buffer.byteLength(JSON.stringify(maximal), 'utf8')).toBeLessThanOrEqual(4096)
  expect(validatePolicy(maximal)).toEqual(maximal)
  let reads = 0
  const hostile = { ...base, get fieldControls() { reads++; return {} } }
  expect(() => validatePolicy(hostile)).toThrow('invalid_log_input'); expect(reads).toBe(0)
})

for (const delta of [-1, 0, 1]) it(`enforces final capture byte budget with margin ${delta}`, async () => {
  const event = input('budget.capture'); delete event.httpRoute
  const original = safeLogEvent(event)
  const expected = { ...original, fieldCapture: { profile: 'http', revision: 1, disabled: ['httpRoute'] } }
  const finalBytes = Buffer.byteLength(JSON.stringify(expected), 'utf8')
  expect(Buffer.byteLength(JSON.stringify(original), 'utf8')).toBeLessThan(finalBytes - 1)
  const { service, directory } = fixture(); await service.setPolicy(patch({ http: { info: { httpRoute: false } } }))
  const child = await childWriter(directory, finalBytes + delta)
  const sent = await child.send('emit', { input: event })
  expect(sent.result).toMatch(/^[0-9a-f-]{36}$/)
  if (delta < 0) {
    expect(sent.status).toMatchObject({ accepted: 1, stored: 0, oversized: 1, dropped: 1, filtered: 0, fallbackSkipped: 0 })
    expect((await service.list({ operation: 'budget.capture' })).rows).toEqual([])
    await child.send('close'); expect(child.output()).toBe('')
  } else {
    expect(sent.status).toMatchObject({ accepted: 1, stored: 1, oversized: 0, dropped: 0, filtered: 0 })
    const detail = await service.detail(sent.result)
    expect(Buffer.byteLength(JSON.stringify(detail), 'utf8')).toBe(finalBytes)
    await expect.poll(() => child.output().split('\n').filter(Boolean).map(line => JSON.parse(line))[0]).toEqual(detail)
    await child.send('close')
  }
})


// Only synchronization/observation is injected into the real eval worker. SQLite
// triggers below produce the native ROLLBACK/FULL failures; no policy algorithm is mirrored.
function controlledWriter(directory: string, branch: 'rollback' | 'full') {
  const barrier = new Int32Array(new SharedArrayBuffer(4))
  const pause = `if(Atomics.compareExchange(new Int32Array(workerData.barrier),0,1,2)===1) {
    Atomics.notify(new Int32Array(workerData.barrier),0)
    Atomics.wait(new Int32Array(workerData.barrier),0,2,5000)
  }`
  const anchor = branch === 'rollback' ? "          db.exec('BEGIN IMMEDIATE')" : "      deleted('1=1', [], 'pruned')"
  expect(SQLITE_WORKER.split(anchor)).toHaveLength(2)
  const fullAnchor = "if (error.code === 'SQLITE_FULL' && !retry) throw error"
  const fullObservation = "if(error.code==='SQLITE_FULL') parentPort.postMessage({nativeFull:true}); " + fullAnchor
  expect(SQLITE_WORKER.split(fullAnchor)).toHaveLength(2)
  const source = SQLITE_WORKER.replace(anchor, pause + '\n' + anchor).replace(fullAnchor, fullObservation)
  // Exact inverse must recover every byte of the original runtime source.
  expect(source.replace(pause + '\n' + anchor, anchor).replace(fullObservation, fullAnchor)).toBe(SQLITE_WORKER)
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
  process.stderr.write(JSON.stringify({ kind: 'field-policy-test-only-instrumentation', branch,
    originalSHA256: sha256(SQLITE_WORKER), injectedSHA256: sha256(source),
    patches: [{ anchor, insertion: pause + '\n', matches: 1 }, { anchor: fullAnchor, insertion: fullObservation.slice(0, -fullAnchor.length), matches: 1 }],
  }) + '\n')
  const worker = new Worker(source, { eval: true, stdout: true, workerData: {
    directory, barrier: barrier.buffer, sqliteModule: createRequire(import.meta.url).resolve('better-sqlite3'),
    policy: base, maxEventBytes: LOG_DEFAULTS.maxEventBytes, stdout: true,
  } }); workers.push(worker)
  let output = '', serial = 0, nativeFull = 0
  worker.stdout!.on('data', c => { output += c.toString() })
  worker.on('message', m => { if (m.nativeFull) nativeFull++ })
  return { barrier, output: () => output, nativeFull: () => nativeFull, async call(action: string, data?: unknown): Promise<any> {
    const id = ++serial
    return new Promise((resolve, reject) => {
      const listener = (message: any) => { if (message.id === id) { clearTimeout(timer); worker.off('message', listener); resolve(message) } }
      const timer = setTimeout(() => { worker.off('message', listener); reject(new Error('controlled writer timeout')) }, 7000)
      worker.on('message', listener); worker.once('error', reject)
      worker.postMessage({ id, action, data, time: Date.now() })
    })
  } }
}

for (const branch of ['rollback', 'full'] as const) it(`reprojects originals after real SQLite ${branch} releases authorization`, async () => {
  const { service, directory } = fixture()
  const capacity = branch === 'full' ? 1048576 : base.maxBytes
  await service.setPolicy({ ...patch({ http: { info: { httpRoute: false } } }), maxBytes: capacity })
  await service.flush()
  const writer = controlledWriter(directory, branch)
  expect((await writer.call('policy')).ok).toBe(true)
  edit(directory, db => {
    if (branch === 'full') db.exec('CREATE TABLE filler (data BLOB); CREATE TRIGGER fail_event BEFORE INSERT ON log_events BEGIN INSERT INTO filler VALUES(randomblob(2000000)); END')
    else db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON log_events BEGIN SELECT RAISE(ROLLBACK,'test'); END")
  })
  Atomics.store(writer.barrier, 0, 1)
  const original = safeLogEvent(input(`reauthorize.${branch}`))
  const pending = writer.call('write', [original])
  try {
    await expect.poll(() => Atomics.load(writer.barrier, 0)).toBe(2)
    await service.setPolicy({ ...patch({ http: { info: { httpRoute: true, statusCode: false } } }), maxBytes: capacity })
  } finally { Atomics.store(writer.barrier, 0, 3); Atomics.notify(writer.barrier, 0) }
  const result = await pending
  expect(result).toMatchObject({ ok: true, result: { stored: 0, filtered: 0, oversized: 0, code: branch === 'full' ? 'storage_full' : 'storage_unavailable' } })
  await expect.poll(() => writer.output().split('\n').filter(Boolean).map(line => JSON.parse(line)).find(e => e.id === original.id)).toMatchObject({ id: original.id, timestamp: original.timestamp, httpRoute: '/api/health', fieldCapture: { revision: 2, disabled: ['statusCode'] } })
  const emitted = JSON.parse(writer.output().trim())
  const { statusCode: _status, ...retained } = original
  expect(emitted).toEqual({ ...retained, fieldCapture: { profile: 'http', revision: 2, disabled: ['statusCode'] } })
  expect((await service.list({ operation: `reauthorize.${branch}` })).rows).toEqual([])
  if (branch === 'full') expect(writer.nativeFull()).toBe(2)
  edit(directory, db => db.exec('DROP TRIGGER fail_event'))
  expect((await writer.call('close')).ok).toBe(true)
})


it('races legacy migration with a first management write without replacing its committed fields', async () => {
  const { service, directory } = fixture(); await service.policy(); await service.close()
  const collection = defaultLogCollection(); collection.sources.http.enabled = false
  delete (collection.integrations as Partial<typeof collection.integrations>).drizzle
  edit(directory, db => db.prepare('UPDATE log_collection SET collection=?,revision=27').run(JSON.stringify(collection)))
  const reader = fixture(directory).service, manager = fixture(directory).service
  await Promise.all([reader.policy(), manager.setPolicy(patch({ http: { info: { httpRoute: false } } }))])
  const latest = await reader.policy()
  expect(latest).toMatchObject({ revision: 28, collection: { sources: { http: { enabled: false } }, integrations: { drizzle: { enabled: true, minLevel: 'debug' } } }, fieldControls: { http: { info: { httpRoute: false } } } })
  await reader.close(); await manager.close()
  expect(await fixture(directory).service.policy()).toMatchObject({ revision: 28, fieldControls: latest.fieldControls, collection: latest.collection })
})

for (const format of ['legacy', 'v1', 'v2'] as const) it(`TUS policy ${format} open and concurrent PATCH preserves revision preferences restart and history`, async () => {
  const { service, directory } = fixture()
  const historyId = service.emit(input('migration.history'))!; await service.flush(); const history = await service.detail(historyId)
  await service.close()
  const collection = defaultLogCollection(); collection.sources.http.minLevel = 'warn'; collection.integrations.tus.enabled = false
  const controls: any = { ...defaultFieldControls(LOG_FIELD_PROFILES), tus: Object.fromEntries(LOG_LEVELS.map(level => [level, { 'tus.method': true, 'tus.uploadId': true, 'tus.size': true, 'tus.offset': true }])) }
  controls.http.info.httpRoute = false
  if (format === 'v2') controls.tus.info['tus.uploadId'] = false
  const persisted = format === 'legacy' ? collection : { version: format === 'v1' ? 1 : 2, collection, fieldControls: format === 'v1' ? { http: controls.http } : controls }
  edit(directory, db => db.prepare('UPDATE log_collection SET collection=?,revision=40').run(JSON.stringify(persisted)))
  let reader = fixture(directory).service, manager = fixture(directory).service
  const opened = await Promise.all([reader.policy(), manager.policy()])
  for (const policy of opened) {
    expect(policy).toMatchObject({ revision: 40, collection })
    expect(policy.fieldControls.http.info.httpRoute).toBe(format === 'legacy')
    expect((policy.fieldControls as any).tus.info['tus.uploadId']).toBe(format !== 'v2')
  }
  await reader.close(); await manager.close()
  edit(directory, db => db.prepare('UPDATE log_collection SET collection=?,revision=40').run(JSON.stringify(persisted)))
  reader = fixture(directory).service; manager = fixture(directory).service
  const cold = fixture(directory).service
  // Both first opens and the first management write compete over the original format.
  await Promise.all([reader.policy(), manager.setPolicy(patch({ tus: { warn: { 'tus.method': false } } }))])
  await Promise.all([reader.setPolicy(patch({ http: { error: { durationMs: false } } })), manager.setPolicy(patch({ tus: { info: { 'tus.offset': false } } }))])
  const latest = await reader.policy()
  expect(latest).toMatchObject({ revision: 43, collection, fieldControls: { http: { error: { durationMs: false } }, tus: { warn: { 'tus.method': false }, info: { 'tus.offset': false } } } })
  expect(latest.fieldControls.http.info.httpRoute).toBe(format === 'legacy')
  expect((latest.fieldControls as any).tus.info['tus.uploadId']).toBe(format !== 'v2')
  await manager.setPolicy(base); expect((await cold.policy()).fieldControls).toEqual(latest.fieldControls)
  expect(await reader.detail(historyId)).toEqual(history)
  edit(directory, db => { const saved = JSON.parse((db.prepare('SELECT collection FROM log_collection').get() as any).collection); expect(saved.version).toBe(2); expect(Object.keys(saved.fieldControls)).toEqual(['http', 'tus']) })
  await reader.close(); await manager.close(); await cold.close()
  const restarted = fixture(directory).service
  expect(await restarted.policy()).toMatchObject({ revision: 44, fieldControls: latest.fieldControls, collection })
  expect(await restarted.detail(historyId)).toEqual(history)
})
for (const corruption of ['v1 extra tus', 'v1 unknown profile', 'v1 missing http', 'v1 missing HTTP leaf', 'v2 missing http', 'v2 missing tus', 'v2 missing TUS level', 'v2 missing TUS leaf', 'v2 invalid TUS boolean', 'v2 unknown version'] as const) it(`TUS policy rejects ${corruption} without fallback or event stdout`, async () => {
  const { service, directory } = fixture(); await service.policy(); await service.close()
  const controls: any = { ...defaultFieldControls(LOG_FIELD_PROFILES), tus: Object.fromEntries(LOG_LEVELS.map(level => [level, { 'tus.method': true, 'tus.uploadId': true, 'tus.size': true, 'tus.offset': true }])) }
  const stored: any = { version: corruption.startsWith('v1') ? 1 : 2, collection: defaultLogCollection(), fieldControls: corruption.startsWith('v1') ? { http: controls.http } : controls }
  if (corruption === 'v1 extra tus') stored.fieldControls.tus = Object.fromEntries(LOG_LEVELS.map(l => [l, { 'tus.method': true, 'tus.uploadId': true, 'tus.size': true, 'tus.offset': true }]))
  if (corruption === 'v1 unknown profile') stored.fieldControls.future = {}
  if (corruption === 'v1 missing http') delete stored.fieldControls.http
  if (corruption === 'v2 invalid TUS boolean') stored.fieldControls.tus.info['tus.method'] = 0
  if (corruption === 'v1 missing HTTP leaf') delete stored.fieldControls.http.info.httpRoute
  if (corruption === 'v2 missing http') delete stored.fieldControls.http
  if (corruption === 'v2 missing tus') delete stored.fieldControls.tus
  if (corruption === 'v2 missing TUS level') delete stored.fieldControls.tus.info
  if (corruption === 'v2 missing TUS leaf') delete stored.fieldControls.tus.info['tus.uploadId']
  if (corruption === 'v2 unknown version') stored.version = 99
  edit(directory, db => db.prepare('UPDATE log_collection SET collection=?,revision=51').run(JSON.stringify(stored)))
  const next = fixture(directory).service; await expect(next.policy()).rejects.toThrow('storage_unavailable')
  const child = await childWriter(directory); const result = await child.send('emit', { input: input('invalid.tus.policy') })
  expect(result.status).toMatchObject({ stored: 0, dropped: 1, unavailable: true }); await child.send('close'); expect(child.output()).toBe('')
})

it('TUS writer reauthorizes original nested values after real rollback', async () => {
  const { service, directory } = fixture()
  await service.setPolicy(patch({ tus: { info: { 'tus.uploadId': false } } })); await service.flush()
  const writer = controlledWriter(directory, 'rollback'); expect((await writer.call('policy')).ok).toBe(true)
  edit(directory, db => db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON log_events BEGIN SELECT RAISE(ROLLBACK,'test'); END"))
  const original = safeLogEvent({ source: 'file', operation: 'file.upload', outcome: 'success', origin: { runtime: 'node', integration: 'tus', capture: 'hook' }, tus: { uploadId: 'c'.repeat(32), phase: 'completed', method: 'PATCH', size: 19, offset: 19 }, counts: { done: 0 } })
  Atomics.store(writer.barrier, 0, 1)
  const pending = writer.call('write', [original])
  try {
    await expect.poll(() => Atomics.load(writer.barrier, 0)).toBe(2)
    await service.setPolicy(patch({ tus: { info: { 'tus.uploadId': true, 'tus.method': false } } }))
  } finally { Atomics.store(writer.barrier, 0, 3); Atomics.notify(writer.barrier, 0) }
  expect(await pending).toMatchObject({ ok: true, result: { stored: 0, filtered: 0, oversized: 0, code: 'storage_unavailable' } })
  const { method: _method, ...retained } = original.tus!
  await expect.poll(() => writer.output().split('\n').filter(Boolean).map(line => JSON.parse(line))[0]).toEqual({ ...original, tus: retained, fieldCapture: { profile: 'tus', revision: 2, disabled: ['tus.method'] } })
  expect(await service.detail(original.id)).toBeNull()
  edit(directory, db => db.exec('DROP TRIGGER fail_event')); expect((await writer.call('close')).ok).toBe(true)
})
