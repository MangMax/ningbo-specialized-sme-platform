import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'
import { enterprise, storedFile } from '../../db/schema'

export const leadListVersion = sqliteTable('lead_list_version', {
  id: integer('id').primaryKey(),
  series: text('series').notNull(),
  channel: text('channel_code').notNull(),
  listType: text('list_type_code').notNull(),
  acquiredOn: text('acquired_on').notNull(),
  fileId: integer('file_id').notNull().references(() => storedFile.id),
  fileSha256: text('file_sha256').notNull(),
  requestHash: text('request_hash').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [unique().on(table.series, table.channel, table.listType, table.acquiredOn, table.fileId)])

export const leadListRow = sqliteTable('lead_list_row', {
  id: integer('id').primaryKey(),
  versionId: integer('version_id').notNull().references(() => leadListVersion.id),
  rowNumber: integer('row_number').notNull(),
  name: text('name').notNull(),
  uscc: text('uscc'),
  district: text('district'),
  note: text('note'),
  enterpriseId: integer('enterprise_id').references(() => enterprise.id),
  reviewHash: text('review_hash'),
  reviewActor: text('review_actor'),
  reviewBasis: text('review_basis'),
  reviewedAt: text('reviewed_at'),
}, table => [unique().on(table.versionId, table.rowNumber)])
