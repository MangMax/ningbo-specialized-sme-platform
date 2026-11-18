import type { PlatformBusinessGroup } from '../platform/business-record'
import type { EventAnnualProcessPage } from './annual-process'
import { PLATFORM_INTERFACES, PLATFORM_QUERY_STATUSES, TITLES } from '../../layers/sme-roster/lib/labels'

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
  latestStatus?: string | null
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

const annualReasons: Record<string, string> = {
  official_business_year_missing: '正式来源缺少本次业务结论年，请补充正式来源；不会借用原认定年。',
  official_event_type_unsupported: '本次正式事项尚不能按年度过程核对。',
  official_result_missing: '正式复核结论未记录，请补充正式来源。',
  platform_year_missing: '平台业务年度未记录，尚不能确认归属本年度。',
  process_type_unknown: '平台事项未明确，认定、复核与更新暂不能混用。',
  application_time_unknown: '申报时间未记录或无法核实，尚不能判断业务先后。',
  identity_unknown: '企业身份依据尚待核实。',
  business_identity_unverified: '平台业务身份或版本尚未核实，请核对原行。',
  observation_time_unknown: '归档观察时间未明确，尚不能判断最新观察。',
  latest_application_time_tied: '多笔业务的最晚申报时间相同，尚不能确定唯一年度末态。',
  latest_status_missing: '最新归档观察未记录办理状态。',
  latest_status_not_terminal: '平台年度末态尚未形成可对应的终审结论，保留全部年度过程。',
  official_result_mismatch: '平台年度末态与正式公布结果不相符，尚无最终结果。',
  latest_observation_conflict: '最新归档观察的办理状态存在真实差异，请核对原行。',
  latest_source_conflict: '最新归档来源存在冲突，请核对原行。',
  stable_source_conflict: '业务来源中的身份或固定事实存在冲突，请核对原行。',
  potential_later_business_unresolved: '仍有可能影响年度末态的业务缺少依据，请先补齐。',
  potential_later_title_unknown: '可能存在后续业务的称号归属未明确，尚不能确认年度末态。',
  no_annual_process: '尚无可归属本年度事项的已归档业务过程。',
  latest_archive_incomplete: '最新查询归档失败或未完整返回，尚不能确认年度末态。',
  archive_failed: '查询归档曾失败，请结合各次查询来源核对。',
  archive_partial: '查询归档包含部分结果，不能据此判断全部业务。',
  archive_range_incomplete: '查询范围未完整覆盖。',
  archive_range_unknown: '旧归档未记录完整范围证明，不能据此声称平台已全部查完。',
  source_generation_changed: '正式来源或平台归档已变化，旧任务结果不能确认本次年度资格。',
  event_unavailable: '本次正式事件当前不可读取。',
  protected_decision: '保留已有人工决定，不自动覆盖或重新建立已否定、取消的对应。',
  decision_required: '当前年度业务尚缺有效确认决定。',
  source_requires_revalidation: '来源已变化，原对应需重新核验。',
  explicit_endpoint_required: '当前业务缺少可核实的选定来源，请核对接口原行。',
  source_materialization_limit: '来源原档暂不能完整读取，请补充可核验来源。',
  annual_event_failed: '本事件年度核对未完成，已完成的历史决定保留。',
  annual_task_interrupted: '年度核对执行中断，已完成的历史决定保留，可按当前来源重试。',
}
const annualFields: Record<string, string> = { year: '业务年度', declareKind: '事项', appliedAt: '申报时间', province: '属地', batch: '维护批次', awardBatchLabel: '认定批次' }
export function annualReasonText(code: string): string {
  if (annualReasons[code]) return annualReasons[code]!
  const field = code.endsWith('_conflict') ? annualFields[code.slice(0, -9)] : undefined
  return field ? `${field}存在真实来源差异，请核对原行。` : '仍有年度依据待核，请核对原行和查询来源。'
}
export function presentAnnualProcess(page: EventAnnualProcessPage): AnnualTimelineView {
  const process = page.process
  return {
    eventId: process.event.id, generation: page.sourceGeneration,
    title: TITLES[process.event.record.titleCode] ?? '称号待核',
    matter: process.event.eventType === 'review' ? '复核' : '认定', year: process.businessYear,
    latestStepId: process.latestStepId, latestStatus: process.latestStepSummary?.status ?? null,
    steps: process.steps.map(step => ({ id: step.id, appliedAt: step.appliedAt, status: step.status, observedAt: step.observedAt,
      businessKey: step.businessKey, reasons: step.reasons.map(annualReasonText), sources: presentAnnualSources(step.groups) })),
    reasons: [...new Set([...process.reasons, ...(process.scopeGaps ?? []).flatMap(gap => gap.reasons)])].map(annualReasonText),
    coverage: [...process.coverage.map(query => `${PLATFORM_INTERFACES[query.interface] ?? '平台接口'} · 查询 #${query.queryId} · ${query.queriedAt} · ${PLATFORM_QUERY_STATUSES[query.status] ?? '状态待核'}${query.fullRange === false ? ' · 范围未完整覆盖' : ''}`), ...process.coverageReasons.map(annualReasonText)],
    qualification: process.finalQualification ? { eventId: process.event.id, generation: page.sourceGeneration,
      stepId: process.finalQualification.stepId, status: process.finalQualification.status, reasons: process.finalQualification.reasons.map(annualReasonText) } : null,
    page: page.page, pageSize: page.pageSize, total: page.total,
  }
}
