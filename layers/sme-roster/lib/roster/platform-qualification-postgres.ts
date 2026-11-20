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

export async function readPostgresPlatformQualificationFacts(db: Reader, subjects: readonly { id: number; uscc_norm: string | null }[]) {
  const byUscc = Map.groupBy(subjects, owner => normalizeUscc(owner.uscc_norm))
  const codes = [...byUscc.keys()].filter(isValidUscc)
  const results = new Map<number, PlatformQualificationFact[]>()
  if (!codes.length) return results
  const scope = qualificationUsccCandidate(sql`p.uscc_raw`, codes)
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
  o.id AS "observationId", c.queried_at AS "collectedAt"`
const latestObservation = sql`
  JOIN platform_business_observation o ON o.version_id = p.version_id
  JOIN platform_collection c ON c.id = o.collection_id
  AND NOT EXISTS (
    SELECT 1 FROM platform_business_observation newer
    JOIN platform_collection captured ON captured.id = newer.collection_id
    WHERE newer.record_id = o.record_id AND newer.content_state = 'verified'
      AND (captured.queried_at COLLATE "C", newer.id) > (c.queried_at COLLATE "C", o.id)
  )`
