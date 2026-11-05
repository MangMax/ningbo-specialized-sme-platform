import { expect, it } from 'vitest'
import { adjudicateQualificationCycles, type QualificationEvent } from '../lib/roster/qualification-cycles'
const award: QualificationEvent = { id: 1, eventType: 'award', year: 2021, decidedYear: 2021, batchSeq: 1, reviewOutcome: null }
const review = (id: number, decidedYear: number, reviewOutcome: 'passed'|'failed' = 'passed'): QualificationEvent => ({ id, eventType: 'review', year: 2021, decidedYear, batchSeq: 1, reviewOutcome })
const judge = (events: QualificationEvent[], year: number, day = `${year}-06-01`) => adjudicateQualificationCycles(events, year, day).group
it('renews from each irregular pass without future-review gaps', () => {
  const events = [award, review(2, 2024), review(3, 2026)]
  expect([2024,2025,2026,2027,2028,2029].map(y => judge(events,y))).toEqual(['eligible','eligible','eligible','eligible','eligible','excluded'])
})
it('expires without results and restores only from the late pass', () => {
  expect([2023,2024,2025,2026,2028,2029].map(y => judge([award,review(2,2026)],y))).toEqual(['eligible','excluded','excluded','eligible','eligible','excluded'])
  expect(judge([award],2024)).toBe('excluded')
  expect(judge([award,review(2,2024)],2026)).toBe('eligible')
  expect(judge([award,review(2,2024)],2027)).toBe('excluded')
})
it('excludes explicit failure and permits a later passed review to restart validity', () => {
  expect(judge([award,review(2,2023,'failed')],2023)).toBe('excluded')
  expect(judge([award,review(2,2023,'failed'),review(3,2026)],2026)).toBe('eligible')
})
const source = { evidenceId: 1, sourceSha256: 'a'.repeat(64), statementPages: [1] }
it('honors the inclusive document interval before annual defaults and continuation', () => {
  const event = { ...award, formalValidity: { ...source, interval: { validFrom: '2022-02-01', validThrough: '2025-04-30' }, continuation: 'until_next_review_results' as const } }
  expect(['2022-01-31','2022-02-01','2025-04-30','2025-05-01'].map(day => judge([event],Number(day.slice(0,4)),day))).toEqual(['excluded','eligible','eligible','excluded'])
})
it('continues until the next result publication then applies that result', () => {
  const event = { ...award, formalValidity: { ...source, continuation: 'until_next_review_results' as const } }
  const next = { ...review(2,2026,'failed'), formalValidity: { ...source, publishedOn: '2026-09-01', continuation: 'until_this_review_results' as const, originAwardEventId: 1 } }
  expect(judge([event,next],2025)).toBe('eligible')
  expect(judge([event,next],2026,'2026-08-31')).toBe('eligible')
  expect(judge([event,next],2026,'2026-09-01')).toBe('excluded')
})
