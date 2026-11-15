import { createRuntimeSchema } from '../../../db/create-runtime'
import { createServer, type Server } from 'node:http'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import * as schema from '../../../db/schema'
vi.mock('@nuxtjs/mcp-toolkit/server',()=>({defineMcpTool:(value:unknown)=>value}))
vi.mock('@db',()=>({useDb:()=>db}))
const sqlite=new Database(':memory:'),db=drizzle(sqlite,{schema})
let server:Server,base:string
let refreshTool: (typeof import('../../../server/mcp/tools/refresh_enterprise_differences'))['default']
let readTool: (typeof import('../../../server/mcp/tools/list_enterprise_difference_comparisons'))['default']
beforeAll(async()=>{
 sqlite.pragma('foreign_keys=ON'); createRuntimeSchema(sqlite)
 const e=db.insert(schema.enterprise).values({name:'传输合成',nameNorm:'传输合成'}).returning().get()
 db.insert(schema.record).values({enterpriseId:e.id,titleCode:'specialized_sme',source:'jxj',nameRaw:e.name}).run()
 vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'refresh-test-token'}));vi.stubGlobal('defineEventHandler',defineEventHandler)
 const post=(await import('../../../server/api/roster/differences/refresh.post')).default
 const get=(await import('../../../server/api/roster/differences/refresh.get')).default
 refreshTool=(await import('../../../server/mcp/tools/refresh_enterprise_differences')).default
 readTool=(await import('../../../server/mcp/tools/list_enterprise_difference_comparisons')).default
 const app=createApp();app.use('/api/roster/differences/refresh',defineEventHandler(event=>event.method==='POST'?post(event):get(event)))
 server=createServer(toNodeListener(app));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`
})
afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));sqlite.close();vi.unstubAllGlobals()})
const request=(method:string,body?:unknown,query='')=>fetch(`${base}/api/roster/differences/refresh${query}`,{method,headers:{authorization:'Bearer refresh-test-token','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
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
