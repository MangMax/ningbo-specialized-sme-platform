import { bigint, text } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'

export const record = businessSchema.table('record', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).notNull(),
  titleCode: text('title_code').notNull(),
  source: text('source').notNull(),
  district: text('district'),
  usccRaw: text('uscc_raw'),
  nameRaw: text('name_raw'),
  qualityFlags: text('quality_flags').default('[]'),
})

export const recordEvent = businessSchema.table('record_event', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  recordId: bigint('record_id', { mode: 'number' }).notNull(),
  eventType: text('event_type').notNull(),
  year: bigint('year', { mode: 'number' }),
  batchSeq: bigint('batch_seq', { mode: 'number' }),
  sortKey: bigint('sort_key', { mode: 'number' }).default(0).notNull(),
  reviewOutcome: text('review_outcome'),
  decidedYear: bigint('decided_year', { mode: 'number' }),
  revision: bigint('revision', { mode: 'number' }).default(1).notNull(),
  formalValidity: text('formal_validity'),
})

export const recordEvidence = businessSchema.table('record_evidence', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  recordEventId: bigint('record_event_id', { mode: 'number' }).notNull(),
  sourceFile: text('source_file').notNull(),
  attachment: text('attachment'),
  listNo: bigint('list_no', { mode: 'number' }),
  page: bigint('page', { mode: 'number' }),
})
