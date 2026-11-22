import { bigint, text } from 'drizzle-orm/pg-core'
import { businessSchema } from '../../../../db/postgresql/business-schema'

export const evidenceReviewReceipt114 = businessSchema.table('evidence_review_receipt_114', {
  id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  requestHash: text('request_hash').notNull(),
  kind: text('kind').notNull(),
  enterpriseId: bigint('enterprise_id', { mode: 'number' }),
  titleCode: text('title_code'),
  direction: text('direction'),
  decisionId: bigint('decision_id', { mode: 'number' }),
  sourceDecisionId: bigint('source_decision_id', { mode: 'number' }),
  reviewedRevisionId: bigint('reviewed_revision_id', { mode: 'number' }),
  actor: text('actor').notNull(),
  basis: text('basis').notNull(),
  ruleVersion: text('rule_version'),
  effectiveAt: text('effective_at'),
  response: text('response').notNull(),
  recordedAt: text('recorded_at').notNull(),
})
