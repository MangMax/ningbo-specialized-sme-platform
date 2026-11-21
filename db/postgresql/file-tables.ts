import { bigint, text } from 'drizzle-orm/pg-core'
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
