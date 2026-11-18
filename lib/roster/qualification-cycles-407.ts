import type { FormalValidity } from './formal-validity'
import type { LifecycleEvent } from '../../layers/sme-roster/lib/roster/lifecycle'

/** Original-award cycle adjudication shared by planning and current eligibility.
 * No database or presentation facts enter this module. Infinity means a plan,
 * not current eligibility: future facts are retained and expiry is not applied. */
type CurrentGroup = 'eligible' | 'pending' | 'excluded'
export type QualificationEvent = LifecycleEvent & { batchSeq: number | null; formalValidity?: FormalValidity; validityInvalid?: boolean; recordId?: number }
export interface CycleJudgment {
  anchor: QualificationEvent | null
  originYear: number
  batch: number | null
  lastAwardYear: number
  failureYears: number[]
  group: CurrentGroup
  notes: string[]
  awardEventIds: number[]
}
type EventTime = LifecycleEvent
export const awardTime = (e: EventTime) => e.decidedYear ?? e.year
export const originTime = (e: EventTime) => e.year ?? (e.eventType === 'award' ? awardTime(e) : null)
export const factTime = (e: EventTime) => e.eventType === 'award' ? awardTime(e) : e.decidedYear
interface CycleFacts {
  awards: QualificationEvent[]
  passed: QualificationEvent[]
  failed: QualificationEvent[]
  gaps: QualificationEvent[]
  failureYears: number[]
  lastAward: number
  lastPassed: number
  lastFailure: number
}
const latestFact = (events: QualificationEvent[]) => Math.max(...events.map(e => factTime(e)!))
function hasUsableTime(event: QualificationEvent, originYear: number, year: number) {
  const time = factTime(event)
  return time != null && originYear <= time && time <= year
}

/** Separate known facts from uncertain facts before deciding whether a gap matters. */
function cycleFacts(events: QualificationEvent[], ambiguous: QualificationEvent[], originYear: number, year: number, day?: string): CycleFacts {
  const awards: QualificationEvent[] = [], passed: QualificationEvent[] = [], failed: QualificationEvent[] = [], gaps = [...ambiguous]
  for (const event of events) {
    if (day && event.eventType === 'review' && event.formalValidity?.publishedOn && event.formalValidity.publishedOn > day) continue
    const batchKnown = event.batchSeq != null || event.eventType === 'award' || !!(day && event.formalValidity?.originAwardEventId)
    if (!hasUsableTime(event,originYear,year) || !batchKnown) gaps.push(event)
    else if (event.eventType === 'award') awards.push(event)
    else if (event.reviewOutcome === 'passed') passed.push(event)
    else if (event.reviewOutcome === 'failed') failed.push(event)
    else gaps.push(event)
  }
  // A known failure date survives uncertain batch applicability. It is still a
  // temporal witness for cross-cycle recovery, even when this cycle has a gap.
  const failureYears = [...events,...ambiguous].filter(e => e.eventType === 'review' && e.reviewOutcome === 'failed' && hasUsableTime(e,originYear,year)).map(e => e.decidedYear!)
  return {awards,passed,failed,gaps,failureYears,lastAward:latestFact(awards),lastPassed:latestFact(passed),lastFailure:latestFact(failed)}
}

/** A gap only yields to a later fact that neutralizes every possible effect.
 * A grant restores, a final failure terminates, and a pass only extends: it
 * cannot neutralize an earlier possible failure. Equal years prove no order.
 */
function gapResolvedBy(gap: QualificationEvent, facts: CycleFacts, originYear: number, year: number): string | null {
  if (!hasUsableTime(gap,originYear,year)) return null
  const time = factTime(gap)!
  if (time < facts.lastAward) return '后续明确重新认定'
  // A termination/renewal only settles its own known batch. An ambiguous batch
  // might refer to a different batch with a different validity window.
  if (gap.batchSeq != null && time < facts.lastFailure && facts.lastFailure > facts.lastAward && facts.lastFailure > facts.lastPassed) return '较晚明确终止'
  return null
}

/** Adjudicate an originating cycle using only applicable, unresolved evidence. */
function adjudicateCycle(events: QualificationEvent[], originYear: number, batch: number | null, year: number, ambiguous: QualificationEvent[] = [], day?: string): CycleJudgment {
  const facts = cycleFacts(events,ambiguous,originYear,year,day)
  // Only the latest actual grant can support a restored qualification. Older
  // grants remain in the adjudication and evidence history, but not filters.
  const anchor = [...facts.awards,...facts.passed].sort((a,b) => factTime(a)! - factTime(b)! || a.id - b.id).at(-1) ?? null
  const result: CycleJudgment = {anchor,originYear,batch,lastAwardYear:facts.lastAward,failureYears:facts.failureYears,group:'pending',notes:[],awardEventIds:facts.awards.filter(e => awardTime(e) === facts.lastAward).map(e => e.id)}
  const unresolved: QualificationEvent[] = []
  for (const gap of facts.gaps) {
    const resolved = gapResolvedBy(gap,facts,originYear,year)
    if (resolved) result.notes.push(`旧缺口 event:${gap.id}（日期/批次/结论）由${resolved}消解，历史及出处保留`)
    else unresolved.push(gap)
  }
  if (day && [...events,...ambiguous].some(e => e.validityInvalid)) result.notes.push('正式有效期来源或原周期引用已失效，待核')
  else if (originYear > year) result.notes.push('原认定年份尚未生效，当前周期待确认')
  else if (unresolved.length) {
    for (const event of unresolved) result.notes.push(`event:${event.id} ${event.eventType === 'award' ? '认定日期/批次' : '复核结论/结论年份/批次'}不完整或无法证明被后续事实消解，当前周期待确认`)
  } else if (facts.lastFailure >= facts.lastAward && facts.failed.length) {
    if (facts.lastFailure === facts.lastAward || facts.lastPassed >= facts.lastFailure) result.notes.push('对应周期失败与通过/认定恢复冲突；未确认重新认定恢复，待确认')
    else { result.group='excluded'; result.notes.push('对应认定周期复核明确不通过，未见后续重新认定恢复') }
  } else {
    // A pass only extends a settled cycle. Expiry is a current-qualification
    // concern; planning omits its cutoff while retaining all recovery/gap guards.
    const dueYear = anchor ? factTime(anchor)! + 3 : null
    const fact = day ? anchor?.formalValidity : undefined
    const futureReviewGrace = day && anchor?.eventType === 'award' && events.some(e => e.eventType === 'review' && e.formalValidity?.continuation === 'until_this_review_results' && e.formalValidity.publishedOn && day < e.formalValidity.publishedOn && e.formalValidity.originAwardEventId === anchor.id)
    if (futureReviewGrace && (!fact?.interval || fact.interval.validFrom <= day!)) result.group='eligible'
    else if (day && fact?.interval) {
      if (fact.interval.validFrom <= day && (day <= fact.interval.validThrough || fact.continuation === 'until_next_review_results' && (!fact.publishedOn || fact.publishedOn <= day))) result.group='eligible'
      else result.notes.push('不在正式来源明确有效日期闭区间内，待确认后续资格')
    } else if (day && fact?.continuation === 'until_next_review_results' && (!fact.publishedOn || fact.publishedOn <= day)) result.group='eligible'
    else if (dueYear != null && (year === Infinity || dueYear > year)) result.group='eligible'
    else result.notes.push('已到复核年份，未见明确延续结果，待确认')
  }
  return result
}

function hasUnresolvedRecovery(current: CycleJudgment[], history: CycleJudgment[]) {
  for (const cycle of current) {
    // A definite final termination no longer depends on whether the earlier
    // grant restored eligibility. Otherwise only the last grant is applicable.
    if (cycle.group === 'excluded') continue
    for (const older of history) {
      if (older.originYear < cycle.originYear && older.failureYears.includes(cycle.lastAwardYear)) return true
    }
  }
  return false
}

export function adjudicateQualificationCycles(formal: QualificationEvent[], year = Infinity, day?: string): { group: CurrentGroup; notes: string[]; originYear: number; cycles: CycleJudgment[] } {
  const byYear = new Map<number, Map<number | null, QualificationEvent[]>>()
  const unknown: QualificationEvent[] = []
  const linked = day ? formal.filter(e => e.eventType === 'review' && e.formalValidity?.originAwardEventId) : []
  for (const event of formal) {
    if (linked.includes(event)) continue
    const origin = originTime(event)
    if (origin == null) { unknown.push(event); continue }
    let batches = byYear.get(origin)
    if (!batches) { batches = new Map(); byYear.set(origin,batches) }
    const events = batches.get(event.batchSeq) ?? []
    events.push(event); batches.set(event.batchSeq,events)
  }
  const judgments = [...byYear].flatMap(([origin,batches]) => {
    const known = [...batches].filter(([batch]) => batch != null)
    const unassigned = batches.get(null) ?? []
    const grants = unassigned.filter(e => e.eventType === 'award')
    const reviews = unassigned.filter(e => e.eventType === 'review')
    // Retain the possibility that each unassigned grant is a separate batch;
    // do not borrow it to repair a known batch. Each possible batch must also
    // withstand the unassigned reviews. If all are eligible, merging any subset
    // of these grants into an eligible batch cannot invalidate it. This proves
    // eligibility without choosing a batch or enumerating partitions. An expired
    // or unresolved separate grant keeps its effect instead of vanishing in the
    // latest known grant. Unknown reviews remain applicability gaps.
    const possible = [
      ...known.map(([batch,events]) => adjudicateCycle([...events,...linked.filter(e => events.some(a => a.id === e.formalValidity!.originAwardEventId))],origin,batch,year,reviews,day)),
      ...grants.map(grant => adjudicateCycle([grant,...linked.filter(e => e.formalValidity!.originAwardEventId === grant.id)],origin,null,year,reviews,day)),
    ]
    return possible.length ? possible : [adjudicateCycle(reviews,origin,null,year,[],day)]
  })
  // Selection follows adjudication, retains *every* batch of the current year,
  // and never uses the latest passed event to erase another batch or a failure.
  const originYear = Math.max(...judgments.map(c => c.originYear))
  const current = judgments.filter(c => c.originYear === originYear)
  const notes = current.flatMap(c => c.notes.map(note => `${c.originYear}年/批次${c.batch ?? '?'}：${note}`))
  let group: CurrentGroup = current[0]?.group ?? 'pending'
  if (!current.length) notes.push('缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格')
  if (new Set(current.map(c => c.group)).size > 1) { group='pending'; notes.push('同年各批次裁定不一致，保留全部批次的结论及未决缺口') }
  // A new award may resolve old unknown-origin history. A renewal never supplies
  // this recovery boundary, even if its conclusion is more recent.
  const latestAward = Math.max(...judgments.map(c => c.lastAwardYear))
  const unknownReviews = unknown.filter(e => e.eventType === 'review')
  const relevantUnknown = unknownReviews.filter(e => e.decidedYear == null || e.decidedYear >= latestAward)
  if (unknownReviews.length > relevantUnknown.length) notes.push('较早复核原周期未知；后续明确新认定恢复，旧缺口及出处保留')
  if (relevantUnknown.length) { group='pending'; notes.push('复核对应原认定周期未知，待确认') }
  if (unknown.some(e => e.eventType === 'award')) { group='pending'; notes.push('认定日期缺失，当前周期待确认') }
  // Preserve #116's same-year re-award ordering boundary, using actual award
  // dates and already partitioned older cycles, never a renewal's anchor year.
  if (hasUnresolvedRecovery(current,judgments)) { group='pending'; notes.push('同年认定恢复与旧周期失败结论顺序冲突，待确认') }
  return { group, notes, originYear, cycles: current }
}
