import { parseEnterpriseDifferenceRefreshInput, fail, latestRefreshCollections, refreshProjectionColumns, projectRefreshObservation, hashRefreshInputs, projectRefreshComparison, refreshComparisonFailure } from './enterprise-difference-refresh-contract'
import { eq, getTableColumns, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { useApplicationDb } from '../../../../db/client'
import { readDifferenceRefreshMetadata, readDifferenceRefreshRows } from '../../lib/platform/difference-hash-inputs'
import { selectDifferenceCollections } from '../../lib/platform/difference-sources'
import { targetSchema } from '../../lib/platform/target-schema'
import { createCurrentQualificationAssessmentReaderWithWitnesses } from '../../lib/roster/current-qualification'
import { CURRENT_TITLES } from '../../lib/roster/current-titles'
import { createTargetRecognizedWitnessReader } from '../../lib/roster/recognized-witness-target'
type Db = ReturnType<typeof useApplicationDb>
function scope(db: Db, raw: unknown) {
  const ids = parseEnterpriseDifferenceRefreshInput(raw).enterpriseIds ?? (db.$client.prepare("select distinct enterprise_id id from record where source='jxj' order by enterprise_id").all() as {id:number}[]).map(r=>r.id)
  const exists = db.$client.prepare('select id from enterprise where id=?')
  if (ids.some(id => !exists.get(id))) return fail('Unknown enterprise ID')
  return [...ids].sort((a,b)=>a-b)
}
type TargetFingerprintPlan = {
  collections: ReturnType<typeof selectDifferenceCollections>
  rows: Map<number, Record<string, unknown>[]>
  typed: Map<number, Record<string, unknown>[][]>
  metadata: Map<number, string | null>
}
/** These are business projections, not content-version or query fingerprints.
 * Only latest query scopes enter; repeated observations of identical rows are sets.
 * Execution time, query/version IDs, hashes and raw response envelopes never enter. */
function businessFingerprint(db: Db, enterpriseId: number, title: string, plan?: TargetFingerprintPlan) {
  const sqlite = db.$client

  const enterprise = sqlite.prepare('select name,name_norm,uscc_norm,city,district from enterprise where id=?').get(enterpriseId) as {name:string;name_norm:string;uscc_norm:string|null}
  const formal = sqlite.prepare(`select r.source,r.title_code,r.name_raw,r.uscc_raw,e.event_type,e.year,e.batch_seq,e.decided_year,e.review_outcome,e.formal_validity from record r left join record_event e on e.record_id=r.id where r.enterprise_id=? and r.title_code=?`).all(enterpriseId,title)
  // Retain equal-time statements; never use arbitrary ID ordering to pick a winner.
  const queries = latestRefreshCollections((plan?.collections ?? selectDifferenceCollections(db, enterpriseId, { confirmedAliases: true }))
    .map(({ collection }) => collection))
  const observations: unknown[] = []
  const projections = ['platform_apply_projection','platform_business_projection','platform_recognized_projection'] as const
  for (const q of queries) {
    if (q.titleCode !== null && q.titleCode !== title) continue
    const collectionId = q.id
    const rows = plan?.rows.get(collectionId) ?? readDifferenceRefreshRows(db, collectionId)
    plan?.rows.set(collectionId, rows)
    const typed = plan?.typed.get(collectionId) ?? projections.map((table,index)=>{
      const projection = [targetSchema.platformApplyProjection,targetSchema.platformBusinessProjection,targetSchema.platformRecognizedProjection][index]!
      const columns = refreshProjectionColumns[table]
      // SQL expressions preserve the original SQLite scalar types, including
      // recognized source-maintenance flags that the ORM decodes as booleans.
      const fields = Object.fromEntries(Object.values(getTableColumns(projection)).filter(column => columns.includes(column.name)).map(column => [column.name,sql`${column}`]))
      const versionRows = db.select(fields).from(projection).innerJoin(targetSchema.platformBusinessObservation,eq(targetSchema.platformBusinessObservation.versionId,projection.versionId)).where(eq(targetSchema.platformBusinessObservation.collectionId,collectionId)).all()
      return versionRows
    })
    plan?.typed.set(collectionId, typed)
    // Unindexed/legacy relations still have their original typed business columns;
    // raw_fields is an archive container and can include execution metadata.
    const relationFields = rows.map(({raw_fields:raw,...fields})=>{
      if(typeof raw!=='string') return fields
      try {
        const source=JSON.parse(raw),business:Record<string,unknown>={}
        for(const key of ['id','rdjb','rddqrq','whpcyear','whpc','cszt','year','sqsj','sblx','personuuid','szsfmc','szq','rdxx','qymc','tyshxydm']) if(Object.hasOwn(source,key)) business[key]=source[key]
        return {...fields,sourceBusiness:business}
      } catch {return {...fields,sourceBusinessMalformed:true}}
    })
    const metadataText = plan?.metadata.has(collectionId) ? plan.metadata.get(collectionId)! : readDifferenceRefreshMetadata(db, collectionId)
    plan?.metadata.set(collectionId, metadataText)
    observations.push(projectRefreshObservation(q, { relations: relationFields, typed, metadata: metadataText }))
  }
  const correspondences=sqlite.prepare(`select c.type,c.role,c.status,(c.ended_at is not null) as ended,${'r.source_relation_key'} as relation_key,e.event_type,e.year,e.batch_seq,e.decided_year,e.review_outcome,
    p.event_type as predecessor_type,p.year as predecessor_year,p.batch_seq as predecessor_batch
    from record_correspondence c left join ${'platform_business_observation r on r.id=c.observation_id'} left join record_event e on e.id=c.event_id left join record_event p on p.id=c.predecessor_event_id
    where c.enterprise_id=? and c.title_code=?`).all(enterpriseId,title)
  const evidence=sqlite.prepare(`select v.source_file,v.attachment,v.list_no,v.page,e.event_type,e.year,e.batch_seq from record_evidence v join record_event e on e.id=v.record_event_id join record r on r.id=e.record_id where r.enterprise_id=? and r.title_code=?`).all(enterpriseId,title)
  const aliases=sqlite.prepare("select name_norm,verification_status from enterprise_alias where enterprise_id=? and verification_status='confirmed'").all(enterpriseId)
  return hashRefreshInputs({ enterprise, aliases, formal, evidence, correspondences, observations })
}
interface Stored {enterprise_id:number;title_code:string;comparison_state:'synchronized'|'unsynchronized'|'not_established';reasons:string;comparison_error:string|null;decision_cutoff_id:number;business_fingerprint:string;changed_at:string;refreshed_at:string}
function readScope(db: Db, ids: number[]) {
  const rows = db.$client.prepare('select * from enterprise_difference_comparison where enterprise_id=? order by title_code')
  const decisions = db.$client.prepare(`select status,reason_code,recorded_at,id from difference_reason where enterprise_id=? and title_code=? and id>? order by recorded_at desc,id desc`)
  return ids.map(enterpriseId=>({enterpriseId,comparisons:(rows.all(enterpriseId) as Stored[]).map(row=>{
    // Existing decision writes remain the sole judgment authority. A business
    // change invalidates display only; immutable old decisions remain untouched.
    const heads=decisions.all(enterpriseId,row.title_code,row.decision_cutoff_id) as {status:string;reason_code:string|null;recorded_at:string;id:number}[]
    const latest=heads[0]
    return {titleCode:row.title_code,comparisonState:row.comparison_state,reasons:JSON.parse(row.reasons) as string[],comparisonError:row.comparison_error,status:latest?.status ?? 'needs_review',reasonCode:latest?.reason_code ?? null,businessFingerprint:row.business_fingerprint,changedAt:row.changed_at,refreshedAt:row.refreshed_at}
  })}))
}
export function readEnterpriseDifferenceComparisons(db: Db, raw: unknown) {
  return db.$client.transaction(()=>({refreshed:0,unchanged:0,enterprises:readScope(db,scope(db,raw))}))()
}
export function refreshEnterpriseDifferences(db: Db, raw: unknown, now = new Date().toISOString()) {
  return db.$client.transaction(()=>{
    const ids=scope(db,raw),reader=createCurrentQualificationAssessmentReaderWithWitnesses(db.$client, createTargetRecognizedWitnessReader(drizzle(db.$client,{schema:targetSchema})))
    const previous=db.$client.prepare('select * from enterprise_difference_comparison where enterprise_id=? and title_code=?')
    const upsert=db.$client.prepare(`insert into enterprise_difference_comparison(enterprise_id,title_code,comparison_state,reasons,comparison_error,decision_cutoff_id,business_fingerprint,changed_at,refreshed_at) values(?,?,?,?,?,?,?,?,?) on conflict(enterprise_id,title_code) do update set comparison_state=excluded.comparison_state,reasons=excluded.reasons,comparison_error=excluded.comparison_error,decision_cutoff_id=excluded.decision_cutoff_id,business_fingerprint=excluded.business_fingerprint,changed_at=excluded.changed_at,refreshed_at=excluded.refreshed_at`)
    let refreshed=0,unchanged=0
    for(const id of ids){
      const plan: TargetFingerprintPlan | undefined = { collections: selectDifferenceCollections(db,id,{confirmedAliases:true}), rows:new Map(), typed:new Map(), metadata:new Map() }
      const pending=CURRENT_TITLES.map(title=>({title,fingerprint:businessFingerprint(db,id,title,plan),old:previous.get(id,title) as Stored|undefined}))
      const changed=pending.filter(p=>p.old?.business_fingerprint!==p.fingerprint)
      const comparisons=changed.map(p=>{
        try {
          return { title: p.title, ...projectRefreshComparison(reader.readPlatformComparisons(id, Date.parse(now), [p.title]).comparisons[0]!) }
        } catch (error) { return { title: p.title, ...refreshComparisonFailure(error) } }
      })
      for(const p of pending){
        if(p.old?.business_fingerprint===p.fingerprint){db.$client.prepare('update enterprise_difference_comparison set refreshed_at=? where enterprise_id=? and title_code=?').run(now,id,p.title);unchanged++;continue}
        const result=comparisons.find(c=>c.title===p.title)!
        upsert.run(id,p.title,result.state,JSON.stringify(result.reasons),result.error,(db.$client.prepare('select coalesce(max(id),0) id from difference_reason where enterprise_id=? and title_code=?').get(id,p.title) as {id:number}).id,p.fingerprint,now,now);refreshed++
      }
    }
    return {refreshed,unchanged,enterprises:readScope(db,ids)}
  }).immediate()
}
export { enterpriseDifferenceRefreshInput, parseEnterpriseDifferenceRefreshQuery, parseEnterpriseDifferenceRefreshInput, refreshProjectionColumns, latestRefreshCollections, projectRefreshObservation, hashRefreshInputs, projectRefreshComparison, refreshComparisonFailure } from './enterprise-difference-refresh-contract'
