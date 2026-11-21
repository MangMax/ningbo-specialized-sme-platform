import { bigint, text } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'

export const evidenceImpactLink113 = businessSchema.table('evidence_impact_link_113', {
  revisionId: bigint('revision_id', { mode: 'number' }).notNull(),
  impactId: bigint('impact_id', { mode: 'number' }).notNull(),
  classification: text('classification').notNull(),
})

export const evidenceImpactProgress113 = businessSchema.table('evidence_impact_progress_113', {
  revisionId: bigint('revision_id', { mode: 'number' }).primaryKey(),
  cursor: bigint('cursor', { mode: 'number' }).notNull().default(0),
  done: bigint('done', { mode: 'number' }).notNull().default(0),
})

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

export const evidenceRevision113 = businessSchema.table('evidence_revision_113', {
  id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  sourceKind: text('source_kind').notNull(),
  sourceKey: text('source_key').notNull(),
  sourceVersion: text('source_version').notNull(),
  enterpriseId: bigint('enterprise_id', { mode: 'number' }),
  titleCode: text('title_code'),
  direction: text('direction'),
  eventId: bigint('event_id', { mode: 'number' }),
  coverageDigest: text('coverage_digest').notNull(),
  factDigest: text('fact_digest').notNull(),
  coverageChanged: bigint('coverage_changed', { mode: 'number' }).notNull(),
  factChanged: bigint('fact_changed', { mode: 'number' }).notNull(),
  queryExecuted: bigint('query_executed', { mode: 'number' }).notNull().default(0),
  metadata: text('metadata').notNull(),
  maxDecisionId: bigint('max_decision_id', { mode: 'number' }).notNull(),
  createdAt: text('created_at').notNull(),
})

export const evidenceRevisionEvent113 = businessSchema.table('evidence_revision_event_113', {
  revisionId: bigint('revision_id', { mode: 'number' }).notNull(),
  eventId: bigint('event_id', { mode: 'number' }).notNull(),
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).notNull(),
  titleCode: text('title_code').notNull(),
})

export const evidenceRuleRelease114 = businessSchema.table('evidence_rule_release_114', {
  id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  ruleId: text('rule_id').notNull(),
  version: text('version').notNull(),
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).notNull(),
  titleCode: text('title_code').notNull(),
  direction: text('direction').notNull(),
  previousDigest: text('previous_digest').notNull(),
  evaluationDigest: text('evaluation_digest').notNull(),
  revisionId: bigint('revision_id', { mode: 'number' }),
  receiptKey: text('receipt_key').notNull(),
})

export const evidenceScopeVersion113 = businessSchema.table('evidence_scope_version_113', {
  scopeKey: text('scope_key').primaryKey(),
  latestRevisionId: bigint('latest_revision_id', { mode: 'number' }).notNull(),
  pendingCount: bigint('pending_count', { mode: 'number' }).notNull(),
})

export const evidenceSemanticHead113 = businessSchema.table('evidence_semantic_head_113', {
  sourceKey: text('source_key').primaryKey(),
  coverageDigest: text('coverage_digest').notNull(),
  factDigest: text('fact_digest').notNull(),
  latestRevisionId: bigint('latest_revision_id', { mode: 'number' }).notNull(),
})

export const explanationImpact113 = businessSchema.table('explanation_impact_113', {
  id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).notNull(),
  titleCode: text('title_code').notNull(),
  direction: text('direction').notNull(),
  decisionId: bigint('decision_id', { mode: 'number' }).notNull(),
  latestRevisionId: bigint('latest_revision_id', { mode: 'number' }).notNull(),
  pendingSinceRevisionId: bigint('pending_since_revision_id', { mode: 'number' }).notNull(),
  reviewedRevisionId: bigint('reviewed_revision_id', { mode: 'number' }),
  classification: text('classification').notNull(),
})
