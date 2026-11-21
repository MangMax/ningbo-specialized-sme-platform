/** Selected evidence only. SQL expressions never participate in business selection.
 * The resolver and its decoded metadata live for one synchronous read transaction. */
import { createHash } from 'node:crypto'
import { eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { targetSchema as s } from './target-schema'
import { provenancePresence } from './target-evidence-read'
import { requireLegacyProvenanceReady } from './legacy-provenance-catalog'
import { sqliteConnection } from './target-connection'
import type { PlatformQueryRow } from './read'
import { PROVENANCE_CELL_NAMES } from './evidence-contract'

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>
export type SelectedProvenanceOwner = { collection: typeof s.platformCollection.$inferSelect; id: number }
type LegacyDisplay = NonNullable<PlatformQueryRow['query']['legacyProvenance']>
export type ResolvedLegacyProvenance = {
  collection: SQL
  archiveId: number
  fields: ReadonlyMap<string, SQL>
  display?: LegacyDisplay
}
export type SelectedLegacyProvenance = ReadonlyMap<number, ResolvedLegacyProvenance | null>
const batches = <T>(items: readonly T[], size = 300) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))
function lifecycle(message: string): never { throw new Error(`Legacy provenance lifecycle: ${message}`) }
function numberLiteral(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) lifecycle('invalid archive coordinate')
  return sql.raw(String(value))
}

/** Walk only headers in SQLite; skip even giant rows bodies before budgeting.
 * Cell expressions retain the original SQLite type and bytes, including NULL/BLOB. */
function envelopeFields<S extends Record<string, unknown>>(db: Db<S>, archiveId: number, byteLength: number) {
  const archive = numberLiteral(archiveId)
  const fields = new Map<string, SQL>()
  let cursor = Buffer.byteLength('T04-PROVENANCE\n')
  const prefix = db.get<{ value: Buffer }>(sql`select substr(bytes,1,${cursor}) value from platform_archive_value where id=${archive}`)!.value
  if (!prefix.equals(Buffer.from('T04-PROVENANCE\n'))) lifecycle('invalid T04 envelope')
  for (const name of PROVENANCE_CELL_NAMES) {
    const header = db.get<{ value: Buffer }>(sql`select substr(bytes,${cursor + 1},128) value from platform_archive_value where id=${archive}`)!.value
    const match = /^(\w+) (null|text|blob|integer|real) (\d+)\n/.exec(header.toString('utf8'))
    if (!match || match[1] !== name) lifecycle('invalid T04 cell')
    const size = Number(match[3])
    if (!Number.isSafeInteger(size) || size < 0 || (match[2] === 'null' && size !== 0)) lifecycle('invalid T04 cell length')
    cursor += Buffer.byteLength(match[0])
    const body = sql`(select substr(bytes,${numberLiteral(cursor + 1)},${numberLiteral(size)}) from platform_archive_value where id=${archive})`
    fields.set(name, match[2] === 'null' ? sql`NULL` : match[2] === 'blob' ? body
      : match[2] === 'integer' ? sql`cast(${body} as integer)` : match[2] === 'real' ? sql`cast(${body} as real)` : sql`cast(${body} as text)`)
    cursor += size
    if (cursor >= byteLength || db.get<{ value: string }>(sql`select hex(substr(bytes,${cursor + 1},1)) value from platform_archive_value where id=${archive}`)?.value !== '0A') lifecycle('truncated T04 cell')
    cursor++
  }
  if (cursor !== byteLength) lifecycle('trailing T04 cells')
  return fields
}

/** IDs have already been selected through public aliases. No alias is guessed from an owner ID. */
export function resolveSelectedLegacyProvenance<S extends Record<string, unknown>>(
  db: Db<S>, owners: readonly SelectedProvenanceOwner[],
): SelectedLegacyProvenance {
  const unique = [...new Map(owners.map(owner => [owner.collection.id, owner])).values()]
  requireLegacyProvenanceReady(sqliteConnection(db))
  const p = s.platformCollectionLegacyProvenance, v = s.platformArchiveValue, r = s.platformCollectionArchiveRef
  const refs = batches(unique.map(owner => owner.collection.id)).flatMap(ids => db.select({
    ownerId: r.ownerId, field: r.field, sealed: r.sealed, archiveId: v.id, storageClass: v.storageClass, byteLength: v.byteLength, sha256: v.sha256,
  }).from(r).leftJoin(v, eq(v.id, r.archiveId)).where(inArray(r.ownerId, ids)).all())
  const byRef = Map.groupBy(refs, row => row.ownerId)
  const authenticated = new Map(unique.map(owner => {
    const capture = { collection: owner.collection, refs: byRef.get(owner.collection.id) ?? [], requestBytes: null }
    return [owner.collection.id, { capture, present: provenancePresence(db, owner.collection.id, owner.id, capture) }]
  }))
  const indices = batches(unique.map(owner => owner.collection.id)).flatMap(ids => db.select().from(p).where(inArray(p.collectionId, ids)).all())
  const byOwner = new Map(indices.map(row => [row.collectionId, row]))
  const archives = new Map(batches(indices.map(row => row.archiveId)).flatMap(ids => db.select({
    id: v.id, storageClass: v.storageClass, byteLength: v.byteLength, sha256: v.sha256,
    actualLength: sql<number | null>`length(${v.bytes})`,
  }).from(v).where(inArray(v.id, ids)).all()).map(row => [row.id, row]))
  const result = new Map<number, ResolvedLegacyProvenance | null>()
  for (const owner of unique) {
    const { capture, present } = authenticated.get(owner.collection.id)!
    const index = byOwner.get(owner.collection.id)
    const ref = capture.refs.find(ref => ref.field === 'legacyProvenance')
    if (present && !index) lifecycle('missing T04 index')
    if (!present && !index) { result.set(owner.collection.id, null); continue }
    if (index && ((index.origin === 't04_envelope') !== present || (present && index.archiveId !== ref?.archiveId))) lifecycle('origin/owner/archive conflict')
    const archiveId = index?.archiveId ?? ref?.archiveId
    if (!archiveId) lifecycle('missing archive')
    const archive = archives.get(archiveId)
    if (!archive || archive.byteLength === null || !archive.sha256 || ('actualLength' in archive && archive.actualLength !== archive.byteLength)) lifecycle('missing or contradictory archive')
    let fields: Map<string, SQL>
    if (present) {
      if (archive.storageClass !== 'blob') lifecycle('invalid T04 storage')
      fields = envelopeFields(db, archiveId, archive.byteLength)
      const alias = fields.get('query_id')!
      if (!db.get<{ ok: number }>(sql`select typeof(${alias})='integer' and ${alias}=${owner.id} ok`)?.ok) lifecycle('original query alias conflict')
      if (index) {
        for (const [name, expected] of [
          ['source_identity', index.sourceIdentity], ['source_sha256', index.sourceSha256], ['segment_index', index.segmentIndex],
          ['input_fingerprint', index.inputFingerprint], ['import_batch_id', index.importBatchId], ['created_at', index.createdAt],
        ] as const) {
          const original = fields.get(name)!
          const expectedCell = typeof expected === 'number' ? sql`cast(${expected} as integer)` : sql`${expected}`
          if (!db.get<{ ok: number }>(sql`select typeof(${original})=typeof(${expectedCell}) and hex(cast(${original} as blob))=hex(cast(${expectedCell} as blob)) ok`)?.ok) lifecycle(`T04 metadata conflict: ${name}`)
        }
      }
    } else {
      if (!index || index.origin !== 'supplement' || archive.storageClass !== 'text') lifecycle('invalid supplement archive')
      const collision = db.get<{ n: number }>(sql`select
        (select count(*) from platform_collection_archive_ref where archive_id=${archiveId}) +
        (select count(*) from platform_observation_archive_ref where archive_id=${archiveId}) +
        (select count(*) from platform_version_archive_ref where archive_id=${archiveId}) +
        (select count(*) from platform_observation_fingerprint_basis where input_archive_id=${archiveId}) n`)!.n
      if (collision) lifecycle('supplement archive owner conflict')
      fields = new Map([
        ['query_id', sql`${owner.id}`], ['source_identity', sql`${index.sourceIdentity}`], ['source_sha256', sql`${index.sourceSha256}`],
        ['segment_index', sql`${index.segmentIndex}`], ['input_fingerprint', sql`${index.inputFingerprint}`],
        ['import_batch_id', sql`${index.importBatchId}`], ['created_at', sql`${index.createdAt}`],
        ['collection', sql`(select cast(bytes as text) from platform_archive_value where id=${numberLiteral(archiveId)})`],
      ])
    }
    result.set(owner.collection.id, { fields, archiveId, collection: fields.get('collection')! })
  }
  return result
}

/** One decode per selected collection, reused by query and relation presentation. */
export function readResolvedLegacyDisplay<S extends Record<string, unknown>>(db: Db<S>, resolved: ResolvedLegacyProvenance) {
  if (resolved.display) return resolved.display
  // Preserve the original display owner's byte/hash authentication after SQL budgeting.
  // This selected-owner check does not promise chunk-sized internal memory.
  const archive = db.select().from(s.platformArchiveValue).where(eq(s.platformArchiveValue.id, resolved.archiveId)).get()
  if (!archive?.bytes || archive.bytes.length !== archive.byteLength || createHash('sha256').update(archive.bytes).digest('hex') !== archive.sha256) lifecycle('archive byte/hash drift')
  const cell = (name: string) => resolved.fields.get(name)!
  const value = db.get<Omit<LegacyDisplay, 'kind' | 'collection'> & { collection: string }>(sql`select
    ${cell('query_id')} queryId, ${cell('source_identity')} sourceIdentity, ${cell('source_sha256')} sourceSha256,
    ${cell('segment_index')} segmentIndex, ${cell('input_fingerprint')} inputFingerprint,
    ${cell('import_batch_id')} importBatchId, ${cell('created_at')} createdAt,
    json_remove(${resolved.collection}, '$.rows') collection`)!
  // Preserve old JSON-mode NULL and errors; never manufacture an empty collection.
  resolved.display = { ...value, kind: 'legacy_pagination', collection: JSON.parse(value.collection) }
  return resolved.display
}
