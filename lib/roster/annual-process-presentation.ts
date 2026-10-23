import type { PlatformBusinessGroup } from '../platform/business-record'
import { PLATFORM_INTERFACES } from '../labels'

/** UI presentation input, deliberately independent of the annual HTTP DTO.
 * The HTTP adapter must use the official DTO after its dependency is integrated.
 * No business eligibility is computed here. */
export interface AnnualTimelineObservation {
  relationId: number
  queryId: number
  row: number
  queriedAt: string
  decision: string
  revision: number | null
}
export interface AnnualTimelineStep {
  id: string
  appliedAt: string | null
  status: string | null
  observedAt: string | null
  businessKey: string | null
  reasons: string[]
  sources: { key: string; interfaceLabel: string; recordLabel: string; observations: AnnualTimelineObservation[] }[]
}
export interface AnnualTimelineView {
  eventId: number
  generation: string
  title: string
  matter: string
  year: number | null
  latestStepId: string | null
  steps: AnnualTimelineStep[]
  reasons: string[]
  coverage: string[]
  qualification: {
    eventId: number
    generation: string
    stepId: string | null
    status: 'confirmed' | 'eligible' | 'blocked' | 'none'
    reasons: string[]
  } | null
  page: number
  pageSize: number
  total: number
}

/** A candidate or a historical task result can never light the final marker. */
export function confirmedAnnualStep(view: AnnualTimelineView): string | null {
  const qualification = view.qualification
  return qualification?.status === 'confirmed'
    && !!view.generation
    && qualification.eventId === view.eventId
    && qualification.generation === view.generation
    && qualification.stepId === view.latestStepId
    ? qualification.stepId : null
}

export function orderedAnnualSteps(steps: AnnualTimelineStep[]): AnnualTimelineStep[] {
  // The backend owns business ordering/eligibility; this only orders the visible
  // page for reading. Unknown application dates remain visible, at the end.
  const instant = (value: string | null) => {
    if (!value) return Number.POSITIVE_INFINITY
    const normalized = value.replace(' ', 'T')
    const parsed = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized.length === 10 ? `${normalized}T00:00:00` : normalized}Z`)
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
  }
  return [...steps].sort((a, b) => instant(a.appliedAt) - instant(b.appliedAt))
}

/** View lifecycle, not a backend job state. In particular done != synced. */
export type AnnualReviewPhase = 'checking' | 'read-only' | 'submitting' | 'unknown' | 'running' | 'syncing' | 'synced' | 'sync-failed' | 'failed' | 'cancelled' | 'blocked'

/** Use each observation's actual decisions. Group summaries are never proof
 * that another observation has a confirmed/rejected/unlinked correspondence. */
export function presentAnnualSources(groups: PlatformBusinessGroup[]): AnnualTimelineStep['sources'] {
  const statuses = { candidate: '已登记候选', confirmed: '已确认（有效性见原行）', rejected: '已否定对应', unlinked: '已取消对应' }
  return groups.map(group => {
    const record = group.businessRecord
    return {
      key: `${record.interface}:${record.recordId ?? 'row'}:${record.versionId ?? 'unknown'}:${group.representativeRelationId}`,
      interfaceLabel: PLATFORM_INTERFACES[record.interface] ?? '平台接口',
      recordLabel: record.recordId == null || record.versionId == null
        ? '业务记录或版本未索引' : `业务记录 ${record.recordId} · 版本 ${record.versionId}`,
      observations: group.observationRefs.map(observation => {
        const own = observation.existingCorrespondences.filter(decision => decision.relationId === observation.relationId)
        return {
          relationId: observation.relationId, queryId: observation.queryId, row: observation.sequenceNo, queriedAt: observation.queriedAt,
          decision: own.length ? own.map(decision => `#${decision.id} ${decision.endedAt ? '历史' : ''}${statuses[decision.status]}${own.length > 1 ? ` · 修订 ${decision.revision}` : ''}`).join('；') : '未登记决定',
          revision: own.length === 1 ? own[0]!.revision : null,
        }
      }),
    }
  })
}
