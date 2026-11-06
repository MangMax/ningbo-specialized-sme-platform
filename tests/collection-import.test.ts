import { it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeDb } from '../db/client'
import { preflightRosterImport, commitRosterImport } from '../server/utils/roster-import'
import { platformResultToImport } from '../lib/platform/recognized-evidence'
import { snapshotInput } from '../server/utils/difference-snapshot'
import type { PlatformLiveQueryResult } from '../lib/platform/live-query'
const stores: ReturnType<typeof initializeDb>[]=[]
const directories: string[]=[]
afterEach(()=>{for(const db of stores.splice(0))db.$client.close();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})
function evidence(source: PlatformLiveQueryResult['source'], revision=0): PlatformLiveQueryResult {
 const raw={id:'original-1',qymc:'fixture',tyshxydm:'91330200123456789X',sblx:'1',year:2026,whpcyear:2026,whpc:revision?'补全':null,unknown:{nested:[null,17,false]},empty:null}
 const rows=[Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,v===null?'':typeof v==='object'?JSON.stringify(v):String(v)]))]
 return {source,status:'success',effectiveConditions:{uscc:raw.tyshxydm,combination:'and'},titleScope:{mode:source==='queryList'?'source_default':'selected',rdjb:source==='queryList'?[]:['1']},queriedAt:`2026-11-06T00:00:0${revision}Z`,completedAt:`2026-11-06T00:00:0${revision+1}Z`,rows,dataRows:[raw],pages:[{source,rdjb:source==='queryList'?null:'1',page:1,status:'success',fetchedCount:1,declaredTotal:1,error:null}],fetchedCount:1,declaredTotal:1,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:100,maxRows:5000,maxDurationMs:60000,pageSize:50}} as PlatformLiveQueryResult
}
it('archives all three typed business sources without HTML and appends changed versions while reusing equal content',()=>{
 const directory=mkdtempSync(join(tmpdir(),'collection-import-'));directories.push(directory)
 const db=initializeDb({create:true,dbPath:join(directory,'fixture.sqlite')});stores.push(db)
 for(const source of ['queryList','businessList','queryBusList'] as const)for(const revision of [0,1,2]){
  const result=evidence(source,revision===2?1:revision);if(revision===2){result.queriedAt='2026-11-06T00:00:03Z';result.completedAt='2026-11-06T00:00:04Z'}
  const request={idempotencyKey:`collection:${source}:${revision}`,sourceKind:'platform_archive' as const,sourceIdentity:'fixture',payload:{platformQueries:[platformResultToImport(result)]}}
  expect(preflightRosterImport(db,request).status).toBe('preflight')
  expect(commitRosterImport(db,request,[],{deferCandidateTasks:true}).status).toBe('committed')
  expect(commitRosterImport(db,request,[],{deferCandidateTasks:true}).status).toBe('committed')
 }
 expect(db.$client.prepare('select count(*) n from platform_business_record').get()).toEqual({n:3})
 expect(db.$client.prepare('select count(*) n from platform_business_record_version').get()).toEqual({n:6})
 for(const table of ['platform_apply_projection','platform_business_projection','platform_recognized_projection'])expect(db.$client.prepare(`select count(*) n from ${table}`).get()).toEqual({n:2})
 const versions=db.$client.prepare('select canonical_raw_json raw from platform_business_record_version').all() as {raw:string}[]
 expect(versions.every(v=>JSON.parse(v.raw).unknown.nested[0]===null&&JSON.parse(v.raw).empty===null)).toBe(true)
 const queries=db.$client.prepare('select collection_evidence evidence,raw_response raw from platform_query').all() as {evidence:string;raw:unknown}[]
 expect(queries.every(q=>q.raw===null&&!q.evidence.includes('rawData')&&!q.evidence.includes('body'))).toBe(true)
})
it('validates exact selected enterprise IDs and rejects empty or excessive scopes',()=>{
 expect(snapshotInput.safeParse({action:'create',clientRequestId:'x',enterpriseIds:[1,1,2]}).success).toBe(true)
 for(const enterpriseIds of [[],[0],[-1],[1.5],Array.from({length:201},(_,i)=>i+1)])expect(snapshotInput.safeParse({action:'create',clientRequestId:'x',enterpriseIds}).success).toBe(false)
})
it('rejects typed row count and projection mismatches without relaxing raw response validation',()=>{
 const count=evidence('queryList');count.dataRows=[]
 expect(()=>platformResultToImport(count)).toThrow('cover every accepted row')
 const projection=evidence('queryList');projection.rows[0]!.year='1999'
 expect(()=>platformResultToImport(projection)).toThrow('match their string projection')
 const both=evidence('queryList');both.rawData={version:1,rows:both.dataRows!,pages:[]}
 expect(()=>platformResultToImport(both)).toThrow('never both')
})

it('reuses complete identical collections without adding queries relations observations or versions and advances last collection time', async()=>{
 const {reuseCollectedPlatformResult}=await import('../server/utils/platform-collection-reuse')
 const directory=mkdtempSync(join(tmpdir(),'collection-reuse-'));directories.push(directory)
 const db=initializeDb({create:true,dbPath:join(directory,'fixture.sqlite')});stores.push(db)
 const enterprise=db.$client.prepare('insert into enterprise(name,name_norm,uscc_norm) values(?,?,?) returning id').get('fixture','fixture','91330200123456789X') as {id:number}
 const tables=['platform_query','platform_relation','platform_business_observation','platform_business_record_version']
 const counts=()=>tables.map(t=>(db.$client.prepare(`select count(*) n from ${t}`).get() as {n:number}).n)
 for(const source of ['queryList','businessList','queryBusList'] as const){
  const first=evidence(source)
  expect(reuseCollectedPlatformResult(db,first,enterprise.id)).toBe(false)
  const request={idempotencyKey:`reuse:${source}`,sourceKind:'platform_archive' as const,sourceIdentity:'fixture',payload:{platformQueries:[platformResultToImport(first)]}}
  expect(commitRosterImport(db,request,[],{deferCandidateTasks:true}).status).toBe('committed')
  const before=counts(),repeat=structuredClone(first);repeat.queriedAt='2026-11-06T00:00:10Z';repeat.completedAt='2026-11-06T00:00:11Z'
  expect(reuseCollectedPlatformResult(db,repeat,enterprise.id)).toBe(true)
  expect(counts()).toEqual(before)
  const row=db.$client.prepare('select queried_at,last_collected_at from platform_query where interface=?').get({queryList:'apply_list',businessList:'business_list',queryBusList:'recognized_list'}[source])
  expect(row).toEqual({queried_at:first.queriedAt,last_collected_at:repeat.queriedAt})
  expect(reuseCollectedPlatformResult(db,first,enterprise.id)).toBe(true)
  expect(db.$client.prepare('select last_collected_at t from platform_query where interface=?').get({queryList:'apply_list',businessList:'business_list',queryBusList:'recognized_list'}[source])).toEqual({t:repeat.queriedAt})
  expect(reuseCollectedPlatformResult(db,evidence(source,1),enterprise.id)).toBe(false)
  const partial={...repeat,completeness:'partial' as const,fullRange:false};expect(reuseCollectedPlatformResult(db,partial,enterprise.id)).toBe(false)
  expect(reuseCollectedPlatformResult(db,repeat,enterprise.id+1)).toBe(false)
  const table={queryList:'platform_apply_projection',businessList:'platform_business_projection',queryBusList:'platform_recognized_projection'}[source]
  db.$client.prepare(`delete from ${table}`).run()
  expect(reuseCollectedPlatformResult(db,repeat,enterprise.id)).toBe(false)
 }
})
