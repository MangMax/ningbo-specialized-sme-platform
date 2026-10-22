import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import Database from 'better-sqlite3'
import { createLogService, validatePolicy, type LogService } from '../lib/logging/service'
import { LOG_DEFAULTS, LOG_LEVELS, LOG_SOURCES, LOG_SUPPORTED_INTEGRATIONS } from '../lib/logging/contract'
import { collectionAllows, defaultLogCollection } from '../lib/logging/policy'
import { safeLogEvent, projectEvlog } from '../lib/logging/privacy'

const dirs: string[] = [], services: LogService[] = [], children: ChildProcess[] = []
const base = { retentionDays: 7, maxBytes: LOG_DEFAULTS.maxBytes }
function fixture(directory = mkdtempSync(join(tmpdir(), 'dual-policy-'))) {
  if (!dirs.includes(directory)) dirs.push(directory)
  const service = createLogService({ directory, flushIntervalMs: 100 }); services.push(service)
  return { service, directory }
}
afterEach(async () => {
  for (const c of children.splice(0)) { c.kill('SIGKILL'); await new Promise<void>(r => c.exitCode !== null || c.signalCode !== null ? r() : c.once('exit', () => r())) }
  for (const s of services.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
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
    {...base,collection:{integrations:{drizzle:{enabled:true,minLevel:'debug'}}}},
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
  const { service, directory } = fixture()
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
  const next = fixture(directory).service
  expect(await next.policy()).toMatchObject({retentionDays:3,collection:{sources:{task:{enabled:false,minLevel:'error'}}}})
})
it('merges concurrent management writes and filters old queues and new batches separately from drops', async () => {
  const {service,directory} = fixture()
  const peer = fixture(directory).service
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
})
it('projects origin by collector and discards arbitrary nested fields without inventing historical attribution', () => {
  expect(safeLogEvent({source:'file',operation:'file.register',outcome:'success'})).not.toHaveProperty('origin')
  expect(safeLogEvent({source:'client',operation:'fixture.run',outcome:'failure',origin:{runtime:'browser',integration:'vue',capture:'hook',execution:'page',message:'PRIVATE'} as any}).origin).toEqual({runtime:'browser',integration:'vue',capture:'hook',execution:'page'})
  expect(projectEvlog({path:'/mcp',applicationLogMcp:{rpcMethod:'ping'}}).origin).toEqual({runtime:'node',integration:'mcp-toolkit',capture:'framework',execution:'request'})
  expect(projectEvlog({path:'/api/health'}).origin?.integration).toBe('nuxt-nitro')
  expect(safeLogEvent({source:'system',operation:'fixture.run',outcome:'success',origin:{runtime:'node',integration:'drizzle',capture:'hook'} as any})).not.toHaveProperty('origin')
})

async function childWriter(directory: string) {
  const script = join(directory,'child.mjs')
  const jiti = createRequire(import.meta.resolve('nuxt/package.json')).resolve('jiti')
  writeFileSync(script, `
import {createRequire} from 'node:module'
const {createJiti}=createRequire(import.meta.url)(${JSON.stringify(jiti)})
const logging=await createJiti(import.meta.url).import(${JSON.stringify(resolve('lib/logging/index.ts'))})
logging.initializeWorkerLogging()
const service=logging.applicationLogs()
process.on('message',async m=>{
  try {
    if(m.type==='emit') { logging.appLog({source:'task',operation:m.operation,outcome:'failure',level:'error'}); await service.flush() }
    if(m.type==='close') await service.close()
    process.send({id:m.id,status:service.status()})
  } catch {process.send({id:m.id,error:true})}
})
process.send({ready:true})
`)
  const child = spawn(process.execPath,[script],{env:{...process.env,NUXT_LOG_DIR:directory},stdio:['ignore','pipe','pipe','ipc']})
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
it('enforces disabled and reenabled rules in a real child sharing the directory, including stdout', async () => {
  const {service,directory}=fixture()
  await service.policy()
  const child=await childWriter(directory)
  await child.send('emit','child.before')
  await service.setPolicy({...base,collection:{sources:{task:{enabled:false,minLevel:'debug'}}}})
  const result=await child.send('emit','child.disabled')
  expect(result.status).toMatchObject({filtered:1,dropped:0})
  expect((await service.list({operation:'child.disabled'})).rows).toEqual([])
  await service.setPolicy({...base,collection:{sources:{task:{enabled:true,minLevel:'debug'}}}})
  await child.send('emit','child.after')
  await child.send('close')
  await new Promise(r=>setTimeout(r,50))
  expect(child.output()).toContain('child.before')
  expect(child.output()).not.toContain('child.disabled')
  expect(child.output()).toContain('child.after')
  expect((await service.list({source:'task'})).rows.map(r=>r.operation).sort()).toEqual(['child.after','child.before'])
  expect((await service.list({operation:'child.after'})).rows[0]!.origin).toEqual({runtime:'node',integration:'application',capture:'manual',execution:'worker'})
})
it('distinguishes unreadable policy failclosed from permitted stdout when event persistence fails', async () => {
  const {service,directory}=fixture()
  await service.policy()
  const child=await childWriter(directory)
  await child.send('emit','fault.warm')
  const db=new Database(join(directory,'events.db'))
  try {
    db.exec("CREATE TRIGGER fail_events BEFORE INSERT ON log_events BEGIN SELECT RAISE(ABORT,'fixture'); END")
    const failed=await child.send('emit','fault.persist')
    expect(failed.status).toMatchObject({dropped:1,stored:1,filtered:0,unavailable:true})
    db.exec('DROP TRIGGER fail_events')
    db.exec("CREATE TRIGGER rollback_events BEFORE INSERT ON log_events BEGIN SELECT RAISE(ROLLBACK,'fixture'); END")
    const rollback=await child.send('emit','fault.rollback')
    expect(rollback.status).toMatchObject({dropped:2,stored:1,filtered:0,unavailable:true})
    db.exec('DROP TRIGGER rollback_events')
    db.exec('BEGIN EXCLUSIVE')
    const unread=await child.send('emit','fault.policy')
    expect(unread.status).toMatchObject({dropped:3,stored:1,filtered:0,unavailable:true})
    db.exec('ROLLBACK')
    await child.send('close')
    await new Promise(r=>setTimeout(r,50))
    expect(child.output()).toContain('fault.persist')
    expect(child.output()).toContain('fault.rollback')
    expect(child.output()).not.toContain('fault.policy')
    expect((await service.list({operation:'fault.persist'})).rows).toEqual([])
  } finally {if(db.inTransaction)db.exec('ROLLBACK');db.close()}
})


it('does not exempt policy and clear metadata from the application integration rule', async () => {
  const {service}=fixture()
  await service.setPolicy({...base,collection:{integrations:{application:{enabled:false,minLevel:'debug'}}}})
  await service.clear({from:'2000-01-01',to:'2100-01-01',operation:'nothing.run',confirm:true})
  await service.flush()
  expect((await service.list({source:'system'})).rows).toEqual([])
  expect(service.status()).toMatchObject({filtered:2,dropped:0})
  expect((await service.policy()).collection.integrations.application.enabled).toBe(false)
  await service.setPolicy({...base,collection:{integrations:{application:{enabled:true,minLevel:'debug'}}}})
  await service.flush()
  expect((await service.list({operation:'logging.policy'})).rows).toHaveLength(1)
})

it('migrates an owned legacy store with default rules while preserving unmarked event rows', async () => {
  const {service,directory}=fixture()
  const id=service.emit({source:'file',operation:'file.register',outcome:'success'})!
  await service.flush(); await service.close()
  const legacy=new Database(join(directory,'events.db'))
  legacy.exec('DROP TABLE log_collection'); legacy.close()
  const next=fixture(directory).service
  const policy=await next.policy()
  expect(policy.revision).toBe(0)
  expect(policy.collection).toEqual(defaultLogCollection())
  expect(await next.detail(id)).toMatchObject({source:'file',operation:'file.register'})
  expect(await next.detail(id)).not.toHaveProperty('origin')
})


it('publishes the same closed keys and complete rules in REST OpenAPI metadata', async () => {
  let metadata:any
  vi.stubGlobal('defineRouteMeta', (value:any)=>{metadata=value})
  try {
    await import('../server/api/logs/policy.patch')
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
