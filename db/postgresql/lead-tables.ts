import { bigint, text, unique } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'
import { storedFile } from './file-tables'
import { enterprise } from './enterprise-tables'

export const postgresLeadListVersion = businessSchema.table('lead_list_version', {
  id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  series: text('series').notNull(),
  channel: text('channel_code').notNull(),
  listType: text('list_type_code').notNull(),
  acquiredOn: text('acquired_on').notNull(),
  fileId: bigint('file_id', { mode: 'number' }).notNull().references(() => storedFile.id),
  fileSha256: text('file_sha256').notNull(),
  requestHash: text('request_hash').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [unique().on(table.series, table.channel, table.listType, table.acquiredOn, table.fileId)])

export const postgresLeadListExport = businessSchema.table('lead_list_export', {
  jobId: text('job_id').primaryKey(),
  versionId: bigint('version_id', { mode: 'number' }).notNull().references(() => postgresLeadListVersion.id),
  content: text('content').notNull(),
})

export const postgresLeadListRow = businessSchema.table('lead_list_row', {
  id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  versionId: bigint('version_id', { mode: 'number' }).notNull().references(() => postgresLeadListVersion.id),
  rowNumber: bigint('row_number', { mode: 'number' }).notNull(),
  name: text('name').notNull(),
  uscc: text('uscc'),
  district: text('district'),
  note: text('note'),
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).references(() => enterprise.id),
  reviewHash: text('review_hash'),
  reviewActor: text('review_actor'),
  reviewBasis: text('review_basis'),
  reviewedAt: text('reviewed_at'),
}, table => [unique().on(table.versionId, table.rowNumber)])
