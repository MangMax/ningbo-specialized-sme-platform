import { bigint, text } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'

export const importBatch = businessSchema.table('import_batch', {
  id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  idempotencyKey: text('idempotency_key').notNull(),
  sourceKind: text('source_kind').notNull(),
  sourceIdentity: text('source_identity').notNull(),
  sourceSha256: text('source_sha256'),
  status: text('status').notNull().default('preflight'),
  preflightResult: text('preflight_result'),
  itemResults: text('item_results'),
  summary: text('summary'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  committedAt: text('committed_at'),
})

export const importReceipt = businessSchema.table('import_receipt', {
  id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  batchId: bigint('batch_id', { mode: 'number' }).notNull(),
  operation: text('operation').notNull(),
  requestHash: text('request_hash').notNull(),
  requestBody: text('request_body').notNull(),
  status: text('status').notNull(),
  summary: text('summary'),
  itemResults: text('item_results'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
  bodyReceiptId: bigint('body_receipt_id', { mode: 'number' }),
})
