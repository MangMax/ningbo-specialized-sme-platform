/** Explicit archival conversion only: never fetches, invents timestamps or infers identity. */
import { z } from 'zod'
import { platformQueryInputShape, platformQueryResultShape, recognizedConditionShape, validRecognizedConditionPairing, type PlatformLiveQueryResult } from './live-query'
import type { RosterImportPlatformQuery } from '../roster-import-client'
import { parsePlatformPage, type PlatformRawRow, type PlatformRow } from './adapter'

export const RDJB_TITLE_CODES: Record<string, string> = { '1': 'innovative_sme', '2': 'specialized_sme', '3': 'little_giant' }
export const TITLE_RDJB_CODES: Record<string, string> = Object.fromEntries(Object.entries(RDJB_TITLE_CODES).map(([rdjb, title]) => [title, rdjb]))
export const PLATFORM_PERSISTED_SOURCE = { queryList: 'apply_list', businessList: 'business_list', queryBusList: 'recognized_list' } as const
const resultSchema = z.object({ ...platformQueryResultShape, effectiveConditions: z.strictObject(platformQueryResultShape.effectiveConditions.shape) })
/** Saved source conditions have the same fields as a live request, but no live subject requirement. */
const archivedConditionsSchema = z.strictObject({
  source: z.literal('queryBusList'),
  ...recognizedConditionShape,
  name: platformQueryInputShape.name,
  uscc: platformQueryInputShape.uscc,
  rdjb: z.array(z.enum(['1', '2', '3'])).min(1).max(3).refine(values => new Set(values).size === values.length),
})
function subjectQueryKey(result: PlatformLiveQueryResult): string | null {
  return result.effectiveConditions.uscc ?? (result.effectiveConditions.name ? `name:${result.effectiveConditions.name}` : null)
}
function archiveQueryKey(result: PlatformLiveQueryResult): string {
  const subject = subjectQueryKey(result)
  if (subject !== null) return subject
  const filters = Object.entries(result.effectiveConditions)
    .filter(([key]) => key !== 'combination')
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return `scope:queryBusList:${result.titleScope.rdjb.join(',')}:${encodeURIComponent(JSON.stringify(filters))}`
}
export function recognizedStoredStatus(result: PlatformLiveQueryResult): NonNullable<RosterImportPlatformQuery['status']> {
  if (result.status === 'not_queried') return 'not_queried'
  if (['failed', 'auth_failed'].includes(result.status) && !result.rows.length) return 'failed'
  if (result.completeness === 'partial' || !result.fullRange) return 'partial'
  if (result.status === 'auth_failed') return 'failed'
  return result.status
}
export function sourcePositionForSequence(result: PlatformLiveQueryResult | null | undefined, sequenceNo: number): { sourceRdjb: string | null; sourcePage: number | null } {
  let offset = 0
  for (const page of result?.pages ?? []) {
    if (page.status !== 'success') continue
    offset += page.fetchedCount
    if (sequenceNo > 0 && sequenceNo <= offset) return { sourceRdjb: page.rdjb, sourcePage: page.page }
  }
  return { sourceRdjb: null, sourcePage: null }
}
export function recognizedEvidenceError(value: unknown): string | null {
  const parsed = resultSchema.safeParse(value)
  if (!parsed.success) return 'collectionEvidence requires the original query result, including times, conditions, pages, rows and unfinished positions'
  const r = parsed.data as PlatformLiveQueryResult
  // Validate against the original value: schema validation must not rewrite own
  // prototype-named JSON keys, nor infer types from old string-only evidence.
  const original = value as PlatformLiveQueryResult
  if (original.rawData) {
    const successful = original.pages.filter(page => page.status === 'success')
    if (original.rawData.pages.length !== successful.length || original.rawData.rows.length !== original.rows.length) return 'Raw observation pages/rows must cover every accepted page'
    const rawRows: PlatformRawRow[] = [], legacyRows: PlatformRow[] = []
    for (const [index, page] of original.rawData.pages.entries()) {
      const expected = successful[index]!
      if (page.source !== expected.source || page.rdjb !== expected.rdjb || page.page !== expected.page) return 'Raw observation source/title/page mismatch'
      try {
        const parsedPage = parsePlatformPage(page.body, 'businessGrid')
        if (parsedPage.source !== page.format || parsedPage.rows.length !== expected.fetchedCount
          || (parsedPage.responsePage !== null && parsedPage.responsePage !== expected.page)
          || (parsedPage.responsePageSize !== null && parsedPage.responsePageSize !== original.limits.pageSize)
          || parsedPage.declaredTotal !== expected.declaredTotal
          || (expected.maxPage != null && parsedPage.responseMaxPage !== expected.maxPage)) return 'Raw response format/count/pagination mismatch'
        rawRows.push(...parsedPage.rawRows)
        legacyRows.push(...parsedPage.rows)
      } catch { return 'Raw response cannot be parsed as original recognized evidence' }
    }
    if (JSON.stringify(rawRows) !== JSON.stringify(original.rawData.rows) || JSON.stringify(legacyRows) !== JSON.stringify(original.rows)) return 'Raw observations and legacy projection must match original responses'
  }
  if (r.source !== 'queryBusList') return 'recognized_list only accepts source=queryBusList'
  if (![r.queriedAt, r.completedAt].every(t => z.iso.datetime({ offset: true }).safeParse(t).success) || Date.parse(r.completedAt) < Date.parse(r.queriedAt)) return 'Original queriedAt/completedAt are required in order'
  const { combination, ...conditions } = r.effectiveConditions
  if (combination !== 'and' || !archivedConditionsSchema.safeParse({ source: r.source, ...conditions, rdjb: r.titleScope.rdjb }).success ||
    !validRecognizedConditionPairing(conditions)) return 'Invalid original source conditions or title scope'
  if (r.titleScope.mode !== 'selected') return 'queryBusList requires selected title scope'
  if (!Number.isInteger(r.limits.pageSize) || r.limits.pageSize < 1 || r.limits.pageSize > 50) return 'Invalid original page size'
  const titleSet = new Set(r.titleScope.rdjb)
  const last = new Map<string, number>()
  let fetched = 0
  for (const p of r.pages) {
    if (p.source !== r.source || !p.rdjb || !titleSet.has(p.rdjb)) return 'Page source/title mismatch'
    const previous = last.get(p.rdjb)
    if ((previous == null && r.fullRange && p.page !== 1) || (previous != null && p.page !== previous + 1)) return 'Pages must preserve contiguous original title/page positions'
    if (p.fetchedCount > r.limits.pageSize || (p.status !== 'success' && p.fetchedCount !== 0)) return 'Invalid page row count'
    last.set(p.rdjb, p.page)
    if (p.status === 'success') fetched += p.fetchedCount
  }
  if (fetched !== r.fetchedCount || fetched !== r.rows.length) return 'Page row counts must correspond exactly to original rows'
  if (r.declaredTotal != null && r.declaredTotal < fetched) return 'Declared total is smaller than fetched rows'
  for (const p of r.unfinished) if (p.source !== r.source || !p.rdjb || !titleSet.has(p.rdjb)) return 'Unfinished source/title mismatch'
  for (const rdjb of titleSet) {
    const pages = r.pages.filter(p => p.rdjb === rdjb)
    const lastPage = pages.at(-1)
    const totals = [...new Set(pages.flatMap(p => p.declaredTotal == null ? [] : [p.declaredTotal]))]
    const maxPages = [...new Set(pages.flatMap(p => p.maxPage == null ? [] : [p.maxPage]))]
    if (totals.length > 1 || maxPages.length > 1 || pages.some(p => p.maxPage != null && p.page > p.maxPage)) return 'Inconsistent original pagination metadata'
    if (pages.some((p, i) => p.status !== 'success' && i !== pages.length - 1)) return 'Failed page must end its archived title traversal'
    if (pages.some(p => p.status === 'success' && (
      (totals[0] != null && p.fetchedCount !== Math.min(r.limits.pageSize, Math.max(0, totals[0] - (p.page - 1) * r.limits.pageSize))) ||
      (maxPages[0] != null && p.page < maxPages[0] && p.fetchedCount !== r.limits.pageSize)
    ))) return 'Page row count does not match original page partition'
    if (totals[0] != null && maxPages[0] != null && maxPages[0] !== Math.max(1, Math.ceil(totals[0] / r.limits.pageSize))) return 'Declared total and terminal page disagree'
    const count = pages.reduce((sum, p) => sum + p.fetchedCount, 0)
    const consumed = count + (r.fullRange ? 0 : ((pages[0]?.page ?? 1) - 1) * r.limits.pageSize)
    const complete = lastPage?.status === 'success' && (totals[0] != null ? consumed === totals[0] : lastPage.maxPage != null ? lastPage.page === lastPage.maxPage : lastPage.fetchedCount === 0)
    if (r.completeness === 'complete' && !complete) return 'Missing terminal page/count proof for requested title; preserve as partial pending missing metadata'
    const unfinished = r.unfinished.filter(p => p.rdjb === rdjb)
    if (unfinished.length > 1 || (complete && unfinished.length)) return 'Unfinished range conflicts with completed title'
    if (r.completeness !== 'complete' && !complete && unfinished.length !== 1) return 'Every unfinished title must retain its next position'
    if (lastPage && unfinished[0] && unfinished[0].page !== lastPage.page + (lastPage.status === 'success' ? 1 : 0)) return 'Unfinished position must identify the actual next/failed page'
    if (!lastPage && r.fullRange && unfinished[0]?.page !== 1) return 'Unqueried title must start at page one'
  }
  if (r.completeness === 'complete') {
    if (r.unfinished.length || r.error || r.pages.some(p => p.status !== 'success') || last.size !== titleSet.size) return 'Complete evidence requires successful pages for every requested title and no unfinished ranges'
    if ((r.status !== 'success' && r.status !== 'no_record') || (r.status === 'no_record') !== (fetched === 0)) return 'Complete success/zero status does not match rows'
    if (r.declaredTotal != null && r.fullRange && r.declaredTotal !== fetched) return 'Complete evidence does not cover declared total'
  } else if (r.completeness === 'not_queried') {
    if (r.status !== 'not_queried' || r.pages.length || fetched || r.unfinished.length !== titleSet.size) return 'Not queried evidence cannot contain executed pages/rows'
  } else {
    if (!r.unfinished.length || !['partial', 'failed', 'auth_failed'].includes(r.status)) return 'Partial/failed evidence requires unfinished ranges and a matching status'
  }
  return null
}
/** A batch item is converted segment by segment, keeping every original segment time. */
export function recognizedResultToImport(result: PlatformLiveQueryResult): RosterImportPlatformQuery {
  const error = recognizedEvidenceError(result)
  if (error) throw new Error(error)
  return {
    interface: PLATFORM_PERSISTED_SOURCE.queryBusList,
    queryKey: archiveQueryKey(result),
    rdjb: result.titleScope.rdjb.join(','),
    titleCode: result.titleScope.rdjb.length === 1 ? RDJB_TITLE_CODES[result.titleScope.rdjb[0]!] : null,
    queriedAt: result.queriedAt, status: recognizedStoredStatus(result),
    failureReason: result.error?.message ?? null, collectionEvidence: result,
    relations: result.rows.map((rawFields, index) => ({
      sequenceNo: index + 1, relationKey: rawFields.id ?? null, usccRaw: rawFields.tyshxydm ?? null,
      nameRaw: rawFields.qymc ?? null, rawFields,
    })),
  }
}
