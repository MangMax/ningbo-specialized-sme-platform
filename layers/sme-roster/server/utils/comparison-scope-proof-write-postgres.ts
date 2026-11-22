import { eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { comparisonScopeProof, comparisonScopeProofAudit } from '../../../../db/postgresql/comparison-proof-tables'
import { importBatch } from '../../../../db/postgresql/import-tables'
import { comparisonProofPlanSteps, ProofError, proofRequest, type ComparisonProofPlan, type ProofRequest, type ProofStatus } from './comparison-scope-proof-model'
import { type CurrentEvidence, type OfficialEvidence } from './comparison-scope-proof-source-projection'
import { fingerprint, ProofSourceError } from './comparison-scope-proof-source-model'
import {
  readPostgresComparisonProofHead, readPostgresCurrentProofSource, readPostgresOfficialProofSource,
} from './comparison-scope-proof-postgres'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Plan = ComparisonProofPlan
type Receipt = { batchId: number; planHash: string; impact: Plan['impact']; proofIds: number[] }
type Batch = {
  id: number; kind: string; identity: string; status: string; plan: Plan | null; receipt: Receipt | null
}

async function plan(tx: Tx, request: ProofRequest) {
  const steps = comparisonProofPlanSteps(request)
  let step = steps.next()
  while (!step.done) {
    const read = step.value
    if (read.type === 'head') {
      step = steps.next(await readPostgresComparisonProofHead(tx, read.proofId))
    } else {
      let sourceFingerprint: string | null
      try {
        sourceFingerprint = (read.kind === 'official_coverage'
          ? await readPostgresOfficialProofSource(tx, read.evidence as OfficialEvidence)
          : await readPostgresCurrentProofSource(tx, read.evidence as CurrentEvidence)).sourceFingerprint
      } catch (error) {
        if (!(error instanceof ProofSourceError) || !read.canBeMissing) throw error
        sourceFingerprint = null
      }
      step = steps.next(sourceFingerprint)
    }
  }
  return step.value
}

async function readBatch(tx: Tx, request: ProofRequest) {
  const [batch] = await tx.select({
    id: importBatch.id, kind: importBatch.sourceKind, identity: importBatch.sourceIdentity, status: importBatch.status,
    plan: sql<Batch['plan']>`${importBatch.preflightResult}::json`, receipt: sql<Batch['receipt']>`${importBatch.summary}::json`,
  }).from(importBatch).where(eq(importBatch.idempotencyKey, request.idempotencyKey)).for('update')
  if (batch && (batch.kind !== 'comparison_scope_proof' || batch.identity !== request.sourceIdentity)) {
    throw new ProofError('idempotency_conflict', 'Idempotency key belongs to another source')
  }
  return batch
}

async function inProofTransaction<T>(db: NodePgDatabase, run: (tx: Tx) => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try { return await db.transaction(run, { isolationLevel: 'serializable' }) }
    catch (error) {
      const reported = error as { code?: string; cause?: { code?: string } }
      if ((reported.code ?? reported.cause?.code) !== '40001') throw error
      if (attempt === 2) throw new ProofError('plan_mismatch', 'Concurrent source change; preflight again')
    }
  }
}

export function preflightPostgresComparisonProof(db: NodePgDatabase, raw: ProofRequest) {
  const request = proofRequest.parse(raw)
  return inProofTransaction(db, async tx => {
    const batch = await readBatch(tx, request)
    const prior = batch?.plan
    if (prior && prior.requestHash !== fingerprint(request)) throw new ProofError('idempotency_conflict', 'Idempotency key belongs to a different request')
    if (batch?.status === 'committed' && prior) return { batchId: batch.id, batchStatus: 'committed' as const, ...prior }
    const next = await plan(tx, request)
    const [saved] = await tx.insert(importBatch).values({
      idempotencyKey: request.idempotencyKey, sourceKind: 'comparison_scope_proof', sourceIdentity: request.sourceIdentity,
      status: 'preflight', preflightResult: JSON.stringify(next), createdAt: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: importBatch.idempotencyKey, set: { preflightResult: sql`excluded.preflight_result`, error: null },
      setWhere: eq(importBatch.status, 'preflight'),
    }).returning({ id: importBatch.id })
    return { batchId: saved?.id ?? batch!.id, batchStatus: 'preflight' as const, ...next }
  })
}

async function writeAudit(tx: Tx, request: ProofRequest, batch: Batch, proofId: number, fromStatus: ProofStatus | null, toStatus: ProofStatus, expectedRevision: number, at: string) {
  await tx.insert(comparisonScopeProofAudit).values({
    proofId, batchId: batch.id, idempotencyKey: request.idempotencyKey, fromStatus, toStatus, expectedRevision,
    resultingRevision: expectedRevision + 1, actorType: request.actor.type, actorId: request.actor.id,
    basis: request.basis, ruleId: request.ruleId, ruleVersion: request.ruleVersion, decidedAt: at,
  })
}

export function commitPostgresComparisonProof(db: NodePgDatabase, raw: ProofRequest, planHash: string) {
  const request = proofRequest.parse(raw)
  return inProofTransaction(db, async tx => {
    const batch = await readBatch(tx, request)
    if (!batch) throw new ProofError('plan_mismatch', 'Preflight batch not found')
    if (!batch.plan || batch.plan.requestHash !== fingerprint(request)) throw new ProofError('idempotency_conflict', 'Request differs from preflight')
    if (batch.plan.planHash !== planHash) throw new ProofError('plan_mismatch', 'Submitted plan hash differs')
    if (batch.status === 'committed') return batch.receipt!
    const ids = request.operations.flatMap(op => op.action === 'decide' ? [op.proofId] : [])
    const proof = comparisonScopeProof
    if (ids.length) await tx.select({ id: proof.id }).from(proof).where(inArray(proof.id, ids)).orderBy(proof.id).for('update')
    const next = await plan(tx, request)
    if (next.planHash !== planHash) throw new ProofError('plan_mismatch', 'Archived sources or proof revisions changed')
    const at = new Date().toISOString()
    const proofIds: number[] = []
    for (const [index, op] of request.operations.entries()) {
      const target = next.targets[index]!
      if ('proofId' in target) {
        await writeAudit(tx, request, batch, target.proofId, target.fromStatus, target.status, target.revision, at)
        proofIds.push(target.proofId)
      } else {
        if (op.action !== 'create') throw new Error('Invalid comparison proof plan target')
        const [row] = await tx.insert(proof).values({
          kind: op.kind, evidence: JSON.stringify(op.evidence), sourceFingerprint: target.sourceFingerprint, createdAt: at,
        }).returning({ id: proof.id })
        await writeAudit(tx, request, batch, row!.id, null, 'candidate', 0, at)
        if (op.status === 'confirmed') await writeAudit(tx, request, batch, row!.id, 'candidate', 'confirmed', 1, at)
        proofIds.push(row!.id)
      }
    }
    const receipt = { batchId: batch.id, planHash, impact: next.impact, proofIds }
    await tx.update(importBatch).set({
      status: 'committed', summary: JSON.stringify(receipt), itemResults: JSON.stringify(proofIds), committedAt: at, error: null,
    }).where(eq(importBatch.id, batch.id))
    return receipt
  })
}
