import type { ComparisonDisposition } from './comparison-platform-projection'
import type { ComparisonDirection } from './comparison-model'
import type { TitleCode } from '../../../db/titles'
import { filterComparisonRows, type ComparisonRowFilter } from './comparison-filter'
import type { projectCuratedComparison } from './curation-model'
import { reconcileKey, type ReconcileIndex } from './reconcile'
import type { QueryAssessmentSummary } from './roster/query-assessment'

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

type SummaryAlias = { enterpriseId: number; name: string; verificationStatus: string }
type CuratedComparison = ReturnType<typeof projectCuratedComparison>

export function filterCuratedComparison(result: CuratedComparison, filter: ComparisonRowFilter, aliasesByEnterprise: ReadonlyMap<number, SummaryAlias[]>) {
  return filterComparisonRows(result.rows.map(row => ({ ...row,
    platform: { aliases: aliasesByEnterprise.get(row.enterpriseId) ?? [] },
  })), filter)
}

export function selectComparisonSummaryPage(result: CuratedComparison, filter: ComparisonRowFilter, page: number, pageSize: number, aliasesByEnterprise: ReadonlyMap<number, SummaryAlias[]>) {
  const scoped = filterCuratedComparison(result, filter, aliasesByEnterprise)
  return { scoped, selected: scoped.slice((page - 1) * pageSize, page * pageSize) }
}

type SummaryInput = ReturnType<typeof selectComparisonSummaryPage>['selected']
export type SummaryDisposition = Omit<ComparisonSummaryDisposition, 'recordedAt'> & {
  enterpriseId: number; titleCode: string; direction: string; recordedAt: string
}

export function projectComparisonSummary(result: CuratedComparison, reconcile: ReconcileIndex,
  scoped: SummaryInput, selected: SummaryInput, dispositions: readonly SummaryDisposition[],
  queriesByEnterprise: ReadonlyMap<number, number[]>, relationCounts: ReadonlyMap<number, number>, assessments: readonly QueryAssessmentSummary[]) {
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
