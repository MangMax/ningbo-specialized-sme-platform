import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import * as schema from '../../db/schema'
import { targetSchema } from '../../lib/platform/target-schema'
import { ensurePlatformObservation } from '../../server/utils/platform-business-record'
import { witnessReaderFixture } from './recognized-witness-target-733'
import { finalizeProcessStored } from '../../upgrade/process-stored'

export async function processReaderFixture(unindexed = false, extra?: (source: Database.Database) => void) {
  const f=await witnessReaderFixture(source=>{
    source.exec(`INSERT INTO enterprise(id,name,name_norm,uscc_norm) VALUES(1,'Alpha','Alpha','U1'),(2,'Beta','Beta','U2');
      INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,last_collected_at,status,created_at) VALUES
      (11,'business_list','Q1','2,3','2026-01-01','2026-01-02','success','c'),
      (12,'business_list','Q2','3','2026-02-01',NULL,'success','c'),
      (13,'business_list','Q3',' 1 , 2 ','2025-01-01',NULL,'success','c');`)
    source.prepare('UPDATE platform_query SET collection_evidence=? WHERE id=13').run(JSON.stringify({titleScope:{rdjb:['3']},pages:[{status:'success',rdjb:'3',fetchedCount:2,page:1}]}))
    const insert=source.prepare('INSERT INTO platform_relation(id,query_id,sequence_no,enterprise_id,relation_key,name_raw,uscc_raw,raw_fields,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    const a={id:'A',rdjb:'1',sblx:'申请',year:2024,sqsj:'2025-03-01',cszt:'pending',whpc:'B',personuuid:'Award',szsfmc:'P'}
    const rows=[
      [1,11,1,1,'A','Source','U1',a],
      [2,12,1,2,'A','Source','U1',a],
      [3,13,1,1,'A','Source','U1',{...a,rdjb:'2',sblx:'复核',year:2025,sqsj:'2024-01-01',cszt:'done',whpc:'C'}],
      [4,12,2,2,'B','Beta','U2',{...a,id:'B',year:'2e3',sqsj:null}],
      [5,11,2,null,null,' Original ',' U ',{...a,id:undefined,rdjb:'1'}],
      [6,13,2,null,'conflict','Conflict',null,{...a,id:'different'}],
      [7,11,3,null,null,' Raw only ',null,{rdjb:false,cszt:'raw'}],
      [8,12,3,null,null,' No raw ',null,null],
    ] as const
    for(const [id,q,seq,owner,key,name,uscc,raw] of rows) insert.run(id,q,seq,owner,key,name,uscc,raw===null?null:JSON.stringify(raw),'c')
    const db=drizzle(source,{schema}); for(const id of [1,2,3,4,5,6,...(unindexed?[]:[7,8])]) ensurePlatformObservation(db,id)
    source.exec(`UPDATE platform_relation SET title_raw=' X ',declare_kind='申请',year=2024,status=' pending ',batch=' B ',applied_at=' D ',award_batch_label=' Award ',province=' P ' WHERE id=5;
      UPDATE platform_relation SET status='other' WHERE id=2;
      UPDATE platform_relation SET declare_kind='review',year=2020,status='other',batch='other',applied_at='other',award_batch_label='other',province='other' WHERE id=6;
      UPDATE platform_relation SET title_raw=X'3200ff',status=char(9),batch='' WHERE id=8;`)
    db.insert(schema.recordCorrespondence).values({enterpriseId:1,titleCode:'specialized_sme',relationId:1,edgeKey:'edge',type:'event_process',role:'candidate',status:'rejected',revision:1,targetIdentity:{},provenance:{},sourceFingerprint:'f',ruleId:'r',ruleVersion:'v',createdAt:'c'}).run()
    extra?.(source)
  })
  return completedProcessReaderFixture(f)
}

export async function emptyProcessReaderFixture() {
  return completedProcessReaderFixture(await witnessReaderFixture(() => {}))
}

function completedProcessReaderFixture(f: Awaited<ReturnType<typeof witnessReaderFixture>>) {
  f.close()
  const source=join(f.root,'process-source.sqlite');copyFileSync(f.target,source)
  finalizeProcessStored({source,target:f.target,runId:'process',predecessorRunId:'witness',legacySource:f.legacySource})
  const statements:string[]=[],t=new Database(f.target,{verbose:q=>statements.push(String(q))});t.pragma('foreign_keys=ON')
  const legacy=new Database(f.legacySource,{readonly:true})
  return {...f,t,legacy,db:drizzle(t,{schema:targetSchema}),old:drizzle(legacy,{schema}),statements,close(){legacy.close();t.close()}}
}
