import { REVIEW_OUTCOMES } from '../labels'

export interface TimelineEventFacts {
  eventType: string
  year: number | null
  batchSeq: number | null
  decidedYear: number | null
  reviewOutcome: string | null
}

/**
 * 来源记录可以指向同一事件,但批次、原认定年和复核结论都是事件事实的一部分。
 * 只有这些事实完全相同的记录才会在企业时间轴上合并。
 */
export function timelineEventIdentity(titleCode: string, event: TimelineEventFacts): string {
  return JSON.stringify([
    titleCode,
    event.eventType,
    event.year,
    event.decidedYear,
    event.reviewOutcome,
    event.batchSeq,
  ])
}

/** 复核事件结论的短标签,未知结论保留为可见状态。 */
export function reviewOutcomeLabel(outcome: string | null): string {
  if (outcome == null) return '结论待核'
  const label = REVIEW_OUTCOMES[outcome]
  return label ? label.replace(/^复核/u, '') : `未知结论：${outcome}`
}

/** 时间轴同时说清复核结论、原认定年份和结论年份是否待核。 */
export function reviewEventSuffix(
  outcome: string | null,
  originalYear: number | null,
  decisionYearUnknown: boolean,
): string {
  const parts = [
    reviewOutcomeLabel(outcome),
    originalYear == null ? null : `原认定 ${originalYear}`,
    decisionYearUnknown ? '结论年份待核' : null,
  ].filter((part): part is string => part != null)
  return `（${parts.join(' · ')}）`
}
