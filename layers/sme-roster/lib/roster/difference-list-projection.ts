import type { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import type { platformCollection } from '../../../../db/postgresql/platform-tables'
import type { publicVersion102 } from '../../server/utils/decision-lifecycle/contract'
import type { DifferenceQualification } from './current-difference'
import type { ComparisonRow } from '../comparison-model'
import { normalizeName } from '../domain'
import { TITLE_ORDER } from '../labels'
import { MAX_PAGE_SIZE } from '../query-limits'
import type { RosterDifferenceFilter, RosterDifferencesResult } from './enterprise-roster-projection'
import type { QueryAssessment } from './query-assessment'

const keyOf = (r: { enterpriseId: number; titleCode: string; direction: string }) => JSON.stringify([r.enterpriseId, r.titleCode, r.direction])
const rank = (title: string) => { const i = TITLE_ORDER.indexOf(title); return i < 0 ? TITLE_ORDER.length : i }

type Head = Pick<typeof differenceReason.$inferSelect, 'id' | 'enterpriseId' | 'titleCode' | 'direction' | 'status' | 'reasonCode'>
type Enterprise = { id: number; name: string; uscc: string | null }
export function selectRosterDifferencePage(filter: RosterDifferenceFilter, derived: ComparisonRow[], heads: Head[],
  enterprises: Map<number, Enterprise>, aliases: Map<number, string[]>,
) {
  const current = new Map(heads.map(r => [keyOf(r), r]))
  const derivedKeys = new Set(derived.map(keyOf))
  const coordinates = new Map([...derived, ...heads].map(r => [keyOf(r), { enterpriseId: r.enterpriseId, titleCode: r.titleCode, direction: r.direction }]))
  const needle = filter.q?.trim() ? normalizeName(filter.q) : null
  const usccNeedle = filter.q?.trim() ? filter.q.trim().toUpperCase() : null
  const rows = [...coordinates.values()].map(r => {
    const head = current.get(keyOf(r)), enterprise = enterprises.get(r.enterpriseId)
    return { ...r, name: enterprise?.name ?? '', uscc: enterprise?.uscc ?? null, explanationId: head?.id ?? null, status: head?.status ?? 'not_queried', reasonCode: head?.reasonCode ?? null, inCurrentDifference: derivedKeys.has(keyOf(r)) }
  }).filter(r =>
    (!filter.title?.length || filter.title.includes(r.titleCode)) &&
    (!filter.direction?.length || filter.direction.includes(r.direction)) &&
    (!filter.status?.length || filter.status.includes(r.status)) &&
    (!filter.reason?.length || r.reasonCode != null && filter.reason.includes(r.reasonCode)) &&
    (!(needle || usccNeedle) || needle != null && (normalizeName(r.name).includes(needle) || (aliases.get(r.enterpriseId) ?? []).some(a => a.includes(needle))) || usccNeedle != null && (r.uscc ?? '').toUpperCase().includes(usccNeedle)),
  ).sort((a, b) => rank(a.titleCode) - rank(b.titleCode) || a.direction.localeCompare(b.direction) || a.name.localeCompare(b.name) || a.enterpriseId - b.enterpriseId)
  const counts = Object.fromEntries(TITLE_ORDER.map(t => [t, { missing_in_miit: 0, extra_in_miit: 0 }])) as RosterDifferencesResult['counts']
  for (const r of rows) { counts[r.titleCode] ??= { missing_in_miit: 0, extra_in_miit: 0 }; counts[r.titleCode]![r.direction]++ }
  const page = Number.isFinite(filter.page) && filter.page! >= 1 ? Math.floor(filter.page!) : 1
  const pageSize = Math.min(Number.isFinite(filter.pageSize) && filter.pageSize! >= 1 ? Math.floor(filter.pageSize!) : 50, MAX_PAGE_SIZE)
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, counts }
}

type Page = ReturnType<typeof selectRosterDifferencePage>
type Explanation = Parameters<typeof publicVersion102>[0]
type Query = Pick<typeof platformCollection.$inferSelect, 'id' | 'queriedAt' | 'interface' | 'status' | 'failureReason'>
export function projectRosterDifferenceList(page: Page, selected: (Page['rows'][number] & DifferenceQualification)[],
  explanations: Map<number, Explanation>, districts: Map<number, string | null>, queries: Map<number, Query>, relations: Map<number, number[]>,
  assessments: QueryAssessment[],
): RosterDifferencesResult {
  return { ...page, rows: selected.map((r, i) => {
      const explanation = r.explanationId == null ? null : explanations.get(r.explanationId)!
      const query = explanation?.evidenceQueryId == null ? null : queries.get(explanation.evidenceQueryId)
      const movedIn = explanation && ([explanation.movedInCity, explanation.movedInTitleCode, explanation.movedInYear, explanation.movedInBatch].some(v => v != null) || explanation.reasonCode === 'moved_in')
        ? { city: explanation.movedInCity, titleCode: explanation.movedInTitleCode, year: explanation.movedInYear, batch: explanation.movedInBatch, complete: [explanation.movedInCity, explanation.movedInTitleCode, explanation.movedInYear, explanation.movedInBatch].every(v => v != null) } : null
      return { ...r, district: districts.get(r.enterpriseId) ?? null, reasonNote: explanation?.reasonNote ?? null, measureCode: explanation?.measureCode ?? null, measureNote: explanation?.measureNote ?? null, movedIn,
        ...(explanation?.factReferences?.length ? { factReferences: explanation.factReferences } : {}),
        verificationStatus: explanation?.verificationStatus ?? 'pending', recordedAt: explanation?.recordedAt ?? null,
        evidence: query ? { queryId: query.id, queriedAt: query.queriedAt, interface: query.interface, status: query.status, failureReason: query.failureReason, relationIds: relations.get(query.id) ?? [] } : null,
        ...assessments[i]!,
      }
    }) }
}
