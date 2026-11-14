/** Evidence-only storage. No JSON decoding or legacy business fallback. */
import { createHash } from 'node:crypto'
import { and, eq, max, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'

/** Successor helpers must reject FK-OFF even when an outer transaction already exists. */
function requireTargetForeignKeys<S extends Record<string,unknown>>(db:BetterSQLite3Database<S>) {
  if(db.get<{foreign_keys:number}>(sql`PRAGMA foreign_keys`)?.foreign_keys!==1)throw new Error('fingerprint writes require foreign_keys=ON before entry')
}
export const ARCHIVE_CHUNK_BYTES = 65536
export type ArchiveInput = { storageClass: 'null', bytes: null, createdAt: string | null } | { storageClass: 'text' | 'blob', bytes: Buffer, createdAt: string | null }
function positiveId(id: number) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid archive identity')
  return id
}
export function insertArchiveValue<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, input: ArchiveInput, expected?: { byteLength?: number | null, sha256?: string | null }) {
  requireTargetForeignKeys(db)
  if (!['null', 'text', 'blob'].includes(input.storageClass) || (input.storageClass === 'null' ? input.bytes !== null : !Buffer.isBuffer(input.bytes))) throw new Error('Invalid archive storage class')
  const bytes = input.bytes
  const byteLength = bytes === null ? null : bytes.length
  const sha256 = bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
  if ((expected?.byteLength !== undefined && expected.byteLength !== byteLength) || (expected?.sha256 !== undefined && expected.sha256 !== sha256)) throw new Error('Archive byte length or hash mismatch')
  const values = { storageClass: input.storageClass, bytes, byteLength, sha256, createdAt: input.createdAt }

  return db.insert(schema.platformArchiveValue).values(values).returning({id:schema.platformArchiveValue.id}).get().id
}
export function readArchiveValue<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, input: { archiveId: number, offset?: number, length?: number }) {
  const id = positiveId(input.archiveId), offset = input.offset ?? 0, length = input.length ?? ARCHIVE_CHUNK_BYTES
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - ARCHIVE_CHUNK_BYTES || !Number.isSafeInteger(length) || length < 1 || length > ARCHIVE_CHUNK_BYTES) throw new Error('Invalid archive range')
  const a = schema.platformArchiveValue
  // SQLite substr over BLOB is the only byte range primitive; select never fetches the complete BLOB.
  const found = db.select({ data: sql<Buffer | null>`substr(${a.bytes}, ${offset + 1}, ${length})`, totalBytes: a.byteLength, storageClass: a.storageClass, sha256: a.sha256 }).from(a).where(eq(a.id, id)).get()
  if (!found) return null
  const bytes = found.data ?? Buffer.alloc(0)
  return { encoding: 'base64' as const, offset, byteLength: bytes.length, totalBytes: found.totalBytes ?? 0, isNull: found.storageClass === 'null', storageClass: found.storageClass, sha256: found.sha256, hasMore: offset + bytes.length < (found.totalBytes ?? 0), data: bytes.toString('base64') }
}

export type ArchiveOwner = { kind: 'collection', ownerId: number } | { kind: 'observation', ownerId: number } | { kind: 'version', ownerId: number }
export type ArchiveField =
  | { kind: 'collection', ownerId: number, field: typeof schema.platformCollectionArchiveRef.$inferInsert.field }
  | { kind: 'observation', ownerId: number, field: typeof schema.platformObservationArchiveRef.$inferInsert.field }
  | { kind: 'version', ownerId: number, field: typeof schema.platformVersionArchiveRef.$inferInsert.field }
function refTable(owner: ArchiveOwner) {
  positiveId(owner.ownerId)
  switch (owner.kind) {
    case 'collection': return schema.platformCollectionArchiveRef
    case 'observation': return schema.platformObservationArchiveRef
    case 'version': return schema.platformVersionArchiveRef
    default: throw new Error('Invalid archive owner namespace')
  }
}
function validateField(owner: ArchiveField) {
  const fields = { collection: ['rawResponse', 'collectionEvidence', 'legacyProvenance', 'request'], observation: ['rawFields', 'sourceText', 'legacyRowSnapshot'], version: ['canonicalRawJson'] }
  refTable(owner)
  if (!fields[owner.kind].includes(owner.field)) throw new Error('Invalid archive owner field')
}
export function bindArchive<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, input: ArchiveField & { archiveId: number }) {
  requireTargetForeignKeys(db)
  validateField(input); positiveId(input.archiveId)
  // Branches preserve the schema's owner-field discriminants at the insert boundary.
  switch (input.kind) {
    case 'collection': db.insert(schema.platformCollectionArchiveRef).values({ ownerId: input.ownerId, field: input.field, archiveId: input.archiveId }).run(); break
    case 'observation': db.insert(schema.platformObservationArchiveRef).values({ ownerId: input.ownerId, field: input.field, archiveId: input.archiveId }).run(); break
    case 'version': db.insert(schema.platformVersionArchiveRef).values({ ownerId: input.ownerId, field: input.field, archiveId: input.archiveId }).run(); break
  }
}
/** Append all fields in one enclosing transaction, then seal. Empty owners cannot be sealed. */
export function sealArchiveOwner<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, owner: ArchiveOwner) {
  requireTargetForeignKeys(db)
  const table = refTable(owner)
  const result = db.update(table).set({ sealed: 1 }).where(eq(table.ownerId, owner.ownerId)).run()
  if (result.changes === 0) throw new Error('No archive bindings to seal')
}
export function writeOwnerArchive<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, owner: ArchiveField, input: ArchiveInput) {
  requireTargetForeignKeys(db)
  return db.transaction(tx => {
    const id = insertArchiveValue(tx, input)
    bindArchive(tx, { ...owner, archiveId: id })
    return id
  })
}
export function readOwnerArchive<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, owner: ArchiveField, range: { offset?: number, length?: number } = {}) {
  validateField(owner)
  const t = refTable(owner)
  const ref = db.select({ archiveId: t.archiveId }).from(t).where(and(eq(t.ownerId, owner.ownerId), eq(t.field, owner.field))).get()
  return ref ? readArchiveValue(db, { archiveId: ref.archiveId, ...range }) : null
}

type AliasBinding = { kind: 'query', oldId: number, collectionId: number } | { kind: 'relation', oldId: number, observationId: number }
export function bindLegacyAlias<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, input: AliasBinding) {
  requireTargetForeignKeys(db)
  positiveId(input.oldId)
  switch (input.kind) {
    case 'query': positiveId(input.collectionId); db.insert(schema.platformLegacyQueryAlias).values({ oldId: input.oldId, collectionId: input.collectionId }).run(); break
    case 'relation': positiveId(input.observationId); db.insert(schema.platformLegacyRelationAlias).values({ oldId: input.oldId, observationId: input.observationId }).run(); break
    default: throw new Error('Invalid alias namespace')
  }
}
/** Caller supplies frozen old maxima, not a sample or the count of rows. No historical scan at runtime. */
export function reserveLegacyIds<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, maxima: { query: number, relation: number }) {
  requireTargetForeignKeys(db)
  db.transaction(tx => {
    for (const namespace of ['query', 'relation'] as const) {
      const value = maxima[namespace]
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid alias high water')
      const t = schema.platformLegacyAliasSequence
      const current = tx.select().from(t).where(eq(t.namespace, namespace)).get()
      const alias = namespace === 'query' ? schema.platformLegacyQueryAlias : schema.platformLegacyRelationAlias
      const maximum = tx.select({ value: max(alias.oldId) }).from(alias).get()?.value ?? 0
      if (value < maximum || (current && value < current.highWater)) throw new Error('Alias high water cannot rewind')
      if (current) tx.update(t).set({ highWater: value }).where(eq(t.namespace, namespace)).run()
      else tx.insert(t).values({ namespace, highWater: value }).run()
    }
  })
}
export function allocateLegacyAlias<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, target: { kind: 'query', collectionId: number } | { kind: 'relation', observationId: number }) {
  requireTargetForeignKeys(db)
  return db.transaction(tx => {
    const t = schema.platformLegacyAliasSequence, namespace = target.kind
    const sequence = tx.select().from(t).where(eq(t.namespace, namespace)).get()
    if (!sequence) throw new Error('Reserve frozen legacy maxima before allocation')
    const alias = namespace === 'query' ? schema.platformLegacyQueryAlias : schema.platformLegacyRelationAlias
    const maximum = tx.select({ value: max(alias.oldId) }).from(alias).get()?.value ?? 0
    const id = positiveId(Math.max(sequence.highWater, maximum) + 1)
    tx.update(t).set({ highWater: id }).where(eq(t.namespace, namespace)).run()
    bindLegacyAlias(tx, { ...target, oldId: id })
    return id
  })
}
export type LegacyReference = { version: 1, kind: 'query', queryId: number } | { version: 1, kind: 'relation', queryId: number, relationId: number }
export type ArchiveReference = { version: 2, kind: 'collection', collectionId: number } | { version: 2, kind: 'observation', observationId: number, collectionId: number }
export function resolveLegacyReference<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>, input: LegacyReference): ArchiveReference | null {
  if (input.version !== 1 || !['query', 'relation'].includes(input.kind)) throw new Error('Invalid legacy namespace')
  positiveId(input.queryId)
  const q = schema.platformLegacyQueryAlias
  const query = db.select({ collectionId: q.collectionId }).from(q).where(eq(q.oldId, input.queryId)).get()
  if (!query) return null
  if (input.kind === 'query') return { version: 2, kind: 'collection', collectionId: query.collectionId }
  positiveId(input.relationId)
  const a = schema.platformLegacyRelationAlias, o = schema.platformBusinessObservation
  const found = db.select({ observationId: a.observationId }).from(a).innerJoin(o, eq(o.id, a.observationId))
    .where(and(eq(a.oldId, input.relationId), eq(o.collectionId, query.collectionId))).get()
  return found ? { version: 2, kind: 'observation', observationId: found.observationId, collectionId: query.collectionId } : null
}
