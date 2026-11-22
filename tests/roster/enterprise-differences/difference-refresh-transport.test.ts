import { createServer, type Server } from 'node:http'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { readPostgresCurrentQualification } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
vi.mock('@nuxtjs/mcp-toolkit/server',()=>({defineMcpTool:(value:unknown)=>value}))
const dir = mkdtempSync(join(tmpdir(), 'difference-refresh-'))
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let server:Server,base:string
let refreshTool: (typeof import('../../../layers/sme-roster/server/mcp/tools/refresh_enterprise_differences'))['default']
let readTool: (typeof import('../../../layers/sme-roster/server/mcp/tools/list_enterprise_difference_comparisons'))['default']
beforeAll(async()=>{
 postgres = await postgresRuntimeFixture({ dir })
 vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
 vi.stubEnv('NUXT_DB_READONLY', '0')
 const native = usePostgresDirectoryDb()
 const [e] = await native.insert(enterprise).values({name:'传输合成',nameNorm:'传输合成'}).returning()
 await native.insert(record).values({enterpriseId:e!.id,titleCode:'specialized_sme',source:'jxj',nameRaw:e!.name})
 vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'refresh-test-token'}));vi.stubGlobal('defineEventHandler',defineEventHandler)
 const post=(await import('../../../layers/sme-roster/server/api/roster/differences/refresh.post')).default
 const get=(await import('../../../layers/sme-roster/server/api/roster/differences/refresh.get')).default
 refreshTool=(await import('../../../layers/sme-roster/server/mcp/tools/refresh_enterprise_differences')).default
 readTool=(await import('../../../layers/sme-roster/server/mcp/tools/list_enterprise_difference_comparisons')).default
 const app=createApp();app.use('/api/roster/differences/refresh',defineEventHandler(event=>event.method==='POST'?post(event):get(event)))
 server=createServer(toNodeListener(app));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`
}, 30_000)
afterAll(async () => {
 if (server) await new Promise<void>(resolve=>server.close(()=>resolve()))
 await closePostgresDirectoryDb()
 postgres?.close()
 vi.unstubAllEnvs()
 vi.unstubAllGlobals()
 rmSync(dir,{recursive:true,force:true})
})
const request=(method:string,body?:unknown,query='')=>fetch(`${base}/api/roster/differences/refresh${query}`,{method,headers:{authorization:'Bearer refresh-test-token','content-type':'application/json',connection:'close'},...(body===undefined?{}:{body:JSON.stringify(body)})})
it('HTTP and MCP share refresh and persisted read semantics',async()=>{
 const first=await request('POST',{enterpriseIds:[1]});expect(first.status).toBe(200)
 const initial=await first.json();expect(initial.refreshed).toBe(3)
 const toolResult=await refreshTool.handler({enterpriseIds:[1]},{} as never) as {content:{text:string}[]}
 const repeated=JSON.parse(toolResult.content[0]!.text);expect(repeated.refreshed).toBe(0);expect(repeated.unchanged).toBe(3)
 const http=await (await request('GET',undefined,'?enterpriseIds=1')).json()
 const mcp=await readTool.handler({enterpriseIds:[1]},{} as never) as {content:{text:string}[]}
 expect(http).toEqual(JSON.parse(mcp.content[0]!.text));expect(http.enterprises[0].comparisons.every((c:{status:string})=>c.status==='needs_review')).toBe(true)
})
it('HTTP and MCP reject empty duplicate and unknown enterprise scopes',async()=>{
 for(const input of [{enterpriseIds:[]},{enterpriseIds:[1,1]},{enterpriseIds:[999]}]){
  expect((await request('POST',input)).status).toBe(400)
  await expect(refreshTool.handler(input,{} as never)).rejects.toThrow()
 }
 for(const query of ['?enterpriseIds=','?enterpriseIds=1,1','?enterpriseIds=1x','?extra=1'])expect((await request('GET',undefined,query)).status).toBe(400)
})
it('HTTP requires token or same-origin browser provenance',async()=>{
 expect((await fetch(`${base}/api/roster/differences/refresh`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(401)
 const result=await fetch(`${base}/api/roster/differences/refresh`,{method:'POST',headers:{'content-type':'application/json','x-task-center-browser':'1','sec-fetch-site':'same-origin',origin:base},body:'{"enterpriseIds":[1]}'})
 expect(result.status).toBe(200)
 expect(refreshTool.enabled!({context:{mcpAuth:{writeAuthorized:false}}} as never)).toBe(false)
})

it('public refresh keeps frozen lower comparison when only higher qualification changes and never invents platform error',async()=>{
 const native = usePostgresDirectoryDb()
 const [e] = await native.insert(enterprise).values({name:'继承刷新',nameNorm:'继承刷新',usccNorm:'91330200123456789X'}).returning()
 const [r] = await native.insert(record).values({enterpriseId:e!.id,titleCode:'specialized_sme',source:'jxj',nameRaw:e!.name}).returning()
 const [event] = await native.insert(recordEvent).values({recordId:r!.id,eventType:'award',year:2025,batchSeq:1}).returning()
 await native.insert(recordEvidence).values({recordEventId:event!.id,sourceFile:'synthetic-refresh.pdf'})
 await native.insert(record).values({enterpriseId:e!.id,titleCode:'innovative_sme',source:'miit',nameRaw:e!.name})
 const assessment = () => native.transaction(tx => readPostgresCurrentQualification(tx,e!.id,Date.parse('2026-06-01')), {isolationLevel:'repeatable read',accessMode:'read only'})
 expect((await assessment())!.titles.find(t=>t.titleCode==='innovative_sme')!.group).toBe('eligible')
 const first=await (await request('POST',{enterpriseIds:[e!.id]})).json()
 const lower=first.enterprises[0].comparisons.find((c:{titleCode:string})=>c.titleCode==='innovative_sme')
 expect(lower.status).toBe('needs_review')
 expect(lower.comparisonError).toBe(null)
 expect(lower).toMatchObject({comparisonState:'not_established',reasons:[]})
 await native.update(recordEvent).set({year:2018}).where(eq(recordEvent.id,event!.id))
 const second=await (await request('POST',{enterpriseIds:[e!.id]})).json()
 const {refreshedAt: _refreshedAt,...business}=lower
 expect(second.enterprises[0].comparisons.find((c:{titleCode:string})=>c.titleCode==='innovative_sme')).toMatchObject(business)
 const readback=await (await request('GET',undefined,`?enterpriseIds=${e!.id}`)).json()
 expect(readback.enterprises).toEqual(second.enterprises)
 expect((await assessment())!.titles.find(t=>t.titleCode==='innovative_sme')!.group).not.toBe('eligible')
})

it('serializes competing HTTP and MCP refreshes and permits persisted reads in read-only mode', async () => {
  const native = usePostgresDirectoryDb()
  const [subject] = await native.insert(enterprise).values({ name: '并发刷新', nameNorm: '并发刷新' }).returning()
  const [official] = await native.insert(record).values({
    enterpriseId: subject!.id, titleCode: 'specialized_sme', source: 'jxj', nameRaw: subject!.name,
  }).returning()
  const input = { enterpriseIds: [subject!.id] }
  const initial = await request('POST', input)
  expect(initial.status).toBe(200)
  const baseline = await initial.json()
  expect(baseline.refreshed).toBe(3)
  await native.update(record).set({ nameRaw: '变更公布名' }).where(eq(record.id, official!.id))
  const [tool, http] = await Promise.all([
    refreshTool.handler(input, {} as never) as Promise<{ content: { text: string }[] }>,
    request('POST', input),
  ])
  expect(http.status).toBe(200)
  const receipts = [JSON.parse(tool.content[0]!.text), await http.json()].sort((a, b) => b.refreshed - a.refreshed)
  expect(receipts.map(result => [result.refreshed, result.unchanged])).toEqual([[1, 2], [0, 3]])
  const comparisons = receipts[1].enterprises[0].comparisons
  expect(comparisons.find((row: { titleCode: string }) => row.titleCode === 'specialized_sme')).toMatchObject({
    status: 'needs_review', comparisonError: null,
  })
  vi.stubEnv('NUXT_DB_READONLY', '1')
  try {
    expect((await request('POST', input)).status).toBe(503)
    await expect(refreshTool.handler(input, {} as never)).rejects.toMatchObject({ statusCode: 503 })
    const readback = await request('GET', undefined, '?enterpriseIds=' + subject!.id)
    expect(readback.status).toBe(200)
    expect((await readback.json()).enterprises).toEqual(receipts[1].enterprises)
  } finally {
    vi.stubEnv('NUXT_DB_READONLY', '0')
  }
})
