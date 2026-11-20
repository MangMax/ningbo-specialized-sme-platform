import { getTableColumns, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { buildRecordCorrespondencePlan, correspondenceEdgeKey, correspondenceHash, CorrespondenceError, recordCorrespondenceMutations, requestedCorrespondenceSources, type CorrespondencePlan, type CorrespondenceReceipt, type CorrespondenceRequest, type StoredCorrespondence } from './record-correspondence'
import { observePostgresCorrespondences } from './record-correspondence-postgres'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Batch = {
  id: number; status: string; kind: string; identity: string
  plan: (CorrespondencePlan & { requestHash: string }) | null; receipt: CorrespondenceReceipt | null
}
const fail = (code: CorrespondenceError['code'], message: string): never => { throw new CorrespondenceError(code, message) }

export async function runPostgresCorrespondenceTransaction<T>(db: NodePgDatabase, run: (tx: Tx) => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try { return await db.transaction(run, { isolationLevel: 'serializable' }) }
    catch (error) {
      const cause = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } }
      const code = cause.code ?? cause.cause?.code
      const constraint = cause.constraint ?? cause.cause?.constraint
      if (code === '23505' && constraint === 'record_correspondence_edge_uq') fail('plan_mismatch', 'Another request committed this edge; preflight again')
      if (code !== '40001') throw error
      if (attempt === 2) fail('plan_mismatch', 'Concurrent source change; preflight again')
    }
  }
}

async function readBatch(tx: Tx, request: CorrespondenceRequest) {
  const { rows: [batch] } = await tx.execute<Batch>(sql`
    SELECT id::float8 AS id,status,source_kind AS kind,source_identity AS identity,
      preflight_result::json AS plan,summary::json AS receipt FROM import_batch
    WHERE idempotency_key=${request.idempotencyKey} FOR UPDATE`)
  if (batch && (batch.kind !== 'correspondence_decision' || batch.identity !== request.sourceIdentity)) {
    fail('idempotency_conflict', 'Idempotency key belongs to another source')
  }
  if (batch?.plan && batch.plan.requestHash !== correspondenceHash(request)) {
    fail('idempotency_conflict', 'Idempotency key belongs to a different request')
  }
  return batch
}

async function loadPlan(tx: Tx, request: CorrespondenceRequest, lock: boolean) {
  const ids = request.operations.flatMap(op => 'correspondenceId' in op ? [op.correspondenceId] : [])
  const keys = request.operations.flatMap(op => 'edge' in op ? [correspondenceEdgeKey(op.edge)] : [])
  const { rows } = await tx.execute<{ row: typeof schema.recordCorrespondence.$inferSelect; relationId: number | null }>(sql`
    SELECT ${postgresRosterRow(schema.recordCorrespondence, 'p')} AS row,a.old_id::float8 AS "relationId"
    FROM record_correspondence p LEFT JOIN platform_legacy_relation_alias a ON a.observation_id=p.observation_id
    WHERE p.id=ANY(${sql.param(ids)}::bigint[]) OR p.edge_key=ANY(${sql.param(keys)}::text[])
    ORDER BY p.id ${lock ? sql`FOR UPDATE OF p` : sql.empty()}`)
  const stored: StoredCorrespondence[] = rows.map(({ row: { observationId: _observation, ...row }, relationId }) => ({ ...row, relationId }))
  const byId = new Map(stored.map(row => [row.id, row]))
  const byEdge = new Map(stored.map(row => [row.edgeKey, row]))
  const proofs = request.operations.flatMap(op => {
    if ('edge' in op && op.edge.type === 'recognized_export') return [{
      relationId: op.edge.relationId, exportRowId: op.edge.exportRowId, ids: request.proofIds ?? [],
    }]
    if (op.action !== 'decide' || op.status !== 'confirmed') return []
    const row = byId.get(op.correspondenceId)
    return row?.type === 'recognized_export' && row.relationId !== null && row.exportRowId !== null
      ? [{ relationId: row.relationId, exportRowId: row.exportRowId, ids: request.proofIds ?? row.provenance.comparisonProofIds as number[] ?? [] }]
      : []
  })
  const observed = await observePostgresCorrespondences(tx, requestedCorrespondenceSources(request, stored), proofs)
  const lookup = { byId: (id: number) => byId.get(id), byEdge: (key: string) => byEdge.get(key) }
  return { lookup, observed, plan: buildRecordCorrespondencePlan(lookup, request, observed) }
}

function planResponse(plan: Pick<CorrespondencePlan, 'planHash' | 'impact' | 'targets'>, batchId: number, batchStatus: CorrespondencePlan['batchStatus']): CorrespondencePlan {
  return { batchId, batchStatus, planHash: plan.planHash, impact: plan.impact, targets: plan.targets }
}

export function preflightPostgresCorrespondences(db: NodePgDatabase, request: CorrespondenceRequest) {
  return runPostgresCorrespondenceTransaction(db, tx => preflightInTransaction(tx, request))
}

async function preflightInTransaction(tx: Tx, request: CorrespondenceRequest) {
  const batch = await readBatch(tx, request)
  if (batch?.status === 'committed' && batch.plan) return planResponse(batch.plan, batch.id, 'committed')
  const { plan } = await loadPlan(tx, request, false)
  const { rows: [saved] } = await tx.execute<{ id: number }>(sql`
    INSERT INTO import_batch(idempotency_key,source_kind,source_identity,status,preflight_result,created_at)
    VALUES (${request.idempotencyKey},'correspondence_decision',${request.sourceIdentity},'preflight',${JSON.stringify(plan)},${new Date().toISOString()})
    ON CONFLICT (idempotency_key) DO UPDATE SET preflight_result=excluded.preflight_result,error=NULL
    WHERE import_batch.status='preflight' RETURNING id::float8 AS id`)
  if (!saved) return fail('idempotency_conflict', 'Batch changed during preflight')
  return planResponse(plan, saved.id, 'preflight')
}

const decisionColumns = getTableColumns(schema.recordCorrespondence)
const auditColumns = getTableColumns(schema.recordCorrespondenceAudit)
function sqlValues<T extends Record<string, unknown>>(columns: Record<keyof T, { name: string; dataType: string }>, changes: T) {
  return Object.entries(changes).map(([key, value]) => {
    const column = columns[key as keyof T]!
    return { name: sql.identifier(column.name), value: column.dataType === 'json' ? JSON.stringify(value) : value }
  })
}

export function commitPostgresCorrespondences(db: NodePgDatabase, request: CorrespondenceRequest, planHash: string) {
  return runPostgresCorrespondenceTransaction(db, tx => commitInTransaction(tx, request, planHash))
}

export async function commitPostgresCorrespondenceDecision(tx: Tx, request: CorrespondenceRequest) {
  const { planHash } = await preflightInTransaction(tx, request)
  return commitInTransaction(tx, request, planHash)
}

async function commitInTransaction(tx: Tx, request: CorrespondenceRequest, planHash: string) {
  const batch = await readBatch(tx, request)
  if (!batch?.plan || batch.plan.planHash !== planHash) return fail('plan_mismatch', 'Matching bound preflight required')
  if (batch.status === 'committed') return batch.receipt!
  const { plan, observed, lookup } = await loadPlan(tx, request, true)
  if (plan.planHash !== planHash) return fail('plan_mismatch', 'Bound targets or source evidence changed')
  const at = new Date().toISOString(), correspondenceIds: number[] = []
  for (const mutation of recordCorrespondenceMutations(lookup, request, observed, batch.id, at)) {
    const fields = sqlValues(decisionColumns, mutation.changes)
    let id: number
    if (mutation.type === 'insert') {
      const { rows: [created] } = await tx.execute<{ id: number }>(sql`
        INSERT INTO record_correspondence(${sql.join(fields.map(field => field.name), sql`,`)})
        VALUES(${sql.join(fields.map(field => sql`${field.value}`), sql`,`)}) RETURNING id::float8 AS id`)
      id = created!.id
    } else {
      id = mutation.row.id
      const result = await tx.execute(sql`
        UPDATE record_correspondence SET ${sql.join(fields.map(field => sql`${field.name}=${field.value}`), sql`,`)}
        WHERE id=${id} AND revision=${mutation.row.revision} ${mutation.candidateOnly ? sql`AND status='candidate'` : sql.empty()}`)
      if (result.rowCount !== 1) return fail('stale_revision', 'Correspondence revision changed')
    }
    for (const audit of mutation.audits) {
      const fields = sqlValues(auditColumns, { ...audit, correspondenceId: id })
      await tx.execute(sql`
        INSERT INTO record_correspondence_audit(${sql.join(fields.map(field => field.name), sql`,`)})
        VALUES(${sql.join(fields.map(field => sql`${field.value}`), sql`,`)})`)
    }
    correspondenceIds.push(id)
  }
  const receipt: CorrespondenceReceipt = { batchId: batch.id, planHash, impact: plan.impact, correspondenceIds }
  await tx.execute(sql`
    UPDATE import_batch SET status='committed',summary=${JSON.stringify(receipt)},item_results=${JSON.stringify(correspondenceIds)},
      committed_at=${at},error=NULL WHERE id=${batch.id}`)
  return receipt
}
