import { sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { normalizeUscc } from '../domain'
import { isValidUscc } from './uscc-research'
import { projectPlatformQualificationFact, type PlatformQualificationInputRow, type PlatformQualificationFact } from './platform-qualification'

/** Retain JS normalization for Unicode. Restrict the ordinary ASCII path in SQL
 * and recheck the small Unicode candidate set with the same domain function. */
export function qualificationUsccCandidate(column: SQL, usccs: string[]) {
  return sql`(upper(regexp_replace(${column} COLLATE "C", '[[:space:]]', '', 'g')) = ANY(${sql.param(usccs)}::text[])
    OR octet_length(${column}) <> char_length(${column}))`
}

type Reader = Pick<NodePgDatabase, 'execute'>
type RecognizedRow = PlatformQualificationInputRow & { flag: Buffer | null; flagStorage: string }

function recognizedFlag({ flag, flagStorage }: Pick<RecognizedRow, 'flag' | 'flagStorage'>): string | number | null {
  if (flag === null) return null
  if (flagStorage === 'text') return flag.toString('utf8')
  if (flagStorage === 'integer') return Number(flag.readBigInt64BE())
  if (flagStorage === 'real') return flag.readDoubleBE()
  return null
}

export function createPostgresPlatformQualificationReader(db: Reader) {
  let variants: Promise<Map<string, { raw: string; normalized: string }[]>> | undefined
  return async (subjects: readonly { id: number; uscc_norm: string | null }[]) => {
    const byUscc = Map.groupBy(subjects, owner => normalizeUscc(owner.uscc_norm))
    const codes = [...byUscc.keys()].filter(isValidUscc)
    if (!codes.length) return new Map<number, PlatformQualificationFact[]>()
    const known = await (variants ??= readQualificationKeyVariants(db))
    const raw = codes.flatMap(code => [code, ...(known.get(code) ?? []).map(key => key.raw)])
    return readFacts(db, byUscc, codes, raw)
  }
}

export type PostgresPlatformQualificationReader = ReturnType<typeof createPostgresPlatformQualificationReader>

async function readQualificationKeyVariants(db: Reader) {
  const { rows } = await db.execute<{ raw: string }>(sql`
    SELECT uscc_raw AS raw FROM platform_recognized_projection WHERE uscc_raw COLLATE "C" !~ '^[0-9A-Z]{18}$'
    UNION SELECT uscc_raw FROM platform_business_projection WHERE uscc_raw COLLATE "C" !~ '^[0-9A-Z]{18}$'
    UNION SELECT uscc_raw FROM platform_apply_projection WHERE uscc_raw COLLATE "C" !~ '^[0-9A-Z]{18}$'`)
  return Map.groupBy(rows.map(({ raw }) => ({ raw, normalized: normalizeUscc(raw) })), key => key.normalized)
}

async function readFacts(db: Reader, byUscc: Map<string, { id: number; uscc_norm: string | null }[]>, codes: string[], raw: string[]) {
  const results = new Map<number, PlatformQualificationFact[]>()
  const scope = sql`p.uscc_raw = ANY(${sql.param(raw)}::text[])`
  const recognized = await db.execute<RecognizedRow>(sql`
    SELECT ${latestProjection}, 'recognized_list' AS source,
      p.source_valid_flag AS flag, p.source_valid_flag_sqlite_storage AS "flagStorage",
      json_build_object('usccRaw',p.uscc_raw,'titleRaw',p.title_raw,'nameRaw',p.name_raw,
        'qualificationFieldsRule',p.qualification_fields_rule,
        'sourceRecognizedAt',p.source_recognized_at,'sourceValidityDate',p.source_validity_date,
        'sourceProvinceName',p.source_province_name,'sourceCityName',p.source_city_name,
        'sourceDistrictName',p.source_district_name,'sourceInvalidatedAt',p.source_invalidated_at,
        'sourceInvalidationReason',p.source_invalidation_reason) AS p
    FROM platform_recognized_projection p
    ${latestObservation}
    WHERE ${scope}`)
  const business = await db.execute<PlatformQualificationInputRow>(sql`
    SELECT ${latestProjection}, 'business_list' AS source,
      json_build_object('usccRaw',p.uscc_raw,'titleRaw',p.title_raw,'nameRaw',p.name_raw,
        'declareKind',p.declare_kind,'status',p.status,'businessYear',p.business_year,
        'appliedAt',p.applied_at,'province',p.province) AS p
    FROM platform_business_projection p
    ${latestObservation}
    WHERE ${scope}`)
  const apply = await db.execute<PlatformQualificationInputRow>(sql`
    SELECT ${latestProjection}, 'apply_list' AS source,
      json_build_object('usccRaw',p.uscc_raw,'titleRaw',p.title_raw,'nameRaw',p.name_raw,
        'declareKind',p.declare_kind,'status',p.status,'declarationYear',p.declaration_year,'appliedAt',p.applied_at) AS p
    FROM platform_apply_projection p
    ${latestObservation}
    WHERE ${scope}`)
  const recognizedFacts = recognized.rows.map(({ flag, flagStorage, ...row }) => ({
    ...row, p: { ...row.p, sourceValidFlag: recognizedFlag({ flag, flagStorage }) },
  }))
  const owners = new Map(codes.map(code => [code, new Set([byUscc.get(code)![0]!.id])]))
  for (const row of [...recognizedFacts, ...business.rows, ...apply.rows]) {
    const fact = projectPlatformQualificationFact({
      ...row, recordId: Number(row.recordId), versionId: Number(row.versionId), observationId: Number(row.observationId),
    }, owners)
    if (!fact) continue
    for (const { id } of byUscc.get(fact.uscc)!) {
      const facts = results.get(id) ?? []
      facts.push({ ...fact, enterpriseId: id })
      results.set(id, facts)
    }
  }
  for (const facts of results.values()) facts.sort((a, b) => a.recordId - b.recordId)
  return results
}

const latestProjection = sql`o.record_id AS "recordId", o.version_id AS "versionId",
  o.id AS "observationId", o.queried_at AS "collectedAt"`
const latestObservation = sql`
  JOIN LATERAL (
    SELECT o.record_id, o.version_id, o.id, c.queried_at
    FROM platform_business_observation o JOIN platform_collection c ON c.id = o.collection_id
    WHERE o.record_id = p.record_id AND o.content_state = 'verified'
    ORDER BY c.queried_at COLLATE "C" DESC, o.id DESC LIMIT 1
  ) o ON o.version_id = p.version_id`
