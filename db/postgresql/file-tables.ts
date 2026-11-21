import { bigint, text, unique } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'

export const storedFile = businessSchema.table('stored_file', {
  id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  relPath: text('rel_path').notNull().unique(),
  displayName: text('display_name'),
  filename: text('filename').notNull(),
  ext: text('ext').notNull(),
  bytes: bigint('bytes', { mode: 'bigint' }).notNull(),
  sha256: text('sha256').notNull(),
  createdAt: text('created_at').notNull(),
  removedAt: text('removed_at'),
})

export const filePhysicalIntent = businessSchema.table('file_physical_intent', {
  id: text('id').primaryKey(),
  fileId: bigint('file_id', { mode: 'number' }).notNull().references(() => storedFile.id),
  relPath: text('rel_path').notNull(),
  sha256: text('sha256').notNull(),
  bytes: bigint('bytes', { mode: 'bigint' }).notNull(),
  state: text('state', { enum: ['pending', 'quarantined', 'recovering', 'recovered'] }).notNull(),
  deleteKey: text('delete_key').notNull().unique('file_physical_delete_key_uq'),
  deleteHash: text('delete_hash').notNull(),
  deleteReceipt: text('delete_receipt'),
  recoverKey: text('recover_key').unique('file_physical_recover_key_uq'),
  recoverHash: text('recover_hash'),
  recoverReceipt: text('recover_receipt'),
  createdAt: text('created_at').notNull(),
})

export const storedFileAudit = businessSchema.table('stored_file_audit', {
  id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  storedFileId: bigint('stored_file_id', { mode: 'number' }).notNull().references(() => storedFile.id),
  oldDisplayName: text('old_display_name').notNull(),
  newDisplayName: text('new_display_name').notNull(),
  createdAt: text('created_at').notNull(),
})

export const fileMaintenanceAudit = businessSchema.table('file_maintenance_audit', {
  id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  fileId: bigint('file_id', { mode: 'number' }).notNull().references(() => storedFile.id),
  revision: bigint('revision', { mode: 'number' }).notNull(),
  action: text('action', { enum: ['update', 'remove', 'restore'] }).notNull(),
  idempotencyKey: text('idempotency_key').unique('file_maintenance_key_uq'),
  requestHash: text('request_hash').notNull(),
  mode: text('mode', { enum: ['legacy', 'versioned'] }).notNull(),
  actor: text('actor'),
  basis: text('basis'),
  before: text('before_json').notNull(),
  after: text('after_json').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [unique('file_maintenance_revision_uq').on(table.fileId, table.revision)])

export const ocrResult = businessSchema.table('ocr_result', {
  id: bigint('id', { mode: 'bigint' }).generatedByDefaultAsIdentity().primaryKey(),
  fileId: bigint('file_id', { mode: 'number' }).notNull().references(() => storedFile.id, { onDelete: 'cascade' }),
  page: bigint('page_no', { mode: 'number' }).notNull(),
  revision: bigint('revision', { mode: 'bigint' }).notNull().default(BigInt(1)),
  pageRelPath: text('page_rel_path'),
  markdown: text('markdown').notNull(),
  raw: text('raw'),
  engine: text('engine').notNull().default('paddleocr'),
  model: text('model'),
  channel: text('channel').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [unique('ocr_result_file_id_page_no_key').on(table.fileId, table.page)])
