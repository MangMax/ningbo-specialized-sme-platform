import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { nativeAppAdapter } from '../../support/native-app'
import { qualificationMatrix } from '../fixtures/qualification-matrix'
import { submitSyntheticRecognizedCollection } from '../fixtures/recognized-source'
import { preflightRecordCorrespondences, commitRecordCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence'
import { listCurrentQualified, type CurrentQualifiedResult } from '../../../layers/sme-roster/lib/roster/current-qualified-query'
import { readExportWorkbook } from '../../support/read-workbook'
const cleanup: Array<() => void | Promise<void>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'native-recognized-468-'))
 const app = nativeAppAdapter({ dir, token: 'recognized-facts-fixture' })
 const db = app.db, matrix = qualificationMatrix(db.$client)
 cleanup.push(async () => { try { await app.close() } finally { rmSync(dir,{recursive:true,force:true}) } })
 let serial=0
 function seed(name:string,raw:Record<string,unknown>){
  const formal=matrix.formal(name,[{eventType:'award',year:2026,decidedYear:2026,batchSeq:1}],{uscc:'91330211NATIVE'+String(++serial).padStart(5,'0')})
  const rawFields={id:'NATIVE-'+serial,qymc:name,tyshxydm:formal.enterprise.usccNorm!,rdjb:'1',rddqrq:'2028-11-20',whpc:'2026-1',...raw}
  const native=submitSyntheticRecognizedCollection(db,{rdjb:'1',queriedAt:`2026-05-01T00:00:${String(serial).padStart(2,'0')}Z`,rows:[{enterpriseId:formal.enterprise.id,raw:rawFields}]})
  const request={idempotencyKey:'native-468-'+serial,sourceIdentity:'synthetic/native-468/'+serial,actor:{type:'agent' as const,id:'fixture'},basis:'Explicit synthetic recognized correspondence',ruleId:'manual',ruleVersion:'1',operations:[{action:'create' as const,status:'confirmed' as const,edge:{type:'event_recognized' as const,eventId:formal.events[0]!.id,relationId:native.relationIds[0]!,role:'recognized_corrob' as const}}]}
  commitRecordCorrespondences(db,request,preflightRecordCorrespondences(db,request).planHash)
  return {formal,native}
 }
 return {app,db,dir,seed}
}
function witness(result:CurrentQualifiedResult,id:number){const row=result.rows.find(row=>row.enterpriseId===id)!;return {valid:row.matchedValidYears,maintenance:row.matchedMaintenance}}

it('native source facts preserve malformed padded missing null empty and typed validity partitions',()=>{
 const {db,seed}=setup()
 const cases:Array<{label:string;raw:Record<string,unknown>;valid:number[];maintenance:Array<{year:number;batch:null}>}>=[
  ...['bad',0,false,' ',' 2024 ','2026',2026,[],{}].map(value=>({label:JSON.stringify(value),raw:{whpcyear:value},valid:[2028],maintenance:[]})),
  ...[{}, {whpcyear:null},{whpcyear:''}].map(raw=>({label:JSON.stringify(raw),raw,valid:[2028],maintenance:[{year:2026,batch:null}]})),
  {label:'padded date',raw:{rddqrq:' 2028-11-20 ',whpcyear:''},valid:[],maintenance:[{year:2026,batch:null}]},
  {label:'padded batch',raw:{whpc:' 2026-1 ',whpcyear:''},valid:[2028],maintenance:[]},
  {label:'nonstring',raw:{rddqrq:2028,whpc:2026,whpcyear:''},valid:[],maintenance:[]},
  {label:'invalid calendar',raw:{rddqrq:'2028-02-30',whpc:'2026-16',whpcyear:''},valid:[],maintenance:[]},
 ]
 for(const [i,item]of cases.entries()){
  const {formal}=seed('边界'+String(i).padStart(2,'0'),item.raw)
  const result=listCurrentQualified(db.$client,{titleCode:'innovative_sme',q:formal.enterprise.name})
  expect(witness(result,formal.enterprise.id),item.label).toEqual({valid:item.valid,maintenance:item.maintenance})
 }
})

it('HTTP MCP and parsed XLSX consume native recognized facts without a staged projection or source selector',async()=>{
 const {app,db,seed}=setup(),{formal}=seed('四消费者企业',{whpcyear:'',whpc:'2023-2'})
 await app.start()
 const filter={titleCode:'innovative_sme' as const,validYear:2028,maintenanceYear:2023}
 const response=await fetch(app.url('/api/roster/current-enterprises?titleCode=innovative_sme&validYear=2028&maintenanceYear=2023'))
 expect(response.status).toBe(200)
 const http=await response.json() as CurrentQualifiedResult
 const reply = await fetch(app.url('/mcp'), {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_current_qualified_enterprises', arguments: filter } }),
 })
 expect(reply.status).toBe(200)
 const raw = await reply.text()
 const wire = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
 const mcp = JSON.parse(wire.result.content[0].text) as CurrentQualifiedResult
 for(const result of[http,mcp,listCurrentQualified(db.$client,filter)]){
  expect(result.total).toBe(1)
  expect(witness(result,formal.enterprise.id)).toEqual({valid:[2028],maintenance:[{year:2023,batch:null}]})
 }
 const submitted = await app.request('/api/roster/exports/current/innovative-sme', {
  method: 'POST', body: JSON.stringify({ clientRequestId: 'recognized-facts-export' }),
 })
 expect(submitted.status).toBe(202)
 const job = await app.terminal((await submitted.json()).jobId)
 expect(job.state, JSON.stringify(job)).toBe('done')
 expect(job.result.counts).toEqual({eligible:1,pending:0,excluded:0})
 const download = await app.download(job.result.artifact.downloadUrl)
 expect(download.response.status).toBe(200)
 const workbook=await readExportWorkbook(download.bytes)
 expect(workbook.getWorksheet('有效企业')!.getCell('B2').text).toBe(formal.enterprise.name)
 expect(workbook.getWorksheet('有效企业')!.getCell('E2').text).toBe('创新型中小企业')
}, 60000)
