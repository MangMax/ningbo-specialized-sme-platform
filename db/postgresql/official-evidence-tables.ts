import { sql, type SQL } from 'drizzle-orm'
import { bigint, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'

export const officialEvidenceRowRevision = businessSchema.table('official_evidence_row_revision', {
  evidenceId: bigint('evidence_id', { mode: 'number' }).notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull(),
  formatVersion: bigint('format_version', { mode: 'number' }).notNull().default(1),
  eventId: bigint('event_id', { mode: 'number' }).notNull(),
  capturedRecordId: bigint('captured_record_id', { mode: 'number' }).notNull(),
  capturedEnterpriseId: bigint('captured_enterprise_id', { mode: 'number' }).notNull(),
  nameRaw: text('name_raw'),
  usccRaw: text('uscc_raw'),
  districtRaw: text('district_raw'),
  sourceDocumentId: bigint('source_document_id', { mode: 'number' }),
  storedFileId: bigint('stored_file_id', { mode: 'number' }),
  path: text('path'),
  sha256: text('sha256'),
  bytes: bigint('bytes', { mode: 'number' }),
  attachment: text('attachment'),
  sectionKey: text('section_key'),
  listNo: bigint('list_no', { mode: 'number' }),
  page: bigint('page', { mode: 'number' }),
  sourceBindingKnown: bigint('source_binding_known', { mode: 'number' }).notNull(),
  actor: text('actor').notNull(),
  basis: text('basis').notNull(),
  commandKind: text('command_kind').notNull(),
  importBatchId: bigint('import_batch_id', { mode: 'number' }),
  correctionBatchKey: text('correction_batch_key'),
  createdAt: text('created_at').notNull(),
  nameRawJson: text('name_raw_json'),
  usccRawJson: text('uscc_raw_json'),
  districtRawJson: text('district_raw_json'),
}, table => [uniqueIndex('official_evidence_row_revision_uq').on(table.evidenceId, table.revision)])

// PostgreSQL text cannot store U+0000. The companion cell keeps the original
// JSON string for affected values while ordinary captures use the original text column.
export const officialRawFieldColumns = { nameRaw: 'name_raw', usccRaw: 'uscc_raw', districtRaw: 'district_raw' } as const
export function postgresOfficialRawField(alias: string, field: keyof typeof officialRawFieldColumns): SQL {
  const column = officialRawFieldColumns[field]
  const table = sql.identifier(alias)
  return sql`coalesce(${table}.${sql.identifier(column + '_json')}::json, to_json(${table}.${sql.identifier(column)}), 'null'::json)`
}

export const sourceDocument = businessSchema.table('source_document', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  source: text('source', { enum: ['jxj', 'miit'] }).notNull(),
  title: text('title').notNull(),
  docNumber: text('doc_number'),
  issueDate: text('issue_date'),
  path: text('path').notNull(),
})

export const eventCorrectionAudit = businessSchema.table('event_correction_audit', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  eventId: bigint('event_id', { mode: 'number' }).notNull(),
  batchId: bigint('batch_id', { mode: 'number' }).notNull(),
  recordId: bigint('record_id', { mode: 'number' }).notNull(),
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).notNull(),
  before: text('before').notNull(),
  after: text('after').notNull(),
  evidence: text('evidence').notNull(),
  sourceIdentity: text('source_identity').notNull(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  basis: text('basis').notNull(),
  correctedAt: text('corrected_at').notNull(),
})

export const evidenceCorrectionBatch = businessSchema.table('evidence_correction_batch', {
  idempotencyKey: text('idempotency_key').primaryKey(),
  requestHash: text('request_hash').notNull(),
  planHash: text('plan_hash').notNull(),
  receipt: text('receipt').notNull(),
  createdAt: text('created_at').notNull(),
})

export const evidenceCorrectionAudit = businessSchema.table('evidence_correction_audit', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  evidenceId: bigint('evidence_id', { mode: 'number' }).notNull(),
  eventId: bigint('event_id', { mode: 'number' }).notNull(),
  batchKey: text('batch_key'),
  entryPoint: text('entry_point', { enum: ['correction', 'legacy_pages'] }).notNull(),
  actor: text('actor').notNull(),
  basis: text('basis').notNull(),
  before: text('before').notNull(),
  after: text('after').notNull(),
  createdAt: text('created_at').notNull(),
})
