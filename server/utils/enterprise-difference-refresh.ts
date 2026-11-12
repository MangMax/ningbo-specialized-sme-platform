import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createError } from 'h3'
import type { useDb } from '../../db/client'
import { createCurrentQualificationAssessmentReader } from '../../lib/roster/current-qualification'
import { CURRENT_TITLES } from '../../lib/roster/current-titles'
import { eq, getTableColumns, sql } from 'drizzle-orm'
import { targetSchema } from '../../lib/platform/target-schema'
import { differenceTargetSources, selectDifferenceCollections } from '../../lib/platform/difference-sources'
import { readDifferenceRefreshRows, readDifferenceRefreshMetadata } from '../../lib/platform/difference-hash-inputs'
import { createCurrentQualificationAssessmentReaderWithWitnesses } from '../../lib/roster/current-qualification'
import { createTargetRecognizedWitnessReader } from '../../lib/roster/recognized-witness-target'
import { drizzle } from 'drizzle-orm/better-sqlite3'

type Db = ReturnType<typeof useDb>
export const enterpriseDifferenceRefreshInput = z.strictObject({ enterpriseIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(10000).refine(ids => new Set(ids).size === ids.length, 'Duplicate enterprise IDs').optional() })
const fail = (message: string): never => { throw createError({statusCode:400,message}) }
export function parseEnterpriseDifferenceRefreshQuery(raw: Record<string, unknown>) {
  if (Object.keys(raw).some(key => key !== 'enterpriseIds')) return fail('Unknown refresh query parameter')
  if (raw.enterpriseIds === undefined) return {}
  if (typeof raw.enterpriseIds !== 'string' || !/^[1-9]\d*(,[1-9]\d*)*$/.test(raw.enterpriseIds)) return fail('Invalid enterpriseIds')
  return { enterpriseIds: raw.enterpriseIds.split(',').map(Number) }
}
function scope(db: Db, raw: unknown) {
  const parsed = enterpriseDifferenceRefreshInput.safeParse(raw)
  if (!parsed.success) return fail('Invalid enterpriseIds; provide distinct positive IDs or omit for all published enterprises')
  const ids = parsed.data.enterpriseIds ?? (db.$client.prepare("select distinct enterprise_id id from record where source='jxj' order by enterprise_id").all() as {id:number}[]).map(r=>r.id)
  const exists = db.$client.prepare('select id from enterprise where id=?')
  if (ids.some(id => !exists.get(id))) return fail('Unknown enterprise ID')
  return [...ids].sort((a,b)=>a-b)
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}
const sortedRows = (rows: unknown[]) => rows.map(canonical).sort()
const setRows = (rows: unknown[]) => [...new Set(sortedRows(rows))]
const scopeFields = (value: unknown): unknown => Array.isArray(value) ? value.map(scopeFields).sort((a,b)=>canonical(a).localeCompare(canonical(b))) : value && typeof value==='object' ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,scopeFields(v)])) : value
// Freeze the original refresh inputs from before the observation-owner expansion.
// Internal projection IDs, archive references and reconciliation columns were
// added later and must not change a business fingerprint.
const refreshProjectionColumns = {
  platform_apply_projection: ['declare_kind','declaration_year','applied_at','status','name_raw','uscc_raw'],
  platform_business_projection: ['declare_kind','business_year','applied_at','status','batch','award_batch_label','province','name_raw','uscc_raw'],
  platform_recognized_projection: ['validity_date_raw','maintenance_year','maintenance_batch','source_validity_date','source_maintenance_batch','source_maintenance_year_absent','district','award_note','title_raw','name_raw','uscc_raw'],
} satisfies Record<string, string[]>
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
  const target = differenceTargetSources(db)
  const enterprise = sqlite.prepare('select name,name_norm,uscc_norm,city,district from enterprise where id=?').get(enterpriseId) as {name:string;name_norm:string;uscc_norm:string|null}
  const formal = sqlite.prepare(`select r.source,r.title_code,r.name_raw,r.uscc_raw,e.event_type,e.year,e.batch_seq,e.decided_year,e.review_outcome,e.formal_validity from record r left join record_event e on e.record_id=r.id where r.enterprise_id=? and r.title_code=?`).all(enterpriseId,title)
  // Retain equal-time statements; never use arbitrary ID ordering to pick a winner.
  const queries = target ? (plan?.collections ?? selectDifferenceCollections(db, enterpriseId, { confirmedAliases: true }))
    .filter(({ collection: c }) => c.titleCode === null || c.titleCode === title)
    .map(({ collection: c, id }) => ({ id, collectionId: c.id, interface: c.interface, query_key: c.queryKey, rdjb: c.rdjb, title_code: c.titleCode, queried_at: c.queriedAt, status: c.status, collection_evidence: null }))
    : sqlite.prepare(`select q.* from platform_query q where (q.query_key=? or q.query_key=? or q.query_key in (select 'name:'||name_norm from enterprise_alias where enterprise_id=? and verification_status='confirmed') or exists(select 1 from platform_relation r where r.query_id=q.id and r.enterprise_id=?))
    and (q.title_code is null or q.title_code=?) order by q.queried_at desc`).all(enterprise.uscc_norm ?? '', `name:${enterprise.name_norm}`,enterpriseId,enterpriseId,title) as {id:number;interface:string;query_key:string;rdjb:string;title_code:string|null;queried_at:string;status:string;collection_evidence:string|null}[]
  const latest = new Map<string,string>()
  const observations: unknown[] = []
  const projections = ['platform_apply_projection','platform_business_projection','platform_recognized_projection'] as const
  for (const q of queries) {
    const key=canonical([q.interface,q.query_key,q.rdjb,q.title_code])
    if (latest.has(key) && latest.get(key)! > q.queried_at) continue
    latest.set(key,q.queried_at)
    const collectionId = 'collectionId' in q && typeof q.collectionId === 'number' ? q.collectionId : null
    const rows = collectionId !== null ? plan?.rows.get(collectionId) ?? readDifferenceRefreshRows(db, collectionId) : sqlite.prepare(`select relation_key,uscc_raw,name_raw,alias_name_raw,province,status,batch,declare_kind,applied_at,award_batch_label,year,match_basis,verification_status,raw_fields from platform_relation where query_id=?`).all(q.id) as Record<string,unknown>[]
    if (collectionId !== null) plan?.rows.set(collectionId, rows)
    const typed = (collectionId !== null ? plan?.typed.get(collectionId) : undefined) ?? projections.map((table,index)=>{
      const projection = [targetSchema.platformApplyProjection,targetSchema.platformBusinessProjection,targetSchema.platformRecognizedProjection][index]!
      const columns = refreshProjectionColumns[table]
      // SQL expressions preserve the original SQLite scalar types, including
      // recognized source-maintenance flags that the ORM decodes as booleans.
      const fields = Object.fromEntries(Object.values(getTableColumns(projection)).filter(column => columns.includes(column.name)).map(column => [column.name,sql`${column}`]))
      const versionRows = collectionId !== null ? db.select(fields).from(projection).innerJoin(targetSchema.platformBusinessObservation,eq(targetSchema.platformBusinessObservation.versionId,projection.versionId)).where(eq(targetSchema.platformBusinessObservation.collectionId,collectionId)).all()
        : sqlite.prepare(`select ${columns.map(column => `p.${column}`).join(',')} from ${table} p join platform_business_observation o on o.version_id=p.version_id join platform_relation r on r.id=o.relation_id where r.query_id=?`).all(q.id)
      return versionRows
    })
    if (collectionId !== null) plan?.typed.set(collectionId, typed)
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
    let metadata: Record<string,unknown> | null = null
    const metadataText = collectionId !== null ? plan?.metadata.has(collectionId) ? plan.metadata.get(collectionId)! : readDifferenceRefreshMetadata(db, collectionId) : q.collection_evidence
    if (collectionId !== null) plan?.metadata.set(collectionId, metadataText)
    if(metadataText) { try { const m=JSON.parse(metadataText);metadata={source:m.source ?? null,status:m.status ?? null,effectiveConditions:scopeFields(m.effectiveConditions ?? null),titleScope:scopeFields(m.titleScope ?? null),completeness:m.completeness ?? null,fullRange:m.fullRange ?? null,pageCoverage:Array.isArray(m.pages)?setRows(m.pages.map((p:Record<string,unknown>)=>({rdjb:p.rdjb ?? null,status:p.status ?? null,declaredTotal:p.declaredTotal ?? null}))):null} } catch { metadata={malformed:true} } }
    observations.push({interface:q.interface,rdjb:q.rdjb,title:q.title_code,status:q.status,metadata,relations:sortedRows(relationFields),typed:typed.map(sortedRows)})
  }
  const correspondences=sqlite.prepare(`select c.type,c.role,c.status,(c.ended_at is not null) as ended,${target ? 'r.source_relation_key' : 'r.relation_key'} as relation_key,e.event_type,e.year,e.batch_seq,e.decided_year,e.review_outcome,
    p.event_type as predecessor_type,p.year as predecessor_year,p.batch_seq as predecessor_batch
    from record_correspondence c left join ${target ? 'platform_business_observation r on r.id=c.observation_id' : 'platform_relation r on r.id=c.relation_id'} left join record_event e on e.id=c.event_id left join record_event p on p.id=c.predecessor_event_id
    where c.enterprise_id=? and c.title_code=?`).all(enterpriseId,title)
  const evidence=sqlite.prepare(`select v.source_file,v.attachment,v.list_no,v.page,e.event_type,e.year,e.batch_seq from record_evidence v join record_event e on e.id=v.record_event_id join record r on r.id=e.record_id where r.enterprise_id=? and r.title_code=?`).all(enterpriseId,title)
  const aliases=sqlite.prepare("select name_norm,verification_status from enterprise_alias where enterprise_id=? and verification_status='confirmed'").all(enterpriseId)
  return createHash('sha256').update(canonical({enterprise,aliases:setRows(aliases),formal:sortedRows(formal),evidence:sortedRows(evidence),correspondences:setRows(correspondences),observations:setRows(observations)})).digest('hex')
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
    const ids=scope(db,raw),reader=differenceTargetSources(db) ? createCurrentQualificationAssessmentReaderWithWitnesses(db.$client, createTargetRecognizedWitnessReader(drizzle(db.$client,{schema:targetSchema}))) : createCurrentQualificationAssessmentReader(db.$client)
    const previous=db.$client.prepare('select * from enterprise_difference_comparison where enterprise_id=? and title_code=?')
    const upsert=db.$client.prepare(`insert into enterprise_difference_comparison(enterprise_id,title_code,comparison_state,reasons,comparison_error,decision_cutoff_id,business_fingerprint,changed_at,refreshed_at) values(?,?,?,?,?,?,?,?,?) on conflict(enterprise_id,title_code) do update set comparison_state=excluded.comparison_state,reasons=excluded.reasons,comparison_error=excluded.comparison_error,decision_cutoff_id=excluded.decision_cutoff_id,business_fingerprint=excluded.business_fingerprint,changed_at=excluded.changed_at,refreshed_at=excluded.refreshed_at`)
    let refreshed=0,unchanged=0
    for(const id of ids){
      const plan: TargetFingerprintPlan | undefined = differenceTargetSources(db) ? { collections: selectDifferenceCollections(db,id,{confirmedAliases:true}), rows:new Map(), typed:new Map(), metadata:new Map() } : undefined
      const pending=CURRENT_TITLES.map(title=>({title,fingerprint:businessFingerprint(db,id,title,plan),old:previous.get(id,title) as Stored|undefined}))
      const changed=pending.filter(p=>p.old?.business_fingerprint!==p.fingerprint)
      const comparisons=changed.map(p=>{
        try {const result=reader.readPlatformComparisons(id,Date.parse(now),[p.title]).comparisons[0]!;return {title:p.title,state:result.comparison.state,reasons:[...new Set(result.comparison.cycles.flatMap(c=>c.reasons))],error:null}}
        catch(error) {
          // The existing reader deliberately refuses an incomplete protective
          // graph. Expose that failure as uncertainty, never as synchronization.
          const message=error instanceof Error ? error.message : ''
          if(message!=='platform_comparison_scope_unavailable' && message!=='input_resource_limit') throw error
          return {title:p.title,state:'not_established' as const,reasons:[message==='input_resource_limit'?'metadata_truncated':'coverage_incomplete'],error:message}
        }
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
