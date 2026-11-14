/** Selected collection display. No business selection lives here. */
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { targetSchema as s } from './target-schema'
import { readResolvedLegacyDisplay, resolveSelectedLegacyProvenance, type SelectedLegacyProvenance } from './target-legacy-provenance'
import type { PlatformQueryRow } from './read'

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>
type QueryDisplay = Pick<PlatformQueryRow['query'], 'collectionEvidence' | 'rawResponse' | 'legacyProvenance'>

export function readTargetCollectionDisplay<S extends Record<string, unknown>>(
  db: Db<S>, selected: { collection: typeof s.platformCollection.$inferSelect; id: number }[],
  includeRaw: boolean,
  resolved: SelectedLegacyProvenance = resolveSelectedLegacyProvenance(db, selected),
) {
  const result = new Map<number, QueryDisplay>()
  const r = s.platformCollectionArchiveRef, v = s.platformArchiveValue
  const ids = selected.map(row => row.collection.id)
  const archives = ids.length ? db.select({ ownerId: r.ownerId, field: r.field, bytes: v.bytes }).from(r).innerJoin(v, eq(v.id, r.archiveId))
    .where(and(inArray(r.ownerId, ids), eq(r.sealed, 1),
      inArray(r.field, includeRaw ? ['rawResponse', 'collectionEvidence'] : ['collectionEvidence']))).all() : []
  const archiveById = Map.groupBy(archives, row => row.ownerId)
  for (const { collection } of selected) {
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
    const legacy = resolved.get(collection.id)
    if (legacy) display.legacyProvenance = readResolvedLegacyDisplay(db, legacy)
    result.set(collection.id, display)
  }
  return result
}
