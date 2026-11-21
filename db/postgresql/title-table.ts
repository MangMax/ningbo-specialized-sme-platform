import { bigint, text } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'

export const title = businessSchema.table('title', {
  code: text('code').primaryKey(),
  nameZh: text('name_zh').notNull(),
  level: text('level').notNull(),
  rank: bigint('rank', { mode: 'number' }).notNull(),
})
