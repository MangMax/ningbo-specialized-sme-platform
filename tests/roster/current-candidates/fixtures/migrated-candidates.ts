import { upgradeTitleCycleDisposition } from '../../../../db/title-cycle-disposition'
import { completePlatformMigration } from '../../../../upgrade/complete-platform'
import { copyFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { ensurePlatformObservation } from '../../../../upgrade/frozen/server/platform-business-record'
import * as s from '../../../../upgrade/legacy-schema'
import * as targetSchema from '../../../../db/schema'
import { normalizeUscc } from '../../../../lib/domain'
import { currentCandidateBindings, currentCandidateSql } from '../../../../upgrade/frozen/current-candidates'
import type { CurrentTitle } from '../../../../lib/roster/current-titles'
export const titles = ['innovative_sme','specialized_sme','little_giant'] as const
export const literalCandidates = {
  innovative_sme:[1,2,3,6,7,9,16,17,19,20,22,23,24],
  specialized_sme:[1,2,3,4,6,7,10,13,18,19,20,21,22],
  little_giant:[1,2,3,5,6,7,8,11,20],
} satisfies Record<CurrentTitle,number[]>
async function buildTemplate() {
  const root=mkdtempSync(join(tmpdir(),'candidate-template-')); clones.push(root)
  const legacySource=join(root,'legacy.sqlite')
  const old=new Database(legacySource)
  try {
    migrate(drizzle(old),{migrationsFolder:'db/migrations'})
    old.exec("INSERT INTO title(code,name_zh,level,rank) VALUES('innovative_sme','创新型中小企业','municipal',1),('specialized_sme','专精特新中小企业','municipal',2),('little_giant','小巨人','national',3)")
    const db=drizzle(old,{schema:s})
    for(let id=1;id<=24;id++)db.insert(s.enterprise).values({id,name:id%2?'same':'Same',nameNorm:'same',usccNorm:id===20?' u7 ':id===23?'':id===24?' \u200b ':`U${id}`}).run()
    for(const title of titles){
      db.insert(s.record).values({enterpriseId:1,titleCode:title,source:'jxj'}).run()
      db.insert(s.differenceReason).values({enterpriseId:2,titleCode:title,direction:'missing_in_miit',status:'needs_review',recordedAt:'t'}).run()
      db.insert(s.recordCorrespondence).values({enterpriseId:3,titleCode:title,edgeKey:title,type:'event_process',role:'candidate',status:'rejected',revision:1,targetIdentity:{},provenance:{},sourceFingerprint:'f',ruleId:'r',ruleVersion:'v',createdAt:'c'}).run()
      db.insert(s.recordCorrespondence).values({enterpriseId:null,titleCode:title,edgeKey:title+'-null',type:'event_process',role:'candidate',status:'candidate',revision:1,targetIdentity:{},provenance:{},sourceFingerprint:'f',ruleId:'r',ruleVersion:'v',createdAt:'c'}).run()
    }
    function query(id:number,rdjb:string,titleCode?:CurrentTitle,evidence?:string,source?:'recognized_list'){
      db.insert(s.platformQuery).values({id,rdjb,titleCode,interface:source??(id%3===0?'apply_list':id%3===1?'recognized_list':'business_list'),queryKey:`Q${id}`,queriedAt:'t',status:'success'}).run()
      if(evidence!==undefined)old.prepare('UPDATE platform_query SET collection_evidence=? WHERE id=?').run(evidence,id)
    }
    function row(queryId:number,sequenceNo:number,enterpriseId:number|null,usccRaw:string|null=null,rawFields:Record<string,unknown>={rdjb:'1'}){
      return db.insert(s.platformRelation).values({queryId,sequenceNo,enterpriseId,usccRaw,rawFields,verificationStatus:'pending',matchBasis:'none'}).returning().get()
    }
    query(1,'1,2,3',undefined,JSON.stringify({pages:[{status:'failed',rdjb:'1',fetchedCount:99},{status:'success',rdjb:'1',fetchedCount:0},{status:'success',rdjb:'2',fetchedCount:1},{status:'success',rdjb:'3',fetchedCount:1}]}))
    row(1,1,4);row(1,2,5);row(1,3,6)
    query(2,'1,2,3');row(2,1,null,' u7 ')
    query(3,'1','little_giant');row(3,1,8)
    query(4,'1,2,3','innovative_sme','{"pages":[{"status":"success","rdjb":"9","fetchedCount":1}]}');row(4,1,9)
    query(5,'2');row(5,1,null,'U10');row(5,2,1);row(5,3,4)
    query(6,'3',undefined,undefined,'recognized_list');row(6,1,11,'U12');row(6,2,null,'NO_MATCH',{id:'foreign',tyshxydm:'U12',rdjb:'3'})
    query(7,'2,3','specialized_sme','{"pages":[]}');row(7,1,13)
    query(8,'1',undefined,undefined,'recognized_list')
    for(const owner of [16,17]){const r=row(8,owner-15,owner,'U16',{id:'shared',rdjb:'1',tyshxydm:'U16'});ensurePlatformObservation(db,r.id)}
    query(9,'1');row(9,1,null)
    for(const [i,evidence] of ['{"pages":[{"status":"success","rdjb":"2","fetchedCount":1}]}',"{pages:[{status:'success',rdjb:'2',fetchedCount:1}]}",'{"pages":[{"status":"success","rdjb":"2","fetchedCount":"1"}]}','{"pages":[{"status":"success","rdjb":"2","fetchedCount":null}]}'].entries()){
      query(10+i,'1,2',undefined,evidence);row(10+i,1,[18,19,21,22][i]!)
    }
    query(14,'9');row(14,1,14)
  } finally {old.close()}
  const runtimeTarget=join(root,'runtime.sqlite'),evidence=join(root,'complete-evidence');mkdirSync(evidence)
  completePlatformMigration(legacySource,runtimeTarget,evidence)
  // Frozen historical completion precedes the current binary's additive schema.
  const completed=new Database(runtimeTarget)
  try {
    completed.pragma('foreign_keys=ON')
    upgradeTitleCycleDisposition(completed)
  } finally {completed.close()}
  return {root,target:runtimeTarget,legacySource}
}
let template: ReturnType<typeof buildTemplate> | undefined
const clones: string[] = []
afterAll(() => { for (const root of clones) rmSync(root, { recursive: true, force: true }) })
export async function targetCandidatesFixture() {
  template ??= buildTemplate()
  const pristine = await template
  const root = mkdtempSync(join(tmpdir(), 'candidate-reader-')); clones.push(root)
  const f = { ...pristine, root, target: join(root, 'runtime.sqlite'), legacySource: join(root, 'legacy.sqlite') }
  copyFileSync(pristine.target, f.target); copyFileSync(pristine.legacySource, f.legacySource)
  const statements:string[]=[]
  const sqlite=new Database(f.target,{verbose:q=>statements.push(String(q))});sqlite.pragma('foreign_keys=ON')
  const legacy=new Database(f.legacySource,{readonly:true});legacy.function('roster84_uscc',{deterministic:true},normalizeUscc)
  return {...f,sqlite,db:drizzle(sqlite,{schema:targetSchema}),legacy,statements,
    oracle:(title:CurrentTitle)=>legacy.prepare(`SELECT id FROM (${currentCandidateSql}) ORDER BY id`).all(currentCandidateBindings(title)),
    close(){legacy.close();sqlite.close()}}
}
