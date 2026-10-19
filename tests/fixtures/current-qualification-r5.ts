import type { Event } from '../helpers/current-export-118'
import type { QualificationCase } from './current-qualification-r4'

// Literal expectations from #116: no ID ordering and no inferred batch identity.
export function qualificationCasesR5(y: number): QualificationCase[] {
  const a = (year: number|null, batchSeq: number|null = 1, decidedYear: number|null = null): Event => ({eventType:'award',year,batchSeq,decidedYear})
  const r = (year: number|null, decidedYear: number|null, reviewOutcome: 'passed'|'failed'|null = 'passed', batchSeq: number|null = 1): Event => ({eventType:'review',year,decidedYear,reviewOutcome,batchSeq})
  const cases: QualificationCase[] = []
  for (const batch of [1,null]) for (const oldAward of [false,true]) {
    const prefix = `F-${batch ?? 'null'}-${oldAward ? 'award' : 'review-only'}`
    const old = oldAward ? [a(y-8)] : []
    const first = oldAward ? y-8 : y-1
    for (const [offset,sheet] of [[-2,'有效企业'],[-1,'待确认'],[0,'有效企业']] as const) {
      cases.push({id:prefix+'-failure-'+offset,events:[...old,r(y-8,y+offset,'failed',batch),a(y-1)],sheet,first,...(offset===-1?{note:'冲突'}:{})})
    }
    cases.push(
      {id:prefix+'-tie-only-pass',events:[...old,r(y-8,y-2,'failed',batch),a(y-2),r(y-2,y-1)],sheet:'待确认',first:oldAward?y-8:y-2,note:'冲突'},
      {id:prefix+'-tie-current-pass',events:[...old,r(y-8,y-1,'failed',batch),a(y-1),r(y-1,y)],sheet:'待确认',first,note:'冲突'},
      {id:prefix+'-tie-later-award',events:[...old,r(y-8,y-2,'failed',batch),a(y-2),a(y-2,1,y-1)],sheet:'有效企业',first:oldAward?y-8:y-2},
      {id:prefix+'-only-pass-no-restoring-award',events:[...old,r(y-8,y-2,'failed',batch),r(y-8,y-1)],sheet:'待确认',first:oldAward?y-8:null},
      {id:prefix+'-undated-failure-current-cycle',events:[...old,r(y-8,null,'failed',batch),a(y-8,1,y-1)],sheet:'待确认',first:oldAward?y-8:y-1,note:'结论'},
    )
  }
  for (const batch of [1,null]) cases.push(
    {id:`F-all-null-${batch ?? 'null'}-tie`,events:[a(y-8,null),r(y-8,y-1,'failed',batch),a(y-1,null)],sheet:'待确认',first:y-8,note:'冲突'},
    {id:`F-all-null-${batch ?? 'null'}-later-award`,events:[r(y-8,y-2,'failed',batch),a(y-1,null)],sheet:'有效企业',first:y-1},
    {id:`F-all-null-${batch ?? 'null'}-later-old-failure`,events:[r(y-8,y,'failed',batch),a(y-1,null)],sheet:'有效企业',first:y-1},
  )
  cases.push(
    {id:'G-fresh-known',events:[a(y-1)],sheet:'有效企业',first:y-1},
    {id:'G-fresh-null',events:[a(y-1,null)],sheet:'有效企业',first:y-1},
    {id:'G-fresh-known-null',events:[a(y-1),a(y-1,null)],sheet:'有效企业',first:y-1},
    {id:'G-fresh-known-null-second-batch',events:[a(y-1),a(y-1,null),a(y-1,2)],sheet:'有效企业',first:y-1},
    {id:'G-fresh-all-null',events:[a(y-1,null),a(y-1,null)],sheet:'有效企业',first:y-1},
    {id:'G-fresh-passed-known-null',events:[a(y-1),r(y-1,y),a(y-1,null)],sheet:'有效企业',first:y-1},
    {id:'G-consistent-passed-null-award',events:[r(y-4,y-1),r(y-4,y-1,'passed',2),a(y-4,null,y-1)],sheet:'有效企业',first:y-1},
    {id:'G-consistent-passed-no-award',events:[r(y-4,y-1),r(y-4,y-1,'passed',2)],sheet:'有效企业',first:null},
    {id:'G-consistent-failed-no-award',events:[r(y-4,y-1,'failed'),r(y-4,y-1,'failed',2)],sheet:'排除明细',first:null},
    {id:'G-consistent-failed-null-award',events:[r(y-4,y-1,'failed'),r(y-4,y-1,'failed',2),a(y-4,null,y-1)],sheet:'待确认',first:y-1},
    {id:'G-mixed-reviews-null-award',events:[r(y-4,y-1),r(y-4,y-1,'failed',2),a(y-4,null,y-1)],sheet:'待确认',first:y-1},
    {id:'G-unknown-review-null-award',events:[a(y-1),r(y-1,y,null),a(y-1,null)],sheet:'待确认',first:y-1,note:'结论'},
    {id:'G-null-review-known-award',events:[a(y-1),r(y-1,y,'passed',null)],sheet:'待确认',first:y-1,note:'批次'},
    {id:'G-null-passed-all-null',events:[r(y-4,y-1,'passed',null),r(y-4,y-1,'passed',null)],sheet:'待确认',first:null,note:'批次'},
    {id:'G-null-failed-all-null',events:[r(y-4,y-1,'failed',null),r(y-4,y-1,'failed',null)],sheet:'待确认',first:null,note:'批次'},
    {id:'G-consistent-passed-known-null',events:[r(y-4,y-1),r(y-4,y-1,'passed',null)],sheet:'待确认',first:null,note:'批次'},
    {id:'G-consistent-failed-known-null',events:[r(y-4,y-1,'failed'),r(y-4,y-1,'failed',null)],sheet:'待确认',first:null,note:'批次'},
    {id:'G-mixed-pass-fail-all-null',events:[r(y-4,y-1,'passed',null),r(y-4,y-1,'failed',null)],sheet:'待确认',first:null,note:'结论'},
    {id:'G-mixed-pass-unknown-all-null',events:[r(y-4,y-1,'passed',null),r(y-4,y-1,null,null)],sheet:'待确认',first:null,note:'结论'},
    {id:'G-undated-review-all-null',events:[r(y-4,null,'passed',null),r(y-4,y-1,'passed',null)],sheet:'待确认',first:null,note:'结论'},
    {id:'G-expired-reviews-all-null',events:[r(y-4,y-3,'passed',null),r(y-4,y-3,'passed',null)],sheet:'待确认',first:null,note:'批次'},
    {id:'G-expired-known-fresh-null',events:[a(y-4,1,y-3),a(y-4,null,y-1)],sheet:'待确认',first:y-3},
    {id:'G-fresh-known-expired-null',events:[a(y-4,1,y-1),a(y-4,null,y-3)],sheet:'待确认',first:y-3},
    {id:'G-expired-fresh-all-null',events:[a(y-4,null,y-3),a(y-4,null,y-1)],sheet:'待确认',first:y-3},
    {id:'G-expired-all-null',events:[a(y-3,null),a(y-3,null)],sheet:'待确认',first:y-3,note:'复核'},
    {id:'G-fresh-near-expiry-all-null',events:[a(y-4,null,y-2),a(y-4,null,y-1)],sheet:'有效企业',first:y-2},
    {id:'G-unknown-date-null-award',events:[a(y-1),a(null,null)],sheet:'待确认',first:null,note:'日期'},
    {id:'G-unknown-date-all-null',events:[a(y-1,null),a(null,null)],sheet:'待确认',first:null,note:'日期'},
    {id:'G-future-null-award',events:[a(y-1),a(y+1,null)],sheet:'待确认',first:y-1},
    {id:'G-unknown-review-date',events:[a(y-1),a(y-1,null),r(y-1,null)],sheet:'待确认',first:y-1,note:'结论'},
    {id:'G-old-unknown-review-neutral-null-award',events:[a(y-8,1,y-1),r(y-8,y-4,null,null),a(y-8,null,y-1)],sheet:'有效企业',first:y-1},
    {id:'G-null-award-before-ambiguous-failure',events:[a(y-8,1,y),r(y-8,y-1,'failed',null),a(y-8,null,y-2)],sheet:'待确认',first:y-2},
    {id:'G-null-award-same-ambiguous-failure',events:[a(y-8,1,y),r(y-8,y-1,'failed',null),a(y-8,null,y-1)],sheet:'待确认',first:y-1},
    {id:'G-null-award-after-ambiguous-failure',events:[a(y-8,1,y),r(y-8,y-2,'failed',null),a(y-8,null,y-1)],sheet:'有效企业',first:y-1},
    {id:'G-losing-batch-does-not-remove-current-failure',events:[a(y-1),r(y-1,y,'failed',null)],sheet:'待确认',first:y-1,note:'批次'},
  )
  return cases
}
