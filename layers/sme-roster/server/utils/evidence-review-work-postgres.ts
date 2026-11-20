import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { z } from 'zod'
import { DecisionError102 } from './decision-lifecycle-102'
import type { workCommand114, ruleCommand114 } from './evidence-review-114'
import { evidenceDigest113 } from './evidence-impact-113'
import { appendPostgresEvidenceRevision } from './evidence-revision-postgres'
import { processPostgresEvidenceImpacts } from './evidence-impact-postgres'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Rule = z.infer<typeof ruleCommand114>

async function releaseRules(tx: Tx, command: Rule) {
  const revisions: Array<number | null> = []
  for (const { previousEvaluationDigest, evaluationDigest, ...scope } of command.scopes) {
    const enterprise = await tx.execute(sql`SELECT id FROM enterprise WHERE id=${scope.enterpriseId}`)
    if (!enterprise.rows.length) throw new DecisionError102(404, 'not_found', 'Rule scope enterprise not found')
    const { rows: [prior] } = await tx.execute<{ previous: string; digest: string; revisionId: number | null }>(sql`
      SELECT previous_digest AS previous,evaluation_digest AS digest,revision_id::float8 AS "revisionId"
      FROM evidence_rule_release_114 WHERE rule_id=${command.ruleId} AND version=${command.version} AND enterprise_id=${scope.enterpriseId}
        AND title_code=${scope.titleCode} AND direction=${scope.direction}`)
    if (prior) {
      if (prior.previous !== previousEvaluationDigest || prior.digest !== evaluationDigest) {
        throw new DecisionError102(409, 'rule_version_conflict', 'Rule version already identifies different evaluated material')
      }
      revisions.push(prior.revisionId)
      continue
    }
    const revisionId = previousEvaluationDigest === evaluationDigest ? null : await appendPostgresEvidenceRevision(tx, {
      ...scope, sourceKind: 'rule_release', sourceVersion: command.version, beforeFactDigest: previousEvaluationDigest, factDigest: evaluationDigest,
      sourceKey: [command.ruleId, scope.enterpriseId, scope.titleCode, scope.direction].join(':'),
      metadata: { ruleId: command.ruleId, ruleVersion: command.version },
    })
    await tx.execute(sql`INSERT INTO evidence_rule_release_114(rule_id,version,enterprise_id,title_code,direction,
      previous_digest,evaluation_digest,revision_id,receipt_key)
      VALUES(${command.ruleId},${command.version},${scope.enterpriseId},${scope.titleCode},${scope.direction},
        ${previousEvaluationDigest},${evaluationDigest},${revisionId},${command.idempotencyKey})`)
    revisions.push(revisionId)
  }
  return { revisionIds: revisions, unchanged: revisions.filter(revision => revision === null).length }
}

export function workPostgresEvidenceReview(db: NodePgDatabase, command: z.infer<typeof workCommand114>) {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(42458,114)`)
    const hash = evidenceDigest113(command)
    const { rows: [prior] } = await tx.execute<{ hash: string; response: Record<string, unknown> }>(sql`
      SELECT request_hash AS hash,response::json AS response FROM evidence_review_receipt_114 WHERE idempotency_key=${command.idempotencyKey}`)
    if (prior) {
      if (prior.hash !== hash) throw new DecisionError102(409, 'idempotency_conflict', 'Idempotency key has a different request')
      return prior.response
    }
    const existingDecision = await tx.execute(sql`SELECT 1 FROM difference_reason WHERE idempotency_key=${command.idempotencyKey}`)
    if (existingDecision.rows.length) throw new DecisionError102(409, 'idempotency_conflict', 'Idempotency key belongs to a decision')
    const result = command.action === 'process' ? await processPostgresEvidenceImpacts(tx, command.limit) : await releaseRules(tx, command)
    const recordedAt = new Date().toISOString()
    const response = { ...result, action: command.action, idempotencyKey: command.idempotencyKey, recordedAt }
    await tx.execute(sql`
      INSERT INTO evidence_review_receipt_114(idempotency_key,request_hash,kind,actor,basis,response,recorded_at)
      VALUES(${command.idempotencyKey},${hash},${command.action},${JSON.stringify(command.actor)},${command.basis},${JSON.stringify(response)},${recordedAt})`)
    return response
  })
}
