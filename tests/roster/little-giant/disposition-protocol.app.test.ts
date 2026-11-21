import { execFileSync } from 'node:child_process'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { nativeAppAdapter } from '../../support/native-app'
import { readDevelopmentDiscovery } from '../current-export/fixtures/specialized-export'
import * as s from '../../../db/schema'
import { installLeadListSchema } from '../../../layers/lead-lists/install-schema'
import { currentDispositions, preflightDisposition } from '../../../layers/sme-roster/server/utils/title-cycle-disposition'

const pgBin = process.env.TEST_ROSTER_DISPOSITION_PG_BIN
describe.each(['SQLite', 'PostgreSQL'] as const)('%s disposition protocol', engine => {
const postgres = engine === 'PostgreSQL'
const enabled = !postgres || Boolean(pgBin)
let dir: string, app: ReturnType<typeof nativeAppAdapter>, started = false
const token = 'synthetic-disposition-token'
const client = new Client({name:'synthetic-disposition',version:'1'})
let tools: Awaited<ReturnType<Client['listTools']>>, discovery:any
let pool: pg.Pool
let enterprise: typeof s.enterprise.$inferSelect
let fact: {
 kind: 'not_applied'; source: { fileId: number; sha256: string; reference: string; statement: string }
 cycle: { eventId: number; revision: number }; observed: { precision: 'day'; value: string }
 effective: { precision: 'unknown'; value: null }; effectiveBasis: null
}
let currentVersion: string
let expectedPlan: (request: unknown) => string
beforeAll(async () => {
 if (!enabled) return
 dir = mkdtempSync('/tmp/cycle-pg-')
 const pgUrl = "postgresql://cycle_fixture@localhost/postgres?host=" + encodeURIComponent(dir)
 app = nativeAppAdapter({dir, token, launch: ({cwd, port}) => ({
  args: [join(cwd, '.output/server/index.mjs')],
  env: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), NUXT_MCP_TOKEN: token,
   NUXT_DB_READONLY: postgres ? '1' : '0', NUXT_POSTGRES_ROSTER_READ: postgres ? '1' : '0',
   NUXT_POSTGRES_DIRECTORY_WRITE: postgres ? '1' : '0', NUXT_POSTGRES_DIRECTORY_URL: postgres ? pgUrl : '' },
 })})
 enterprise = app.db.insert(s.enterprise).values({ name:'合成进程处置', nameNorm:'合成进程处置' }).returning().get()
 const record = app.db.insert(s.record).values({ enterpriseId:enterprise.id, titleCode:'little_giant', source:'jxj' }).returning().get()
 const event = app.db.insert(s.recordEvent).values({ recordId:record.id, eventType:'award', year:2021 }).returning().get()
 const file = app.db.insert(s.storedFile).values({ relPath:'synthetic.pdf', filename:'synthetic.pdf', ext:'pdf', bytes:1,
  sha256:'a'.repeat(64), createdAt:'2026-01-01' }).returning().get()
 fact = { kind:'not_applied', source:{ fileId:file.id, sha256:file.sha256, reference:'page 1', statement:'未申请' },
  cycle:{ eventId:event.id, revision:1 }, observed:{ precision:'day', value:'2024-01-01' },
  effective:{ precision:'unknown', value:null }, effectiveBasis:null }
 currentVersion = currentDispositions(app.db, [enterprise.id]).version
 expectedPlan = request => preflightDisposition(app.db, request).planHash
 discovery = await readDevelopmentDiscovery()
 if (postgres) {
  installLeadListSchema(app.db.$client)
  const env = { PATH: process.env.PATH, LANG: 'C', PGHOST: dir, PGPORT: '5432', PGDATABASE: 'postgres',
   PGUSER:'cycle_fixture', PGSQL_BIN: join(pgBin!, 'psql') }
  const run = (program: string, args: string[]) => execFileSync(join(pgBin!, program), args, { env, stdio:'pipe' })
  run('initdb', ['-A','trust','-E','UTF8','--locale=C','-U','cycle_fixture','-D',join(dir,'pg')])
  run('pg_ctl', ['-w','-D',join(dir,'pg'),'-l',join(dir,'pg.log'),'-o', "-c listen_addresses='' -k " + dir, 'start'])
  started = true
  execFileSync(process.execPath, ['upgrade/postgresql/stage-sqlite.mjs', app.dbPath, 'staged'], { env, stdio:'pipe' })
  for (const name of ['enterprise-directory','enterprise-identity','jobs','file-and-lead-lists','roster']) {
   run('psql', ['-X','-w','-q','-v','staging=staged','-f','upgrade/postgresql/materialize-' + name + '.sql'])
  }
  pool = new pg.Pool({ connectionString: pgUrl })
 }
 await app.start()
 await client.connect(new StreamableHTTPClientTransport(new URL(app.url('/mcp')), { requestInit:{headers:{authorization:'Bearer ' + token}} }))
 tools = await client.listTools()
}, 90000)
afterAll(async () => {
 try {
  if (app) await client.close()
  await app?.close()
  await pool?.end()
 } finally {
  if (started) execFileSync(join(pgBin!, 'pg_ctl'), ['-w','-D',join(dir,'pg'),'-m','fast','stop'], { stdio:'pipe' })
  if (dir) rmSync(dir, {recursive:true,force:true})
 }
})
const decode=(r:any)=>r.structuredContent??JSON.parse(r.content.find((c:any)=>c.text).text)
const http=async(action:string,body?:unknown,auth=token)=>{
 const response=await fetch(app.url('/api/roster/title-cycle-dispositions/'+action),{method:body?'POST':'GET',headers:{'content-type':'application/json',authorization:`Bearer ${auth}`},...(body?{body:JSON.stringify(body)}:{})})
 return {status:response.status,body:await response.json()}
}
it.skipIf(!enabled)('discovers strict actual toolkit schemas and runs assert confirm replace withdraw and immutable replay across transports',async()=>{
 for(const name of ['preflight_title_cycle_disposition','commit_title_cycle_disposition','get_current_title_cycle_dispositions','list_title_cycle_disposition_history'])expect(tools.tools.find(t=>t.name===name)?.inputSchema.additionalProperties).toBe(false)
 for(const action of ['preflight','commit','current','history'])expect(JSON.stringify(discovery)).toContain('/api/roster/title-cycle-dispositions/'+action)
 expect((await http('preflight',{},'wrong')).status).toBe(401)
 const unauth=await fetch(app.url('/mcp'),{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'commit_title_cycle_disposition',arguments:{}}})});expect(unauth.status).toBe(401)
 const read=async()=>decode(await client.callTool({name:'get_current_title_cycle_dispositions',arguments:{enterpriseIds:[enterprise.id]}}))
 const request=async(operations:unknown[],key:string)=>({operations,idempotencyKey:key,expectedVersion:(await read()).version,actor:{type:'agent',id:'synthetic'},basis:'合成原文'})
 const r=await request([{action:'assert',enterpriseId:enterprise.id,fact}],'assert')
 for(const invalid of [{...r,extra:true},{...r,operations:[{action:'assert',enterpriseId:enterprise.id,fact:{...fact,source:{...fact.source,extra:true}}}]}]){
  expect((await client.callTool({name:'preflight_title_cycle_disposition',arguments:invalid})).isError).toBe(true)
  expect((await http('preflight',invalid)).status).toBe(400)
 }
 const run=async(r:any)=>{
  const before=await read(),plan=await http('preflight',r);expect(plan.status).toBe(200);expect(await read()).toEqual(before)
  const envelope={request:r,planHash:plan.body.planHash},result=await client.callTool({name:'commit_title_cycle_disposition',arguments:envelope});expect(result.isError).not.toBe(true)
  return {receipt:decode(result),envelope}
 }
 expect(r.expectedVersion).toBe(currentVersion)
 expect((await http('preflight', r)).body.planHash).toBe(expectedPlan(r))
 const a=await run(r)
 await run(await request([{action:'confirm',id:a.receipt.ids[0],revision:1}],'confirm'))
 expect((await read()).rows).toMatchObject([{revision:2,status:'confirmed',fact,effectReady:false}])
 const b=await run(await request([{action:'replace',id:a.receipt.ids[0],revision:2,fact:{...fact,kind:'not_recommended',source:{...fact.source,statement:'未推荐'}}}],'replace'))
 await run(await request([{action:'withdraw',id:b.receipt.ids[0],revision:1}],'withdraw'))
 const history=decode(await client.callTool({name:'list_title_cycle_disposition_history',arguments:{enterpriseIds:[enterprise.id]}}))
 expect(history.rows.map((r:any)=>[r.revision,r.status])).toEqual([[1,'pending'],[2,'confirmed'],[3,'replaced'],[1,'pending'],[2,'withdrawn']])
 expect((await http('commit',a.envelope)).body).toEqual(a.receipt)
 expect((await http('preflight',{...r,basis:'changed'})).status).toBe(409)
 const stale=await request([{action:'assert',enterpriseId:enterprise.id,fact}],'stale'),plan=await http('preflight',stale)
 await run(await request([{action:'assert',enterpriseId:enterprise.id,fact:{...fact,cycle:null}}],'advance'))
 const before=await read();expect((await http('commit',{request:stale,planHash:plan.body.planHash})).status).toBe(409);expect(await read()).toEqual(before)
 const pin=await request([{action:'assert',enterpriseId:enterprise.id,fact}],'pin'),p=await http('preflight',pin)
 if (postgres) await pool.query('UPDATE business.stored_file SET sha256=$1', ['b'.repeat(64)])
 else app.db.update(s.storedFile).set({sha256:'b'.repeat(64)}).run()
 const frozen=await read();expect((await http('commit',{request:pin,planHash:p.body.planHash})).status).toBe(409);expect(await read()).toEqual(frozen)
 expect(app.db.select().from(s.recordEvent).all()).toHaveLength(1)
 if (postgres) {
  expect((await pool.query('SELECT id FROM business.record_event')).rowCount).toBe(1)
  expect(app.db.select().from(s.titleCycleDispositionRevision).all()).toEqual([])
 }
})
})
