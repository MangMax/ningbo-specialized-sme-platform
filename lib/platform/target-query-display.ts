/** Selected collection display and budget expressions. No business selection lives here. */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { targetSchema as s } from './target-schema'
import { provenancePresence } from './target-evidence-read'
import type { PlatformQueryRow } from './read'

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>
type QueryDisplay = Pick<PlatformQueryRow['query'], 'collectionEvidence' | 'rawResponse' | 'legacyProvenance'>

/** Walk length-prefixed headers in SQLite, skipping bodies. A giant legacy rows array
 * never crosses into JS to calculate the original json_remove(...,'$.rows') budget. */
function legacyCells<S extends Record<string, unknown>>(db: Db<S>, collectionId: number) {
  const r = s.platformCollectionArchiveRef, v = s.platformArchiveValue
  const archive = db.select({ id: v.id }).from(r).innerJoin(v, eq(v.id, r.archiveId))
    .where(and(eq(r.ownerId, collectionId), eq(r.field, 'legacyProvenance'), eq(r.sealed, 1))).get()
  const cells = new Map<string, SQL>()
  if (!archive) return cells
  let cursor = Buffer.byteLength('T04-PROVENANCE\n')
  const prefix = db.get<{ prefix: string }>(sql`select cast(substr(bytes,1,${cursor}) as text) prefix from platform_archive_value where id=${archive.id}`)?.prefix
  if (prefix !== 'T04-PROVENANCE\n') throw new Error('Invalid original provenance envelope')
  for (const name of ['query_id', 'source_identity', 'source_sha256', 'segment_index', 'collection', 'input_fingerprint', 'import_batch_id', 'created_at']) {
    const header = db.get<{ header: Buffer }>(sql`select substr(bytes,${cursor + 1},128) header from platform_archive_value where id=${archive.id}`)!.header
    const match = /^(\w+) (null|text|blob|integer|real) (\d+)\n/.exec(header.toString('utf8'))
    if (!match || match[1] !== name) throw new Error('Invalid original provenance cell')
    const size = Number(match[3])
    if (!Number.isSafeInteger(size)) throw new Error('Invalid original provenance size')
    cursor += Buffer.byteLength(match[0])
    const body = sql`(select substr(bytes,${cursor + 1},${size}) from platform_archive_value where id=${archive.id})`
    cells.set(name, match[2] === 'null' ? sql`NULL` : match[2] === 'blob' ? body
      : match[2] === 'integer' ? sql`cast(${body} as integer)` : match[2] === 'real' ? sql`cast(${body} as real)` : sql`cast(${body} as text)`)
    cursor += size + 1
  }
  return cells
}
export function targetLegacyCollectionExpression<S extends Record<string, unknown>>(db: Db<S>, collectionId: number) {
  return legacyCells(db, collectionId).get('collection') ?? sql`NULL`
}

export function readTargetCollectionDisplay<S extends Record<string, unknown>>(
  db: Db<S>, selected: { collection: typeof s.platformCollection.$inferSelect; id: number }[],
  sources: ReadonlyMap<number, Record<string, unknown> | null>, includeRaw: boolean,
) {
  const result = new Map<number, QueryDisplay>()
  const queryById = new Map<number, Record<string, unknown>>()
  for (const source of sources.values()) {
    const query = source?.query
    if (query && typeof query === 'object' && 'id' in query && typeof query.id === 'number') queryById.set(query.id, query)
  }
  const r = s.platformCollectionArchiveRef, v = s.platformArchiveValue
  const ids = selected.map(row => row.collection.id)
  const archives = ids.length ? db.select({ ownerId: r.ownerId, field: r.field, bytes: v.bytes }).from(r).innerJoin(v, eq(v.id, r.archiveId))
    .where(and(inArray(r.ownerId, ids), eq(r.sealed, 1),
      inArray(r.field, includeRaw ? ['rawResponse', 'collectionEvidence'] : ['collectionEvidence']))).all() : []
  const archiveById = Map.groupBy(archives, row => row.ownerId)
  for (const { collection, id } of selected) {
    const refs = archiveById.get(collection.id) ?? []
    const evidence = refs.find(row => row.field === 'collectionEvidence')
    if (!evidence) throw new Error('Missing sealed collection archive')
    // JSON is decoded only for selected page presentation; original response bytes remain independent.
    const display: QueryDisplay = { collectionEvidence: evidence.bytes === null ? null : JSON.parse(evidence.bytes.toString('utf8')) }
    if (includeRaw) {
      const raw = refs.find(row => row.field === 'rawResponse')
      if (!raw) throw new Error('Missing sealed collection archive')
      // SQLite's text-affinity reader returns a BLOB as a Buffer, as did the old reader.
      display.rawResponse = raw.bytes === null ? null : db.get<{ value: string }>(sql`select
        case when storage_class='blob' then bytes else cast(bytes as text) end value from platform_archive_value
        where id=(select archive_id from platform_collection_archive_ref where owner_id=${collection.id} and field='rawResponse')`)!.value
    }
    const query = queryById.get(id)
    if (query && 'legacyProvenance' in query) {
      // Same SQLite field projection used by the shared evidence display owner below.
      display.legacyProvenance = legacyDisplay(db, collection.id)
    } else if (!query && provenancePresence(db, collection.id, id)) {
      display.legacyProvenance = legacyDisplay(db, collection.id)
    }
    result.set(collection.id, display)
  }
  return result
}
function legacyDisplay<S extends Record<string, unknown>>(db: Db<S>, collectionId: number) {
  const cells = legacyCells(db, collectionId), cell = (name: string) => cells.get(name) ?? sql`NULL`
  const value = db.get<Omit<typeof s.platformQueryLegacyProvenance.$inferSelect, 'collection'> & { collection: string }>(sql`select
    ${cell('query_id')} queryId, ${cell('source_identity')} sourceIdentity, ${cell('source_sha256')} sourceSha256,
    ${cell('segment_index')} segmentIndex, ${cell('input_fingerprint')} inputFingerprint,
    ${cell('import_batch_id')} importBatchId, ${cell('created_at')} createdAt,
    json_remove(${cell('collection')}, '$.rows') collection`)!
  return { ...value, kind: 'legacy_pagination' as const, collection: JSON.parse(value.collection) }
}
