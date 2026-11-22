import { bigint, primaryKey, text } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'

export const platformQueryTitleScope = businessSchema.table('platform_query_title_scope', {
  collectionId: bigint('collection_id', { mode: 'number' }).notNull(),
  rdjb: text('rdjb').notNull(),
}, table => [primaryKey({ columns: [table.collectionId, table.rdjb] })])
