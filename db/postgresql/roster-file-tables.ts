import { bigint, text } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'

export const rosterFileClassification = businessSchema.table('roster_file_classification', {
  fileId: bigint('file_id', { mode: 'number' }).primaryKey(),
  source: text('source', { enum: ['jxj', 'miit'] }),
  kind: text('kind', { enum: ['announcement', 'export'] }),
  year: bigint('year', { mode: 'number' }),
  batch: bigint('batch', { mode: 'number' }),
  titleCode: text('title_code'),
  categoryState: text('category_state', { enum: ['set', 'inferred', 'unset'] }).notNull().default('unset'),
  parseState: text('parse_state', { enum: ['unparsed', 'parsed', 'failed'] }).notNull().default('unparsed'),
})

export const storedFilePart = businessSchema.table('stored_file_part', {
  id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  fileId: bigint('file_id', { mode: 'number' }).notNull(),
  titleCode: text('title_code').notNull(),
  eventKind: text('event_kind', { enum: ['award', 'review', 'maintain', 'nurture'] }).notNull(),
  year: bigint('year', { mode: 'number' }),
  batch: bigint('batch', { mode: 'number' }),
  attachment: text('attachment'),
  rowCount: bigint('row_count', { mode: 'number' }).notNull().default(0),
  origin: text('origin', { enum: ['derived', 'agent', 'legacy'] }).notNull().default('derived'),
  hasConflict: bigint('has_conflict', { mode: 'number' }).notNull().default(0),
})

export const fileDeclaration669 = businessSchema.table('file_declaration_669', {
  declarationId: text('declaration_id').primaryKey(),
  displaySequence: bigint('display_sequence', { mode: 'number' }).notNull().default(0),
  fileId: bigint('file_id', { mode: 'number' }).notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull(),
  active: bigint('active', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  contentVersion: text('content_version'),
  part: text('part').notNull(),
  pageRanges: text('page_ranges'),
})

export const fileParseAudit105 = businessSchema.table('file_parse_audit_105', {
  id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  fileId: bigint('file_id', { mode: 'number' }).notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  operation: text('operation', { enum: ['replace', 'status'] }).notNull(),
  actor: text('actor').notNull(),
  reason: text('reason').notNull(),
  before: text('before').notNull(),
  after: text('after').notNull(),
  createdAt: text('created_at').notNull(),
})
