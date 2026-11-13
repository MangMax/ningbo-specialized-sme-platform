import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { beforeAll, expect, it } from 'vitest'
import * as schema from '../db/schema'
import { queryPlatformSlots, readCompleteLegacySlot, type LegacySlotCollection, type PlatformQueryOutcome } from '../lib/platform/client'
import { buildPlatformWritePayload } from '../lib/platform/payload'
import { commitRosterImport } from '../server/utils/roster-import'
import { runPlatformReconcile } from '../server/utils/platform-reconcile'
import { normalizePlatformRelation } from '../lib/platform/normalization'
import { rowSnapshot, schemaHash } from '../lib/platform/sqlite-row-cells'
import { slotLegacyRow, slotPayloadRow, slotInputDigest, RECONCILE_SLOT_T04, captureReconcileSlot, type SlotInput } from '../lib/platform/reconcile-slot-capture'
import { installReconcileSlotPrerequisite, hasReconcileSlotCapture } from '../upgrade/reconcile-slot-schema'
import { captureSourceSlot, completeReconcileSlotCapture, readSlotCapture, sourceSlotInput, verifyReconcileHistory } from '../upgrade/reconcile-slot-capture'
import { installBusinessStatusPrerequisite } from '../upgrade/business-status'
import { upgradeCollections, withFrozenSource, manifest } from '../upgrade/collections'
import { upgradeObservations } from '../upgrade/observations'
import { upgradeProjections, projectionManifest } from '../upgrade/projections'
import { finalizeObservations, finalizeCollectionScopes } from '../upgrade/finalize-observations'
import { finalizeFingerprintBasis } from '../upgrade/fingerprint-basis'
import { finalizeApplyStored } from '../upgrade/apply-stored'
import { finalizeCandidateScopes } from '../upgrade/candidate-scope'
import { finalizeRecognizedStored } from '../upgrade/recognized-stored'
import { finalizeRecognizedWitness } from '../upgrade/recognized-witness'
import { finalizeProcessStored } from '../upgrade/process-stored'
import { transferCorrespondence } from '../upgrade/correspondence'
import { transferDifferenceReferences } from '../upgrade/difference-references'
import { indexLegacyProvenance } from '../upgrade/legacy-provenance'
import type { PlatformRawRow } from '../lib/platform/adapter'

const owner = process.env.OFFLINE_764_ROOT
if (!owner) throw new Error('Exclusive OFFLINE_764_ROOT required')
const root = join(owner,'final-fixture-batch'), source = join(root,'schema0.sqlite'), target = join(root,'target.sqlite')
mkdirSync(root,{recursive:true})
const caseRoot=mkdtempSync(join(owner,'cases-'))
const time='2026-11-13T00:00:00.000Z', uscc='91330211000000088X'
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const opts={source,target,runId:'c',collectionRunId:'c',observationRunId:'o',projectionRunId:'p',finalizationRunId:'f',batchSize:17}
const completion={source,target,runId:'capture',collectionRunId:'c'}
let serial=0
function copy(from:string,name:string,directory=root) {
  const path=join(directory,name+'.sqlite')
  copyFileSync(from,path);chmodSync(path,0o600)
  expect(statSync(path).nlink).toBe(1)
  expect(statSync(path).ino).not.toBe(statSync(from).ino)
  return path
}
function caseCopy(from:string) {return copy(from,'case-'+(++serial),caseRoot)}
function open(path:string,readonly=false) {
  const t=new Database(path,{readonly,fileMustExist:true});t.pragma('foreign_keys=ON');return t
}
function snapshot(name:string) {
  const path=join(root,name+'.sqlite')
  if (!existsSync(path)) {copyFileSync(target,path);chmodSync(path,0o400)}
  return path
}
function step(name:string,action:()=>unknown) {
  const receipt=join(root,name+'.json')
  if (!existsSync(receipt)) {
    const result=action()
    writeFileSync(receipt,JSON.stringify({result,targetSha256:hash(readFileSync(target))},null,2))
  }
}
function response(rows:PlatformRawRow[],page=1) {
  return JSON.stringify({zrarData:{grid:{businessListGrid:{page,pageSize:50,maxCount:rows.length,pageSet:rows.slice((page-1)*50,page*50)}}}})
}
async function produce(rows:PlatformRawRow[],key:string,rdjb:'1'|'2'|'3'='2') {
  return (await queryPlatformSlots({uscc:key,cookie:'offline=764',retries:0,now:()=>time,fetchImpl:async(_url,init)=>{
    const page=Number(new URLSearchParams(init.body).get('pageNum'))
    return {ok:true,status:200,text:async()=>response(rows,page)}
  }},[{interface:'business_list',rdjb}]))[0]!
}
function insert(s:Database.Database,outcome:PlatformQueryOutcome,rawRows?:PlatformRawRow[]) {
  const request=buildPlatformWritePayload({sourceIdentity:'offline764',idempotencyKey:'764:'+outcome.queryKey+':'+outcome.rdjb,
    queries:[{...outcome,outcome:{...outcome,...(rawRows?{rawRows}: {})}}],enterprises:[{id:1,name:'Capture',uscc}]})
  const result=commitRosterImport(drizzle(s,{schema}),request,[],{deferCandidateTasks:true})
  expect(result.status,JSON.stringify(result)).toBe('committed')
  return (s.prepare('SELECT id FROM platform_query WHERE query_key=? AND rdjb=?').get(outcome.queryKey,outcome.rdjb) as {id:number}).id
}
type MatrixCase={name:string;expected:'verified'|'miss'|'error'|'uncaptured';queryId:number}
let cases:MatrixCase[]=[]
beforeAll(async()=>{
  if (!existsSync(source)) {
    const s=new Database(source)
    try {
      migrate(drizzle(s),{migrationsFolder:'db/migrations'})
      s.exec(`INSERT INTO title(code,name_zh,level,rank) VALUES('innovative_sme','创新型中小企业','municipal',1),('specialized_sme','专精特新中小企业','municipal',2),('little_giant','小巨人','national',3);
        INSERT INTO enterprise(id,name,name_norm,uscc_norm) VALUES(1,'Capture','Capture','${uscc}');
        INSERT INTO record(enterprise_id,source,title_code) VALUES(1,'miit','specialized_sme');`)
      const typed:PlatformRawRow=JSON.parse(`{"id":"SHARED","qymc":"Capture","tyshxydm":"${uscc}","rdjb":"2","szsfmc":"P","cszt":"done","whpc":"B","sblx":"申请","sqsj":"D","personuuid":"A","year":2024,"n":1,"b":true,"x":null,"o":{"z":1,"a":false},"arr":[1,false],"__proto__":{"own":true},"constructor":"own"}`)
      const original=await produce([typed],uscc)
      const main=insert(s,original,[typed]);cases.push({name:'main',expected:'verified',queryId:main})
      for (const name of ['supplement','evidence-priority']) {
        const out=await produce([typed],name),id=insert(s,out,[typed])
        const batch=Number(s.prepare('SELECT max(id) FROM import_batch').pluck().get())
        s.prepare('INSERT INTO platform_query_legacy_provenance(query_id,source_identity,source_sha256,segment_index,collection,input_fingerprint,import_batch_id,created_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(id,'offline764/'+name,hash(name),0,JSON.stringify({source:'businessList',completeness:'partial',fetchedCount:1,pages:[]}),hash('input:'+name),batch,time)
        if (name==='evidence-priority') s.prepare('UPDATE platform_query SET collection_evidence=? WHERE id=?').run(JSON.stringify({source:'queryList',completeness:'not_queried',fetchedCount:0,pages:[]}),id)
        cases.push({name,expected:'verified',queryId:id})
      }
      // Other fresh slots are genuinely produced and imported, including complete empty.
      for (const rdjb of ['1','3'] as const) cases.push({name:'empty-'+rdjb,expected:'verified',queryId:insert(s,await produce([],uscc,rdjb))})
      const apply=(await queryPlatformSlots({uscc,cookie:'offline=764',retries:0,now:()=>time,fetchImpl:async()=>({ok:true,status:200,text:async()=>JSON.stringify({zrarData:{grid:{applyGrid:{page:1,pageSize:50,maxCount:0,pageSet:[]}}}})})},[{interface:'apply_list'}]))[0]!
      cases.push({name:'empty-apply',expected:'verified',queryId:insert(s,apply)})
      const multi=await produce(Array.from({length:51},(_,i)=>({id:'M'+i,cszt:'done'})),'multi')
      cases.push({name:'multi51',expected:'verified',queryId:insert(s,multi)})
      const fifty=await produce(Array.from({length:50},(_,i)=>({id:'F'+i})),'fifty')
      cases.push({name:'single50',expected:'verified',queryId:insert(s,fifty)})
      const mutations:{name:string;expected:'verified'|'miss';edit:(c:LegacySlotCollection)=>void;queryTime?:string;failureReason?:string}[]=[
        {name:'unfinished-object',expected:'verified',edit:c=>{Object.assign(c,{unfinished:{}})}},
        {name:'unfinished-empty-string',expected:'verified',edit:c=>{Object.assign(c,{unfinished:''})}},
        {name:'unparseable-query-time',expected:'verified',edit:c=>{c.queriedAt='not-date'},queryTime:'not-date'},
        {name:'nonmonotonic-page-time',expected:'verified',edit:c=>{c.pages[0]!.queriedAt='2026-11-14'}},
        {name:'ignored-page-policy',expected:'verified',edit:c=>{Object.assign(c.pages[0]!,{maxPage:99,nextPage:100})}},
        {name:'outer-failure-reason',expected:'verified',edit:()=>{},failureReason:'old outer diagnostic'},
        {name:'missing-page',expected:'miss',edit:c=>{c.pages=[]}},
        {name:'duplicate-page',expected:'miss',edit:c=>{c.pages.push({...c.pages[0]!})}},
        {name:'wrong-page',expected:'miss',edit:c=>{c.pages[0]!.page=2}},
        {name:'wrong-pagesize',expected:'miss',edit:c=>{c.pages[0]!.raw=c.pages[0]!.raw.replace('"pageSize":50','"pageSize":49')}},
        {name:'declared-changed',expected:'miss',edit:c=>{c.declaredTotal=2}},
        {name:'page-declared-changed',expected:'miss',edit:c=>{c.pages[0]!.declaredTotal=2}},
        {name:'fetched-changed',expected:'miss',edit:c=>{c.pages[0]!.fetchedCount=0}},
        {name:'request-lower',expected:'miss',edit:c=>{c.requestCount=0}},
        {name:'request-upper',expected:'miss',edit:c=>{c.requestCount=101}},
        {name:'request-fraction',expected:'miss',edit:c=>{c.requestCount=1.5}},
        {name:'request-max',expected:'verified',edit:c=>{c.requestCount=100}},
        {name:'completed-before',expected:'miss',edit:c=>{c.completedAt='2026-11-12'}},
        {name:'completed-invalid',expected:'miss',edit:c=>{c.completedAt='bad'}},
        {name:'page-time-invalid',expected:'miss',edit:c=>{c.pages[0]!.queriedAt='bad'}},
        {name:'page-error-undefined',expected:'miss',edit:c=>{Reflect.deleteProperty(c.pages[0]!,'error')}},
        {name:'wrong-source',expected:'miss',edit:c=>{c.pages[0]!.source='queryList'}},
        {name:'wrong-rdjb',expected:'miss',edit:c=>{c.pages[0]!.rdjb='3'}},
        {name:'wrong-raw-row',expected:'miss',edit:c=>{c.pages[0]!.raw=c.pages[0]!.raw.replace('SHARED','OTHER')}},
        {name:'failure-reason',expected:'miss',edit:c=>{c.failureReason='failed'}},
        {name:'unfinished-page',expected:'miss',edit:c=>{c.unfinished=[{source:'businessList',rdjb:'2',page:2}]}},
      ]
      for (const test of mutations) {
        const c:LegacySlotCollection=JSON.parse(original.raw);test.edit(c)
        c.queryKey=test.name
        const outcome={...original,queryKey:test.name,queriedAt:test.queryTime??time,raw:JSON.stringify(c),failureReason:test.failureReason??null}
        cases.push({name:test.name,expected:test.expected,queryId:insert(s,outcome,[typed])})
      }
      for (const [name,value] of [['shared-text','done'],['shared-blob',Buffer.from([0,255])],['shared-empty-blob',Buffer.alloc(0)]] as const) {
        const out=await produce([typed],name),id=insert(s,out,[typed])
        s.prepare('UPDATE platform_relation SET status=?,province=?,batch=?,declare_kind=?,applied_at=?,award_batch_label=?,year=? WHERE query_id=?').run(value,' other ',' other ','review',' other ',' other ',2020,id)
        cases.push({name,expected:'verified',queryId:id})
      }
      const unindexed=await produce([{qymc:'No key',cszt:'raw'}],'unindexed')
      const uid=insert(s,unindexed)
      s.prepare('DELETE FROM platform_business_observation WHERE relation_id IN (SELECT id FROM platform_relation WHERE query_id=?)').run(uid)
      cases.push({name:'unindexed',expected:'verified',queryId:uid})
      const fallback={id:'FB',qymc:'Fallback',tyshxydm:uscc,szsfmc:'P',cszt:'done',whpc:'B',sblx:'apply',sqsj:'D',personuuid:'A',year:'2024'}
      for (const name of ['null-raw','empty-raw']) {
        const out=await produce([fallback],name),id=insert(s,out)
        s.prepare('UPDATE platform_relation SET raw_fields=? WHERE query_id=?').run(name==='null-raw'?null:'{}',id)
        s.prepare('DELETE FROM platform_business_observation WHERE relation_id IN (SELECT id FROM platform_relation WHERE query_id=?)').run(id)
        cases.push({name,expected:'verified',queryId:id})
      }
      const invalid=insert(s,await produce([{id:'INVALID'}],'invalid-json'))
      s.prepare("UPDATE platform_relation SET raw_fields='{' WHERE query_id=?").run(invalid)
      s.prepare('DELETE FROM platform_business_observation WHERE relation_id IN (SELECT id FROM platform_relation WHERE query_id=?)').run(invalid)
      cases.push({name:'invalid-json',expected:'error',queryId:invalid})
      for (const name of ['null-response','bare-success','no-record-with-row','key-order']) {
        const id=insert(s,{...original,queryKey:name,raw:name==='null-response'?'':name==='bare-success'?response([typed]):JSON.stringify({...JSON.parse(original.raw),queryKey:name})},[typed])
        if (name==='no-record-with-row') s.prepare("UPDATE platform_query SET status='no_record' WHERE id=?").run(id)
        if (name==='key-order') {
          s.prepare('UPDATE platform_relation SET raw_fields=? WHERE query_id=?').run(JSON.stringify(Object.fromEntries(Object.entries(typed).reverse())),id)
          s.prepare('DELETE FROM platform_business_observation WHERE relation_id IN (SELECT id FROM platform_relation WHERE query_id=?)').run(id)
        }
        cases.push({name,expected:'miss',queryId:id})
      }
      s.exec("INSERT INTO platform_query(interface,query_key,rdjb,queried_at,status,created_at) VALUES('recognized_list','recognized','2','t','success','c')")
      cases.push({name:'recognized',expected:'uncaptured',queryId:Number(s.prepare('SELECT max(id) FROM platform_query').pluck().get())})
      writeFileSync(join(root,'cases.json'),JSON.stringify(cases,null,2))
      writeFileSync(join(root,'schema0-cells.json'),JSON.stringify(s.prepare('SELECT id FROM platform_relation ORDER BY id').all().map((r)=>rowSnapshot(s,'platform_relation','id',(r as {id:number}).id))))
    } finally {s.close()}
    chmodSync(source,0o400)
    writeFileSync(join(root,'source-binding.json'),JSON.stringify({sha256:hash(readFileSync(source)),base:'ee6c45f87b11dc5fe8b9f8ab4defff573c874e8b'}))
  }
  cases=JSON.parse(readFileSync(join(root,'cases.json'),'utf8'))
  expect(hash(readFileSync(source))).toBe(JSON.parse(readFileSync(join(root,'source-binding.json'),'utf8')).sha256)
  if (!existsSync(target)) copy(source,'target')
  snapshot('expand')
  step('prerequisite',()=>withFrozenSource(source,f=>{
    if (!existsSync(join(root,'status-prerequisite.json'))) installBusinessStatusPrerequisite(target,f,join(root,'status-prerequisite.json'))
    return installReconcileSlotPrerequisite(target,f)
  }))
  snapshot('prerequisite')
  step('t04',()=>upgradeCollections({...opts,transformVersion:RECONCILE_SLOT_T04}))
  snapshot('t04')
  step('t05a',()=>upgradeObservations({...opts,runId:'o'}));snapshot('t05a')
  step('t05b',()=>upgradeProjections({...opts,runId:'p'}));snapshot('t05b')
  step('t05c',()=>finalizeObservations({...opts,runId:'f'}));snapshot('t05c')
  step('scopes',()=>finalizeCollectionScopes({...opts,runId:'scopes'}));snapshot('71606')
  step('basis',()=>finalizeFingerprintBasis({source:join(root,'71606.sqlite'),target,runId:'basis',predecessorRunId:'scopes',legacySource:source}));snapshot('71607')
  step('apply',()=>finalizeApplyStored({source:join(root,'71607.sqlite'),target,runId:'apply',predecessorRunId:'basis',legacySource:source}));snapshot('71608')
  step('candidate',()=>finalizeCandidateScopes({source:join(root,'71608.sqlite'),target,runId:'candidate',predecessorRunId:'apply'}));snapshot('candidate')
  step('recognized',()=>finalizeRecognizedStored({source:join(root,'candidate.sqlite'),target,runId:'recognized',predecessorRunId:'candidate'}));snapshot('recognized')
  step('witness',()=>finalizeRecognizedWitness({source:join(root,'recognized.sqlite'),target,runId:'witness',predecessorRunId:'recognized'}));snapshot('witness')
  step('process',()=>finalizeProcessStored({source:join(root,'witness.sqlite'),target,runId:'process',predecessorRunId:'witness',legacySource:source}));snapshot('71610')
  step('correspondence',()=>transferCorrespondence({source:join(root,'71610.sqlite'),target,runId:'correspondence'}));snapshot('71611')
  step('difference',()=>transferDifferenceReferences({source:join(root,'71611.sqlite'),target,runId:'difference'}));snapshot('71612')
  step('provenance',()=>indexLegacyProvenance({source:join(root,'71612.sqlite'),target,runId:'provenance',batchSize:7}));snapshot('71613')
  step('capture',()=>completeReconcileSlotCapture(completion));snapshot('complete')
  const basePath=join(root,'base-t04.sqlite')
  if (!existsSync(join(root,'base-t04.json'))) {
    if (!existsSync(basePath)) copy(source,'base-t04')
    const {createJiti}=createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
    const base=await createJiti(import.meta.url,{fsCache:false,moduleCache:false}).import(join(owner!,'frozen/base-collections.ts'))
    const result=base.upgradeCollections({...opts,target:basePath})
    writeFileSync(join(root,'base-t04.json'),JSON.stringify(result,null,2))
    chmodSync(basePath,0o400)
  }
},120000)

it('B01 authenticates real producer and unified-import rawResponse-only rows and independently reproduces exact-base omission',async()=>{
  const s=open(source,true),db=drizzle(s,{schema})
  try {
    const main=cases.find(c=>c.name==='main')!
    const q=db.select().from(schema.platformQuery).all().find(q=>q.id===main.queryId)!
    const rows=db.select().from(schema.platformRelation).where(eq(schema.platformRelation.queryId,q.id)).all()
    expect(rows).toHaveLength(1)
    expect(q.collectionEvidence).toBeNull()
    expect(Object.keys(rows[0]!.rawFields!)).toEqual(['id','qymc','tyshxydm','rdjb','szsfmc','cszt','whpc','sblx','sqsj','personuuid','year','n','b','x','o','arr','__proto__','constructor'])
    expect(readCompleteLegacySlot(q.rawResponse,q,rows.map(slotLegacyRow))?.completeness).toBe('complete')
    expect(Object.hasOwn(slotPayloadRow(rows[0]!),'__proto__')).toBe(true)
    expect(Object.hasOwn(slotLegacyRow(rows[0]!),'__proto__')).toBe(false)
    let calls=0
    const report=await runPlatformReconcile({db,usccs:[uscc],now:()=>new Date(time),write:false,cookie:null,fetchImpl:async()=>{calls++;throw new Error('network forbidden')}})
    expect(report.queries).toEqual({network:0,reused:4,byInterface:{business_list:0,apply_list:0}})
    expect(calls).toBe(0);expect(report.relations).toBe(1);expect(report.collection.complete).toBe(4)
    writeFileSync(join(root,'schema0-service.json'),JSON.stringify(report,null,2))
    const basePath=join(root,'base-t04.sqlite')
    const b=open(basePath,true),t=open(target,true)
    try {
      expect(b.prepare('SELECT parse_state,completeness FROM platform_collection WHERE id=?').get(q.id)).toEqual({parse_state:'absent',completeness:'unknown'})
      expect(hasReconcileSlotCapture(b)).toBe(false)
      expect(readSlotCapture(t,q.id)).toMatchObject({state:'verified',rowCount:1,reason:null})
      writeFileSync(join(root,'BASE-COUNTEREXAMPLE.json'),JSON.stringify({queryId:q.id,base:hash(readFileSync(join(owner!,'frozen/base-collections.ts'))),oldComplete:true,baseCapture:false,candidate:readSlotCapture(t,q.id)},null,2))
    } finally {b.close();t.close()}
  } finally {s.close()}
})

it('B05 B07 validates every strict and permissive literal envelope case through the real complete chain',()=>{
  const s=open(source,true),t=open(target,true)
  try {
    expect(t.pragma('user_version',{simple:true})).toBe(71613)
    for (const test of cases) {
      const capture=readSlotCapture(t,test.queryId)
      expect(capture.state,test.name).toBe(test.expected)
      expect(capture, test.name).toEqual(captureSourceSlot(s,t,test.queryId))
      const input=sourceSlotInput(s,test.queryId)
      if (test.expected!=='uncaptured') expect(capture.inputSha256,test.name).toBe(slotInputDigest(input))
    }
    verifyReconcileHistory(s,t,true)
    expect(t.pragma('foreign_key_check')).toEqual([])
    expect(t.prepare("SELECT transform_version FROM platform_migration_run WHERE run_id='capture'").pluck().get()).toBe('reconcile-slot-capture-v1')
    for (const name of ['supplement','evidence-priority']) {
      const id=cases.find(c=>c.name===name)!.queryId
      expect(t.prepare('SELECT source,completeness,provenance_state FROM platform_collection WHERE id=?').get(id)).toEqual(name==='supplement'
        ?{source:'businessList',completeness:'partial',provenance_state:'legacy_supplement'}
        :{source:'queryList',completeness:'not_queried',provenance_state:'conflict'})
      expect(t.prepare('SELECT origin FROM platform_collection_legacy_provenance WHERE collection_id=?').pluck().get(id)).toBe('t04_envelope')
    }
    writeFileSync(join(root,'CAPTURE-READBACK.json'),JSON.stringify(cases.map(c=>({...c,capture:readSlotCapture(t,c.queryId)})),null,2))
  } finally {s.close();t.close()}
})

it('B07 B08 preserves all original cells aliases archives typed history and per-observation native conflicts without version fallback',()=>{
  const s=open(source,true),t=open(target,true),db=drizzle(s,{schema})
  try {
    const originalIds=s.prepare('SELECT id FROM platform_relation ORDER BY id').pluck().all()
    expect(t.prepare('SELECT old_id FROM platform_legacy_relation_alias ORDER BY old_id').pluck().all()).toEqual(originalIds)
    expect(t.prepare('SELECT old_id FROM platform_legacy_query_alias ORDER BY old_id').pluck().all()).toEqual(s.prepare('SELECT id FROM platform_query ORDER BY id').pluck().all())
    for (const id of originalIds as number[]) expect(rowSnapshot(t,'platform_relation','id',id)).toEqual(rowSnapshot(s,'platform_relation','id',id))
    for (const table of ['import_batch','import_receipt','platform_business_record']) expect(t.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).toEqual(s.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
    const shared=cases.filter(c=>c.name.startsWith('shared-'))
    const versions=shared.map(c=>t.prepare('SELECT version_id FROM platform_business_observation WHERE collection_id=?').pluck().get(c.queryId))
    expect(new Set(versions).size).toBe(1);expect(versions[0]).not.toBeNull()
    for (const [i,c] of shared.entries()) {
      const p=t.prepare('SELECT p.* FROM platform_business_projection p JOIN platform_business_observation o ON o.id=p.observation_id WHERE o.collection_id=?').get(c.queryId) as Record<string,unknown>
      const stored=[ 'done', Buffer.from([0,255]),Buffer.alloc(0) ][i]
      expect(p.stored_status).toEqual(stored);expect(p.parsed_status).toBe('done')
      expect(p.status_conflict).toBe(i===0?0:1);expect(p.reconciled_status).toBe(i===0?'done':null)
      for (const [field,stored,parsed] of [['province','other','P'],['batch','other','B'],['declare_kind','review','apply'],['applied_at','other','D'],['award_batch_label','other','A'],['year',2020,2024]] as const) {
        expect(p['stored_'+field],field).toBe(stored);expect(p['parsed_'+field],field).toBe(parsed)
        expect(p[field+'_conflict'],field).toBe(1);expect(p['reconciled_'+field],field).toBeNull()
      }
      const row=db.select().from(schema.platformRelation).where(eq(schema.platformRelation.queryId,c.queryId)).get()!
      const normalized=normalizePlatformRelation('business_list',row)
      expect(normalized.status).toEqual(i===0?'done':null)
      expect(normalized.normalizationConflicts.map(c=>c.field)).toEqual(i===0?['province','batch','declareKind','appliedAt','awardBatchLabel','year']:['province','status','batch','declareKind','appliedAt','awardBatchLabel','year'])
    }
    const unindexed=cases.find(c=>c.name==='unindexed')!
    expect(t.prepare('SELECT version_id,identity_state FROM platform_business_observation WHERE collection_id=?').get(unindexed.queryId)).toEqual({version_id:null,identity_state:'not_indexed'})
    const fallback=cases.filter(c=>c.name.endsWith('-raw'))
    for (const c of fallback) {
      const row=db.select().from(schema.platformRelation).where(eq(schema.platformRelation.queryId,c.queryId)).get()!
      expect(slotPayloadRow(row)).toEqual({id:'FB',qymc:'Fallback',tyshxydm:uscc,szsfmc:'P',cszt:'done',whpc:'B',sblx:'apply',sqsj:'D',personuuid:'A',year:'2024'})
    }
    verifyReconcileHistory(s,t,true)
    for (const v of s.prepare('SELECT id,canonical_raw_json,content_hash FROM platform_business_record_version ORDER BY id').all() as {id:number;canonical_raw_json:string;content_hash:string}[]) {
      const actual=t.prepare('SELECT a.bytes,v.content_hash FROM platform_business_record_version v JOIN platform_archive_value a ON a.id=v.canonical_archive_id WHERE v.id=?').get(v.id)
      expect(actual).toEqual({bytes:Buffer.from(v.canonical_raw_json),content_hash:v.content_hash})
    }
  } finally {s.close();t.close()}
})

it('B11 rolls prerequisite capture batch checkpoint T05 and final failures back then retries the same run and snapshot',()=>{
  const prerequisite=caseCopy(join(root,'expand.sqlite'))
  withFrozenSource(source,f=>{
    const before=hash(readFileSync(prerequisite))
    expect(()=>installReconcileSlotPrerequisite(prerequisite,f,()=>{throw new Error('prerequisite-fault')})).toThrow('prerequisite-fault')
    expect(hash(readFileSync(prerequisite))).toBe(before)
    installReconcileSlotPrerequisite(prerequisite,f)
  })
  for (const at of ['capture','checkpoint'] as const) {
    const path=caseCopy(join(root,'prerequisite.sqlite'))
    const fail=()=>{throw new Error(at+'-fault')}
    expect(()=>upgradeCollections({...opts,target:path,transformVersion:RECONCILE_SLOT_T04,beforeCapture:at==='capture'?fail:undefined,beforeCheckpoint:at==='checkpoint'?fail:undefined})).toThrow(at+'-fault')
    const t=open(path)
    expect(t.prepare('SELECT count(*) FROM platform_collection').pluck().get()).toBe(0)
    expect(t.prepare('SELECT count(*) FROM platform_archive_value').pluck().get()).toBe(0)
    expect(t.prepare('SELECT count(*) FROM platform_migration_checkpoint').pluck().get()).toBe(0)
    t.close()
    expect(upgradeCollections({...opts,target:path,transformVersion:RECONCILE_SLOT_T04}).copiedCount).toBe(cases.length)
  }
  for (const phase of ['t05a','t05b'] as const) {
    const path=caseCopy(join(root,(phase==='t05a'?'t04':'t05a')+'.sqlite'))
    const t=open(path),before=projectionManifest(t);t.close()
    const run=()=>phase==='t05a'?upgradeObservations({...opts,target:path,runId:'o',beforeCheckpoint:()=>{throw new Error('t05-fault')}}):upgradeProjections({...opts,target:path,runId:'p',beforeCheckpoint:()=>{throw new Error('t05-fault')}})
    expect(run).toThrow('t05-fault')
    const after=open(path);expect(projectionManifest(after)).toBe(before);after.close()
    expect(phase==='t05a'?upgradeObservations({...opts,target:path,runId:'o'}).state:upgradeProjections({...opts,target:path,runId:'p'}).state).toBe('complete')
  }
  const final=caseCopy(join(root,'71613.sqlite')),t=open(final),before=projectionManifest(t);t.close()
  expect(()=>completeReconcileSlotCapture({...completion,target:final,beforeCommit:()=>{throw new Error('final-fault')}})).toThrow('final-fault')
  const after=open(final);expect(projectionManifest(after)).toBe(before);expect(after.prepare("SELECT * FROM platform_migration_run WHERE run_id='capture'").get()).toBeUndefined();after.close()
  expect(completeReconcileSlotCapture({...completion,target:final}).state).toBe('complete')
})

it('B11 refuses input schema transform manifest cursor archive and historical capture drift and leaves old bindings untouched',()=>{
  for (const drift of ['source','schema','manifest','transform','cursor','archive'] as const) {
    const path=caseCopy(join(root,'t04.sqlite')),src=drift==='source'?caseCopy(source):source,t=open(path)
    if (drift==='source') {const s=open(src);s.exec("UPDATE platform_relation SET name_raw='drift' WHERE id=1");s.close()}
    if (drift==='schema') t.exec('CREATE TABLE schema_drift(id INTEGER)')
    if (drift==='manifest') t.exec("UPDATE platform_relation SET status='drift' WHERE id=1")
    if (drift==='transform') t.exec("UPDATE platform_migration_run SET transform_version='t04-collection-v1' WHERE run_id='c'")
    if (drift==='cursor') t.exec("UPDATE platform_migration_checkpoint SET last_old_id=99999 WHERE run_id='c'")
    if (drift==='archive') t.exec('DROP TRIGGER reconcile_slot_immutable; UPDATE platform_collection SET reconcile_slot_input_sha256=printf(\'%064d\',0) WHERE id=1')
    t.close()
    expect(()=>upgradeCollections({...opts,source:src,target:path,transformVersion:RECONCILE_SLOT_T04}),drift).toThrow()
  }
  const path=caseCopy(join(root,'t04.sqlite'))
  expect(()=>upgradeCollections({...opts,target:path})).toThrow('Explicit')
  withFrozenSource(source,f=>expect(()=>installReconcileSlotPrerequisite(path,f)).toThrow('Fresh'))
  const old=caseCopy(join(root,'base-t04.sqlite')),t=open(old),before=hash(readFileSync(old));t.close()
  withFrozenSource(source,f=>expect(()=>installReconcileSlotPrerequisite(old,f)).toThrow('begun'))
  expect(hash(readFileSync(old))).toBe(before)
  const running=caseCopy(join(root,'expand.sqlite'))
  expect(()=>upgradeCollections({...opts,target:running,beforeCheckpoint:()=>{throw new Error('old-running')}})).toThrow('old-running')
  const runningDb=open(running),binding=runningDb.prepare('SELECT * FROM platform_migration_run').all(),catalog=schemaHash(runningDb);runningDb.close()
  withFrozenSource(source,f=>expect(()=>installReconcileSlotPrerequisite(running,f)).toThrow('begun'))
  const preserved=open(running);expect(schemaHash(preserved)).toBe(catalog);expect(preserved.prepare('SELECT * FROM platform_migration_run').all()).toEqual(binding);expect(hasReconcileSlotCapture(preserved)).toBe(false);preserved.close()
  expect(upgradeCollections({...opts,target:running}).copiedCount).toBe(cases.length)
  expect(upgradeCollections({...opts,target:old}).copiedCount).toBe(cases.length)
  expect(hash(readFileSync(old))).toBe(before)
})

it('B12 historical completion replays only its frozen set preserves successor data and rejects historical drift',()=>{
  const path=caseCopy(join(root,'complete.sqlite')),t=open(path)
  const main=cases.find(c=>c.name==='main')!.queryId
  expect(()=>t.prepare("UPDATE platform_collection SET reconcile_slot_state='miss',reconcile_slot_reason='bad' WHERE id=?").run(main)).toThrow()
  expect(()=>t.prepare("UPDATE platform_collection SET query_key='bad' WHERE id=?").run(main)).toThrow()
  expect(()=>t.prepare("UPDATE platform_collection SET reconcile_slot_raw_archive_id=999999 WHERE id=?").run(main)).toThrow()
  t.prepare("UPDATE platform_collection SET last_collected_at='later' WHERE id=?").run(main)
  // Controlled successor facts test historical scope only; B2 writer lifecycle remains UNRUN.
  t.exec(`INSERT INTO platform_collection(id,interface,query_key,rdjb,queried_at,status,created_at,provenance_state,parse_state,rule_version,completeness)
    VALUES(999999,'business_list','successor','2','later','success','c','captured','valid','w4a-new-collection-v1','unknown');
    INSERT INTO enterprise(id,name,name_norm) VALUES(999999,'Successor','Successor');`)
  const before=projectionManifest(t);t.close()
  const result=completeReconcileSlotCapture({...completion,target:path})
  expect(result.copied_count).toBe(cases.length)
  const after=open(path);expect(projectionManifest(after)).toBe(before)
  after.exec(`DROP TRIGGER reconcile_slot_immutable; UPDATE platform_collection SET reconcile_slot_input_sha256=printf('%064d',0) WHERE id=${main}`);after.close()
  expect(()=>completeReconcileSlotCapture({...completion,target:path})).toThrow()
})

it('B11 preserves old completed71613 catalog receipts and exact original provenance replay without installing capture',()=>{
  const shared=process.env.PLATFORM_757_FIXTURES!
  const path=caseCopy(join(shared,'normal-71613.sqlite')),oldSource=join(owner!,'frozen/old-71612.sqlite')
  expect(hash(readFileSync(path))).toBe('8acbef6f3a16762383307924a8a289a984aa1dd8839458135b2fd5d1c0cb8844')
  const t=open(path),before=hash(readFileSync(path)),catalog=schemaHash(t),logs=t.prepare('SELECT * FROM platform_migration_run ORDER BY run_id').all();t.close()
  withFrozenSource(source,f=>expect(()=>installReconcileSlotPrerequisite(path,f)).toThrow('Fresh'))
  expect(indexLegacyProvenance({source:oldSource,target:path,runId:'review-normal'}).state).toBe('complete')
  const after=open(path);expect(hasReconcileSlotCapture(after)).toBe(false);expect(schemaHash(after)).toBe(catalog);expect(after.prepare('SELECT * FROM platform_migration_run ORDER BY run_id').all()).toEqual(logs);after.close()
  expect(hash(readFileSync(path))).toBe(before)
})

it('B11 runs the explicit offline completion CLI on a private copy with the same historical source binding',()=>{
  const path=caseCopy(join(root,'71613.sqlite')),evidence=join(caseRoot,'completion-cli-'+serial);mkdirSync(evidence)
  const result=spawnSync(process.execPath,['upgrade/run.mjs','complete-reconcile-slot',source,path,evidence,'capture','c'],{encoding:'utf8',env:{...process.env,JITI_FS_CACHE:'false',NODE_DISABLE_COMPILE_CACHE:'1'}})
  expect(result.status,result.stderr).toBe(0)
  const receipt=JSON.parse(readFileSync(join(evidence,'receipt.json'),'utf8'))
  expect(receipt.source_snapshot_sha256).toBe(hash(readFileSync(source)))
  expect(receipt.transform_version).toBe('reconcile-slot-capture-v1')
  expect(completeReconcileSlotCapture({...completion,target:path})).toEqual(receipt)
})

it('B07 distinguishes missing ref from SQL NULL and binds every fallback cell independent of parsed payload',()=>{
  const s=open(source,true)
  try {
    const test=cases.find(c=>c.name==='null-response')!,input=sourceSlotInput(s,test.queryId)
    expect(input.rawResponse).toEqual({storageClass:'null',byteLength:null,sha256:null})
    expect(captureReconcileSlot({...input,rawResponse:{missing:true}},null,null,{rows:[]})).toMatchObject({state:'uncaptured',reason:'missing_raw_ref',inputSha256:null})
    const original=slotInputDigest(input)
    for (const column of ['relation_key','name_raw','uscc_raw','province','status','batch','declare_kind','applied_at','award_batch_label','year']) {
      const modified:SlotInput=structuredClone(input),cell=modified.relations[0]!.fallbackCells.find(c=>c.name===column)!
      cell.hex+='00';expect(slotInputDigest(modified),column).not.toBe(original)
    }
    expect(manifest(s,undefined,true).digest).not.toBe(manifest(s).digest)
  } finally {s.close()}
})

it('B05 keeps literal multi-page ordering partitions and permissive unfinished shapes equal to the original validator',()=>{
  const s=open(source,true),db=drizzle(s,{schema}),test=cases.find(c=>c.name==='multi51')!
  try {
    const q=db.select().from(schema.platformQuery).where(eq(schema.platformQuery.id,test.queryId)).get()!
    const rows=db.select().from(schema.platformRelation).where(eq(schema.platformRelation.queryId,q.id)).all()
    const base:LegacySlotCollection=JSON.parse(q.rawResponse!)
    const variants:{name:string;accepted:boolean;edit:(c:LegacySlotCollection)=>void}[]=[
      {name:'complete-51',accepted:true,edit:()=>{}},
      {name:'missing-last',accepted:false,edit:c=>{c.pages.pop()}},
      {name:'repeated-second',accepted:false,edit:c=>{c.pages[1]!.page=1}},
      {name:'changed-second-declaration',accepted:false,edit:c=>{c.pages[1]!.declaredTotal=50}},
      {name:'reversed-rows',accepted:false,edit:c=>{const raw=JSON.parse(c.pages[0]!.raw);raw.zrarData.grid.businessListGrid.pageSet.reverse();c.pages[0]!.raw=JSON.stringify(raw)}},
      {name:'backward-page-times',accepted:true,edit:c=>{c.pages[1]!.queriedAt='2025-01-01'}},
      {name:'unfinished-false',accepted:true,edit:c=>{Object.assign(c,{unfinished:false})}},
      {name:'unfinished-null',accepted:false,edit:c=>{Object.assign(c,{unfinished:null})}},
    ]
    for (const v of variants) {
      const envelope=structuredClone(base);v.edit(envelope)
      const raw=JSON.stringify(envelope),bytes=Buffer.from(raw),input=sourceSlotInput(s,q.id)
      input.rawResponse={storageClass:'text',byteLength:bytes.length,sha256:hash(bytes)}
      expect(Boolean(readCompleteLegacySlot(raw,q,rows.map(slotLegacyRow))),v.name).toBe(v.accepted)
      expect(captureReconcileSlot(input,1,raw,{rows}).state,v.name).toBe(v.accepted?'verified':'miss')
    }
  } finally {s.close()}
})

it('B07 independently hashes the ordered native input envelope without reparsing raw archive bytes',()=>{
  const s=open(source,true),t=open(target,true),q=cases.find(c=>c.name==='main')!.queryId
  try {
    const query=s.prepare('SELECT id,interface,rdjb,query_key queryKey,queried_at queriedAt FROM platform_query WHERE id=?').get(q)
    const bytes=(table:string,column:string,id:number)=>s.prepare(`SELECT typeof(${column}) storageClass,length(cast(${column} AS blob)) byteLength,cast(${column} AS blob) bytes FROM ${table} WHERE id=?`).get(id) as {storageClass:string;byteLength:number|null;bytes:Buffer|null}
    const raw=bytes('platform_query','raw_response',q)
    const relations=(s.prepare('SELECT id,sequence_no sequenceNo FROM platform_relation WHERE query_id=? ORDER BY sequence_no').all(q) as {id:number;sequenceNo:number}[]).map(row=>{
      const raw=bytes('platform_relation','raw_fields',row.id)
      const fallbackCells=['relation_key','name_raw','uscc_raw','province','status','batch','declare_kind','applied_at','award_batch_label','year'].map(name=>{
        const c=bytes('platform_relation',name,row.id)
        return {name,storageClass:c.storageClass,hex:c.bytes?.toString('hex').toUpperCase()??''}
      })
      return {...row,rawFields:{storageClass:raw.storageClass,byteLength:raw.byteLength,sha256:raw.bytes===null?null:hash(raw.bytes)},fallbackCells}
    })
    const expected=hash(JSON.stringify({rule:'legacy-reconcile-slot-v1',query,rawResponse:{storageClass:raw.storageClass,byteLength:raw.byteLength,sha256:raw.bytes===null?null:hash(raw.bytes)},relations}))
    expect(readSlotCapture(t,q).inputSha256).toBe(expected)
  } finally {s.close();t.close()}
})

it('B11 enforces capture checks sealed same-owner FK binding and insert barriers independently of the update freeze',()=>{
  const path=caseCopy(join(root,'complete.sqlite')),t=open(path),id=cases.find(c=>c.name==='main')!.queryId
  try {
    const capture=readSlotCapture(t,id)
    expect(t.pragma('foreign_key_list(platform_collection)')).toEqual(expect.arrayContaining([expect.objectContaining({from:'reconcile_slot_raw_archive_id',table:'platform_archive_value',to:'id',on_delete:'RESTRICT'})]))
    t.exec('DROP TRIGGER reconcile_slot_immutable')
    for (const assignment of ["reconcile_slot_state='invalid'","reconcile_slot_rule='wrong'","reconcile_slot_row_count=-1","reconcile_slot_row_count=0.5","reconcile_slot_row_count=NULL","reconcile_slot_input_sha256='bad'","reconcile_slot_reason='not-null'","reconcile_slot_state='error'"]) {
      expect(()=>t.exec(`UPDATE platform_collection SET ${assignment} WHERE id=${id}`),assignment).toThrow()
      expect(readSlotCapture(t,id)).toEqual(capture)
    }
    const other=readSlotCapture(t,cases.find(c=>c.name==='empty-1')!.queryId).rawArchiveId!
    expect(()=>t.prepare('UPDATE platform_collection SET reconcile_slot_raw_archive_id=? WHERE id=?').run(other,id)).toThrow('sealed raw owner')
    expect(()=>t.prepare(`INSERT INTO platform_collection(id,interface,query_key,rdjb,queried_at,status,created_at,provenance_state,parse_state,rule_version,completeness,
      reconcile_slot_state,reconcile_slot_rule,reconcile_slot_raw_archive_id,reconcile_slot_row_count,reconcile_slot_input_sha256)
      VALUES(99999,'business_list','forged','2','t','success','c','captured','valid','fake','unknown','verified','legacy-reconcile-slot-v1',?,0,?)`).run(capture.rawArchiveId,capture.inputSha256)).toThrow('capture after original owner seal')
  } finally {t.close()}
})

it('B11 retains committed T04 prefixes and T05 observation batches when a later capture checkpoint or version batch fails',()=>{
  const second=cases[1]!.queryId
  for (const at of ['capture','checkpoint'] as const) {
    const path=caseCopy(join(root,'prerequisite.sqlite'))
    const fail=(id:number)=>{if(id===second)throw new Error('later-'+at)}
    expect(()=>upgradeCollections({...opts,target:path,batchSize:1,transformVersion:RECONCILE_SLOT_T04,beforeCapture:at==='capture'?fail:undefined,beforeCheckpoint:at==='checkpoint'?fail:undefined})).toThrow('later-'+at)
    const t=open(path)
    expect(t.prepare('SELECT id FROM platform_collection ORDER BY id').pluck().all()).toEqual([cases[0]!.queryId])
    expect(readSlotCapture(t,cases[0]!.queryId).state).toBe('verified')
    expect(t.prepare("SELECT last_old_id,copied_count FROM platform_migration_checkpoint WHERE run_id='c'").get()).toEqual({last_old_id:cases[0]!.queryId,copied_count:1})
    t.close()
    const retried=upgradeCollections({...opts,target:path,transformVersion:RECONCILE_SLOT_T04})
    expect(retried.batchDigest).toBe(JSON.parse(readFileSync(join(root,'t04.json'),'utf8')).result.batchDigest)
  }
  const path=caseCopy(join(root,'t05a.sqlite'))
  expect(()=>upgradeProjections({...opts,target:path,runId:'p',beforeCheckpoint:phase=>{if(phase==='versions')throw new Error('version-fault')}})).toThrow('version-fault')
  const t=open(path)
  expect(t.prepare("SELECT count(*) FROM platform_migration_checkpoint WHERE run_id='p' AND phase='t05b-versions'").pluck().get()).toBe(0)
  expect(t.prepare("SELECT copied_count FROM platform_migration_checkpoint WHERE run_id='p' AND phase='t05b-observations'").pluck().get()).toBe(t.prepare('SELECT count(*) FROM platform_relation').pluck().get())
  t.close()
  expect(upgradeProjections({...opts,target:path,runId:'p'}).state).toBe('complete')
})

it('B11 refuses final source catalog transform manifest cursor and completion-run drift without rewriting receipts',()=>{
  for (const drift of ['source','schema','transform','manifest','cursor','run'] as const) {
    const path=caseCopy(join(root,'complete.sqlite')),src=drift==='source'?caseCopy(source):source,t=open(path)
    if (drift==='source') {const s=open(src);s.exec("UPDATE platform_relation SET name_raw='source-drift' WHERE id=1");s.close()}
    if (drift==='schema') t.exec('CREATE TABLE final_schema_drift(id INTEGER)')
    if (drift==='transform') t.exec("UPDATE platform_migration_run SET transform_version='t04-collection-v1' WHERE run_id='c'")
    if (drift==='manifest') t.exec("UPDATE platform_migration_run SET source_manifest_sha256='drift' WHERE run_id='c'")
    if (drift==='cursor') t.exec("UPDATE platform_migration_checkpoint SET copied_count=0 WHERE run_id='capture'")
    const before=t.prepare('SELECT * FROM platform_migration_run ORDER BY run_id').all();t.close()
    expect(()=>completeReconcileSlotCapture({...completion,source:src,target:path,runId:drift==='run'?'other-run':'capture'}),drift).toThrow()
    const after=open(path);expect(after.prepare('SELECT * FROM platform_migration_run ORDER BY run_id').all()).toEqual(before);after.close()
  }
})
