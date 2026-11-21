import { bigint, primaryKey, text, unique } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'
import { enterprise } from './enterprise-tables'
import { storedFile } from './file-tables'

export const enterpriseSourceChannel = businessSchema.table('enterprise_source_channel', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
})

export const enterpriseSourceListType = businessSchema.table('enterprise_source_list_type', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
})

export const enterpriseSource = businessSchema.table('enterprise_source', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  module: text('module').notNull(),
  businessTable: text('business_table').notNull(),
  versionKey: text('version_key').notNull(),
  channelCode: text('channel_code').notNull().references(() => enterpriseSourceChannel.code),
  listTypeCode: text('list_type_code').notNull().references(() => enterpriseSourceListType.code),
  acquiredOn: text('acquired_on'),
  series: text('series').notNull(),
  fileId: bigint('file_id', { mode: 'number' }).references(() => storedFile.id),
  sha256: text('sha256'),
}, table => [unique().on(table.module, table.businessTable, table.versionKey)])

export const enterpriseSourceLink = businessSchema.table('enterprise_source_link', {
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).notNull().references(() => enterprise.id),
  sourceId: bigint('source_id', { mode: 'number' }).notNull().references(() => enterpriseSource.id),
}, table => [primaryKey({ columns: [table.enterpriseId, table.sourceId] })])
