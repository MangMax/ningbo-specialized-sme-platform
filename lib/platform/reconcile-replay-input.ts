/** Internal schema0 producer seam. This selects a representation; the writer still authenticates it. */
import { eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import type { RosterImportPlatformQuery } from '../roster-import-client'
import { checkedBusinessStatus, type BusinessStatusValue } from './business-status'
import { normalizePlatformRelation } from './normalization'
import { platformQuerySourceConflict } from './query-replay'

type Query = typeof schema.platformQuery.$inferSelect
type Relation = typeof schema.platformRelation.$inferSelect
type Db = Pick<BetterSQLite3Database<typeof schema>, 'get' | 'select'>
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type RawCell = { storageClass: 'null'; hex: '' } | { storageClass: 'text' | 'blob'; hex: string }
type OriginalRaw =
  | { kind: 'sql_null'; cell: Extract<RawCell, { storageClass: 'null' }>; value: null }
  | { kind: 'decoded_json'; cell: Exclude<RawCell, { storageClass: 'null' }>; value: JsonValue }
type OriginalRelation = {
  /** All schema columns, including original IDs, aliases, key, sourceText and order. */
  columns: Relation
  status: BusinessStatusValue
  raw: OriginalRaw
}

function originalRaw(db: Db, id: number): OriginalRaw {
  const cell = db.get<{ storageClass: string; hex: string }>(sql`
    SELECT typeof(raw_fields) AS storageClass, hex(cast(raw_fields AS blob)) AS hex
    FROM platform_relation WHERE id=${id}`)
  if (!cell) throw new Error(`Missing original reconcile relation ${id}`)
  if (cell.storageClass === 'null' && cell.hex === '') return { kind: 'sql_null', cell: { storageClass: 'null', hex: '' }, value: null }
  if (cell.storageClass !== 'text' && cell.storageClass !== 'blob') throw new Error(`Invalid original raw cell ${id}`)
  // JSON.parse is the original ORM decoder too. Preserve primitives, arrays, own keys and order.
  const value: JsonValue = JSON.parse(Buffer.from(cell.hex, 'hex').toString('utf8'))
  return { kind: 'decoded_json', cell: { storageClass: cell.storageClass, hex: cell.hex }, value }
}

/** Constructed only by the selected schema0 snapshot owner, inside its read transaction.
 * Unavailable/undecodable originals are errors, never a reference fallback. */
export class StoredReplayOriginal {
  private constructor(
    private readonly query: Query,
    private readonly relations: readonly OriginalRelation[],
  ) {}

  static read(db: Db, queryId: Query['id']): StoredReplayOriginal {
    const query = db.select().from(schema.platformQuery).where(eq(schema.platformQuery.id, queryId)).get()
    if (!query) throw new Error(`Missing original reconcile query ${queryId}`)
    const relations = db.select().from(schema.platformRelation).where(eq(schema.platformRelation.queryId, query.id))
      .orderBy(schema.platformRelation.sequenceNo).all()
    const sequences = new Set<number>()
    const originals = relations.map(columns => {
      if (columns.queryId !== query.id || sequences.has(columns.sequenceNo)) throw new Error('Invalid original reconcile relation binding')
      sequences.add(columns.sequenceNo)
      const status = checkedBusinessStatus(columns.status)
      if (query.interface !== 'business_list' && Buffer.isBuffer(status)) throw new Error('Invalid apply stored status cell')
      return {
        columns,
        status: Buffer.isBuffer(status) ? Buffer.from(status) : status,
        raw: originalRaw(db, columns.id),
      }
    })
    return new StoredReplayOriginal(query, originals)
  }

  encode(legacyQuery: RosterImportPlatformQuery): RosterImportPlatformQuery {
    const query = this.query
    if (legacyQuery.interface !== query.interface || legacyQuery.queryKey !== query.queryKey
      || legacyQuery.rdjb !== query.rdjb || legacyQuery.queriedAt !== query.queriedAt) {
      throw new Error('Invalid original reconcile query binding')
    }
    const bySequence = new Map(this.relations.map(row => [row.columns.sequenceNo, row]))
    const rows = legacyQuery.relations ?? []
    // queryUsesReference permits subsets for general callers; this producer must retain every row.
    const complete = rows.length === bySequence.size
      && new Set(rows.map(row => row.sequenceNo)).size === bySequence.size
      && rows.every(row => bySequence.has(row.sequenceNo))
    // The only native non-JSON source cell in the legacy fallback is business status.
    // Detect it before invoking the unchanged serializer; never catch an authentication error.
    const inputCompatible = rows.every(row => !Buffer.isBuffer(row.rawFields?.cszt)
      && normalizePlatformRelation(query.interface, row).normalizationConflicts.length === 0)
    // Reuse the actual immutable comparison rules, without authenticating/writing or swallowing
    // any error. Native ORM source values stay internal; no public Buffer transport is produced.
    const conflict = complete && inputCompatible ? platformQuerySourceConflict(legacyQuery, {
      ref: `query:${query.id}`,
      metadata: query,
      relationCount: this.relations.length,
      relationAt: sequenceNo => {
        const original = bySequence.get(sequenceNo)
        return original ? { values: original.columns, ref: `relation:${original.columns.id}` } : undefined
      },
    }) : true
    if (!conflict) return legacyQuery
    return {
      interface: query.interface,
      queryKey: query.queryKey,
      rdjb: query.rdjb,
      queriedAt: query.queriedAt,
      reuseExisting: true,
      relations: this.relations.map(row => ({ sequenceNo: row.columns.sequenceNo })),
    }
  }
}
