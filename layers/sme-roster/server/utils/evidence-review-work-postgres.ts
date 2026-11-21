import { and, eq, sql } from 'drizzle-orm'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { evidenceReviewReceipt114, evidenceRuleRelease114 } from '../../../../db/postgresql/evidence-review-tables'
import { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
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
    const [owner] = await tx.select({ id: enterprise.id }).from(enterprise).where(eq(enterprise.id, scope.enterpriseId))
    if (!owner) throw new DecisionError102(404, 'not_found', 'Rule scope enterprise not found')
    const [prior] = await tx.select({
      previous: evidenceRuleRelease114.previousDigest, digest: evidenceRuleRelease114.evaluationDigest,
      revisionId: evidenceRuleRelease114.revisionId,
    }).from(evidenceRuleRelease114).where(and(
      eq(evidenceRuleRelease114.ruleId, command.ruleId), eq(evidenceRuleRelease114.version, command.version),
      eq(evidenceRuleRelease114.enterpriseId, scope.enterpriseId), eq(evidenceRuleRelease114.titleCode, scope.titleCode),
      eq(evidenceRuleRelease114.direction, scope.direction),
    ))
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
    await tx.insert(evidenceRuleRelease114).values({
      ...scope, ruleId: command.ruleId, version: command.version, previousDigest: previousEvaluationDigest,
      evaluationDigest, revisionId, receiptKey: command.idempotencyKey,
    })
    revisions.push(revisionId)
  }
  return { revisionIds: revisions, unchanged: revisions.filter(revision => revision === null).length }
}

export function workPostgresEvidenceReview(db: NodePgDatabase, command: z.infer<typeof workCommand114>) {
  return db.transaction(async tx => {
    // Drizzle has no PostgreSQL advisory-lock builder. Keep the transaction-scoped lock.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(42458,114)`)
    const hash = evidenceDigest113(command)
    const [prior] = await tx.select({ hash: evidenceReviewReceipt114.requestHash, response: evidenceReviewReceipt114.response })
      .from(evidenceReviewReceipt114).where(eq(evidenceReviewReceipt114.idempotencyKey, command.idempotencyKey))
    if (prior) {
      if (prior.hash !== hash) throw new DecisionError102(409, 'idempotency_conflict', 'Idempotency key has a different request')
      return JSON.parse(prior.response) as Record<string, unknown>
    }
    const [existingDecision] = await tx.select({ id: differenceReason.id }).from(differenceReason)
      .where(eq(differenceReason.idempotencyKey, command.idempotencyKey))
    if (existingDecision) throw new DecisionError102(409, 'idempotency_conflict', 'Idempotency key belongs to a decision')
    const result = command.action === 'process' ? await processPostgresEvidenceImpacts(tx, command.limit) : await releaseRules(tx, command)
    const recordedAt = new Date().toISOString()
    const response = { ...result, action: command.action, idempotencyKey: command.idempotencyKey, recordedAt }
    await tx.insert(evidenceReviewReceipt114).values({
      idempotencyKey: command.idempotencyKey, requestHash: hash, kind: command.action, actor: JSON.stringify(command.actor),
      basis: command.basis, response: JSON.stringify(response), recordedAt,
    })
    return response
  })
}
