/** Offline historical oracle from ab503081dae3e24680afc9b07395a7e3ff21fc9f. */
import { inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../legacy-schema'
import { PLATFORM_PROCESS_RAW_KEYS, platformProcessRawFromJson } from '../../../lib/platform/normalization'

type Db = BetterSQLite3Database<typeof schema>
const r = schema.platformRelation

/** Only the seven archived process keys, never the full raw row. */
export const legacyProcessRaw = sql`case when json_valid(${r.rawFields}) then json_extract(${r.rawFields}, ${sql.raw(PLATFORM_PROCESS_RAW_KEYS.map(key => `'$.${key}'`).join(', '))}) else null end`.mapWith(platformProcessRawFromJson)

/** Row-level title raw value is bounded text, never the full archive body. */
export const legacyRawRdjb = sql<string | null>`case when json_valid(${r.rawFields}) then case when json_type(${r.rawFields}, '$.rdjb') = 'text' then json_extract(${r.rawFields}, '$.rdjb') else null end else null end`

/** Stored columns and the bounded process-key projection needed by legacy normalization. */
export const legacyRelationColumns = {
  id: r.id, queryId: r.queryId, sequenceNo: r.sequenceNo, relationKey: r.relationKey, enterpriseId: r.enterpriseId,
  rawFields: legacyProcessRaw, rawRdjb: legacyRawRdjb, declareKind: r.declareKind, appliedAt: r.appliedAt, year: r.year,
  province: r.province, batch: r.batch, status: r.status, awardBatchLabel: r.awardBatchLabel, nameRaw: r.nameRaw, usccRaw: r.usccRaw,
}

export type LegacyRelationRow = {
  id: number
  queryId: number
  sequenceNo: number
  relationKey: string | null
  enterpriseId: number | null
  rawFields: Record<string, unknown> | null
  rawRdjb: string | null
  declareKind: string | null
  appliedAt: string | null
  year: number | null
  province: string | null
  batch: string | null
  status: string | null
  awardBatchLabel: string | null
  nameRaw: string | null
  usccRaw: string | null
}

export const FACT_BATCH = 400

export function factBatches(ids: number[]) {
  const unique = [...new Set(ids)].filter(id => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b)
  return Array.from({ length: Math.ceil(unique.length / FACT_BATCH) }, (_, i) => unique.slice(i * FACT_BATCH, (i + 1) * FACT_BATCH))
}

/** Read unindexed original rows for legacy fallback. Raw is bounded to the seven allowlisted
 * process keys; malformed JSON stays unverifiable instead of crashing Drizzle decoding. */
export function readLegacyRelationRows(db: Db, relationIds: number[]): LegacyRelationRow[] {
  const rows: LegacyRelationRow[] = []
  for (const ids of factBatches(relationIds)) rows.push(...db.select(legacyRelationColumns).from(r).where(inArray(r.id, ids)).orderBy(r.id).all())
  return rows
}
