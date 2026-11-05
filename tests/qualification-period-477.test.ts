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
it('ignores unpublished failure when adjudicating same-year independent re-award recovery', () => {
  const failure = { ...review(2,2026,'failed'), formalValidity: { ...source, publishedOn: '2027-01-01', continuation: 'until_this_review_results' as const, originAwardEventId: 1 } }
  const events = [award, failure, { ...award, id: 3, year: 2026, decidedYear: 2026 }]
  expect(['2026-06-01','2026-12-31','2027-01-01','2027-01-02'].map(day => judge(events,Number(day.slice(0,4)),day))).toEqual(['eligible','eligible','pending','pending'])
})
it('continues a renewed cycle until the linked result publication', () => {
  const next = { ...review(3,2027,'failed'), formalValidity: { ...source, publishedOn: '2027-09-01', continuation: 'until_this_review_results' as const, originAwardEventId: 1 } }
  const events = [award, review(2,2023), next]
  expect(['2026-06-01','2027-08-31','2027-09-01','2027-09-02'].map(day => judge(events,Number(day.slice(0,4)),day))).toEqual(['eligible','eligible','excluded','excluded'])
})
it('prioritizes the renewed anchor interval over linked continuation at inclusive boundaries', () => {
  const pass = { ...review(2,2023), formalValidity: { ...source, interval: { validFrom: '2026-04-01', validThrough: '2026-05-31' } } }
  const next = { ...review(3,2027,'failed'), formalValidity: { ...source, publishedOn: '2027-09-01', continuation: 'until_this_review_results' as const, originAwardEventId: 1 } }
  expect(['2026-03-31','2026-04-01','2026-05-31','2026-06-01'].map(day => judge([award,pass,next],2026,day))).toEqual(['excluded','eligible','eligible','excluded'])
})
it('does not borrow continuation from another award cycle or override a published failure', () => {
  const next = { ...review(3,2027,'failed'), formalValidity: { ...source, publishedOn: '2027-09-01', continuation: 'until_this_review_results' as const, originAwardEventId: 1 } }
  expect(judge([award,review(2,2023),next,{ ...award,id:4,year:2022,decidedYear:2022 }],2026)).toBe('excluded')
  expect(judge([award,review(2,2023),next,review(4,2025,'failed')],2026)).toBe('excluded')
})
it('effective mode retains known failure across batches and missing batch, then permits later recovery', () => {
 const a={...award,year:2025,decidedYear:2025}
 const fail={...review(3,2026,'failed'),year:2025,batchSeq:2}
 const effective=(events:QualificationEvent[],y=2026)=>adjudicateQualificationCycles(events,y,`${y}-11-05`,true).group
 expect(effective([a,{...a,id:2,batchSeq:2},fail])).toBe('excluded')
 expect(effective([a,{...fail,batchSeq:null}])).toBe('excluded')
 expect(effective([a,{...fail,batchSeq:null,reviewOutcome:'passed'}])).toBe('eligible')
 expect(effective([a,{...fail,batchSeq:null}],2025)).toBe('eligible')
 expect(effective([a,{...fail,batchSeq:null},{...review(4,2027),year:2025,batchSeq:null}],2027)).toBe('eligible')
 expect(effective([a,fail,{...a,id:5,year:2027,decidedYear:2027}],2027)).toBe('eligible')
})
it('effective mode accepts passed review without origin coordinates but never unknown or failed outcome',()=>{
 for(const outcome of ['passed','failed',null] as const){
 const e={...review(9,2026),year:null,batchSeq:null,reviewOutcome:outcome,formalValidity:{...source,continuation:'until_next_review_results' as const}}
 expect(adjudicateQualificationCycles([e],2026,'2026-11-05',true).group).toBe(outcome==='passed'?'eligible':'excluded')
 }
})
it('effective failure priority starts at publication rather than the unpublished decision year', () => {
  const next = { ...review(2,2026,'failed'), formalValidity: { ...source, publishedOn: '2026-09-01', continuation: 'until_this_review_results' as const, originAwardEventId: 1 } }
  expect(['2026-08-31','2026-09-01'].map(day => adjudicateQualificationCycles([award,next],2026,day,true).group)).toEqual(['eligible','excluded'])
})
