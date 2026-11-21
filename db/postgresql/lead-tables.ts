import { bigint, text, unique } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'

export const postgresLeadListVersion = businessSchema.table('lead_list_version', {
  id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  series: text('series').notNull(),
  channel: text('channel_code').notNull(),
  listType: text('list_type_code').notNull(),
  acquiredOn: text('acquired_on').notNull(),
  fileId: bigint('file_id', { mode: 'number' }).notNull(),
  fileSha256: text('file_sha256').notNull(),
  requestHash: text('request_hash').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [unique().on(table.series, table.channel, table.listType, table.acquiredOn, table.fileId)])

export const postgresLeadListExport = businessSchema.table('lead_list_export', {
  jobId: text('job_id').primaryKey(),
  versionId: bigint('version_id', { mode: 'number' }).notNull().references(() => postgresLeadListVersion.id),
  content: text('content').notNull(),
})
