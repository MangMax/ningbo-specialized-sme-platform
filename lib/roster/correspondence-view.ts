/** Client read shape of #66's sanitized correspondence source routes. */
import { EVENTS, REVIEW_OUTCOMES } from '../../layers/sme-roster/lib/labels'
import type { OfficialPublishedFact } from '../../layers/sme-roster/lib/roster/official-published-presentation'
export type { OfficialPublishedFact }

export type PublishedPresentationError = 'invalid_scope' | 'source_limit' | 'field_limit' | 'response_limit' | 'read_failed'
export type PublishedPresentation =
  | { availability: 'available'; error: null; facts: OfficialPublishedFact[] }
  | { availability: 'unavailable'; error: PublishedPresentationError; facts: [] }

/** Literal raw names, including empty/whitespace; never infer an alias or legal rename. */
export function publishedNameText(fact: OfficialPublishedFact): string {
  if (fact.availability === 'unavailable') return '公布名称暂不可用'
  if (fact.availability === 'unknown_legacy') return '未逐出处核实'
  const name = fact.nameRaw === null ? '已捕获出处，名称原值未知' : `公布名称：${JSON.stringify(fact.nameRaw)}`
  return name + (fact.sourceBindingKnown ? '' : '（出处绑定未核实）')
}

export type SourceKind = 'event' | 'relation' | 'export_row'
export type CorrespondenceStatus = 'candidate' | 'confirmed' | 'rejected' | 'unlinked'
export type CorrespondenceType = 'event_process' | 'event_recognized' | 'later_process' | 'event_export_context' | 'process_export_context' | 'recognized_export'

export interface CorrespondenceRef {
  id: number
  type: CorrespondenceType
  role: string
  status: CorrespondenceStatus
  eventId: number | null
  predecessorEventId: number | null
  relationId: number | null
  exportRowId: number | null
  enterpriseId: number | null
  titleCode: string
  revision: number
  requiresRevalidation: boolean
}

export interface OfficialEvidence {
  publishedName?: OfficialPublishedFact
  id: number
  sourceFile: string
  attachment: string | null
  listNo: number | null
  page: number | null
}

export interface EventSource {
  publishedPresentation?: PublishedPresentation
  id: number
  recordId: number
  eventType: string
  year: number | null
  batchSeq: number | null
  decidedYear: number | null
  reviewOutcome: string | null
  record: { id: number; enterpriseId: number; titleCode: string; source: string; usccRaw: string | null }
  evidence: OfficialEvidence[]
  correspondences: CorrespondenceRef[]
}

export interface RelationSource {
  normalizationConflicts?: import('../platform/normalization').PlatformNormalizationConflict[]
  id: number
  queryId: number
  sequenceNo: number
  relationKey: string | null
  enterpriseId: number | null
  usccRaw: string | null
  nameRaw: string | null
  province: string | null
  status: string | null
  batch: string | null
  declareKind: string | null
  appliedAt: string | null
  awardBatchLabel: string | null
  year: number | null
  sourceRdjb: string | null
  sourcePage: number | null
  rawFields: Record<string, unknown> | null
  query: {
    id: number
    interface: string
    queryKey: string
    rdjb: string
    titleCode: string | null
    queriedAt: string
    status: string
    failureReason: string | null
    relationCount: number
    collectionEvidence: import('../platform/live-query').PlatformLiveQueryResult | null
    legacyProvenance?: import('../../layers/sme-roster/lib/roster/enterprise-roster').RosterPlatformQueryRow['legacyProvenance']
  }
  correspondences: CorrespondenceRef[]
}

export interface ExportRowSource {
  id: number
  batchId: number
  sourceRowNo: number
  usccRaw: string | null
  nameRaw: string | null
  district: string | null
  province: string | null
  city: string | null
  regStatus: string | null
  rawFields: Record<string, unknown> | null
  batch: {
    id: number
    titleCode: string
    year: number
    collectedOn: string
    originalFilename: string
    sha256: string
    rowCount: number
    importStatus: string
    replacedBatchId: number | null
  }
  correspondences: CorrespondenceRef[]
}

export interface CorrespondenceDetail extends CorrespondenceRef {
  ruleId: string
  ruleVersion: string
  createdAt: string
  decidedAt: string | null
  endedAt: string | null
  event: EventSource | null
  predecessorEvent: EventSource | null
  relation: RelationSource | null
  exportRow: ExportRowSource | null
}

/** Explicit `view=summary` list row. Source bodies are available through point/source reads. */
export type CorrespondenceSummary = Omit<CorrespondenceDetail, 'event' | 'predecessorEvent' | 'relation' | 'exportRow'>

export type SourceResponse =
  | { source: EventSource; correspondences: CorrespondenceDetail[] }
  | { source: RelationSource; correspondences: CorrespondenceDetail[] }
  | { source: ExportRowSource; correspondences: CorrespondenceDetail[] }

export function correspondenceSourceUrl(kind: SourceKind, id: number): string {
  const segment = { event: 'events', relation: 'relations', export_row: 'export-rows' }[kind]
  return `/api/roster/correspondences/${segment}/${id}`
}

export function classifyEventLinks<T extends Pick<CorrespondenceRef, 'id' | 'type' | 'eventId' | 'predecessorEventId'>>(eventId: number, links: T[]) {
  return {
    event: links.filter(link => link.eventId === eventId && link.type !== 'later_process'),
    later: links.filter(link => link.type === 'later_process' && link.predecessorEventId === eventId),
  }
}

export function correspondenceStatusText(link: Pick<CorrespondenceRef, 'status' | 'requiresRevalidation'>): string {
  const status = { candidate: '候选 · 待确认', confirmed: '已确认', rejected: '已拒绝', unlinked: '已解除' }[link.status]
  return link.requiresRevalidation ? `${status} · 待重新核验` : status
}

/** Formal event years have different meanings for an award and a review. */
export function eventDecisionText(event: Pick<EventSource, 'eventType' | 'year' | 'decidedYear' | 'reviewOutcome'>): string {
  if (event.eventType === 'review') {
    const outcome = event.reviewOutcome === 'failed' ? '复核不通过' : event.reviewOutcome === 'passed' ? REVIEW_OUTCOMES.passed : '复核结果待核'
    return `原认定 ${event.year ?? '年份待核'}${event.year == null ? '' : ' 年'} · ${event.decidedYear == null ? '复核结论年份待核' : `复核结论 ${event.decidedYear} 年`} · ${outcome}`
  }
  if (event.eventType === 'award') return `认定 ${event.year ?? '年份待核'}${event.year == null ? '' : ' 年'}${event.decidedYear != null && event.year !== event.decidedYear ? ` · 结论 ${event.decidedYear} 年` : ''}`
  return `${EVENTS[event.eventType] ?? '正式事件'} · ${event.year == null ? '年份待核' : `${event.year} 年`}`
}

export const CORRESPONDENCE_ROLES: Record<string, string> = {
  supports_award: '支持认定事件', supports_review: '支持复核事件', context_only: '同批次流程背景',
  recognized_corrob: '平台认定佐证', current_context: '当前平台认定背景',
  followup_apply: '后续申请', followup_update: '后续更新', followup_review: '后续复核',
  current_snapshot_context: '当前导出快照背景', same_current_row: '同一现状记录', candidate_same_current_row: '现状记录候选',
}

/** A comparison return is a path, never a caller supplied arbitrary URL. */
export function sourceReturnTarget(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\/comparison(?:\?|$)/.test(value)) return null
  if (value.includes('\\') || value.includes('#') || /[\x00-\x1f]/.test(value)) return null
  try {
    const parsed = new URL(value, 'https://local.invalid')
    return parsed.origin === 'https://local.invalid' && parsed.pathname === '/comparison' ? value : null
  } catch { return null }
}

/** Only typed formal scopes participate; raw platform fields are never inspected. */
export function sourcePublishedNamesUnavailable(value: SourceResponse): boolean {
  return ('publishedPresentation' in value.source && value.source.publishedPresentation?.availability === 'unavailable')
    || value.correspondences.some(row => row.event?.publishedPresentation?.availability === 'unavailable'
      || row.predecessorEvent?.publishedPresentation?.availability === 'unavailable')
}
