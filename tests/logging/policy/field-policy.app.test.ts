import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import { createPostgresLogService } from '../../../layers/core/lib/logging/postgres-service'
import { usePostgresLogCases } from '../fixtures/postgres-cases'
import { validatePolicy, type LogService } from '../../../layers/core/lib/logging/service'
import { LOG_DEFAULTS, LOG_LEVELS, type LogInput, type LogPolicyPatch } from '../../../layers/core/lib/logging/contract'
import { LOG_FIELD_PROFILES, defaultFieldControls } from '../../../layers/core/lib/logging/field-controls'
import { defaultLogCollection } from '../../../layers/core/lib/logging/policy'
import { safeLogEvent } from '../../../layers/core/lib/logging/privacy'

const dirs: string[] = [], services: LogService[] = [], children: ChildProcess[] = []
const base = { retentionDays: 7, maxBytes: LOG_DEFAULTS.maxBytes }
const fields = LOG_FIELD_PROFILES[0].fields.map(f => f.key)
const origin = { runtime: 'node', integration: 'nuxt-nitro', capture: 'framework' } as const
const input = (operation = 'field.event', level: typeof LOG_LEVELS[number] = 'info'): LogInput => ({ source: 'http', operation, outcome: 'failure', level, httpMethod: 'GET', httpRoute: '/api/health', statusCode: 503, durationMs: 0, errorCode: 'upstream_failed', counts: { done: 0 }, origin })
const patch = (fieldControls: unknown) => ({ ...base, fieldControls }) as LogPolicyPatch
const openLogCase = usePostgresLogCases()
const runtimes: ReturnType<typeof openLogCase>[] = []
function open(postgresUrl: string) {
  const service = createPostgresLogService({ postgresUrl, flushIntervalMs: 100 })
  services.push(service)
  return service
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'field-policy-'))
  dirs.push(directory)
  const runtime = openLogCase()
  runtimes.push(runtime)
  return { service: open(runtime.url), directory, runtime }
}
afterEach(async () => {
  for (const c of children.splice(0)) { c.kill('SIGKILL'); await new Promise<void>(r => c.exitCode !== null || c.signalCode !== null ? r() : c.once('exit', () => r())) }
  for (const s of services.splice(0)) await s.close()
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
async function childWriter(directory: string, postgresUrl: string, maxEventBytes: number = LOG_DEFAULTS.maxEventBytes) {
  const script = join(directory, 'field-child.mjs')
  const jiti = createRequire(import.meta.resolve('nuxt/package.json')).resolve('jiti')
  writeFileSync(script, `
import {createRequire} from 'node:module'
const {createJiti}=createRequire(import.meta.url)(${JSON.stringify(jiti)})
const {createPostgresLogService}=await createJiti(import.meta.url).import(${JSON.stringify(resolve('layers/core/lib/logging/postgres-service.ts'))})
const service=createPostgresLogService({postgresUrl:${JSON.stringify(postgresUrl)},stdout:true,flushIntervalMs:100,maxEventBytes:${maxEventBytes}})
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
  const { service, runtime } = fixture()
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
  const next = open(runtime.url)
  expect(await next.policy()).toMatchObject({ revision: 2, retentionDays: 3, fieldControls: { http: { info: { httpRoute: false } } } })
  expect(await next.detail(id)).toEqual(historical)
}, 20_000)

for (const level of LOG_LEVELS) it(`writer ${level} persists and outputs each disabled field with identical capture`, async () => {
  const { service, directory, runtime } = fixture()
  await service.setPolicy({ ...base, collection: {
    sources: { http: { enabled: true, minLevel: 'debug' } },
    integrations: { 'nuxt-nitro': { enabled: true, minLevel: 'debug' } },
  } })
  const child = await childWriter(directory, runtime.url)
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
}, 20_000)

it('applies AND before field capture and authorizes old queues using latest policy', async () => {
  const { service, directory, runtime } = fixture(); await service.policy()
  const child = await childWriter(directory, runtime.url)
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
}, 20_000)

it('merges distinct concurrent leaves and orders same leaf writes with one shared revision', async () => {
  const { service, runtime } = fixture(); const peer = open(runtime.url)
  await service.policy(); await peer.policy()
  await Promise.all([service.setPolicy(patch({ http: { info: { httpRoute: false } } })), peer.setPolicy(patch({ http: { info: { statusCode: false }, warn: { durationMs: false } } }))])
  expect(await peer.policy()).toMatchObject({ revision: 2, fieldControls: { http: { info: { httpRoute: false, statusCode: false }, warn: { durationMs: false } } } })
  await service.setPolicy(patch({ http: { info: { httpRoute: true } } }))
  await peer.setPolicy(patch({ http: { info: { httpRoute: false } } }))
  expect(await service.policy()).toMatchObject({ revision: 4, fieldControls: { http: { info: { httpRoute: false, statusCode: false } } } })
}, 20_000)

it('reads historical policy in concurrent sessions and merges later writes', async () => {
  const { service, runtime } = fixture()
  const collection = defaultLogCollection()
  collection.sources.http.minLevel = 'warn'
  collection.integrations.application.enabled = false
  runtime.psql(['-c', `UPDATE runtime_logs.log_collection SET collection='${JSON.stringify(collection)}', revision=19`])
  const peer = open(runtime.url)
  const snapshots = await Promise.all([service.policy(), peer.policy()])
  for (const snapshot of snapshots) expect(snapshot).toMatchObject({ revision: 19, collection, fieldControls: defaultFieldControls(LOG_FIELD_PROFILES) })
  await Promise.all([service.setPolicy(patch({ http: { error: { httpRoute: false } } })), peer.setPolicy(patch({ http: { warn: { statusCode: false } } }))])
  expect(await service.policy()).toMatchObject({ revision: 21, collection, fieldControls: { http: { error: { httpRoute: false }, warn: { statusCode: false } } } })
}, 20_000)

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
}, 20_000)

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
  const { service, directory, runtime } = fixture(); await service.setPolicy(patch({ http: { info: { httpRoute: false } } }))
  const child = await childWriter(directory, runtime.url, finalBytes + delta)
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
}, 20_000)
