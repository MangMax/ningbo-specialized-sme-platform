import { EVENTS, REVIEW_OUTCOMES } from '../labels'

/** Minimal display facts only. Locators stay on the caller's existing evidence. */
export type OfficialPublishedFact = {
  evidenceId: number; eventId: number
} & (
  | { availability: 'captured'; revision: number; nameRaw: string | null; sourceBindingKnown: boolean }
  | { availability: 'unknown_legacy' | 'unavailable'; revision: null; nameRaw: null; sourceBindingKnown: null }
)

/** Literal raw names, including empty/whitespace; never infer an alias or legal rename. */
export function publishedNameText(fact: OfficialPublishedFact): string {
  if (fact.availability === 'unavailable') return '公布名称暂不可用'
  if (fact.availability === 'unknown_legacy') return '未逐出处核实'
  const name = fact.nameRaw === null ? '已捕获出处，名称原值未知' : `公布名称：${JSON.stringify(fact.nameRaw)}`
  return name + (fact.sourceBindingKnown ? '' : '（出处绑定未核实）')
}

/** Formal event years have different meanings for an award and a review. */
export function eventDecisionText(event: { eventType: string; year: number | null; decidedYear: number | null; reviewOutcome: string | null }): string {
  if (event.eventType === 'review') {
    const outcome = event.reviewOutcome === 'failed' ? '复核不通过' : event.reviewOutcome === 'passed' ? REVIEW_OUTCOMES.passed : '复核结果待核'
    return `原认定 ${event.year ?? '年份待核'}${event.year == null ? '' : ' 年'} · ${event.decidedYear == null ? '复核结论年份待核' : `复核结论 ${event.decidedYear} 年`} · ${outcome}`
  }
  if (event.eventType === 'award') return `认定 ${event.year ?? '年份待核'}${event.year == null ? '' : ' 年'}${event.decidedYear != null && event.year !== event.decidedYear ? ` · 结论 ${event.decidedYear} 年` : ''}`
  return `${EVENTS[event.eventType] ?? '正式事件'} · ${event.year == null ? '年份待核' : `${event.year} 年`}`
}
