import { expect, it } from 'vitest'
import { dispositionSchemas, dispositionFailure } from '../../../layers/sme-roster/server/utils/title-cycle-disposition-protocol'
it('rejects root and nested extras and maps invalid input separately from storage faults', () => {
 expect(dispositionSchemas.current.safeParse({enterpriseIds:[1], extra:true}).success).toBe(false)
 expect(dispositionFailure(dispositionSchemas.current.safeParse({enterpriseIds:['1']}).error).status).toBe(400)
 expect(dispositionFailure(new Error('SQLITE secret /private/db'))).toEqual({status:500,body:{error:{code:'transaction_failed',message:'Disposition operation failed'}}})
})

import { afterAll, beforeAll, vi } from 'vitest'
import { createServer } from 'node:http'
import { createApp, createRouter, toNodeListener } from 'h3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initializeDb } from '../../../db/client'
import * as s from '../../../db/schema'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { dispositionOperation } from '../../../layers/sme-roster/server/utils/title-cycle-disposition-protocol'
vi.mock('@db',()=>({useDb:()=>db}))
const dir=mkdtempSync(join(tmpdir(),'disposition-wire-'))
const db=initializeDb({create:true,dbPath:join(dir,'db')})
let server: ReturnType<typeof createServer>, base:string
const sdk=new McpServer({name:'disposition',version:'1'}), client=new Client({name:'test',version:'1'})
beforeAll(async()=>{
 vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'test-api-secret',mcpToken:'test-mcp-secret'}))
 const {dispositionRoute}=await import('../../../layers/sme-roster/server/utils/title-cycle-disposition-route')
 const router=createRouter()
 for(const action of ['preflight','commit','current','history'] as const){
  if(action==='preflight'||action==='commit')router.post('/'+action,dispositionRoute(action));else router.get('/'+action,dispositionRoute(action))
  sdk.registerTool(action,{inputSchema:dispositionSchemas[action]},async (input: unknown)=>{
   try{return {content:[{type:'text' as const,text:JSON.stringify(dispositionOperation(db,action,input))}]}}
   catch(e){return {isError:true,content:[{type:'text' as const,text:JSON.stringify(dispositionFailure(e).body)}]}}
  })
 }
 server=createServer(toNodeListener(createApp().use(router)))
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 base=`http://127.0.0.1:${(server.address() as any).port}`
 const [a,b]=InMemoryTransport.createLinkedPair();await sdk.connect(a);await client.connect(b)
})
afterAll(async()=>{await client.close();await sdk.close();await new Promise<void>(resolve=>server.close(()=>resolve()));db.$client.close();rmSync(dir,{recursive:true,force:true});vi.unstubAllGlobals()})
const http=async(action:string,body?:unknown,token='test-api-secret')=>{
 const r=await fetch(base+'/'+action,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()}
}
it('enforces actual HTTP auth and SDK root strictness before storage and preserves literal lifecycle readback',async()=>{
 const tools=await client.listTools();expect(tools.tools.find(t=>t.name==='preflight')!.inputSchema.additionalProperties).toBe(false)
 expect((await http('preflight',{},'wrong')).status).toBe(401)
 expect((await http('preflight',{})).status).toBe(400)
 expect((await client.callTool({name:'current',arguments:{enterpriseIds:[1],extra:'secret'}})).isError).toBe(true)
 expect((await http('current?enterpriseIds=1&extra=x')).status).toBe(400)
 const enterprise=db.insert(s.enterprise).values({name:'合成公开处置',nameNorm:'合成公开处置'}).returning().get()
 const record=db.insert(s.record).values({enterpriseId:enterprise.id,titleCode:'little_giant',source:'jxj'}).returning().get()
 const event=db.insert(s.recordEvent).values({recordId:record.id,eventType:'award',year:2021}).returning().get()
 const file=db.insert(s.storedFile).values({relPath:'synthetic.pdf',filename:'synthetic.pdf',ext:'pdf',bytes:1,sha256:'a'.repeat(64),createdAt:'2026-01-01'}).returning().get()
 const read=async()=> (await http('current?enterpriseIds='+enterprise.id)).body
 const fact={kind:'not_applied',source:{fileId:file.id,sha256:file.sha256,reference:'page 1',statement:'未申请'},cycle:{eventId:event.id,revision:1},observed:{precision:'day',value:'2024-01-01'},effective:{precision:'unknown',value:null},effectiveBasis:null}
 const request=async(operations:unknown[],key:string)=>({operations,idempotencyKey:key,expectedVersion:(await read()).version,actor:{type:'agent',id:'synthetic'},basis:'合成原文'})
 const run=async(r:any)=>{const p=await http('preflight',r);expect(p.status).toBe(200);const envelope={request:r,planHash:p.body.planHash};const result=await client.callTool({name:'commit',arguments:envelope});expect(result.isError).not.toBe(true);return {envelope,receipt:JSON.parse((result.content as any)[0].text)}}
 const r=await request([{action:'assert',enterpriseId:enterprise.id,fact}],'assert');const before=await read()
 expect((await http('preflight',{...r,extra:true})).status).toBe(400)
 expect((await http('preflight',r)).status).toBe(200);expect(await read()).toEqual(before)
 const a=await run(r);expect((await read()).rows).toMatchObject([{revision:1,status:'pending',fact}])
 await run(await request([{action:'confirm',id:a.receipt.ids[0],revision:1}],'confirm'))
 expect((await read()).rows).toMatchObject([{revision:2,status:'confirmed',effectReady:false}])
 const b=await run(await request([{action:'replace',id:a.receipt.ids[0],revision:2,fact:{...fact,kind:'not_recommended',source:{...fact.source,statement:'未推荐'}}}],'replace'))
 await run(await request([{action:'withdraw',id:b.receipt.ids[0],revision:1}],'withdraw'))
 expect((await http('history?enterpriseIds='+enterprise.id)).body.rows.map((r:any)=>[r.revision,r.status])).toEqual([[1,'pending'],[2,'confirmed'],[3,'replaced'],[1,'pending'],[2,'withdrawn']])
 expect((await http('commit',a.envelope)).body).toEqual(a.receipt)
 expect((await http('preflight',{...r,basis:'changed'})).status).toBe(409)
 const pin=await request([{action:'assert',enterpriseId:enterprise.id,fact}],'pin');const plan=await http('preflight',pin)
 db.update(s.storedFile).set({sha256:'b'.repeat(64)}).run()
 const frozen=await read();expect((await http('commit',{request:pin,planHash:plan.body.planHash})).status).toBe(409);expect(await read()).toEqual(frozen)
 const retry={...pin,idempotencyKey:'storage-fault',operations:[{action:'assert',enterpriseId:enterprise.id,fact:{...fact,cycle:null,source:{...fact.source,sha256:'b'.repeat(64),statement:'未申请 test-api-secret'}}}]}
 const retryPlan=await http('preflight',retry)
 expect(retryPlan.status).toBe(200)
 db.$client.exec("CREATE TRIGGER fail_public_receipt BEFORE INSERT ON title_cycle_disposition_receipt BEGIN SELECT RAISE(ABORT, 'SQLITE private /db test-api-secret'); END")
 const failure=await http('commit',{request:retry,planHash:retryPlan.body.planHash})
 expect(failure).toEqual({status:500,body:{error:{code:'transaction_failed',message:'Disposition operation failed'}}})
 expect(await read()).toEqual(frozen)
 db.$client.exec('DROP TRIGGER fail_public_receipt')
 expect((await http('commit',{request:retry,planHash:retryPlan.body.planHash})).status).toBe(200)
 const safe=await read();expect(JSON.stringify(safe)).not.toContain('test-api-secret')
 expect(db.select().from(s.titleCycleDispositionRevision).all().at(-1)?.fact.source.statement).toBe('未申请 test-api-secret')
 expect(db.select().from(s.recordEvent).all()).toHaveLength(1)
})
