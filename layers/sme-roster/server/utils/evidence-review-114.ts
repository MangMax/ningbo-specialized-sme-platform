import { type EvidenceReviewAnchor, decodeImpactCursor, invalidImpactCursor, impactList114, impactScopeFilter114, pageImpactRows, type impactPreview114, type impactSources114, type impactEvents114, type workCommand114 } from './evidence-review-114-contract'
import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createDrizzleLogger } from '../../../core/lib/logging/drizzle'
import { setTimeout as scheduleExpiry, clearTimeout as cancelExpiry } from 'node:timers'
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { z } from 'zod'
import * as s from '../../../../db/schema'
import { readDecision102, currentDecision102, type DecisionDb } from './decision-lifecycle-102'
import { DecisionError102, parse102 } from './decision-lifecycle-102/contract'
import { captureRuleRevision113, evaluateEvidenceImpact113, processEvidenceImpacts113, readEvidenceRevision113, readEvidenceToken113 } from './evidence-impact-113'
import { evidenceDigest113 } from './evidence-digest'
import { readQueryCoverage } from '../../lib/roster/query-assessment'
import { differenceEvidenceColumns } from '../../lib/platform/difference-reference-target'
import { currentEnterpriseIdentity } from '../../lib/roster/enterprise-identity'
// File-backed WAL read snapshots freeze both immutable links and inherited mutable
// legacy ownership across pages. Reads never write a cache table or copy archives.
// Bound held readers/time so anonymous cursors cannot retain unlimited WAL history.
const snapshots = new Map<string, { db: DecisionDb; client: InstanceType<typeof Database>; timer: ReturnType<typeof scheduleExpiry> }>()
function closeSnapshot(id: string) {
  const snapshot = snapshots.get(id)
  if (!snapshot) return
  snapshots.delete(id)
  cancelExpiry(snapshot.timer)
  try { snapshot.client.exec('ROLLBACK') } finally { snapshot.client.close() }
}
/** Existing Nitro close hook owns shutdown; timers are unref'ed and also clear here. */
export function closeReviewSnapshots114() {
  const failures: unknown[] = []
  for (const id of snapshots.keys()) {
    try { closeSnapshot(id) } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Failed to close review read snapshots')
}
function openSnapshot(db: DecisionDb) {
  while (snapshots.size >= 64) closeSnapshot(snapshots.keys().next().value!)
  const source = (db as DecisionDb & { $client: { name: string } }).$client
  const Connection = source.constructor as typeof Database
  const client = new Connection(source.name, { readonly: true, fileMustExist: true })
  try { client.exec('BEGIN') } catch (error) { client.close(); throw error }
  const id = randomUUID(), timer = scheduleExpiry(() => closeSnapshot(id), 120000)
  timer.unref()
  const snapshot = { db: drizzle(client, { schema: s, logger: createDrizzleLogger({ connection: 'evidence_review' }) }), client, timer }
  snapshots.set(id, snapshot)
  return { id, ...snapshot }
}
function anchor(db: DecisionDb): EvidenceReviewAnchor {
  return db.get<EvidenceReviewAnchor>(sql`select coalesce((select min(revision_id)-1 from evidence_impact_progress_113 where done=0),(select max(id) from evidence_revision_113),0) revision,
    coalesce((select max(id) from explanation_impact_113),0) impact, coalesce((select max(id) from difference_reason),0) decision,coalesce((select max(id) from evidence_review_receipt_114),0) receipt`)!
}
function pageContext(db: DecisionDb, operation: string, input: {cursor?:string}) {
  const {cursor: token,...filter}=input
  if(!token) {
    if (operation !== 'list') return {asOf:anchor(db),after:0,filter,db}
    const snapshot = openSnapshot(db)
    try { return {asOf:{...anchor(snapshot.db),snapshotId:snapshot.id},after:0,filter,db:snapshot.db} }
    catch (error) { closeSnapshot(snapshot.id); throw error }
  }
  const cursor = decodeImpactCursor(operation, filter, token)
  const snapshot = operation === 'list' ? snapshots.get(cursor.asOf.snapshotId!) : null
  if (operation === 'list' && !snapshot) throw invalidImpactCursor()
  return { ...cursor, filter, db: snapshot?.db ?? db }
}
const headAt = (a:EvidenceReviewAnchor) => sql`select d.id from difference_reason d where d.enterprise_id=i.enterprise_id and d.title_code=i.title_code and d.direction=i.direction and d.id<=${a.decision} order by d.recorded_at desc,d.id desc limit 1`
function impactRows(db:DecisionDb,input:z.infer<typeof impactList114>,a:EvidenceReviewAnchor,after:number,id?:number) {
  return db.all<any>(sql`with frozen as (
    select i.id,i.enterprise_id enterpriseId,i.title_code titleCode,i.direction,i.decision_id decisionId,
      coalesce((select max(l.revision_id) from evidence_impact_link_113 l where l.impact_id=i.id and l.revision_id<=${a.revision}),0) latestRevisionId,
      (select max(r.reviewed_revision_id) from evidence_review_receipt_114 r where r.enterprise_id=i.enterprise_id and r.title_code=i.title_code and r.direction=i.direction and (r.decision_id=i.decision_id or r.source_decision_id=i.decision_id) and r.id<=${a.receipt}) reviewedRevisionId,
      (${headAt(a)}) headId,
      exists(select 1 from enterprise e where e.id=i.enterprise_id and ${currentEnterpriseIdentity(db, sql`e.id`)}) ownerExists
    from explanation_impact_113 i where i.id>${after} and i.id<=${a.impact} and ${impactScopeFilter114(input,'i')} and ${id==null?sql`1`:sql`i.id=${id}`}
    and ${input.eventId==null?sql`1`:sql`exists(select 1 from evidence_impact_link_113 l join evidence_revision_event_113 e on e.revision_id=l.revision_id where l.impact_id=i.id and l.revision_id<=${a.revision} and e.event_id=${input.eventId} and e.enterprise_id=i.enterprise_id and e.title_code=i.title_code)`}
  ), classified as (
    select *,latestRevisionId>coalesce(reviewedRevisionId,-1) pending,
      case when not ownerExists then 'merged' when (select lifecycle_action from difference_reason where id=headId)='withdraw' then 'withdrawn' when decisionId=headId then 'current' else 'historical' end lineage,
      case when exists(select 1 from evidence_impact_link_113 l where l.impact_id=frozen.id and l.revision_id<=${a.revision} and l.revision_id>coalesce(reviewedRevisionId,-1) and l.classification='premise_invalid') then 'premise_invalid' else 'evidence_changed' end classification
    from frozen where latestRevisionId>0 or reviewedRevisionId is not null
  ) select id,enterpriseId,titleCode,direction,decisionId,latestRevisionId,reviewedRevisionId,pending,lineage,classification from classified
    where ${input.view==='all'?sql`1`:input.view==='current'?sql`lineage='current'`:sql`lineage!='current'`}
    and ${input.state==='all'?sql`1`:input.state==='pending'?sql`pending=1`:sql`pending=0`} order by id limit ${input.limit+1}`)
}
function hydrate(db:DecisionDb,row:any) {
  const exists = db.get(sql`select 1 from difference_reason where id=${row.decisionId}`)
  // Unmanaged legacy duplicate merges may predate/precede review adoption. Keep the
  // original impact/decision IDs and disclose the missing version; never substitute
  // a survivor's decision or fabricate its historical reason.
  return {...row,pending:!!row.pending,oldDecision:exists ? {...readDecision102(db,row.decisionId),isCurrent:row.lineage==='current'} : null}
}
export function listImpacts114(db:DecisionDb,input:z.infer<typeof impactList114>) {
  const c=pageContext(db,'list',input)
  try {
    const rows=impactRows(c.db,input,c.asOf,c.after).map(r=>hydrate(c.db,r))
    const readiness=input.enterpriseId && input.titleCode && input.direction ? readEvidenceToken113(c.db,{enterpriseId:input.enterpriseId,titleCode:input.titleCode,direction:input.direction}).projectionReady : !c.db.get(sql`select 1 from evidence_impact_progress_113 where done=0 limit 1`)
    const result={...pageImpactRows(rows,input.limit,'list',c,r=>r.id),projectionReady:readiness}
    if (!result.nextCursor && c.after === 0 && c.asOf.snapshotId) closeSnapshot(c.asOf.snapshotId)
    return result
  } catch (error) { if (c.asOf.snapshotId) closeSnapshot(c.asOf.snapshotId); throw error }
}
export function getImpact114(db:DecisionDb,id:number) {
  // Detail includes partially projected committed work and always returns a live token.
  const a=anchor(db); a.revision=db.get<{id:number}>(sql`select coalesce(max(id),0) id from evidence_revision_113`)!.id
  const row=impactRows(db,parse102(impactList114,{view:'all',state:'all'}),a,0,id)[0]
  if(!row)throw new DecisionError102(404,'not_found','Evidence impact not found')
  const scope={enterpriseId:row.enterpriseId,titleCode:row.titleCode,direction:row.direction}
  const present=!!db.get(sql`select 1 from enterprise e where id=${row.enterpriseId} and ${currentEnterpriseIdentity(db, sql`e.id`)}`)
  const queryCoverage=present?readQueryCoverage(db,scope):null
  const decisionUnavailable=!db.get(sql`select 1 from difference_reason where id=${row.decisionId}`)
  const review = db.get<{ reviewedRevisionId: number; actor: string | null; basis: string; ruleVersion: string | null; effectiveAt: string; recordedAt: string }>(sql`select reviewed_revision_id reviewedRevisionId,actor,basis,rule_version ruleVersion,effective_at effectiveAt,recorded_at recordedAt from evidence_review_receipt_114
    where enterprise_id=${row.enterpriseId} and title_code=${row.titleCode} and direction=${row.direction} and (decision_id=${row.decisionId} or source_decision_id=${row.decisionId}) and reviewed_revision_id is not null order by id desc limit 1`)
  // actor 'null' and a NULL legacy column both mean "not recorded"; never synthesize a user.
  const reviewedBaseline = review ? {...review,actor:review.actor == null ? null : JSON.parse(review.actor)} : null
  return {...hydrate(db,row),reviewedBaseline,currentDecision:present?currentDecision102(db,scope):null,evidenceToken:readEvidenceToken113(db,scope),queryCoverage,gaps:{decisionUnavailable,coverageStatus:queryCoverage?.status??'unknown',truncated:queryCoverage?.truncated??false,subjectUnknown:!present || !queryCoverage?.sources.some(s=>['exact_uscc','matched_relation'].includes(s.subjectMatch)),projectionReady:readEvidenceToken113(db,scope).projectionReady}}
}
export function previewImpacts114(db:DecisionDb,input:z.infer<typeof impactPreview114>) {
  const revision=readEvidenceRevision113(db,input.revisionId);if(!revision)throw new DecisionError102(404,'not_found','Committed evidence revision not found')
  const c=pageContext(db,'preview',input)
  const rows=db.all<{id:number;enterpriseId:number;titleCode:string;direction:string;status:string;evidenceQueryId:number|null;lifecycleAction:string|null}>(sql`select d.id,d.enterprise_id enterpriseId,d.title_code titleCode,d.direction,d.status,${differenceEvidenceColumns(db, 'd').evidenceQueryId} evidenceQueryId,d.lifecycle_action lifecycleAction
    from difference_reason d where d.id>${c.after} and d.id<=${Math.min(c.asOf.decision,revision.maxDecisionId)} and ${impactScopeFilter114(input,'d')}
    and ${revision.enterpriseId==null?sql`1`:sql`d.enterprise_id=${revision.enterpriseId}`} and ${revision.titleCode==null?sql`1`:sql`d.title_code=${revision.titleCode}`} and ${revision.direction==null?sql`1`:sql`d.direction=${revision.direction}`}
    and not exists(select 1 from difference_reason n where n.enterprise_id=d.enterprise_id and n.title_code=d.title_code and n.direction=d.direction and n.id<=${c.asOf.decision} and (n.recorded_at>d.recorded_at or (n.recorded_at=d.recorded_at and n.id>d.id))) order by d.id limit ${input.limit+1}`)
  return pageImpactRows(rows.map(d=>({...d,classification:evaluateEvidenceImpact113(db,revision,d)})),input.limit,'preview',c,r=>r.id)
}
export function listSources114(db:DecisionDb,input:z.infer<typeof impactSources114>) {
  if(!db.get(sql`select 1 from explanation_impact_113 where id=${input.id}`))throw new DecisionError102(404,'not_found','Evidence impact not found')
  const c=pageContext(db,'sources',input)
  // Sources are immutable metadata/scalars; never return arbitrary raw source metadata.
  const rows=db.all<any>(sql`select r.id revisionId,r.source_kind sourceKind,r.source_key sourceKey,r.source_version sourceVersion,r.enterprise_id enterpriseId,r.title_code titleCode,r.direction,r.event_id eventId,r.coverage_changed coverageChanged,r.fact_changed factChanged,r.created_at createdAt,l.classification
    from evidence_impact_link_113 l join evidence_revision_113 r on r.id=l.revision_id where l.impact_id=${input.id} and r.id>${c.after} and r.id<=${c.asOf.revision} order by r.id limit ${input.limit+1}`)
  return pageImpactRows(rows,input.limit,'sources',c,r=>r.revisionId)
}
export function listEvents114(db:DecisionDb,input:z.infer<typeof impactEvents114>) {
  if(!readEvidenceRevision113(db,input.revisionId))throw new DecisionError102(404,'not_found','Committed evidence revision not found')
  const c=pageContext(db,'events',input)
  const rows=db.all<any>(sql`select revision_id revisionId,event_id eventId,enterprise_id enterpriseId,title_code titleCode from evidence_revision_event_113 where revision_id=${input.revisionId} and event_id>${c.after} and ${input.enterpriseId==null?sql`1`:sql`enterprise_id=${input.enterpriseId}`} order by event_id limit ${input.limit+1}`)
  return pageImpactRows(rows,input.limit,'events',c,r=>r.eventId)
}
export function work114(db:DecisionDb,command:z.infer<typeof workCommand114>) {
  return db.transaction(tx=>{
    const hash=evidenceDigest113(command), t=s.evidenceReviewReceipt114
    const prior=tx.select().from(t).where(eq(t.idempotencyKey,command.idempotencyKey)).get()
    if(prior){if(prior.requestHash!==hash)throw new DecisionError102(409,'idempotency_conflict','Idempotency key has a different request');return prior.response}
    if(tx.get(sql`select 1 from difference_reason where idempotency_key=${command.idempotencyKey}`))throw new DecisionError102(409,'idempotency_conflict','Idempotency key belongs to a decision')
    let result:Record<string,unknown>
    if(command.action==='process')result=processEvidenceImpacts113(tx, {limit:command.limit})
    else {
      const revisions=command.scopes.map(({previousEvaluationDigest,evaluationDigest,...scope})=>{
        if(!tx.get(sql`select 1 from enterprise where id=${scope.enterpriseId}`))throw new DecisionError102(404,'not_found','Rule scope enterprise not found')
        const release=s.evidenceRuleRelease114
        const prior=tx.select().from(release).where(and(eq(release.ruleId,command.ruleId),eq(release.version,command.version),eq(release.enterpriseId,scope.enterpriseId),eq(release.titleCode,scope.titleCode),eq(release.direction,scope.direction))).get()
        if(prior){
          if(prior.previousDigest!==previousEvaluationDigest || prior.evaluationDigest!==evaluationDigest)throw new DecisionError102(409,'rule_version_conflict','Rule version already identifies different evaluated material')
          return prior.revisionId
        }
        const revisionId=captureRuleRevision113(tx,{ruleId:command.ruleId,version:command.version,scope,previousEvaluationDigest,evaluationDigest})
        tx.insert(release).values({ruleId:command.ruleId,version:command.version,...scope,previousDigest:previousEvaluationDigest,evaluationDigest,revisionId,receiptKey:command.idempotencyKey}).run()
        return revisionId
      })
      result={revisionIds:revisions,unchanged:revisions.filter(r=>r==null).length}
    }
    const recordedAt=new Date().toISOString(), response={...result,action:command.action,idempotencyKey:command.idempotencyKey,recordedAt}
    tx.insert(t).values({idempotencyKey:command.idempotencyKey,requestHash:hash,kind:command.action,actor:command.actor,basis:command.basis,response,recordedAt}).run()
    return response
  },{behavior:'immediate'})
}
export { impactList114, impactGet114, impactSources114, impactEvents114, impactPreview114, processCommand114, ruleCommand114, workCommand114, type EvidenceReviewAnchor, invalidImpactCursor, decodeImpactCursor, pageImpactRows, impactScopeFilter114 } from './evidence-review-114-contract'
