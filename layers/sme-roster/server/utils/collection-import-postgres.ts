import { evidenceRevisionEvent113, evidenceSemanticHead113 } from '../../../../db/postgresql/evidence-review-tables'
import { record, recordEvent } from '../../../../db/postgresql/ledger-tables'
import { recordCorrespondence } from '../../../../db/postgresql/qualification-tables'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { platformBusinessObservation, platformCollection, platformLegacyQueryAlias, platformLegacyRelationAlias } from '../../../../db/postgresql/platform-tables'
import { and, DrizzleQueryError, eq, exists, max, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { RELATION_DECLARE_KIND_ORDER } from '../../lib/labels'
import { normalizeUscc } from '../../lib/domain'
import type { RosterImportItemResult, RosterImportPlatformQuery, RosterImportPreflight, RosterImportRequest, RosterImportSummary } from '../../lib/roster-import-client'
import { queryEvidenceError } from '../../lib/platform/query-evidence'
import { platformQuerySourceConflict, stagedPlatformQuerySource, type PlatformQueryReplaySource } from '../../lib/platform/query-replay'
import { normalizePlatformRelation } from '../../lib/platform/normalization'
import { captureReconcileSlot } from '../../lib/platform/reconcile-slot-capture'
import { writePostgresCollectionHeader } from '../../lib/platform/postgres-collection-write'
import { writePostgresObservation } from '../../lib/platform/postgres-observation-write'
import { readPostgresFingerprintQueries, readPostgresRelationFingerprints } from './postgres-platform-fingerprint'
import { executePostgresRosterImport, type NativeImportExecution, type PostgresImportAction, type PostgresImportBatch } from './roster-export-import-postgres'
import { projectQueryEvidenceRevisions } from './evidence-impact-model'
import { evidenceDigest113 } from './evidence-digest'
import { appendPostgresEvidenceRevision } from './evidence-revision-postgres'
import { stagePostgresJob } from '../../../core/server/utils/job-runner-postgres'
import { EVENT_ARCHIVE_RULE_VERSION } from './event-archive-discovery-model'
import { CANDIDATE_JOB_KIND, candidateJobParams } from './jobs/candidate-discovery-contract'
import type { PlatformProjectionResult } from '../../lib/platform/business-record'
import { PlatformProjectionError } from '../../lib/platform/projection-error'
import { ArchivedObservationWriteError, planPostgresHistoricalObservation, previewPostgresArchivedObservation, writePostgresArchivedObservation } from './platform-observation-import-postgres'
import { applyProjectionPreview, businessProjectionPreview, planPlatformObservation, recognizedProjectionPreview } from './platform-business-record'
import { LegacyProvenanceError } from '../../lib/platform/legacy-provenance-error'
import { inspectPostgresLegacyProvenance, writePostgresLegacyProvenance } from './platform-legacy-provenance-postgres'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Collection = Awaited<ReturnType<typeof writePostgresCollectionHeader>>
type Observation = Awaited<ReturnType<typeof writePostgresObservation>>
const emptySummary = { written: 0, skipped: 0, failed: 0, evidenceRepointed: 0 }
const originalText = (value: unknown) => typeof value === 'string' ? value.trim() || null : null
const itemError = (ref: string, code: string, message: string, field?: string): RosterImportItemResult =>
  ({ ok:false,kind:'platform_query',ref,error:{code,message,...(field ? {field} : {})} })

async function archivedSource(tx: Tx, query: RosterImportPlatformQuery): Promise<{ id: number; source: PlatformQueryReplaySource } | null> {
  const [entry] = await tx.select({ id: platformLegacyQueryAlias.oldId }).from(platformCollection)
    .innerJoin(platformLegacyQueryAlias, eq(platformLegacyQueryAlias.collectionId, platformCollection.id))
    .where(and(eq(platformCollection.interface, query.interface), eq(platformCollection.queryKey, query.queryKey.trim()),
      eq(platformCollection.rdjb, query.rdjb?.trim() ?? ''), eq(platformCollection.queriedAt, query.queriedAt.trim())))
  if (!entry) return null
  const { query: stored } = (await readPostgresFingerprintQueries(tx,[entry.id])).get(entry.id)!
  const originals = await readPostgresRelationFingerprints(tx,{queryId:entry.id,archiveReplay:true})
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
  if (!Array.isArray(relations) || relations.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    return invalid('collection_evidence_invalid', 'Relations must preserve the original source rows', 'relations')
  }
  const normalized = relations.map(row => normalizePlatformRelation(query.interface,row))
  const codes = [...new Set(normalized.map(row => normalizeUscc(row.usccRaw)).filter(Boolean))]
  const ids = [...new Set(normalized.flatMap(row => row.enterpriseId == null ? [] : [row.enterpriseId]))]
  // Drizzle has no recursive CTE or CYCLE builder for canonical owner traversal.
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
  const owners = await tx.select({ id: enterprise.id }).from(enterprise)
    .where(ownsName ? eq(enterprise.nameNorm, columns.queryKey.slice(5)) : eq(enterprise.usccNorm, columns.queryKey))
    .orderBy(enterprise.id).limit(2)
  const revisions = projectQueryEvidenceRevisions({
    ...columns,id:header.queryAlias,completeness:envelope?.completeness ?? null,conditions:JSON.stringify(envelope?.effectiveConditions ?? {}),
    pages:JSON.stringify((envelope?.pages ?? []).map(p=>({rdjb:p.rdjb,page:p.page,status:p.status,fetchedCount:p.fetchedCount,
      declaredTotal:p.declaredTotal,maxPage:p.maxPage ?? null }))),
    unfinished:JSON.stringify((envelope?.unfinished ?? []).map(p=>({rdjb:p.rdjb,page:p.page}))),
  },owners.length === 1 ? owners[0]!.id : null,observations.map(row=>row.evidence))
  for (const revision of revisions) {
    const previous = revision.preserveFacts
      ? (await tx.select({ digest: evidenceSemanticHead113.factDigest }).from(evidenceSemanticHead113)
          .where(eq(evidenceSemanticHead113.sourceKey, revision.sourceKind+':'+revision.sourceKey)))[0]?.digest
      : undefined
    const fact = revision.preserveFacts ? previous ?? evidenceDigest113([]) : revision.factDigest
    const id = await appendPostgresEvidenceRevision(tx,{ ...revision,enterpriseId:revision.enterpriseId ?? undefined,
      titleCode:revision.titleCode ?? undefined,direction:revision.direction ?? undefined,eventId:revision.eventId ?? undefined,factDigest:fact })
    if (id === null || revision.enterpriseId == null) continue
    await tx.insert(evidenceRevisionEvent113).select(tx.select({
      revisionId: sql<number>`${id}::bigint`.as('revision_id'), eventId: recordEvent.id,
      enterpriseId: record.enterpriseId, titleCode: record.titleCode,
    }).from(record).innerJoin(recordEvent, eq(recordEvent.recordId, record.id))
      .where(and(eq(record.enterpriseId, revision.enterpriseId),
        revision.titleCode == null ? undefined : eq(record.titleCode, revision.titleCode),
        exists(tx.select({ id: recordCorrespondence.id }).from(recordCorrespondence)
          .where(and(eq(recordCorrespondence.status, 'confirmed'),
            or(eq(recordCorrespondence.eventId, recordEvent.id), eq(recordCorrespondence.predecessorEventId, recordEvent.id))))),
      ))).onConflictDoNothing()
  }
}

async function writeQuery(tx: Tx, plan: QueryPlan, batchId: number): Promise<RosterImportItemResult> {
  const { query,normalized,byId,byCode } = plan
  const same = plan.same ?? (plan.plannedReuse ? await archivedSource(tx,query) : null)
  if (same) {
    const canonicalProjection: PlatformProjectionResult[] = []
    for (const relation of query.relations ?? []) {
      const relationId = same.source.relationAt(relation.sequenceNo)!.id!
      const sync = query.reuseExisting !== true && relation.rawFields != null
      const result = await writePostgresArchivedObservation(tx,relationId,{ kind:sync ? 'replay' : 'reference' })
      if (result) canonicalProjection.push(result)
    }
    return { ok:true,kind:'platform_query',ref:'query:'+same.id,detail:{
      relations:[],skipped:new Set((query.relations ?? []).map(row=>row.sequenceNo)).size,canonicalProjection,rowsWritten:0,reuseExisting:true,
    } }
  }
  const assignments = normalized.map(row => {
    const requestedOwner = row.enterpriseId
    const explicit = requestedOwner != null
    const owner = requestedOwner === undefined ? byCode.get(normalizeUscc(row.usccRaw))?.canonical ?? null
      : requestedOwner === null ? null : byId.get(requestedOwner)?.canonical ?? requestedOwner
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
  await tx.update(platformCollection).set({
    reconcileSlotState: slot.state, reconcileSlotRule: slot.rule, reconcileSlotRawArchiveId: slot.rawArchiveId,
    reconcileSlotRowCount: slot.rowCount, reconcileSlotInputSha256: slot.inputSha256, reconcileSlotReason: slot.reason,
  }).where(eq(platformCollection.id, header.collectionId))
  await recordQueryEvidence(tx,header,observations)
  return { ok:true,kind:'platform_query',ref:'query:'+header.queryAlias,detail:{ relations:observations.map(row=>row.projection.relationId),
    skipped:0,canonicalProjection:observations.map(row=>row.projection),rowsWritten:1+observations.length } }
}

function archiveSummary(results: RosterImportItemResult[], reference: boolean, fields: boolean): RosterImportSummary {
  const rows = results.flatMap(item=>item.detail?.canonicalProjection as PlatformProjectionResult[] ?? [])
  const synced = rows.filter(row=>row.syncRequested)
  const observations = new Map(synced.map(row=>[row.relationId,row]))
  const versions = new Set(synced.flatMap(row=>row.versionId === null ? [] : [row.versionId]))
  const created = new Set(synced.filter(row=>row.applyProjectionCreated || row.businessProjectionCreated || row.recognizedProjectionCreated)
    .map(row=>row.versionId)).size
  const quarantined = [...observations.values()].filter(row=>row.versionId === null || row.recordId === null).length
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
    skipped:results.reduce((count,item)=>count+Number(item.detail?.skipped ??
      (item.kind==='platform_legacy_provenance' && item.detail?.rowsWritten===0)),0),
    ...(rows.length ? {canonicalProjection:{...projection,...counts}} : {}),
    ...(fields ? {platformFields:{ status:quarantined || reference ? 'partial' as const : observations.size ? 'ready' as const : 'not_performed' as const,
      eligibleVersions:versions.size,projectionsCreated:created,projectionsReused:versions.size-created,
      projectionsChecked:versions.size,observationsChecked:observations.size,quarantinedObservations:quarantined }} : {}) }
}

export async function planPostgresPlatformQueries(tx: Tx, queries: readonly RosterImportPlatformQuery[]) {
  const plans: QueryPlan[] = []
  const conflicts: RosterImportItemResult[] = []
  const pending = new Map<string,PlatformQueryReplaySource>()
  for (const [index,query] of queries.entries()) {
    const key = JSON.stringify([query.interface,query.queryKey.trim(),query.rdjb?.trim() ?? '',query.queriedAt.trim()])
    if (query.interface === 'recognized_list' && pending.has(key)) {
      conflicts.push(itemError('query:'+index,'query_identity_duplicate','One original query identity may appear only once per batch','platformQueries'))
      continue
    }
    const plan = await planQuery(tx,query,index,pending.get(key))
    if ('error' in plan) conflicts.push(plan.error)
    else {
      plans.push(plan)
      pending.set(key,plan.source)
    }
  }
  return { plans, conflicts }
}

export function commitPostgresPlatformCollection(db: NodePgDatabase, request: RosterImportRequest, checkpoint: (tx: Tx) => Promise<void>) {
  return executePostgresRosterImport(db, 'commit', request, (tx, batch) =>
    executePostgresPlatformItems(tx, batch, 'commit', request, checkpoint))
}

export async function executePostgresPlatformItems(tx: Tx,batch: PostgresImportBatch,action: PostgresImportAction,
  request: RosterImportRequest, checkpoint?: (tx: Tx)=>Promise<void>, stageCandidateJobs = true): Promise<NativeImportExecution> {
  const queries = Array.isArray(request.payload.platformQueries) ? request.payload.platformQueries : []
  const requestedObservations = request.payload.platformRecordObservations ?? []
  const provenance = request.payload.platformLegacyProvenance ?? []
  // Drizzle has no transaction-scoped PostgreSQL advisory lock API.
  if (action === 'commit') await tx.execute(sql`SELECT pg_advisory_xact_lock(21785,0)`)
  const { plans, conflicts } = await planPostgresPlatformQueries(tx,queries)
  const canonicalProjection: NonNullable<RosterImportPreflight['canonicalProjection']> = []
  const addObservationError = (kind: 'platform_observation' | 'platform_relation', relationId: number, error: unknown) => {
    if (!(error instanceof PlatformProjectionError)) throw error
    conflicts.push({ ok:false,kind,ref:'relation:'+relationId,
      error:{ code:error.code,message:error.message,...(kind==='platform_relation' ? {field:'relations'} : {}) } })
  }
  for (const plan of plans) {
    for (const relation of plan.query.relations ?? []) {
      const original = plan.source.relationAt(relation.sequenceNo)!
      if (original.id != null) {
        try { canonicalProjection.push(await previewPostgresArchivedObservation(tx, original.id)) }
        catch (error) { addObservationError('platform_relation', original.id, error) }
        continue
      }
      const projection = planPlatformObservation({
        interface: plan.query.interface, relationKey: original.values.relationKey, rawFields: original.values.rawFields,
      })
      const apply = applyProjectionPreview(projection)
      const business = businessProjectionPreview(projection)
      const recognized = recognizedProjectionPreview(projection)
      canonicalProjection.push({
        relationId: null, identityState: projection.identityState, contentState: projection.contentState, keySource: projection.keySource,
        ...(apply ? { applyProjection: apply } : {}),
        ...(business ? { businessProjection: business } : {}),
        ...(recognized ? { recognizedProjection: recognized } : {}),
      })
    }
  }
  const observationSources: NonNullable<RosterImportPreflight['platformObservationSources']> = []
  let observationReview = 0
  for (const { relationId } of requestedObservations) {
    const expected = batch.preflight?.platformObservationSources?.find(row=>row.relationId===relationId)?.inputFingerprint
    try {
      const preview = await planPostgresHistoricalObservation(tx,relationId,expected)
      observationSources.push({ relationId,inputFingerprint:preview.inputFingerprint })
      canonicalProjection.push(preview)
      observationReview += Number(preview.identityState!=='resolved' || preview.contentState!=='verified')
    } catch (error) {
      addObservationError('platform_observation',relationId,error)
      if (expected) observationSources.push({ relationId,inputFingerprint:expected })
    }
  }
  const legacy: Awaited<ReturnType<typeof inspectPostgresLegacyProvenance>>[] = []
  const legacySources = []
  for (const input of provenance) {
    const expected = batch.preflight?.platformLegacyProvenanceSources?.find(row=>row.queryId===input.queryId)?.inputFingerprint
    try {
      const plan = await inspectPostgresLegacyProvenance(tx,input,expected)
      legacy.push(plan)
      legacySources.push({ queryId:input.queryId,inputFingerprint:plan.fingerprint })
    } catch (error) {
      if (!(error instanceof LegacyProvenanceError)) throw error
      conflicts.push({ kind:'platform_legacy_provenance',ref:'query:'+input.queryId,ok:false,error:{code:error.code,message:error.message} })
      if (expected) legacySources.push({ queryId:input.queryId,inputFingerprint:expected })
    }
  }
  const preflight = { add:plans.filter(plan=>!plan.same && !plan.plannedReuse).length+legacy.filter(plan=>!plan.exists).length,
    update:0,remove:0,review:plans.filter(plan=>plan.query.status==='failed').length+observationReview,conflicts,evidenceRepoints:0,batchStatus:batch.status,
    ...(canonicalProjection.length ? {canonicalProjection} : {}),
    ...(observationSources.length ? {platformObservationSources:observationSources} : {}),
    ...(legacySources.length ? {platformLegacyProvenanceSources:legacySources} : {}) }
  if (action === 'preflight') return {preflight}
  if (conflicts.length) return {preflight,items:conflicts,summary:{...emptySummary,failed:conflicts.length},
    error:'批次校验未通过：'+conflicts.length+' 项有误，未写入任何数据'}
  const writes: { kind: string; ref: string; run(tx: Tx): Promise<RosterImportItemResult> }[] = [
    ...plans.map((plan,index)=>({kind:'platform_query',ref:plan.same?.source.ref ?? 'query:'+index,
      run:(nested: Tx)=>writeQuery(nested,plan,batch.id)})),
    ...observationSources.map(({ relationId,inputFingerprint })=>{
      const item = { kind:'platform_observation',ref:'relation:'+relationId }
      return { ...item,async run(nested: Tx) {
        const projection = await writePostgresArchivedObservation(nested,relationId,{ kind:'historical',batchId:batch.id,expected:inputFingerprint })
        return { ...item,ok:true,detail:{ canonicalProjection:[projection!],rowsWritten:0 } }
      } }
    }),
    ...legacy.map(plan=>{
      const item = { kind:'platform_legacy_provenance',ref:'query:'+plan.input.queryId }
      return { ...item,async run(nested: Tx) {
        return { ...item,ok:true,detail:await writePostgresLegacyProvenance(nested,plan,batch.id) }
      } }
    }),
  ]
  const items: RosterImportItemResult[] = []
  try {
    await tx.transaction(async nested=>{
      for (const write of writes) items.push(await write.run(nested))
    })
  } catch (error) {
    // Constraint and trigger rejections prove this write did not commit.
    // Connection failures and retries must continue through the exception path.
    const code = error instanceof DrizzleQueryError ? (error.cause as { code?: string } | undefined)?.code : undefined
    const rejected = code?.startsWith('23') || code === 'P0001'
    if ((!rejected && !(error instanceof PlatformProjectionError)) || !writes[items.length]) throw error
    const { kind, ref } = error instanceof ArchivedObservationWriteError
      ? { kind: error.kind, ref: 'relation:' + error.relationId }
      : writes[items.length]!
    const details = error instanceof PlatformProjectionError
      ? { code: error.code, message: error.message }
      : { code: 'platform_write_failed', message: '平台证据写入失败，已整批回滚' }
    const failed: RosterImportItemResult = { ok:false,kind,ref,
      error:{ ...details,...(kind==='platform_observation' ? {} : {field:'relations'})} }
    const rolledBack = items.map(item=>({ ...item,ok:false,error:{code:'commit_rolled_back',message:'整批回滚，本项未写入'} }))
    const notExecuted = writes.slice(items.length+1).map(({kind,ref})=>({
      kind,ref,ok:false,error:{code:'not_executed',message:'整批回滚，本项未执行'},
    }))
    return {preflight,items:[...rolledBack,failed,...notExecuted],summary:{...emptySummary,failed:writes.length},
      error:'批次执行阶段有项失败（已整批回滚，未写入任何数据）'}
  }
  const summary = archiveSummary(items,plans.some(plan=>(plan.same || plan.plannedReuse) &&
    (plan.query.reuseExisting === true || (!plan.query.relations?.length && plan.source.relationCount > 0) ||
      plan.query.relations?.some(row=>row.rawFields == null))),request.sourceKind==='platform_archive')
  const candidateTaskIds = [], queuedCandidateTaskIds = []
  if (checkpoint) await checkpoint(tx)
  else if (stageCandidateJobs && process.env.NUXT_DB_READONLY !== '1') {
    for (const item of items.filter(item=>item.kind==='platform_query')) {
      const queryId = Number(item.ref.slice('query:'.length))
      const [row] = await tx.select({ last: max(platformLegacyRelationAlias.oldId) }).from(platformLegacyQueryAlias)
        .innerJoin(platformBusinessObservation, eq(platformBusinessObservation.collectionId, platformLegacyQueryAlias.collectionId))
        .innerJoin(platformLegacyRelationAlias, eq(platformLegacyRelationAlias.observationId, platformBusinessObservation.id))
        .where(eq(platformLegacyQueryAlias.oldId, queryId))
      const clientRequestId = 'archive:'+queryId+':'+(row?.last ?? 0)+':'+EVENT_ARCHIVE_RULE_VERSION
      const { row: job, inserted } = await stagePostgresJob(tx,{kind:CANDIDATE_JOB_KIND,params:candidateJobParams.parse({queryId,clientRequestId})})
      candidateTaskIds.push(job.id)
      if (inserted) queuedCandidateTaskIds.push(job.id)
    }
  }
  return {preflight,items,summary,error:null,candidateTaskIds,queuedCandidateTaskIds}
}
