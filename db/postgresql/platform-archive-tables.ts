import { bigint, customType, primaryKey, text } from 'drizzle-orm/pg-core'
import { businessSchema } from './business-schema'

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })

export const platformArchiveValue = businessSchema.table('platform_archive_value', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().generatedByDefaultAsIdentity(),
  storageClass: text('storage_class').notNull(),
  bytes: bytea('bytes'),
  byteLength: bigint('byte_length', { mode: 'number' }),
  sha256: text('sha256'),
  createdAt: text('created_at'),
})

export const platformCollectionArchiveRef = businessSchema.table('platform_collection_archive_ref', {
  ownerId: bigint('owner_id', { mode: 'number' }).notNull(),
  field: text('field').notNull(),
  archiveId: bigint('archive_id', { mode: 'bigint' }).notNull(),
  sealed: bigint('sealed', { mode: 'number' }).notNull().default(0),
}, table => [primaryKey({ columns: [table.ownerId, table.field] })])

export const platformObservationArchiveRef = businessSchema.table('platform_observation_archive_ref', {
  ownerId: bigint('owner_id', { mode: 'number' }).notNull(),
  field: text('field').notNull(),
  archiveId: bigint('archive_id', { mode: 'bigint' }).notNull(),
  sealed: bigint('sealed', { mode: 'number' }).notNull().default(0),
}, table => [primaryKey({ columns: [table.ownerId, table.field] })])

export const platformCollectionLegacyProvenance = businessSchema.table('platform_collection_legacy_provenance', {
  collectionId: bigint('collection_id', { mode: 'number' }).primaryKey(),
  origin: text('origin', { enum: ['t04_envelope', 'supplement'] }).notNull(),
  sourceIdentity: text('source_identity').notNull(),
  sourceSha256: text('source_sha256').notNull(),
  segmentIndex: bigint('segment_index', { mode: 'number' }).notNull(),
  inputFingerprint: text('input_fingerprint').notNull(),
  importBatchId: bigint('import_batch_id', { mode: 'number' }).notNull(),
  createdAt: text('created_at').notNull(),
  archiveId: bigint('archive_id', { mode: 'bigint' }).notNull().unique(),
})

export const platformQueryTitleScope = businessSchema.table('platform_query_title_scope', {
  collectionId: bigint('collection_id', { mode: 'number' }).notNull(),
  rdjb: text('rdjb').notNull(),
}, table => [primaryKey({ columns: [table.collectionId, table.rdjb] })])

export const platformQueryTitleScopeError = businessSchema.table('platform_query_title_scope_error', {
  collectionId: bigint('collection_id', { mode: 'number' }).primaryKey(),
})

export const platformVersionArchiveRef = businessSchema.table('platform_version_archive_ref', {
  ownerId: bigint('owner_id', { mode: 'number' }).notNull(),
  field: text('field').notNull(),
  archiveId: bigint('archive_id', { mode: 'bigint' }).notNull(),
  sealed: bigint('sealed', { mode: 'number' }).notNull().default(0),
}, table => [primaryKey({ columns: [table.ownerId, table.field] })])
