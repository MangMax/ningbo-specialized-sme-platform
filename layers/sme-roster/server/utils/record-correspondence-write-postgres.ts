import { and, eq, getTableColumns, inArray, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import { importBatch } from '../../../../db/postgresql/import-tables'
import { platformLegacyRelationAlias } from '../../../../db/postgresql/platform-tables'
import { recordCorrespondence, recordCorrespondenceAudit } from '../../../../db/postgresql/qualification-tables'
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
  const [batch] = await tx.select({
    id: importBatch.id, status: importBatch.status, kind: importBatch.sourceKind, identity: importBatch.sourceIdentity,
    plan: sql<Batch['plan']>`${importBatch.preflightResult}::json`,
    receipt: sql<Batch['receipt']>`${importBatch.summary}::json`,
  }).from(importBatch).where(eq(importBatch.idempotencyKey, request.idempotencyKey)).for('update')
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
  const edge = alias(recordCorrespondence, 'edge'), relation = platformLegacyRelationAlias
  const { provenance, targetIdentity, observationId: _observationId, ...columns } = getTableColumns(edge)
  const query = tx.select({
    ...columns, relationId: relation.oldId,
    targetIdentity: sql<StoredCorrespondence['targetIdentity']>`${targetIdentity}::json`,
    provenance: sql<StoredCorrespondence['provenance']>`${provenance}::json`,
  }).from(edge).leftJoin(relation, eq(relation.observationId, edge.observationId))
    .where(or(inArray(edge.id, ids), inArray(edge.edgeKey, keys))).orderBy(edge.id)
  const stored = await (lock ? query.for('update', { of: edge }) : query)
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
  const [saved] = await tx.insert(importBatch).values({
    idempotencyKey: request.idempotencyKey, sourceKind: 'correspondence_decision', sourceIdentity: request.sourceIdentity,
    status: 'preflight', preflightResult: JSON.stringify(plan), createdAt: new Date().toISOString(),
  }).onConflictDoUpdate({
    target: importBatch.idempotencyKey,
    set: { preflightResult: sql`excluded.preflight_result`, error: null },
    setWhere: eq(importBatch.status, 'preflight'),
  }).returning({ id: importBatch.id })
  if (!saved) return fail('idempotency_conflict', 'Batch changed during preflight')
  return planResponse(plan, saved.id, 'preflight')
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
    const edge = recordCorrespondence
    let id: number
    if (mutation.type === 'insert') {
      const { targetIdentity, provenance, ...changes } = mutation.changes
      const [created] = await tx.insert(edge).values({
        ...changes, targetIdentity: JSON.stringify(targetIdentity), provenance: JSON.stringify(provenance),
      }).returning({ id: edge.id })
      id = created!.id
    } else {
      id = mutation.row.id
      const { targetIdentity, provenance, ...changes } = mutation.changes
      const result = await tx.update(edge).set({
        ...changes,
        targetIdentity: targetIdentity === undefined ? undefined : JSON.stringify(targetIdentity),
        provenance: provenance === undefined ? undefined : JSON.stringify(provenance),
      }).where(and(
        eq(edge.id, id), eq(edge.revision, mutation.row.revision),
        mutation.candidateOnly ? eq(edge.status, 'candidate') : undefined,
      ))
      if (result.rowCount !== 1) return fail('stale_revision', 'Correspondence revision changed')
    }
    for (const { evidence, ...audit } of mutation.audits) {
      await tx.insert(recordCorrespondenceAudit).values({ ...audit, evidence: JSON.stringify(evidence), correspondenceId: id })
    }
    correspondenceIds.push(id)
  }
  const receipt: CorrespondenceReceipt = { batchId: batch.id, planHash, impact: plan.impact, correspondenceIds }
  await tx.update(importBatch).set({
    status: 'committed', summary: JSON.stringify(receipt), itemResults: JSON.stringify(correspondenceIds),
    committedAt: at, error: null,
  }).where(eq(importBatch.id, batch.id))
  return receipt
}
