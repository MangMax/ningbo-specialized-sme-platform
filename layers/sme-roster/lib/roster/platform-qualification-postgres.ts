import { and, desc, eq, sql, type SQLWrapper } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { platformApplyProjection as apply, platformBusinessObservation as observation, platformBusinessProjection as business,
  platformCollection as collection, platformRecognizedProjection as recognized } from '../../../../db/postgresql/platform-tables'
import { platformSourceCellValue, type PlatformSourceCell } from '../../../../db/postgresql/platform-source-values'
import { normalizeUscc } from '../domain'
import { isValidUscc } from './uscc-research'
import { projectPlatformQualificationFact, type PlatformQualificationInputRow, type PlatformQualificationFact } from './platform-qualification'

/** Retain JS normalization for Unicode. Restrict the ordinary ASCII path in SQL
 * and recheck the small Unicode candidate set with the same domain function.
 * Drizzle 0.45 has no COLLATE, regexp_replace, length comparison or array ANY builder. */
export function qualificationUsccCandidate(column: SQLWrapper, usccs: string[]) {
  return sql`(upper(regexp_replace(${column} COLLATE "C", '[[:space:]]', '', 'g')) = ANY(${sql.param(usccs)}::text[])
    OR octet_length(${column}) <> char_length(${column}))`
}

type Reader = Pick<NodePgDatabase, 'select'>

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
  // PostgreSQL regex with the bytewise collation has no Drizzle operator.
  const unusual = (column: SQLWrapper) => sql`${column} COLLATE "C" !~ '^[0-9A-Z]{18}$'`
  const variants = [recognized, business, apply].map(table =>
    db.select({ raw: table.usccRaw }).from(table).where(unusual(table.usccRaw)))
  const rows = await variants[0]!.union(variants[1]!).union(variants[2]!)
  return Map.groupBy(rows.flatMap(({ raw }) => raw === null ? [] : [{ raw, normalized: normalizeUscc(raw) }]), key => key.normalized)
}

async function readFacts(db: Reader, byUscc: Map<string, { id: number; uscc_norm: string | null }[]>, codes: string[], raw: string[]) {
  const results = new Map<number, PlatformQualificationFact[]>()
  // Array ANY binds one parameter for an entire batch. Drizzle only offers parameter-per-value inArray.
  const scope = (column: SQLWrapper) => sql`${column} = ANY(${sql.param(raw)}::text[])`
  const latest = (recordId: typeof recognized.recordId | typeof business.recordId | typeof apply.recordId) =>
    db.select({ recordId: observation.recordId, versionId: observation.versionId,
      observationId: observation.id, collectedAt: collection.queriedAt })
      .from(observation).innerJoin(collection, eq(collection.id, observation.collectionId))
      .where(and(eq(observation.recordId, recordId), eq(observation.contentState, 'verified')))
      // Drizzle has no COLLATE builder. The stored text order is bytewise.
      .orderBy(desc(sql`${collection.queriedAt} COLLATE "C"`), desc(observation.id)).limit(1).as('latest')
  const coordinates = (row: ReturnType<typeof latest>) => ({
    recordId: row.recordId, versionId: row.versionId, observationId: row.observationId, collectedAt: row.collectedAt,
  })
  const recognizedLatest = latest(recognized.recordId)
  const recognizedRows = await db.select({ ...coordinates(recognizedLatest),
    p: { usccRaw: recognized.usccRaw, titleRaw: recognized.titleRaw, nameRaw: recognized.nameRaw,
      // pg already decodes JSONB. Drizzle's column decoder parses scalar strings again.
      sourceValidFlag: sql<PlatformSourceCell>`${recognized.sourceValidFlag}`,
      qualificationFieldsRule: recognized.qualificationFieldsRule, sourceRecognizedAt: recognized.sourceRecognizedAt,
      sourceValidityDate: recognized.sourceValidityDate, sourceProvinceName: recognized.sourceProvinceName,
      sourceCityName: recognized.sourceCityName, sourceDistrictName: recognized.sourceDistrictName,
      sourceInvalidatedAt: recognized.sourceInvalidatedAt, sourceInvalidationReason: recognized.sourceInvalidationReason },
  }).from(recognized).innerJoinLateral(recognizedLatest, eq(recognizedLatest.versionId, recognized.versionId))
    .where(scope(recognized.usccRaw))
  const businessLatest = latest(business.recordId)
  const businessRows = await db.select({ ...coordinates(businessLatest),
    p: { usccRaw: business.usccRaw, titleRaw: business.titleRaw, nameRaw: business.nameRaw, declareKind: business.declareKind,
      status: business.status, businessYear: business.businessYear, appliedAt: business.appliedAt, province: business.province },
  }).from(business).innerJoinLateral(businessLatest, eq(businessLatest.versionId, business.versionId)).where(scope(business.usccRaw))
  const applyLatest = latest(apply.recordId)
  const applyRows = await db.select({ ...coordinates(applyLatest),
    p: { usccRaw: apply.usccRaw, titleRaw: apply.titleRaw, nameRaw: apply.nameRaw, declareKind: apply.declareKind,
      status: apply.status, declarationYear: apply.declarationYear, appliedAt: apply.appliedAt },
  }).from(apply).innerJoinLateral(applyLatest, eq(applyLatest.versionId, apply.versionId)).where(scope(apply.usccRaw))
  const facts: PlatformQualificationInputRow[] = [
    ...recognizedRows.map(row => ({
      ...row, source: 'recognized_list' as const, p: { ...row.p, sourceValidFlag: platformSourceCellValue(row.p.sourceValidFlag) },
    })),
    ...businessRows.map(row => ({ ...row, source: 'business_list' as const })),
    ...applyRows.map(row => ({ ...row, source: 'apply_list' as const })),
  ]
  const owners = new Map(codes.map(code => [code, new Set([byUscc.get(code)![0]!.id])]))
  for (const row of facts) {
    const fact = projectPlatformQualificationFact(row, owners)
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
