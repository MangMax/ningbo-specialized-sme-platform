/** Synthetic upgrade-only predecessor. Never read a private acceptance directory. */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll } from 'vitest'
import { installBusinessStatusPrerequisite } from '../../../../upgrade/business-status'
import { installReconcileSlotPrerequisite } from '../../../../upgrade/reconcile-slot-schema'
import { withFrozenSource, upgradeCollections } from '../../../../upgrade/collections'
import { upgradeObservations } from '../../../../upgrade/observations'
import { upgradeProjections } from '../../../../upgrade/projections'
import { finalizeObservations, finalizeCollectionScopes } from '../../../../upgrade/finalize-observations'
import { finalizeFingerprintBasis } from '../../../../upgrade/fingerprint-basis'
import { finalizeApplyStored } from '../../../../upgrade/apply-stored'
import { finalizeCandidateScopes } from '../../../../upgrade/candidate-scope'
import { finalizeRecognizedStored } from '../../../../upgrade/recognized-stored'
import { finalizeRecognizedWitness } from '../../../../upgrade/recognized-witness'
import { finalizeProcessStored } from '../../../../upgrade/process-stored'
import { transferCorrespondence } from '../../../../upgrade/correspondence'
import { transferDifferenceReferences } from '../../../../upgrade/difference-references'
import { indexLegacyProvenance } from '../../../../upgrade/legacy-provenance'
import { completeReconcileSlotCapture } from '../../../../upgrade/reconcile-slot-capture'
import { ensurePlatformObservation } from '../../../../upgrade/frozen/server/platform-business-record'
import * as schema from '../../../../upgrade/legacy-schema'
import { BUSINESS_STATUS_V2 } from '../../../../db/business-status'
import { RECONCILE_SLOT_T04 } from '../../../../layers/sme-roster/lib/platform/reconcile-slot-capture'
const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, {recursive:true,force:true}) })
let template: ReturnType<typeof build> | undefined
function build() {
 const root=mkdtempSync(join(tmpdir(),'retirement-prefix-')); roots.push(root)
 const source=join(root,'source.sqlite'),target=join(root,'target.sqlite')
 const old=new Database(source)
 try {
  migrate(drizzle(old),{migrationsFolder:'db/migrations'})
  old.exec("INSERT INTO title(code,name_zh,level,rank) VALUES('specialized_sme','专精特新','municipal',2); INSERT INTO enterprise(id,name,name_norm) VALUES(1,'Original','original')")
  for(const [i,sourceInterface] of ['apply_list','business_list','recognized_list'].entries()) {
   const id=i+1,raw={id:'ROW-'+id,rdjb:'2',year:'2026',whpcyear:'false'}
   old.prepare("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at,raw_response) VALUES(?,?,?,'2','2026-11-14','success','original',?)").run(id,sourceInterface,'Q'+id,JSON.stringify(id === 1 ? {kind:'legacy-slot-pages/v1',interface:sourceInterface,queryKey:'Q'+id,rdjb:'2',queriedAt:'2026-11-14',completedAt:'2026-11-14T00:01:00Z',completeness:'complete',unfinished:[],failureReason:null,requestCount:1,declaredTotal:1,pages:[{source:'queryList',rdjb:'2',page:1,queriedAt:'2026-11-14',status:'success',error:null,fetchedCount:1,declaredTotal:1,raw:JSON.stringify({zrarData:{grid:{applyGrid:{page:1,pageSize:50,maxCount:1,pageSet:[raw]}}}})}]} : {rows:[raw]}))
   old.prepare("INSERT INTO platform_relation(id,query_id,sequence_no,relation_key,enterprise_id,raw_fields,created_at) VALUES(?,?,1,?,1,?,'original')").run(id,id,raw.id,JSON.stringify(raw))
   ensurePlatformObservation(drizzle(old,{schema}),id)
  }
 } finally {old.close()}
 copyFileSync(source,target)
 withFrozenSource(source,f=>{
  installBusinessStatusPrerequisite(target,f,join(root,'status.json'))
  installReconcileSlotPrerequisite(target,f)
 })
 const common={source,target,collectionRunId:'c',observationRunId:'o',projectionRunId:'p',finalizationRunId:'f',batchSize:2}
 upgradeCollections({...common,runId:'c',transformVersion:RECONCILE_SLOT_T04})
 upgradeObservations({...common,runId:'o'})
 upgradeProjections({...common,runId:'p',transformVersion:BUSINESS_STATUS_V2})
 finalizeObservations({...common,runId:'f'})
 finalizeCollectionScopes({...common,runId:'scopes'})
 const predecessor=join(root,'predecessor.sqlite')
 copyFileSync(target,predecessor)
 finalizeFingerprintBasis({source:predecessor,target,runId:'basis',predecessorRunId:'scopes',legacySource:source})
 copyFileSync(target,predecessor)
 finalizeApplyStored({source:predecessor,target,runId:'apply',predecessorRunId:'basis',legacySource:source})
 copyFileSync(target,predecessor)
 finalizeCandidateScopes({source:predecessor,target,runId:'candidate',predecessorRunId:'apply'})
 copyFileSync(target,predecessor)
 finalizeRecognizedStored({source:predecessor,target,runId:'recognized',predecessorRunId:'candidate'})
 copyFileSync(target,predecessor)
 finalizeRecognizedWitness({source:predecessor,target,runId:'witness',predecessorRunId:'recognized'})
 copyFileSync(target,predecessor)
 finalizeProcessStored({source:predecessor,target,runId:'process',predecessorRunId:'witness',legacySource:source})
 copyFileSync(target,predecessor)
 transferCorrespondence({source:predecessor,target,runId:'correspondence'})
 copyFileSync(target,predecessor)
 transferDifferenceReferences({source:predecessor,target,runId:'differences'})
 copyFileSync(target,predecessor)
 indexLegacyProvenance({source:predecessor,target,runId:'provenance',batchSize:2})
 return {root,source,target}
}
export function preRetirementFixture(capture=true) {
 template??=build()
 const root=mkdtempSync(join(tmpdir(),'retirement-case-'));roots.push(root)
 const source=join(root,'source.sqlite'),target=join(root,'target.sqlite')
 copyFileSync(template.source,source);copyFileSync(template.target,target)
 if(capture)completeReconcileSlotCapture({source,target,runId:'capture',collectionRunId:'c'})
 return {root,source,target}
}
