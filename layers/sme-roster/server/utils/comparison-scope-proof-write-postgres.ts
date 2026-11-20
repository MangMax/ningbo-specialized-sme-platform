import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { comparisonProofPlanSteps, ProofError, proofRequest, type ComparisonProofPlan, type ProofRequest, type ProofStatus } from './comparison-scope-proof'
import { fingerprint, ProofSourceError, type CurrentEvidence, type OfficialEvidence } from './comparison-scope-proof-source'
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
  const { rows: [batch] } = await tx.execute<Batch>(sql`
    SELECT id::float8 AS id, source_kind AS kind, source_identity AS identity, status,
      preflight_result::json AS plan, summary::json AS receipt
    FROM import_batch WHERE idempotency_key=${request.idempotencyKey} FOR UPDATE`)
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
    const { rows: [saved] } = await tx.execute<{ id: number }>(sql`
      INSERT INTO import_batch(idempotency_key,source_kind,source_identity,status,preflight_result,created_at)
      VALUES (${request.idempotencyKey},'comparison_scope_proof',${request.sourceIdentity},'preflight',
        ${JSON.stringify(next)},${new Date().toISOString()})
      ON CONFLICT (idempotency_key) DO UPDATE SET preflight_result=excluded.preflight_result, error=NULL
      WHERE import_batch.status='preflight'
      RETURNING id::float8 AS id`)
    return { batchId: saved?.id ?? batch!.id, batchStatus: 'preflight' as const, ...next }
  })
}

async function writeAudit(tx: Tx, request: ProofRequest, batch: Batch, proofId: number, fromStatus: ProofStatus | null, toStatus: ProofStatus, expectedRevision: number, at: string) {
  await tx.execute(sql`
    INSERT INTO comparison_scope_proof_audit(proof_id,batch_id,idempotency_key,from_status,to_status,
      expected_revision,resulting_revision,actor_type,actor_id,basis,rule_id,rule_version,decided_at)
    VALUES (${proofId},${batch.id},${request.idempotencyKey},${fromStatus},${toStatus},
      ${expectedRevision},${expectedRevision + 1},${request.actor.type},${request.actor.id},${request.basis},
      ${request.ruleId},${request.ruleVersion},${at})`)
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
    if (ids.length) await tx.execute(sql`
      SELECT id FROM comparison_scope_proof WHERE id=ANY(${sql.param(ids)}::bigint[]) ORDER BY id FOR UPDATE`)
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
        const { rows: [row] } = await tx.execute<{ id: number }>(sql`
          INSERT INTO comparison_scope_proof(kind,evidence,source_fingerprint,created_at)
          VALUES (${op.kind},${JSON.stringify(op.evidence)},${target.sourceFingerprint},${at})
          RETURNING id::float8 AS id`)
        await writeAudit(tx, request, batch, row!.id, null, 'candidate', 0, at)
        if (op.status === 'confirmed') await writeAudit(tx, request, batch, row!.id, 'candidate', 'confirmed', 1, at)
        proofIds.push(row!.id)
      }
    }
    const receipt = { batchId: batch.id, planHash, impact: next.impact, proofIds }
    await tx.execute(sql`
      UPDATE import_batch SET status='committed', summary=${JSON.stringify(receipt)},
        item_results=${JSON.stringify(proofIds)}, committed_at=${at}, error=NULL WHERE id=${batch.id}`)
    return receipt
  })
}
