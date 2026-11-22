import { bigint, text } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'

export const recordCorrespondence = businessSchema.table('record_correspondence', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  edgeKey: text('edge_key').notNull(),
  type: text('type', { enum: ['event_process', 'event_recognized', 'later_process', 'event_export_context', 'process_export_context', 'recognized_export'] }).notNull(),
  role: text('role').notNull(),
  eventId: bigint('event_id', { mode: 'number' }),
  predecessorEventId: bigint('predecessor_event_id', { mode: 'number' }),
  observationId: bigint('observation_id', { mode: 'number' }),
  platformEvidenceReboundRevision: bigint('platform_evidence_rebound_revision', { mode: 'number' }),
  exportRowId: bigint('export_row_id', { mode: 'number' }),
  enterpriseId: bigint('enterprise_id', { mode: 'number' }),
  titleCode: text('title_code').notNull(),
  status: text('status', { enum: ['candidate', 'confirmed', 'rejected', 'unlinked'] }).notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull(),
  targetIdentity: text('target_identity').notNull(),
  provenance: text('provenance'),
  sourceFingerprint: text('source_fingerprint').notNull(),
  ruleId: text('rule_id').notNull(),
  ruleVersion: text('rule_version').notNull(),
  createdAt: text('created_at').notNull(),
  decidedAt: text('decided_at'),
  endedAt: text('ended_at'),
})

export const recordCorrespondenceAudit = businessSchema.table('record_correspondence_audit', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  correspondenceId: bigint('correspondence_id', { mode: 'number' }).notNull(),
  batchId: bigint('batch_id', { mode: 'number' }).notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  expectedRevision: bigint('expected_revision', { mode: 'number' }).notNull(),
  resultingRevision: bigint('resulting_revision', { mode: 'number' }).notNull(),
  actorType: text('actor_type', { enum: ['user', 'agent'] }).notNull(),
  actorId: text('actor_id').notNull(),
  basis: text('basis').notNull(),
  ruleId: text('rule_id').notNull(),
  ruleVersion: text('rule_version').notNull(),
  evidence: text('evidence').notNull(),
  decidedAt: text('decided_at').notNull(),
})

export const titleCycleDispositionRevision = businessSchema.table('title_cycle_disposition_revision', {
  revisionId: bigint('revision_id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  id: text('id').notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull(),
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).notNull(),
  titleCode: text('title_code').notNull(),
  cycleEventId: bigint('cycle_event_id', { mode: 'number' }),
  status: text('status').notNull(),
  kind: text('kind').notNull(),
  sourceFileId: bigint('source_file_id', { mode: 'number' }).notNull(),
  sourceSha256: text('source_sha256').notNull(),
  cycleRevision: bigint('cycle_revision', { mode: 'number' }),
  effectivePrecision: text('effective_precision').notNull(),
  effectiveValue: text('effective_value'),
  fact: text('fact').notNull(),
  audit: text('audit').notNull(),
})

export const enterpriseFactRevision = businessSchema.table('enterprise_fact_revision', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).notNull(),
  factId: bigint('fact_id', { mode: 'number' }).notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull(),
  status: text('status').notNull(),
  fact: text('fact').notNull(),
  replaces: bigint('replaces', { mode: 'number' }),
  action: text('action').notNull(),
  actor: text('actor').notNull(),
  basis: text('basis').notNull(),
  createdAt: text('created_at').notNull(),
})


export const enterpriseFactReceipt = businessSchema.table('enterprise_fact_receipt', {
  idempotencyKey: text('idempotency_key').primaryKey(),
  requestHash: text('request_hash').notNull(),
  receipt: text('receipt').notNull(),
})

export const titleCycleDispositionReceipt = businessSchema.table('title_cycle_disposition_receipt', {
  key: text('key').primaryKey(),
  requestHash: text('request_hash').notNull(),
  receipt: text('receipt').notNull(),
})
