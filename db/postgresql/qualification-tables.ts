import { bigint, text } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'

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
