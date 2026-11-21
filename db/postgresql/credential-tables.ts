import { text } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'

export const serviceCredential = businessSchema.table('service_credential', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
})
