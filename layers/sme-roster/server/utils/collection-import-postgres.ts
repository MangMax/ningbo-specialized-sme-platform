import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { RELATION_DECLARE_KIND_ORDER } from '../../lib/labels'
import { normalizeUscc } from '../../lib/domain'
import type { RosterImportItemResult, RosterImportPlatformQuery, RosterImportRequest, RosterImportSummary } from '../../lib/roster-import-client'
import { queryEvidenceError } from '../../lib/platform/query-evidence'
import { platformQuerySourceConflict, stagedPlatformQuerySource, type PlatformQueryReplaySource } from '../../lib/platform/query-replay'
import { normalizePlatformRelation } from '../../lib/platform/normalization'
import { captureReconcileSlot } from '../../lib/platform/reconcile-slot-capture'
import { planPlatformObservation } from '../../lib/platform/observation-plan'
import { writePostgresCollectionHeader } from '../../lib/platform/postgres-collection-write'
import { writePostgresObservation } from '../../lib/platform/postgres-observation-write'
import { readPostgresFingerprintQueries, readPostgresRelationFingerprints } from './postgres-platform-fingerprint'
import { executePostgresRosterImport } from './roster-export-import-postgres'
import { usePostgresRosterDb } from './postgres-roster-db'
import { projectQueryEvidenceRevisions, evidenceDigest113 } from './evidence-impact-113'
import { appendPostgresEvidenceRevision } from './evidence-revision-postgres'
import { stagePostgresJob } from '../../../core/server/utils/job-runner-postgres'
import { EVENT_ARCHIVE_RULE_VERSION } from './event-archive-discovery'
import { CANDIDATE_JOB_KIND, candidateJobParams } from './jobs/candidate-discovery'
import type { PlatformProjectionResult } from '../../lib/platform/business-record'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Collection = Awaited<ReturnType<typeof writePostgresCollectionHeader>>
type Observation = Awaited<ReturnType<typeof writePostgresObservation>>
const emptySummary = { written: 0, skipped: 0, failed: 0, evidenceRepointed: 0 }
const originalText = (value: unknown) => typeof value === 'string' ? value.trim() || null : null
const itemError = (ref: string, code: string, message: string, field?: string): RosterImportItemResult =>
  ({ ok:false,kind:'platform_query',ref,error:{code,message,...(field ? {field} : {})} })

async function archivedSource(tx: Tx, query: RosterImportPlatformQuery): Promise<{ id: number; source: PlatformQueryReplaySource } | null> {
  const { rows: [entry] } = await tx.execute<{ id: number }>(sql`SELECT a.old_id::float8 AS id
    FROM platform_collection c JOIN platform_legacy_query_alias a ON a.collection_id=c.id
    WHERE c.interface=${query.interface} AND c.query_key=${query.queryKey.trim()} AND c.rdjb=${query.rdjb?.trim() ?? ''}
      AND c.queried_at=${query.queriedAt.trim()}`)
  if (!entry) return null
  const { query: stored } = (await readPostgresFingerprintQueries(tx,[entry.id])).get(entry.id)!
  const originals = await readPostgresRelationFingerprints(tx,{queryId:entry.id})
  const ref = 'query:' + entry.id
  const bySequence = new Map(originals.map(({ relation }) => [relation.sequenceNo,
    { values:relation as unknown as NonNullable<RosterImportPlatformQuery['relations']>[number],ref:'relation:'+relation.id,id:relation.id }]))
  return { id:entry.id,source:{ref,metadata:{titleCode:stored.titleCode,status:stored.status,failureReason:stored.failureReason,
    rawResponse:stored.rawResponse,collectionEvidence:stored.collectionEvidence},relationCount:originals.length,relationAt:sequenceNo=>bySequence.get(sequenceNo)} }
}

async function planQuery(tx: Tx, query: RosterImportPlatformQuery, index: number, pending?: PlatformQueryReplaySource) {
  const ref = 'query:' + index
  const invalid = (code: string, message: string, field?: string) => ({ error:itemError(ref,code,message,field) } as const)
  if (!originalText(query.queryKey)) return invalid('query_key_required','平台查询缺少 queryKey','queryKey')
  if (!originalText(query.queriedAt)) return invalid('queried_at_required','平台查询缺少 queriedAt（查询时点）','queriedAt')
  const same = await archivedSource(tx,query)
  const relations = query.relations ?? []
  const normalized = relations.map(row => normalizePlatformRelation(query.interface,row))
  const codes = [...new Set(normalized.map(row => normalizeUscc(row.usccRaw)).filter(Boolean))]
  const ids = [...new Set(normalized.flatMap(row => row.enterpriseId == null ? [] : [row.enterpriseId]))]
  const { rows: owners } = await tx.execute<{ id: number; usccNorm: string | null; canonical: number }>(sql`
    WITH RECURSIVE requested(id,uscc_norm,canonical) AS (
      SELECT id,uscc_norm,id FROM enterprise WHERE id=ANY(${sql.param(ids)}::bigint[]) OR uscc_norm=ANY(${sql.param(codes)}::text[])
      UNION ALL
      SELECT r.id,r.uscc_norm,m.into_enterprise_id FROM requested r JOIN enterprise_merge m ON m.from_enterprise_id=r.canonical
    ) CYCLE canonical SET cycle USING seen
    SELECT id::float8 AS id,uscc_norm AS "usccNorm",canonical::float8 AS canonical FROM requested r
    WHERE NOT cycle AND NOT EXISTS(SELECT 1 FROM enterprise_merge m WHERE m.from_enterprise_id=r.canonical) ORDER BY id`)
  const byId = new Map(owners.map(owner => [owner.id,owner]))
  const byCode = new Map(owners.filter(owner=>owner.usccNorm).map(owner=>[owner.usccNorm!,owner]))
  const evidenceError = queryEvidenceError(query,same?.source ?? pending,{ byId:id=>byId.get(id),byUscc:code=>byCode.get(normalizeUscc(code)) })
  if (evidenceError) return invalid('collection_evidence_invalid',evidenceError,'collectionEvidence')
  for (const [i,row] of normalized.entries()) {
    if (!same && !pending && row.sequenceNo !== i+1) return invalid('sequence_no_invalid','新完整采集的 sequenceNo 必须按输入顺序从 1 连续编号','relations[].sequenceNo')
    if (row.normalizationConflicts.length) return invalid('platform_field_conflict','标准字段与原档冲突：'+row.normalizationConflicts.map(c=>c.field).join(', '),'relations')
  }
  if (!same && !pending && query.reuseExisting) return invalid('query_reuse_missing','No original collection exists at these coordinates','reuseExisting')
  if (!same && !pending && !query.collectionEvidence && query.rawResponse == null) return invalid('query_source_required','新采集必须提供原始 rawResponse 或 collectionEvidence','rawResponse')
  const source = same?.source ?? pending ?? stagedPlatformQuerySource(query,ref)
  const conflict = platformQuerySourceConflict(query,source)
  if (conflict) return { error:conflict } as const
  const stored = { ...query, relations: query.relations?.map(row => row.enterpriseId == null ? row :
    { ...row,enterpriseId:byId.get(row.enterpriseId)?.canonical ?? row.enterpriseId }) }
  return { query:stored,source,same,plannedReuse:pending !== undefined,normalized,byCode,byId } as const
}

type QueryPlan = Exclude<Awaited<ReturnType<typeof planQuery>>, {error: RosterImportItemResult}>
async function recordQueryEvidence(tx: Tx, header: Collection, observations: Observation[]) {
  const { query, columns } = header
  const envelope = query.collectionEvidence
  const ownsName = columns.queryKey.startsWith('name:')
  const { rows: owners } = await tx.execute<{ id: number }>(sql`SELECT id::float8 AS id FROM enterprise
    WHERE ${ownsName ? sql`name_norm=${columns.queryKey.slice(5)}` : sql`uscc_norm=${columns.queryKey}`} ORDER BY id LIMIT 2`)
  const revisions = projectQueryEvidenceRevisions({
    ...columns,id:header.queryAlias,completeness:envelope?.completeness ?? null,conditions:JSON.stringify(envelope?.effectiveConditions ?? {}),
    pages:JSON.stringify((envelope?.pages ?? []).map(p=>({rdjb:p.rdjb,page:p.page,status:p.status,fetchedCount:p.fetchedCount,
      declaredTotal:p.declaredTotal,maxPage:p.maxPage ?? null }))),
    unfinished:JSON.stringify((envelope?.unfinished ?? []).map(p=>({rdjb:p.rdjb,page:p.page}))),
  },owners.length === 1 ? owners[0]!.id : null,observations.map(row=>row.evidence))
  for (const revision of revisions) {
    const fact = revision.preserveFacts ? (await tx.execute<{ digest: string }>(sql`SELECT fact_digest AS digest FROM evidence_semantic_head_113
      WHERE source_key=${revision.sourceKind+':'+revision.sourceKey}`)).rows[0]?.digest ?? evidenceDigest113([]) : revision.factDigest
    const id = await appendPostgresEvidenceRevision(tx,{ ...revision,enterpriseId:revision.enterpriseId ?? undefined,
      titleCode:revision.titleCode ?? undefined,direction:revision.direction ?? undefined,eventId:revision.eventId ?? undefined,factDigest:fact })
    if (id === null) continue
    await tx.execute(sql`INSERT INTO evidence_revision_event_113(revision_id,event_id,enterprise_id,title_code)
      SELECT ${id},e.id,r.enterprise_id,r.title_code FROM record r JOIN record_event e ON e.record_id=r.id
      WHERE r.enterprise_id=${revision.enterpriseId ?? null} AND ${revision.titleCode == null ? sql`true` : sql`r.title_code=${revision.titleCode}`}
      AND EXISTS(SELECT 1 FROM record_correspondence c WHERE c.status='confirmed' AND (c.event_id=e.id OR c.predecessor_event_id=e.id))
      ON CONFLICT DO NOTHING`)
  }
}

async function writeQuery(tx: Tx, plan: QueryPlan, batchId: number): Promise<RosterImportItemResult> {
  const { query,normalized,byId,byCode } = plan
  const same = plan.same ?? (plan.plannedReuse ? await archivedSource(tx,query) : null)
  if (same) return { ok:true,kind:'platform_query',ref:'query:'+same.id,detail:{
    relations:[],skipped:new Set((query.relations ?? []).map(row=>row.sequenceNo)).size,canonicalProjection:[],rowsWritten:0,reuseExisting:true,
  } }
  const assignments = normalized.map(row => {
    const explicit = row.enterpriseId != null
    const owner = explicit ? byId.get(row.enterpriseId!)?.canonical ?? row.enterpriseId! : byCode.get(normalizeUscc(row.usccRaw))?.canonical ?? null
    const unknown = row.declareKind != null && !RELATION_DECLARE_KIND_ORDER.includes(row.declareKind)
    return { enterpriseId:owner,matchBasis:row.matchBasis ?? (explicit ? 'manual' : owner != null ? 'uscc' : 'none') as 'manual'|'uscc'|'none',
      verificationStatus:row.verificationStatus ?? (owner != null && !unknown ? 'confirmed' : 'pending') as 'confirmed'|'pending',
      nameRaw:originalText(row.nameRaw),usccRaw:originalText(row.usccRaw),aliasNameRaw:originalText(row.aliasNameRaw),
      origin:'command' as const,actor:{type:'agent' as const,id:'roster-import'},basis:'roster-import batch:'+batchId }
  })
  const header = await writePostgresCollectionHeader(tx,{queryText:JSON.stringify(query),
    evidenceText:query.collectionEvidence == null ? null : JSON.stringify(query.collectionEvidence),
    assignments,createdAt:new Date().toISOString(),batchId})
  const observations: Observation[] = []
  for (const [index,row] of (header.query.relations ?? []).entries()) {
    observations.push(await writePostgresObservation(tx,header,row,assignments[index]!,batchId))
  }
  const raw = query.rawResponse ?? null
  const slot = captureReconcileSlot({query:{id:header.queryAlias,...header.columns},
    rawResponse:{storageClass:raw === null ? 'null' : 'text',byteLength:raw === null ? null : Buffer.byteLength(raw),sha256:header.rawArchive.sha256},
    relations:observations.map(row=>row.slotInput)},header.rawArchive.id,raw,{rows:observations.map(row=>row.slot)})
  await tx.execute(sql`UPDATE platform_collection SET reconcile_slot_state=${slot.state},reconcile_slot_rule=${slot.rule},
    reconcile_slot_raw_archive_id=${slot.rawArchiveId},reconcile_slot_row_count=${slot.rowCount},reconcile_slot_input_sha256=${slot.inputSha256},
    reconcile_slot_reason=${slot.reason} WHERE id=${header.collectionId}`)
  await recordQueryEvidence(tx,header,observations)
  return { ok:true,kind:'platform_query',ref:'query:'+header.queryAlias,detail:{ relations:observations.map(row=>row.projection.relationId),
    skipped:0,canonicalProjection:observations.map(row=>row.projection),rowsWritten:1+observations.length } }
}

function archiveSummary(results: RosterImportItemResult[], reference: boolean, fields: boolean): RosterImportSummary {
  const rows = results.flatMap(item=>item.detail?.canonicalProjection as PlatformProjectionResult[] ?? [])
  const synced = rows.filter(row=>row.syncRequested)
  const versions = new Set(synced.flatMap(row=>row.versionId === null ? [] : [row.versionId]))
  const created = synced.filter(row=>row.applyProjectionCreated || row.businessProjectionCreated || row.recognizedProjectionCreated).length
  const quarantined = synced.filter(row=>row.versionId === null || row.recordId === null).length
  const projection = { recordsCreated:rows.filter(row=>row.recordCreated).length,versionsCreated:rows.filter(row=>row.versionCreated).length,
    observationsCreated:rows.filter(row=>row.observationCreated).length,observationsReused:rows.filter(row=>!row.observationCreated).length,
    missingKey:rows.filter(row=>row.identityState==='missing_key').length,conflict:rows.filter(row=>row.identityState==='conflict').length,
    unverifiable:rows.filter(row=>row.contentState==='unverifiable').length }
  const counts = Object.fromEntries(['apply','business','recognized'].flatMap(source=>{
    const keys = [source+'ProjectionCreated',source+'ProjectionReused']
    return keys.some(key=>rows.some(row=>Object.hasOwn(row,key))) ? keys.map(key=>[key.replace('Projection','Projections'),
      rows.filter(row=>Reflect.get(row,key)===true).length]) : []
  }))
  return { ...emptySummary,written:results.reduce((count,item)=>count+Number(item.detail?.rowsWritten ?? 0),0),
    skipped:results.reduce((count,item)=>count+Number(item.detail?.skipped ?? 0),0),
    ...(rows.length ? {canonicalProjection:{...projection,...counts}} : {}),
    ...(fields ? {platformFields:{ status:quarantined || reference ? 'partial' as const : synced.length ? 'ready' as const : 'not_performed' as const,
      eligibleVersions:versions.size,projectionsCreated:created,projectionsReused:versions.size-created,
      projectionsChecked:versions.size,observationsChecked:synced.length,quarantinedObservations:quarantined }} : {}) }
}

export function runPostgresPlatformImport(action: 'preflight' | 'commit' | 'replay', request: RosterImportRequest) {
  if (action === 'replay' || !request.payload.platformQueries?.length || Object.keys(request.payload).some(key=>key!=='platformQueries')) return
  const db = usePostgresRosterDb(true)
  if (!db) return
  return executePostgresRosterImport(db,action,request,async (tx,batch)=>{
    if (action === 'commit') await tx.execute(sql`SELECT pg_advisory_xact_lock(21785,0)`)
    const plans: QueryPlan[] = []
    const conflicts: RosterImportItemResult[] = []
    const pending = new Map<string,PlatformQueryReplaySource>()
    for (const [index,query] of request.payload.platformQueries!.entries()) {
      const key = JSON.stringify([query.interface,query.queryKey.trim(),query.rdjb?.trim() ?? '',query.queriedAt.trim()])
      if (query.interface === 'recognized_list' && pending.has(key)) {
        conflicts.push(itemError('query:'+index,'query_identity_duplicate','One original query identity may appear only once per batch','platformQueries'))
        continue
      }
      const plan = await planQuery(tx,query,index,pending.get(key))
      if ('error' in plan) conflicts.push(plan.error)
      else { plans.push(plan); pending.set(key,plan.source) }
    }
    const preflight = { add:plans.filter(plan=>!plan.same && !plan.plannedReuse).length,update:0,remove:0,review:plans.filter(plan=>plan.query.status==='failed').length,
      conflicts,evidenceRepoints:0,batchStatus:batch.status }
    if (action === 'preflight') return {preflight}
    if (conflicts.length) return {preflight,items:conflicts,summary:{...emptySummary,failed:conflicts.length},
      error:'批次校验未通过：'+conflicts.length+' 项有误，未写入任何数据'}
    const items = await tx.transaction(async nested=>{
      const results: RosterImportItemResult[] = []
      for (const plan of plans) results.push(await writeQuery(nested,plan,batch.id))
      return results
    })
    const summary = archiveSummary(items,plans.some(plan=>!!plan.same || plan.plannedReuse),request.sourceKind==='platform_archive')
    const candidateTaskIds = []
    if (process.env.NUXT_POSTGRES_JOBS === '1') {
      for (const item of items) {
        const queryId = Number(item.ref.slice('query:'.length))
        const { rows: [row] } = await tx.execute<{ last: number }>(sql`
          SELECT coalesce(max(a.old_id),0)::float8 AS last FROM platform_legacy_query_alias q
          JOIN platform_business_observation o ON o.collection_id=q.collection_id
          JOIN platform_legacy_relation_alias a ON a.observation_id=o.id WHERE q.old_id=${queryId}`)
        const clientRequestId = 'archive:'+queryId+':'+row!.last+':'+EVENT_ARCHIVE_RULE_VERSION
        const { row: job } = await stagePostgresJob(tx,{kind:CANDIDATE_JOB_KIND,params:candidateJobParams.parse({queryId,clientRequestId})})
        candidateTaskIds.push(job.id)
      }
    }
    return {preflight,items,summary,error:null,candidateTaskIds}
  })
}
