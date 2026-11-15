import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initializeDb } from '../../../db/client'
import { qualificationMatrix } from '../fixtures/qualification-matrix'
import { submitSyntheticRecognizedCollection } from '../fixtures/recognized-source'
import { preflightRecordCorrespondences, commitRecordCorrespondences } from '../../../server/utils/record-correspondence'
import { listCurrentQualified, type CurrentQualifiedResult } from '../../../lib/roster/current-qualified-query'
import { writeCurrentWorkbook } from '../../../lib/roster/current-workbook'
import { readExportWorkbook } from '../../support/read-workbook'
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
const cleanup: Array<() => void | Promise<void>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllEnvs();vi.unstubAllGlobals()})
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'native-recognized-468-')),dbPath=join(dir,'source.sqlite')
 const db=initializeDb({create:true,dbPath}),matrix=qualificationMatrix(db.$client)
 vi.stubEnv('NUXT_DB_PATH',dbPath)
 cleanup.push(()=>{db.$client.close();rmSync(dir,{recursive:true,force:true})})
 let serial=0
 function seed(name:string,raw:Record<string,unknown>){
  const formal=matrix.formal(name,[{eventType:'award',year:2026,decidedYear:2026,batchSeq:1}],{uscc:'91330211NATIVE'+String(++serial).padStart(5,'0')})
  const rawFields={id:'NATIVE-'+serial,qymc:name,tyshxydm:formal.enterprise.usccNorm!,rdjb:'1',rddqrq:'2028-11-20',whpc:'2026-1',...raw}
  const native=submitSyntheticRecognizedCollection(db,{rdjb:'1',queriedAt:`2026-05-01T00:00:${String(serial).padStart(2,'0')}Z`,rows:[{enterpriseId:formal.enterprise.id,raw:rawFields}]})
  const request={idempotencyKey:'native-468-'+serial,sourceIdentity:'synthetic/native-468/'+serial,actor:{type:'agent' as const,id:'fixture'},basis:'Explicit synthetic recognized correspondence',ruleId:'manual',ruleVersion:'1',operations:[{action:'create' as const,status:'confirmed' as const,edge:{type:'event_recognized' as const,eventId:formal.events[0]!.id,relationId:native.relationIds[0]!,role:'recognized_corrob' as const}}]}
  commitRecordCorrespondences(db,request,preflightRecordCorrespondences(db,request).planHash)
  return {formal,native}
 }
 return {db,dir,seed}
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
 const {db,dir,seed}=setup(),{formal}=seed('四消费者企业',{whpcyear:'',whpc:'2023-2'})
 const h3=await import('h3');vi.stubGlobal('defineEventHandler',h3.defineEventHandler)
 const handler=(await import('../../../server/api/roster/current-enterprises.get')).default
 const server=createServer(h3.toNodeListener(h3.createApp().use(h3.createRouter().get('/api/roster/current-enterprises',handler))))
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));cleanup.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`
 const filter={titleCode:'innovative_sme' as const,validYear:2028,maintenanceYear:2023}
 const response=await fetch(base+'/api/roster/current-enterprises?titleCode=innovative_sme&validYear=2028&maintenanceYear=2023')
 expect(response.status).toBe(200)
 const http=await response.json() as CurrentQualifiedResult
 const tool=(await import('../../../server/mcp/tools/list_current_qualified_enterprises')).default
 const mcp=JSON.parse(await (tool as any).handler(filter,{})) as CurrentQualifiedResult
 for(const result of[http,mcp,listCurrentQualified(db.$client,filter)]){
  expect(result.total).toBe(1)
  expect(witness(result,formal.enterprise.id)).toEqual({valid:[2028],maintenance:[{year:2023,batch:null}]})
 }
 const file=join(dir,'native.xlsx'),summary=await writeCurrentWorkbook(db.$client,'innovative_sme',file,()=>{})
 expect(summary.counts).toEqual({eligible:1,pending:0,excluded:0})
 const workbook=await readExportWorkbook(readFileSync(file))
 expect(workbook.getWorksheet('有效企业')!.getCell('B2').text).toBe(formal.enterprise.name)
 expect(workbook.getWorksheet('有效企业')!.getCell('E2').text).toBe('创新型中小企业')
})
