/** Offline-only frozen stage dependency from ab503081dae3e24680afc9b07395a7e3ff21fc9f. */
import { sql } from 'drizzle-orm'
/** Explicit finalized-target declarations. Not registered in ordinary expand schema; W/R adoption is gated. */
import { check, index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'
import * as expand from './legacy-schema'
export const platformBusinessObservation = sqliteTable('platform_business_observation', {
  id: integer('id').primaryKey(),
  collectionId: integer('collection_id').notNull().references(()=>expand.platformCollection.id,{onDelete:'restrict'}),
  sequenceNo: integer('sequence_no').notNull(),
  ...expand.observationFields(),
  positionState: text('position_state',{enum:['verified','unknown','conflict']}).notNull(),
},t=>expand.observationConstraints(t,t.id))
export const platformObservationAssignment=expand.definePlatformObservationAssignment(()=>platformBusinessObservation.id)
export const platformObservationArchiveRef=expand.definePlatformObservationArchiveRef(()=>platformBusinessObservation.id)
export const platformLegacyRelationAlias=expand.definePlatformLegacyRelationAlias(()=>platformBusinessObservation.id)
export const platformApplyProjection=expand.definePlatformApplyProjection(()=>platformBusinessObservation.id)
export const platformBusinessProjection=expand.definePlatformBusinessProjection(()=>platformBusinessObservation.id)
export const platformRecognizedProjection=expand.definePlatformRecognizedProjection(()=>platformBusinessObservation.id)

/** #720 successor only: same physical tables, collection ownership. */
export const platformQueryTitleScope = sqliteTable('platform_query_title_scope', {
  collectionId: integer('collection_id').notNull().references(()=>expand.platformCollection.id,{onDelete:'restrict'}),
  rdjb: text('rdjb').notNull(),
}, t=>[
  primaryKey({columns:[t.collectionId,t.rdjb]}),
  index('platform_query_title_scope_rdjb_collection_idx').on(t.rdjb,t.collectionId),
  check('platform_query_title_scope_safe_id',sql`${t.collectionId} > 0 AND ${t.collectionId} <= 9007199254740991`),
])
export const platformQueryTitleScopeError = sqliteTable('platform_query_title_scope_error', {
  collectionId: integer('collection_id').primaryKey().notNull().references(()=>expand.platformCollection.id,{onDelete:'restrict'}),
}, t=>[check('platform_query_title_scope_error_safe_id',sql`${t.collectionId} > 0 AND ${t.collectionId} <= 9007199254740991`)])

/** Physical deferred FK is installed only by the offline 71607 DDL (Drizzle has no deferred FK option). */
export const platformObservationFingerprintBasis = sqliteTable('platform_observation_fingerprint_basis', {
  observationId: integer('observation_id').primaryKey().notNull().references(()=>platformBusinessObservation.id,{onDelete:'restrict'}),
  scheme: text('scheme',{enum:['legacy-indexed-v1','legacy-bootstrap-v1','target-command-v1','uncaptured']}).notNull(),
  inputArchiveId: integer('input_archive_id').unique().references(()=>expand.platformArchiveValue.id,{onDelete:'restrict'}),
},t=>[
  check('platform_fingerprint_basis_safe_id',sql`typeof(${t.observationId})='integer' AND ${t.observationId} BETWEEN 1 AND 9007199254740991`),
  check('platform_fingerprint_basis_scheme',sql`${t.scheme} IN ('legacy-indexed-v1','legacy-bootstrap-v1','target-command-v1','uncaptured')`),
  check('platform_fingerprint_basis_input',sql`(${t.scheme}='uncaptured' AND ${t.inputArchiveId} IS NULL) OR (${t.scheme}<>'uncaptured' AND ${t.inputArchiveId} IS NOT NULL)`),
])

/** #755 collection-only metadata; physical insert/exclusion guards are offline DDL. */
export const platformCollectionLegacyProvenance = sqliteTable('platform_collection_legacy_provenance', {
  collectionId: integer('collection_id').primaryKey().notNull().references(()=>expand.platformCollection.id,{onDelete:'restrict'}),
  origin: text('origin',{enum:['t04_envelope','supplement']}).notNull(),
  sourceIdentity: text('source_identity').notNull(),
  sourceSha256: text('source_sha256').notNull(),
  segmentIndex: integer('segment_index').notNull(),
  inputFingerprint: text('input_fingerprint').notNull(),
  importBatchId: integer('import_batch_id').notNull().references(()=>expand.importBatch.id,{onDelete:'restrict'}),
  createdAt: text('created_at').notNull(),
  archiveId: integer('archive_id').notNull().unique().references(()=>expand.platformArchiveValue.id,{onDelete:'restrict'}),
},t=>[
  unique('platform_collection_legacy_source_uq').on(t.sourceSha256,t.segmentIndex),
  ...[t.collectionId,t.importBatchId,t.archiveId].map(c=>check(`collection_provenance_${c.name}_safe`,sql`typeof(${c})='integer' AND ${c} BETWEEN 1 AND 9007199254740991`)),
  check('collection_provenance_segment_safe',sql`typeof(${t.segmentIndex})='integer' AND ${t.segmentIndex} BETWEEN 0 AND 9007199254740991`),
  check('collection_provenance_origin',sql`typeof(${t.origin})='text' AND ${t.origin} IN ('t04_envelope','supplement')`),
  ...[t.sourceSha256,t.inputFingerprint].map(c=>check(`collection_provenance_${c.name}_hex`,sql`typeof(${c})='text' AND length(${c})=64 AND length(cast(${c} AS blob))=64 AND ${c} NOT GLOB '*[^0-9a-f]*'`)),
  ...[t.sourceIdentity,t.createdAt].map(c=>check(`collection_provenance_${c.name}_text`,sql`typeof(${c})='text'`)),
])

export const targetSchema={...expand,platformCollectionLegacyProvenance,platformObservationFingerprintBasis,platformBusinessObservation,platformObservationAssignment,platformObservationArchiveRef,platformLegacyRelationAlias,platformApplyProjection,platformBusinessProjection,platformRecognizedProjection,platformQueryTitleScope,platformQueryTitleScopeError}

/** Explicit fresh capture variant only. Kept separate so old target SELECT/replay stays byte-identical. */
export const platformReconcileCapture = sqliteTable('platform_collection', {
  id: integer('id').primaryKey(),
  state: text('reconcile_slot_state',{enum:['uncaptured','verified','miss','error']}).notNull(),
  rule: text('reconcile_slot_rule'),
  rawArchiveId: integer('reconcile_slot_raw_archive_id').references(()=>expand.platformArchiveValue.id,{onDelete:'restrict'}),
  rowCount: integer('reconcile_slot_row_count'),
  inputSha256: text('reconcile_slot_input_sha256'),
  reason: text('reconcile_slot_reason'),
})
