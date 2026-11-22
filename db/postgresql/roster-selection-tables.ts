import { bigint, boolean, text } from 'drizzle-orm/pg-core'
import { differenceMeasures, differenceReasons, differenceStatuses } from '../difference-codes'
import { businessSchema } from './business-schema'

export const rosterLegacyMember = businessSchema.table('roster_legacy_member', {
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).primaryKey(),
})

export const rosterAnnouncementMember = businessSchema.table('roster_announcement_member', {
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).notNull(),
  intakeId: bigint('intake_id', { mode: 'number' }).notNull(),
})

export const rosterAnnouncementIntake = businessSchema.table('roster_announcement_intake', {
  idempotencyKey: text('idempotency_key').notNull(),
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  digest: text('digest').notNull(),
  request: text('request').notNull(),
  removedReason: text('removed_reason'),
  supplementDigest: text('supplement_digest'),
  reviewedRequest: text('reviewed_request'),
  receipt: text('receipt'),
})

export const differenceReason = businessSchema.table('difference_reason', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).notNull(),
  titleCode: text('title_code').notNull(),
  direction: text('direction', { enum: ['missing_in_miit', 'extra_in_miit'] }).notNull(),
  status: text('status', { enum: differenceStatuses }).notNull().default('not_queried'),
  reasonCode: text('reason_code', { enum: differenceReasons }),
  reasonNote: text('reason_note'),
  measureCode: text('measure_code', { enum: differenceMeasures }),
  measureNote: text('measure_note'),
  evidenceQueryId: bigint('evidence_query_id', { mode: 'number' }),
  evidenceRelationId: bigint('evidence_relation_id', { mode: 'number' }),
  originalEvidenceRelationPublicId: bigint('original_evidence_relation_public_id', { mode: 'number' }),
  originalEvidenceQueryPublicId: bigint('original_evidence_query_public_id', { mode: 'number' }),
  movedInCity: text('moved_in_city'),
  movedInTitleCode: text('moved_in_title_code'),
  movedInYear: bigint('moved_in_year', { mode: 'number' }),
  movedInBatch: bigint('moved_in_batch', { mode: 'number' }),
  verificationStatus: text('verification_status', { enum: ['confirmed', 'pending'] }).notNull().default('pending'),
  recordedAt: text('recorded_at').notNull(),
  createdAt: text('created_at').notNull(),
  lifecycleAction: text('lifecycle_action', { enum: ['replace', 'withdraw'] }),
  previousId: bigint('previous_id', { mode: 'number' }),
  actor: text('actor'),
  basis: text('basis'),
  ruleVersion: text('rule_version'),
  effectiveAt: text('effective_at'),
  idempotencyKey: text('idempotency_key'),
  requestHash: text('request_hash'),
  currentQualification: text('current_qualification'),
  factReferences: text('fact_references'),
  retiredEvidenceValidity: text('retired_evidence_validity', { enum: ['valid', 'evidence_changed', 'premise_invalid'] }),
  retiredEvidenceReviewed: boolean('retired_evidence_reviewed'),
})

export const enterpriseDifferenceComparison = businessSchema.table('enterprise_difference_comparison', {
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).notNull(),
  titleCode: text('title_code').notNull(),
  comparisonState: text('comparison_state').notNull(),
  reasons: text('reasons').notNull(),
  comparisonError: text('comparison_error'),
  businessFingerprint: text('business_fingerprint').notNull(),
  stateFingerprint: text('state_fingerprint'),
  changedAt: text('changed_at').notNull(),
  refreshedAt: text('refreshed_at').notNull(),
  decisionCutoffId: bigint('decision_cutoff_id', { mode: 'number' }).notNull(),
})
