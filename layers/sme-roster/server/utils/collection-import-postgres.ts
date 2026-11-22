import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { platformBusinessObservation, platformCollection } from '../../../../db/postgresql/platform-tables'
import { and, DrizzleQueryError, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { RELATION_DECLARE_KIND_ORDER } from '../../lib/labels'
import { normalizeUscc } from '../../lib/domain'
import type { RosterImportItemResult, RosterImportPlatformQuery, RosterImportPreflight, RosterImportRequest, RosterImportSummary } from '../../lib/roster-import-client'
import { queryEvidenceError } from '../../lib/platform/query-evidence'
import { platformQuerySourceConflict, stagedPlatformQuerySource, type PlatformQueryReplaySource } from '../../lib/platform/query-replay'
import { normalizePlatformRelation } from '../../lib/platform/normalization'
import { writePostgresCollectionHeader } from '../../lib/platform/postgres-collection-write'
import { writePostgresObservation } from '../../lib/platform/postgres-observation-write'
import { executePostgresRosterImport, type NativeImportExecution, type PostgresImportAction, type PostgresImportBatch } from './roster-export-import-postgres'
import { prunePostgresPlatformCaptures } from './platform-capture-retention-postgres'
import type { PlatformProjectionResult } from '../../lib/platform/business-record'
import { PlatformProjectionError } from '../../lib/platform/projection-error'
import { applyProjectionPreview, businessProjectionPreview, planPlatformObservation, recognizedProjectionPreview } from './platform-business-record'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Observation = Awaited<ReturnType<typeof writePostgresObservation>>
const emptySummary = { written: 0, skipped: 0, failed: 0, evidenceRepointed: 0 }
const originalText = (value: unknown) => typeof value === 'string' ? value.trim() || null : null
const itemError = (ref: string, code: string, message: string, field?: string): RosterImportItemResult =>
  ({ ok:false,kind:'platform_query',ref,error:{code,message,...(field ? {field} : {})} })

async function storedQuery(tx: Tx, query: RosterImportPlatformQuery) {
  const c = platformCollection

  const [entry] = await tx.select({
    id: c.publicId, collectionId: c.id, titleCode: c.titleCode, status: c.status, failureReason: c.failureReason,
  }).from(c)
    .where(and(eq(c.interface, query.interface), eq(c.queryKey, query.queryKey.trim()),
      eq(c.rdjb, originalText(query.rdjb) ?? ''), eq(c.queriedAt, query.queriedAt.trim())))
  if (!entry) return null
  const ref = 'query:' + entry.id
  return { ...entry, ref }
}

async function storedQueryReference(tx: Tx, entry: NonNullable<Awaited<ReturnType<typeof storedQuery>>>, query: RosterImportPlatformQuery) {
  const o = platformBusinessObservation

  const rows = query.relations?.length ? await tx.select({ sequenceNo: o.sequenceNo, relationKey: o.sourceRelationKey, relationId: o.publicId })
    .from(o).where(eq(o.collectionId, entry.collectionId)) : []
  const bySequence = new Map(rows.map(row => [row.sequenceNo, { values: row, ref: 'relation:' + row.relationId }]))
  return platformQuerySourceConflict(query, {
    ref: entry.ref,
    metadata: { titleCode: entry.titleCode, status: entry.status as NonNullable<RosterImportPlatformQuery['status']>,
      failureReason: entry.failureReason, rawResponse: null, collectionEvidence: null },
    relationCount: rows.length,
    relationAt: sequenceNo => bySequence.get(sequenceNo),
  })
}

async function planQuery(tx: Tx, query: RosterImportPlatformQuery, index: number, pending?: PlatformQueryReplaySource) {
  const ref = 'query:' + index
  const invalid = (code: string, message: string, field?: string) => ({ error:itemError(ref,code,message,field) } as const)
  if (!originalText(query.queryKey)) return invalid('query_key_required','平台查询缺少 queryKey','queryKey')
  if (!originalText(query.queriedAt)) return invalid('queried_at_required','平台查询缺少 queriedAt（查询时点）','queriedAt')
  const relations = query.relations ?? []
  if (!Array.isArray(relations) || relations.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    return invalid('collection_evidence_invalid', 'Relations must preserve the original source rows', 'relations')
  }
  const same = await storedQuery(tx, query)
  if (same || query.reuseExisting === true) {
    if (query.reuseExisting !== true || query.rawResponse != null || query.collectionEvidence != null ||
      relations.some(row => Object.keys(row).some(key => key !== 'sequenceNo' && key !== 'relationKey'))) {
      return invalid('query_replay_offline', 'Existing collections accept only a reference to the collection and its row coordinates', 'reuseExisting')
    }
    if (!same && !pending) return invalid('query_reuse_missing','No original collection exists at these coordinates','reuseExisting')
    const conflict = same ? await storedQueryReference(tx, same, query) : platformQuerySourceConflict(query, pending!)
    if (conflict) return { error: conflict } as const
    return { kind: 'reference' as const, query, collection: same }
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
  const evidenceError = queryEvidenceError(query,pending,{ byId:id=>byId.get(id),byUscc:code=>byCode.get(normalizeUscc(code)) })
  if (evidenceError) return invalid('collection_evidence_invalid',evidenceError,'collectionEvidence')
  for (const [i,row] of normalized.entries()) {
    if (!pending && row.sequenceNo !== i+1) return invalid('sequence_no_invalid','新完整采集的 sequenceNo 必须按输入顺序从 1 连续编号','relations[].sequenceNo')
    if (row.normalizationConflicts.length) return invalid('platform_field_conflict','标准字段与原档冲突：'+row.normalizationConflicts.map(c=>c.field).join(', '),'relations')
  }
  if (!pending && !query.collectionEvidence && query.rawResponse == null) return invalid('query_source_required','新采集必须提供原始 rawResponse 或 collectionEvidence','rawResponse')
  const source = pending ?? stagedPlatformQuerySource(query,ref)
  const conflict = platformQuerySourceConflict(query,source)
  if (conflict) return { error:conflict } as const
  const stored = { ...query, relations: query.relations?.map(row => row.enterpriseId == null ? row :
    { ...row,enterpriseId:byId.get(row.enterpriseId)?.canonical ?? row.enterpriseId }) }
  if (pending) return { kind: 'reference' as const, query: stored, collection: null }
  return { kind: 'new' as const, query: stored, source, normalized, byCode, byId }
}

type QueryPlan = Exclude<Awaited<ReturnType<typeof planQuery>>, {error: RosterImportItemResult}>
async function writeQuery(tx: Tx, plan: QueryPlan, batchId: number): Promise<RosterImportItemResult> {
  const { query } = plan
  if (plan.kind === 'reference') {
    const source = plan.collection ?? await storedQuery(tx, query)
    if (!source) throw new Error('Missing collection referenced in the same batch')
    return { ok:true,kind:'platform_query',ref:source.ref,detail:{
      relations:[],skipped:new Set((query.relations ?? []).map(row=>row.sequenceNo)).size,rowsWritten:0,reuseExisting:true,
    } }
  }
  const { normalized, byId, byCode } = plan
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
  return { ok:true,kind:'platform_query',ref:'query:'+header.queryId,detail:{ relations:observations.map(row=>row.projection.relationId),
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
    skipped:results.reduce((count,item)=>count+Number(item.detail?.skipped ?? 0),0),
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
    const key = JSON.stringify([query.interface, originalText(query.queryKey), originalText(query.rdjb) ?? '', originalText(query.queriedAt)])
    if (query.interface === 'recognized_list' && pending.has(key)) {
      conflicts.push(itemError('query:'+index,'query_identity_duplicate','One original query identity may appear only once per batch','platformQueries'))
      continue
    }
    const plan = await planQuery(tx,query,index,pending.get(key))
    if ('error' in plan) conflicts.push(plan.error)
    else {
      plans.push(plan)
      if (plan.kind === 'new') pending.set(key,plan.source)
    }
  }
  return { plans, conflicts }
}

export function commitPostgresPlatformCollection(db: NodePgDatabase, request: RosterImportRequest, checkpoint: (tx: Tx) => Promise<void>) {
  return executePostgresRosterImport(db, 'commit', request, (tx, batch) =>
    executePostgresPlatformItems(tx, batch, 'commit', request, checkpoint))
}

export async function executePostgresPlatformItems(tx: Tx,batch: PostgresImportBatch,action: PostgresImportAction,
  request: RosterImportRequest, checkpoint?: (tx: Tx)=>Promise<void>): Promise<NativeImportExecution> {
  const queries = Array.isArray(request.payload.platformQueries) ? request.payload.platformQueries : []
  // Drizzle has no transaction-scoped PostgreSQL advisory lock API.
  if (action === 'commit') await tx.execute(sql`SELECT pg_advisory_xact_lock(21785,0)`)
  const { plans, conflicts } = await planPostgresPlatformQueries(tx,queries)
  const canonicalProjection: NonNullable<RosterImportPreflight['canonicalProjection']> = []
  for (const plan of plans) {
    if (plan.kind !== 'new') continue
    for (const relation of plan.query.relations ?? []) {
      const original = plan.source.relationAt(relation.sequenceNo)!
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
  const preflight = { add:plans.filter(plan=>plan.kind==='new').length,
    update:0,remove:0,review:plans.filter(plan=>plan.query.status==='failed').length,conflicts,evidenceRepoints:0,batchStatus:batch.status,
    ...(canonicalProjection.length ? {canonicalProjection} : {}) }
  if (action === 'preflight') return {preflight}
  if (conflicts.length) return {preflight,items:conflicts,summary:{...emptySummary,failed:conflicts.length},
    error:'批次校验未通过：'+conflicts.length+' 项有误，未写入任何数据'}
  const writes = plans.map((plan,index)=>({kind:'platform_query',
    ref: (plan.kind === 'reference' ? plan.collection?.ref : null) ?? 'query:'+index,
    run:(nested: Tx)=>writeQuery(nested,plan,batch.id)}))
  const items: RosterImportItemResult[] = []
  try {
    await tx.transaction(async nested=>{
      for (const write of writes) items.push(await write.run(nested))
      const recordIds = new Set(items.flatMap(item => (item.detail?.canonicalProjection as PlatformProjectionResult[] | undefined) ?? [])
        .flatMap(row => row.recordId === null ? [] : [row.recordId]))
      await prunePostgresPlatformCaptures(nested, [...recordIds], true)
    })
  } catch (error) {
    // Constraint and trigger rejections prove this write did not commit.
    // Connection failures and retries must continue through the exception path.
    const code = error instanceof DrizzleQueryError ? (error.cause as { code?: string } | undefined)?.code : undefined
    const rejected = code?.startsWith('23') || code === 'P0001'
    if ((!rejected && !(error instanceof PlatformProjectionError)) || !writes[items.length]) throw error
    const { kind, ref } = writes[items.length]!
    const details = error instanceof PlatformProjectionError
      ? { code: error.code, message: error.message }
      : { code: 'platform_write_failed', message: '平台证据写入失败，已整批回滚' }
    const failed: RosterImportItemResult = { ok:false,kind,ref,
      error:{ ...details, field:'relations' } }
    const rolledBack = items.map(item=>({ ...item,ok:false,error:{code:'commit_rolled_back',message:'整批回滚，本项未写入'} }))
    const notExecuted = writes.slice(items.length+1).map(({kind,ref})=>({
      kind,ref,ok:false,error:{code:'not_executed',message:'整批回滚，本项未执行'},
    }))
    return {preflight,items:[...rolledBack,failed,...notExecuted],summary:{...emptySummary,failed:writes.length},
      error:'批次执行阶段有项失败（已整批回滚，未写入任何数据）'}
  }
  const summary = archiveSummary(items,plans.some(plan=>plan.kind==='reference'),request.sourceKind==='platform_archive')
  await checkpoint?.(tx)
  return {preflight,items,summary,error:null}
}
