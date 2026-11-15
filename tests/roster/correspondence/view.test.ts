import { describe, expect, it } from 'vitest'
import { classifyEventLinks, correspondenceStatusText, eventDecisionText, sourceReturnTarget, type CorrespondenceRef } from '../../../lib/roster/correspondence-view'

describe('record correspondence view contracts', () => {
  it('keeps later workflows independent from the event evidence and export context', () => {
    const links: Pick<CorrespondenceRef, 'id' | 'type' | 'eventId' | 'predecessorEventId'>[] = [
      { id: 1, type: 'event_process', eventId: 9, predecessorEventId: null },
      { id: 2, type: 'later_process', eventId: null, predecessorEventId: 9 },
      { id: 3, type: 'event_export_context', eventId: 9, predecessorEventId: null },
    ]
    const result = classifyEventLinks(9, links)
    expect(result.event.map(row => row.id)).toEqual([1, 3])
    expect(result.later.map(row => row.id)).toEqual([2])
  })

  it('distinguishes candidate, confirmed and revalidation without promoting candidates', () => {
    expect(correspondenceStatusText({ status: 'candidate', requiresRevalidation: false })).toBe('候选 · 待确认')
    expect(correspondenceStatusText({ status: 'confirmed', requiresRevalidation: true })).toBe('已确认 · 待重新核验')
    expect(correspondenceStatusText({ status: 'confirmed', requiresRevalidation: false })).toBe('已确认')
  })

  it('allows only a same-app comparison return target', () => {
    expect(sourceReturnTarget('/comparison?mode=record&queryIds=12')).toBe('/comparison?mode=record&queryIds=12')
    expect(sourceReturnTarget('https://other.test/comparison')).toBeNull()
    expect(sourceReturnTarget('//other.test/comparison')).toBeNull()
    expect(sourceReturnTarget('/comparison/../admin')).toBeNull()
  })

  it('names original award year and review decision year separately with a Chinese conclusion', () => {
    expect(eventDecisionText({ eventType: 'award', year: 2021, decidedYear: 2021, reviewOutcome: null })).toBe('认定 2021 年')
    expect(eventDecisionText({ eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'failed' })).toBe('原认定 2021 年 · 复核结论 2024 年 · 复核不通过')
    expect(eventDecisionText({ eventType: 'review', year: 2021, decidedYear: null, reviewOutcome: null })).toBe('原认定 2021 年 · 复核结论年份待核 · 复核结果待核')
  })
})
