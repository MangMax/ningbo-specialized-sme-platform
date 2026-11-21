import { bigint, primaryKey, text, unique, type AnyPgColumn } from 'drizzle-orm/pg-core'
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
  version: bigint('version', { mode: 'number' }).notNull().default(1),
  verificationStatus: text('verification_status', { enum: ['confirmed', 'pending', 'withdrawn'] }).notNull().default('pending'),
  sourceKind: text('source_kind', { enum: ['platform_business', 'platform_apply', 'announcement', 'manual'] }).notNull(),
  sourceRefId: bigint('source_ref_id', { mode: 'number' }).notNull().default(0),
  originalName: text('original_name'),
  originalSourceKind: text('original_source_kind'),
  originalSourceRefId: bigint('original_source_ref_id', { mode: 'number' }),
  validFrom: text('valid_from'),
  validTo: text('valid_to'),
  note: text('note'),
  createdAt: text('created_at').notNull(),
}, table => [unique().on(table.enterpriseId, table.nameNorm, table.sourceKind, table.sourceRefId)])

export const enterpriseMerge = businessSchema.table('enterprise_merge', {
  fromEnterpriseId: bigint('from_enterprise_id', { mode: 'number' }).primaryKey().references(() => enterprise.id, { onDelete: 'restrict' }),
  intoEnterpriseId: bigint('into_enterprise_id', { mode: 'number' }).notNull().references(() => enterprise.id, { onDelete: 'restrict' }),
  basis: text('basis').notNull(),
  recordedAt: text('recorded_at').notNull(),
})

export const enterpriseRegion = businessSchema.table('enterprise_region', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  parentCode: text('parent_code').references((): AnyPgColumn => enterpriseRegion.code),
  level: bigint('level', { mode: 'number' }).notNull(),
})

export const enterpriseIndustry = businessSchema.table('enterprise_industry', {
  code: text('code').primaryKey(),
  inputId: text('input_id').notNull().unique(),
  name: text('name').notNull(),
  parentCode: text('parent_code').references((): AnyPgColumn => enterpriseIndustry.code),
  level: bigint('level', { mode: 'number' }).notNull(),
  description: text('description'),
})

export const enterpriseDirectory = businessSchema.table('enterprise_directory', {
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).primaryKey().references(() => enterprise.id),
  districtCode: text('district_code').references(() => enterpriseRegion.code),
  townshipCode: text('township_code').references(() => enterpriseRegion.code),
  industryCode: text('industry_code').references(() => enterpriseIndustry.code),
  removedReason: text('removed_reason'),
  revision: bigint('revision', { mode: 'number' }).notNull().default(1),
})

export const enterpriseAddress = businessSchema.table('enterprise_address', {
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).notNull().references(() => enterprise.id),
  kind: text('kind', { enum: ['registered', 'operating'] }).notNull(),
  address: text('address').notNull(),
}, table => [primaryKey({ columns: [table.enterpriseId, table.kind] })])

export const enterpriseAliasAudit = businessSchema.table('enterprise_alias_audit', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  aliasId: bigint('alias_id', { mode: 'number' }).notNull().references(() => enterpriseAlias.id),
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).notNull(),
  action: text('action').notNull(),
  actor: text('actor').notNull(),
  basis: text('basis').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  before: text('before').notNull(),
  after: text('after').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [unique().on(table.aliasId, table.idempotencyKey)])

export const enterpriseProfileAudit = businessSchema.table('enterprise_profile_audit', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  enterpriseId: bigint('enterprise_id', { mode: 'number' }).notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  requestHash: text('request_hash').notNull(),
  beforeVersion: text('before_version').notNull(),
  afterVersion: text('after_version').notNull(),
  before: text('before').notNull(),
  after: text('after').notNull(),
  actor: text('actor').notNull(),
  basis: text('basis').notNull(),
  retainedAliasId: bigint('retained_alias_id', { mode: 'number' }),
  aliasCreated: bigint('alias_created', { mode: 'number' }).notNull().default(0),
  createdAt: text('created_at').notNull(),
})
