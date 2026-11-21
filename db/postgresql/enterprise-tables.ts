import { bigint, text } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'

export const enterprise = businessSchema.table('enterprise', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  usccNorm: text('uscc_norm').unique(),
  name: text('name').notNull(),
  nameNorm: text('name_norm').notNull(),
  district: text('district'),
  city: text('city'),
  regStatus: text('reg_status'),
  qualityFlags: text('quality_flags').default('[]'),
})

export const enterpriseAlias = businessSchema.table('enterprise_alias', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).notNull().references(() => enterprise.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  nameNorm: text('name_norm').notNull(),
  verificationStatus: text('verification_status').notNull().default('pending'),
})
