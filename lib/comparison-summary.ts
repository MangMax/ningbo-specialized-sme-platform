import { differenceEvidenceColumns } from './platform/difference-reference-target'
import { identityFunctions } from './roster/enterprise-read-snapshot'
import { inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { readComparisonTargetMemberships, type ComparisonDisposition } from './comparison-platform'
import { targetSchema as target } from './platform/target-schema'
import type { ComparisonDirection } from './comparison'
import type { TitleCode } from '../db/titles'
import { filterComparisonRows, type ComparisonRowFilter } from './comparison-filter'
import type { getCuratedComparison } from './curation'
import { reconcileKey, type ReconcileIndex } from './reconcile'
import { readQueryAssessmentSummaries, type QueryAssessmentSummary } from './roster/query-assessment'

export type ComparisonSummaryDisposition = Pick<ComparisonDisposition,
  'explanationId' | 'status' | 'reasonCode' | 'measureCode' | 'verificationStatus' | 'recordedAt' | 'evidenceQueryId' | 'evidenceRelationId'>

/** Explicit summary DTO: no notes, aliases, queries, relations or collection/cache originals. */
export interface ComparisonSummaryRow {
  enterpriseId: number
  name: string
  nameNorm: string
  uscc: string | null
  district: string | null
  titleCode: TitleCode
  direction: ComparisonDirection
  curated: boolean
  evidenceIncluded: false
  detailUrl: string
  explanation: { code: string } | null
  /** Independent coverage, decision lifecycle and validity; no evidence payload. */
  assessment: QueryAssessmentSummary
  platform: {
    aliasCount: number
    confirmedAliasCount: number
    queryCount: number
    /** All original source rows of included queries, irrespective of confirmed ownership. */
    sourceRelationCount: number
    disposition: ComparisonSummaryDisposition
  }
}

/**
 * Keep global/filter counts on narrow SQL projections. Only the selected page gets
 * relation counts and a response DTO; never hydrate platform or cache originals.
 * The base comparison/curation reader already projects record/enterprise scalars.
 */
export function readComparisonSummary(
  db: BetterSQLite3Database<typeof schema>,
  result: ReturnType<typeof getCuratedComparison>,
  reconcile: ReconcileIndex,
  filter: ComparisonRowFilter,
  page: number,
  pageSize: number,
) {
  const ids = [...new Set(result.rows.map(row => row.enterpriseId))]
  const aliases = ids.length ? db.select({
    enterpriseId: schema.enterpriseAlias.enterpriseId,
    name: schema.enterpriseAlias.name,
    verificationStatus: schema.enterpriseAlias.verificationStatus,
  }).from(schema.enterpriseAlias).where(inArray(schema.enterpriseAlias.enterpriseId, ids)).all() : []
  const aliasesByEnterprise = new Map<number, typeof aliases>()
  for (const alias of aliases) {
    const bucket = aliasesByEnterprise.get(alias.enterpriseId) ?? []
    bucket.push(alias)
    aliasesByEnterprise.set(alias.enterpriseId, bucket)
  }

  // Match the legacy inclusion union: related enterprise OR its own query key.
  // Neither a candidate relation nor an own-key match confirms identity.
  if (ids.length) identityFunctions(db)
  const memberships = readComparisonTargetMemberships(db, ids)
  const queriesByEnterprise = new Map<number, number[]>()
  for (const member of memberships) {
    const bucket = queriesByEnterprise.get(member.enterpriseId) ?? []
    bucket.push(member.queryId)
    queriesByEnterprise.set(member.enterpriseId, bucket)
  }

  // Select no reason/measure notes or JSON actor/basis/history fields.
  const dispositions = ids.length ? db.select({
    enterpriseId: schema.differenceReason.enterpriseId,
    titleCode: schema.differenceReason.titleCode,
    direction: schema.differenceReason.direction,
    explanationId: schema.differenceReason.id,
    status: schema.differenceReason.status,
    reasonCode: schema.differenceReason.reasonCode,
    measureCode: schema.differenceReason.measureCode,
    verificationStatus: schema.differenceReason.verificationStatus,
    recordedAt: schema.differenceReason.recordedAt,
    ...differenceEvidenceColumns(db),
  }).from(schema.differenceReason).where(inArray(schema.differenceReason.enterpriseId, ids)).all() : []
  const current = new Map<string, ComparisonSummaryDisposition>()
  for (const { enterpriseId, titleCode, direction, ...disposition } of dispositions) {
    const key = `${enterpriseId}|${titleCode}|${direction}`
    const previous = current.get(key)
    if (!previous?.recordedAt || previous.recordedAt < disposition.recordedAt) current.set(key, disposition)
  }
  const defaultDisposition: ComparisonSummaryDisposition = {
    explanationId: null, status: 'not_queried', reasonCode: null, measureCode: null,
    verificationStatus: 'pending', recordedAt: null, evidenceQueryId: null, evidenceRelationId: null,
  }
  const scoped = filterComparisonRows(result.rows.map(row => ({ ...row,
    platform: { aliases: aliasesByEnterprise.get(row.enterpriseId) ?? [] },
  })), filter)
  const selected = scoped.slice((page - 1) * pageSize, page * pageSize)
  const assessments = readQueryAssessmentSummaries(db, selected.map(row => ({
    enterpriseId: row.enterpriseId, titleCode: row.titleCode, direction: row.direction,
  })))
  const selectedQueryIds = [...new Set(selected.flatMap(row => queriesByEnterprise.get(row.enterpriseId) ?? []))]
  const relationCounts = new Map<number, number>()
  // Bound bind parameters even for an enterprise with a long query history.
  for (let start = 0; start < selectedQueryIds.length; start += 500) {
    const qa = target.platformLegacyQueryAlias, o = target.platformBusinessObservation
    const counts = db.select({ queryId: qa.oldId, count: sql<number>`count(*)` })
      .from(o).innerJoin(qa, sql`${qa.collectionId}=${o.collectionId}`)
      .where(inArray(qa.oldId, selectedQueryIds.slice(start, start + 500))).groupBy(qa.oldId).all()
    for (const row of counts) relationCounts.set(row.queryId, row.count)
  }
  const explanationFor = (row: typeof scoped[number]) => reconcile.entries.get(reconcileKey(row))
  const dispositionFor = (row: typeof scoped[number]) => current.get(`${row.enterpriseId}|${row.titleCode}|${row.direction}`) ?? defaultDisposition
  const withExplanation = scoped.filter(row => dispositionFor(row).explanationId != null).length
  const rows: ComparisonSummaryRow[] = selected.map((row, index) => ({
    enterpriseId: row.enterpriseId, name: row.name, nameNorm: row.nameNorm, uscc: row.uscc,
    district: row.district, titleCode: row.titleCode, direction: row.direction, curated: row.curated,
    evidenceIncluded: false,
    detailUrl: `/api/comparison?view=full&enterpriseId=${row.enterpriseId}&title=${row.titleCode}&direction=${row.direction}&showCurated=true`,
    explanation: explanationFor(row) ? { code: explanationFor(row)!.explanation.code } : null,
    assessment: assessments[index]!,
    platform: {
      aliasCount: row.platform.aliases.length,
      confirmedAliasCount: row.platform.aliases.filter(alias => alias.verificationStatus === 'confirmed').length,
      queryCount: queriesByEnterprise.get(row.enterpriseId)?.length ?? 0,
      sourceRelationCount: (queriesByEnterprise.get(row.enterpriseId) ?? []).reduce((sum, id) => sum + (relationCounts.get(id) ?? 0), 0),
      disposition: dispositionFor(row),
    },
  }))
  return {
    view: 'summary' as const, rows, total: scoped.length, counts: result.counts, curatedCounts: result.curatedCounts,
    platform: {
      withEvidence: scoped.filter(row => dispositionFor(row).explanationId != null || row.platform.aliases.length > 0 || queriesByEnterprise.has(row.enterpriseId)).length,
      withExplanation, withoutExplanation: scoped.length - withExplanation,
    },
    reconcile: { generatedAt: reconcile.generatedAt, matched: scoped.filter(row => explanationFor(row)).length },
  }
}
