import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import { usePostgresLogCases } from '../fixtures/postgres-cases'
import { createPostgresLogService } from '../../../layers/core/lib/logging/postgres-service'
import { validatePolicy, type LogService } from '../../../layers/core/lib/logging/service'
import { LOG_DEFAULTS, LOG_LEVELS, LOG_SOURCES, LOG_SUPPORTED_INTEGRATIONS } from '../../../layers/core/lib/logging/contract'
import { collectionAllows, defaultLogCollection } from '../../../layers/core/lib/logging/policy'
import { safeLogEvent, projectEvlog } from '../../../layers/core/lib/logging/privacy'

const dirs: string[] = [], services: LogService[] = [], children: ChildProcess[] = []
const openLogCase = usePostgresLogCases()
const runtimes: ReturnType<typeof openLogCase>[] = []
const base = { retentionDays: 7, maxBytes: LOG_DEFAULTS.maxBytes }
function open(postgresUrl: string) {
  const service = createPostgresLogService({ postgresUrl, flushIntervalMs: 100 })
  services.push(service)
  return service
}
function fixture() {
  const runtime = openLogCase()
  runtimes.push(runtime)
  return { service: open(runtime.url), runtime }
}
afterEach(async () => {
  for (const c of children.splice(0)) { c.kill('SIGKILL'); await new Promise<void>(r => c.exitCode !== null || c.signalCode !== null ? r() : c.once('exit', () => r())) }
  for (const s of services.splice(0)) await s.close()
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.useRealTimers()
})
it('applies AND and the stricter level across all eleven sources and all level pairs', () => {
  for (const source of LOG_SOURCES) for (const sourceLevel of LOG_LEVELS) for (const integrationLevel of LOG_LEVELS) for (const level of LOG_LEVELS) for (const sourceEnabled of [false,true]) for (const integrationEnabled of [false,true]) {
    const collection = defaultLogCollection()
    collection.sources[source] = { enabled: sourceEnabled, minLevel: sourceLevel }
    collection.integrations.application = { enabled: integrationEnabled, minLevel: integrationLevel }
    const event = safeLogEvent({ source, operation: 'matrix.run', outcome: 'failure', level, origin: { runtime: 'node', integration: 'application', capture: 'manual' } })
    expect(collectionAllows(event, collection)).toBe(sourceEnabled && integrationEnabled && LOG_LEVELS.indexOf(level) >= Math.max(LOG_LEVELS.indexOf(sourceLevel), LOG_LEVELS.indexOf(integrationLevel)))
  }
})
it('rejects unknown top-level, unknown integration, prototype and incomplete rule inputs', () => {
  for (const input of [
    {...base,revision:1}, {...base,catalog:{}}, {...base,collection:{sources:{task:{enabled:false}}}},
    {...base,collection:{integrations:{unknown_library:{enabled:true,minLevel:'debug'}}}},
    {...base,collection:{sources:{task:{enabled:true,minLevel:'trace'}}}},
    {...base,collection:{sources:{task:{enabled:true,minLevel:'error',extra:true}}}},
    JSON.parse('{"retentionDays":7,"maxBytes":536870912,"collection":{"sources":{"__proto__":{"enabled":false,"minLevel":"debug"}}}}'),
    Object.assign(Object.create({ polluted:true }), base),
  ]) expect(() => validatePolicy(input)).toThrow('invalid_log_input')
  const payload = {...base,collection:defaultLogCollection()}
  expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(4096)
  expect(validatePolicy(payload)).toEqual(payload)
})
it('preserves legacy updates, old missing origins, history and restart rules', async () => {
  const { service, runtime } = fixture()
  const id = service.emit({source:'task',operation:'history.run',outcome:'success'})!
  await service.flush()
  expect((await service.detail(id))!.origin).toBeUndefined()
  expect((await service.list()).rows[0]!.origin).toBeUndefined()
  await service.setPolicy({...base,collection:{sources:{task:{enabled:false,minLevel:'error'}}}})
  const first = await service.policy()
  await service.setPolicy({retentionDays:3,maxBytes:base.maxBytes})
  expect((await service.policy()).collection).toEqual(first.collection)
  expect((await service.policy()).revision).toBe(first.revision+1)
  expect(await service.detail(id)).toMatchObject({operation:'history.run'})
  await service.close()
  const next = open(runtime.url)
  expect(await next.policy()).toMatchObject({retentionDays:3,collection:{sources:{task:{enabled:false,minLevel:'error'}}}})
}, 20_000)
it('merges concurrent management writes and filters old queues and new batches separately from drops', async () => {
  // Keep the old event pending while both policy commits race. Early drain is
  // now intentionally faster than those RPCs; an already committed old event
  // would be valid history, rather than a stale-policy failure.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'] })
  const {service,runtime} = fixture()
  const peer = open(runtime.url)
  await service.policy(); await peer.policy()
  peer.emit({source:'task',operation:'queue.old',outcome:'failure',level:'error'})
  await Promise.all([
    service.setPolicy({...base,collection:{sources:{task:{enabled:false,minLevel:'debug'}}}}),
    peer.setPolicy({...base,collection:{integrations:{application:{enabled:true,minLevel:'warn'}}}}),
  ])
  peer.emit({source:'task',operation:'queue.new',outcome:'failure',level:'error'})
  await peer.flush()
  expect((await service.list({source:'task'})).rows).toEqual([])
  expect(peer.status()).toMatchObject({filtered:3,dropped:0,overflow:0}) // two tasks plus its info-level policy metadata
  expect(await service.policy()).toMatchObject({revision:2,collection:{sources:{task:{enabled:false,minLevel:'debug'}},integrations:{application:{enabled:true,minLevel:'warn'}}}})
  await service.setPolicy({...base,collection:{sources:{task:{enabled:true,minLevel:'debug'}}}})
  peer.emit({source:'task',operation:'queue.reenabled',outcome:'success'})
  await peer.flush()
  expect((await service.list({source:'task'})).rows.map(r=>r.operation)).toEqual(['queue.reenabled'])
}, 20_000)
it('projects origin by collector and discards arbitrary nested fields without inventing historical attribution', () => {
  expect(safeLogEvent({source:'file',operation:'file.register',outcome:'success'})).not.toHaveProperty('origin')
  expect(safeLogEvent({source:'client',operation:'fixture.run',outcome:'failure',origin:{runtime:'browser',integration:'vue',capture:'hook',execution:'page',message:'PRIVATE'} as any}).origin).toEqual({runtime:'browser',integration:'vue',capture:'hook',execution:'page'})
  expect(projectEvlog({path:'/mcp',applicationLogMcp:{rpcMethod:'ping'}}).origin).toEqual({runtime:'node',integration:'mcp-toolkit',capture:'framework',execution:'request'})
  expect(projectEvlog({path:'/api/health'}).origin?.integration).toBe('nuxt-nitro')
  expect(safeLogEvent({source:'system',operation:'fixture.run',outcome:'success',origin:{runtime:'node',integration:'unknown_library',capture:'hook'} as any})).not.toHaveProperty('origin')
})

async function childWriter(directory: string, env: NodeJS.ProcessEnv) {
  const script = join(directory,'child.mjs')
  const jiti = createRequire(import.meta.resolve('nuxt/package.json')).resolve('jiti')
  writeFileSync(script, `
import {createRequire} from 'node:module'
const {createJiti}=createRequire(import.meta.url)(${JSON.stringify(jiti)})
const logging=await createJiti(import.meta.url).import(${JSON.stringify(resolve('layers/core/lib/logging/index.ts'))})
const options={source:'task',outcome:'failure',level:'error'}
logging.initializeWorkerLogging()
const service=logging.applicationLogs()
const emit=operation=>logging.appLog({...options,operation})
process.on('message',async m=>{
  try {
    if(m.type==='emit') { emit(m.operation); await service.flush() }
    if(m.type==='close') await service.close()
    process.send({id:m.id,status:service.status()})
  } catch {process.send({id:m.id,error:true})}
})
process.send({ready:true})
`)
  const child = spawn(process.execPath,[script],{env:{...process.env,...env},stdio:['ignore','pipe','pipe','ipc']})
  children.push(child)
  let output = '', errors = ''
  child.stdout!.on('data',chunk=>{ output+=chunk.toString() })
  child.stderr!.on('data',chunk=>{ errors+=chunk.toString() })
  await new Promise<void>((resolve,reject)=> {child.once('message',()=>resolve());child.once('error',reject);child.once('exit',()=>reject(new Error(errors)))})
  let serial=0
  return {child, output:()=>output, errors:()=>errors, send(type:string,operation?:string):Promise<any>{
    return new Promise((resolve,reject)=>{
      const id=++serial
      const timer=setTimeout(()=>reject(new Error('child command timeout: '+errors)),5000)
      const listener=(m:any)=>{if(m.id===id){clearTimeout(timer);child.off('message',listener);resolve(m)}}
      child.on('message',listener);child.send({id,type,operation})
    })
  }}
}
it('enforces shared PostgreSQL log policy in a separate worker, including stdout', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pg-policy-'))
  dirs.push(directory)
  const runtime = openLogCase()
  runtimes.push(runtime)
  const service = createPostgresLogService({ postgresUrl: runtime.url, flushIntervalMs: 100 })
  services.push(service)
  await service.policy()
  const child = await childWriter(directory, runtime.env)
  await child.send('emit','child.before')
  await service.setPolicy({...base,collection:{sources:{task:{enabled:false,minLevel:'debug'}}}})
  const result=await child.send('emit','child.disabled')
  expect(result.status).toMatchObject({filtered:1,dropped:0})
  expect((await service.list({operation:'child.disabled'})).rows).toEqual([])
  await service.setPolicy({...base,collection:{sources:{task:{enabled:true,minLevel:'debug'}}}})
  await child.send('emit','child.after')
  await child.send('close')
  // IPC acknowledgements and stdout arrive on separate channels.
  await vi.waitFor(() => expect(child.output()).toContain('child.after'))
  expect(child.output()).toContain('child.before')
  expect(child.output()).not.toContain('child.disabled')
  expect((await service.list({source:'task'})).rows.map(r=>r.operation).sort()).toEqual(['child.after','child.before'])
  expect((await service.list({operation:'child.after'})).rows[0]!.origin).toEqual({runtime:'node',integration:'application',capture:'manual',execution:'worker'})
}, 20_000)
it('distinguishes a rejected insert from unreadable policy without losing later permitted events', async () => {
  const { service, runtime } = fixture()
  runtime.psql(['-c', `ALTER TABLE runtime_logs.log_events ADD CHECK (operation <> 'rollback.fixture')`])
  const failed = service.emit({ source: 'task', operation: 'rollback.fixture', outcome: 'failure' })!
  await service.flush()
  expect(await service.detail(failed)).toBeNull()
  expect(service.status()).toMatchObject({ stored: 0, dropped: 1, writeUnknown: 0, unavailable: true })

  runtime.psql(['-c', 'ALTER TABLE runtime_logs.log_collection RENAME TO offline_collection'])
  const denied = service.emit({ source: 'task', operation: 'offline.fixture', outcome: 'failure' })!
  await service.flush()
  await expect(service.policy()).rejects.toMatchObject({ code: 'storage_unavailable' })
  runtime.psql(['-c', 'ALTER TABLE runtime_logs.offline_collection RENAME TO log_collection'])
  expect(await service.detail(denied)).toBeNull()

  const next = service.emit({ source: 'task', operation: 'recovered.fixture', outcome: 'success' })!
  await service.flush()
  expect(await service.detail(next)).toMatchObject({ operation: 'recovered.fixture' })
  expect(service.status()).toMatchObject({ stored: 1, dropped: 2, writeUnknown: 0, unavailable: false })
}, 20_000)

it('does not exempt policy and clear metadata from the application integration rule', async () => {
  const {service}= fixture()
  await service.setPolicy({...base,collection:{integrations:{application:{enabled:false,minLevel:'debug'}}}})
  await service.clear({from:'2000-01-01',to:'2100-01-01',operation:'nothing.run',confirm:true})
  await service.flush()
  expect((await service.list({source:'system'})).rows).toEqual([])
  expect(service.status()).toMatchObject({filtered:2,dropped:0})
  expect((await service.policy()).collection.integrations.application.enabled).toBe(false)
  await service.setPolicy({...base,collection:{integrations:{application:{enabled:true,minLevel:'debug'}}}})
  await service.flush()
  expect((await service.list({operation:'logging.policy'})).rows).toHaveLength(1)
}, 20_000)

it('publishes the same closed keys and complete rules in REST OpenAPI metadata', async () => {
  let metadata:any
  vi.stubGlobal('defineRouteMeta', (value:any)=>{metadata=value})
  try {
    await import('../../../layers/core/server/api/logs/policy.patch')
    const schema=metadata.openAPI.requestBody.content['application/json'].schema
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['retentionDays','maxBytes'])
    const maps=schema.properties.collection.properties
    expect(maps.sources.additionalProperties).toBe(false)
    expect(Object.keys(maps.sources.properties)).toEqual([...LOG_SOURCES])
    expect(maps.integrations.additionalProperties).toBe(false)
    expect(Object.keys(maps.integrations.properties)).toEqual([...LOG_SUPPORTED_INTEGRATIONS])
    expect(maps.sources.properties.http.required).toEqual(['enabled','minLevel'])
    expect(maps.sources.properties.http.properties.minLevel.enum).toEqual([...LOG_LEVELS])
    expect(maps.integrations.properties.application.$ref).toBe('#/paths/~1api~1logs~1policy/patch/requestBody/content/application~1json/schema/properties/collection/properties/sources/properties/http')
  } finally {vi.unstubAllGlobals()}
})
