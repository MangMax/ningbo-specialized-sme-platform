import type { Event } from '../helpers/current-export-118'

export type QualificationCase = {
  id: string
  events: Event[]
  sheet: '有效企业' | '待确认' | '排除明细'
  first: number | null
  note?: string
  missing?: number[]
}
export function qualificationCasesR4(y: number): QualificationCase[] {
  const a = (year: number|null, batchSeq: number|null = 1, decidedYear: number|null = null): Event => ({eventType:'award',year,batchSeq,decidedYear})
  const r = (year: number|null, decidedYear: number|null, reviewOutcome: 'passed'|'failed'|null = 'passed', batchSeq: number|null = 1): Event => ({eventType:'review',year,decidedYear,reviewOutcome,batchSeq})
  return [
    {id:'A-batches-passed',events:[a(y-4),a(y-4,2),r(y-4,y-1),r(y-4,y-1,'passed',2)],sheet:'有效企业',first:y-4},
    {id:'A-batches-failed',events:[a(y-4),a(y-4,2),r(y-4,y-1,'failed'),r(y-4,y-1,'failed',2)],sheet:'排除明细',first:y-4},
    {id:'A-batches-fresh',events:[a(y-1),a(y-1,2)],sheet:'有效企业',first:y-1},
    {id:'A-batches-mixed',events:[a(y-4),a(y-4,2),r(y-4,y-1),r(y-4,y-1,'failed',2)],sheet:'待确认',first:y-4,note:'批次'},
    {id:'A-batches-no-review',events:[a(y-4),a(y-4,2),r(y-4,y-1)],sheet:'待确认',first:y-4,note:'复核'},
    {id:'A-batches-unknown',events:[a(y-4),a(y-4,2),r(y-4,y-1),r(y-4,y-1,null,2)],sheet:'待确认',first:y-4,note:'结论'},
    {id:'A-batches-undated',events:[a(y-4),a(y-4,2),r(y-4,y-1),r(y-4,null,'passed',2)],sheet:'待确认',first:y-4,note:'结论'},
    {id:'B-later-reaward-resolves-tie',events:[a(y-16),r(y-16,y-4,'failed'),a(y-4),a(y-4,1,y-1)],sheet:'有效企业',first:y-16},
    {id:'B-later-terminal-resolves-tie',events:[a(y-16),r(y-16,y-4,'failed'),a(y-4),r(y-4,y-1,'failed')],sheet:'排除明细',first:y-16},
    {id:'B-only-same-year-reaward',events:[a(y-16),r(y-16,y-4,'failed'),a(y-4)],sheet:'待确认',first:y-16,note:'冲突'},
    {id:'B-later-passed-does-not-resolve-tie',events:[a(y-16),r(y-16,y-4,'failed'),a(y-4),r(y-4,y-1)],sheet:'待确认',first:y-16,note:'冲突'},
    {id:'C-unknown-before-failed',events:[a(y-8),r(y-8,y-4,null),r(y-8,y-1,'failed')],sheet:'排除明细',first:y-8,note:'旧缺口'},
    {id:'C-unknown-before-award',events:[a(y-8),r(y-8,y-6,null),a(y-8,1,y-1)],sheet:'有效企业',first:y-8,note:'旧缺口'},
    {id:'C-unknown-and-failed-before-award',events:[a(y-8),r(y-8,y-5,null),r(y-8,y-4,'failed'),a(y-8,1,y-1)],sheet:'有效企业',first:y-8},
    {id:'C-batch-gap-before-award',events:[a(y-8),r(y-8,y-6,'failed',null),a(y-8,1,y-1)],sheet:'有效企业',first:y-8,note:'旧缺口'},
    {id:'C-unknown-before-only-passed',events:[a(y-8),r(y-8,y-6,null),r(y-8,y-1)],sheet:'待确认',first:y-8,note:'结论'},
    {id:'C-failed-then-only-passed',events:[a(y-8),r(y-8,y-4,'failed'),r(y-8,y-1)],sheet:'待确认',first:y-8,note:'恢复'},
    {id:'C-unknown-same-year-award',events:[a(y-8),r(y-8,y-1,null),a(y-8,1,y-1)],sheet:'待确认',first:y-8,note:'结论'},
    {id:'C-unknown-after-award',events:[a(y-8),a(y-8,1,y-2),r(y-8,y-1,null)],sheet:'待确认',first:y-8,note:'结论'},
    {id:'C-undated-unknown-with-award',events:[a(y-8),r(y-8,null,null),a(y-8,1,y-1)],sheet:'待确认',first:y-8,note:'结论'},
    {id:'C-unknown-same-year-failed',events:[a(y-8),r(y-8,y-1,null),r(y-8,y-1,'failed')],sheet:'待确认',first:y-8,note:'结论'},
    {id:'C-unknown-after-failed',events:[a(y-8),r(y-8,y-2,'failed'),r(y-8,y-1,null)],sheet:'待确认',first:y-8,note:'结论'},
    {id:'C-undated-unknown-with-failed',events:[a(y-8),r(y-8,null,null),r(y-8,y-1,'failed')],sheet:'待确认',first:y-8,note:'结论'},
    {id:'C-old-pass-gap-before-current-pass',events:[a(y-8),r(y-8,y-4,'passed',null),r(y-8,y-1)],sheet:'待确认',first:y-8,note:'批次'},
    {id:'C-failed-batch-gap-before-only-passed',events:[a(y-8),r(y-8,y-4,'failed',null),r(y-8,y-1)],sheet:'待确认',first:y-8,note:'批次'},
    {id:'C-batch-gap-before-failed',events:[a(y-8),r(y-8,y-2,null,null),r(y-8,y-1,'failed')],sheet:'待确认',first:y-8,note:'批次'},
    {id:'D-old-unproven-award-before-renewal',events:[a(y-8,1,y-3),r(y-4,y-1)],missing:[0],sheet:'有效企业',first:null,note:'首次'},
    {id:'D-old-proven-award-before-renewal',events:[a(y-8,1,y-3),r(y-4,y-1)],sheet:'有效企业',first:y-3},
    {id:'D-old-unproven-award-same-year-renewal',events:[a(y-8,1,y-1),r(y-4,y-1)],missing:[0],sheet:'有效企业',first:null},
    {id:'D-old-proven-award-same-year-renewal',events:[a(y-8,1,y-1),r(y-4,y-1)],sheet:'有效企业',first:y-1},
    {id:'D-old-unproven-award-after-renewal',events:[a(y-8,1,y),r(y-4,y-1)],missing:[0],sheet:'有效企业',first:null},
    {id:'D-old-proven-award-after-renewal',events:[a(y-8,1,y),r(y-4,y-1)],sheet:'有效企业',first:y},
    {id:'D-independent-renewal-only',events:[r(y-4,y-1)],sheet:'有效企业',first:null},
    {id:'D-unproven-current-award',events:[a(y-4,1,y-3),r(y-4,y-1)],missing:[0],sheet:'待确认',first:null,note:'出处'},
    {id:'D-unproven-current-review',events:[a(y-4),r(y-4,y-1)],missing:[1],sheet:'待确认',first:y-4,note:'出处'},
    {id:'D-unproven-unknown-origin-award',events:[a(null),r(y-4,y-1)],missing:[0],sheet:'待确认',first:null,note:'出处'},
    {id:'D-old-unproven-review-after-renewal',events:[a(y-8),r(y-8,y,'failed'),r(y-4,y-1)],missing:[1],sheet:'有效企业',first:y-8},
    {id:'R3-cross-cycle-same-conclusion',events:[a(y-8),a(y-5),r(y-8,y-1,'failed'),r(y-5,y-1)],sheet:'有效企业',first:y-8},
    {id:'R3-independent-failure-then-passed',events:[a(y-16),r(y-8,y-4,'failed'),r(y-8,y-1)],sheet:'待确认',first:y-16,note:'恢复'},
  ]
}
