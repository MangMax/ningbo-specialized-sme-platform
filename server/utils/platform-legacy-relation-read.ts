import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'

type Db = BetterSQLite3Database<typeof schema>

export interface LegacyRelationRow {
  id: number
  queryId: number
  sequenceNo: number
  relationKey: string | null
  enterpriseId: number | null
  rawFields: Record<string, unknown> | null
  sourceText: string | null
  usccRaw: string | null
  nameRaw: string | null
  aliasNameRaw: string | null
  province: string | null
  status: string | null
  batch: string | null
  declareKind: string | null
  appliedAt: string | null
  awardBatchLabel: string | null
  year: number | null
  matchBasis: string
  verificationStatus: string
}

const LEGACY_BATCH = 400

/** Read original rows for unprojected historical observations without asking Drizzle to
 * parse malformed legacy JSON. Malformed bytes stay unverifiable rather than crashing. */
export function readLegacyRelationRows(db: Db, relationIds: number[]): LegacyRelationRow[] {
  const unique = [...new Set(relationIds)].filter(id => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b)
  const rows: Array<Omit<LegacyRelationRow, 'rawFields'> & { rawFields: string | null }> = []
  for (let i = 0; i < unique.length; i += LEGACY_BATCH) {
    const ids = sql.join(unique.slice(i, i + LEGACY_BATCH).map(id => sql`${id}`), sql`, `)
    rows.push(...db.all<Omit<LegacyRelationRow, 'rawFields'> & { rawFields: string | null }>(sql`
      select id, query_id as queryId, sequence_no as sequenceNo, relation_key as relationKey,
        enterprise_id as enterpriseId, raw_fields as rawFields, source_text as sourceText,
        uscc_raw as usccRaw, name_raw as nameRaw, alias_name_raw as aliasNameRaw, province, status, batch,
        declare_kind as declareKind, applied_at as appliedAt, award_batch_label as awardBatchLabel, year,
        match_basis as matchBasis, verification_status as verificationStatus
      from platform_relation where id in (${ids}) order by id
    `))
  }
  return rows.map(row => {
    let rawFields: Record<string, unknown> | null = null
    try { rawFields = row.rawFields == null ? null : JSON.parse(row.rawFields) } catch { rawFields = null }
    return { ...row, rawFields }
  })
}
