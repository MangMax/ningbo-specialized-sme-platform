export const HEADERS_409 = ['序号','企业名称','统一社会信用代码','区县','称号','首次认定年份','认定及复核情况','公布名称','已确认曾用名','公布对应情况','情况说明','来源及页码']
export const X409 = { name: '已注销但存在独立未决主体事实', eligible: '正式有效控制', pending: '独立待核控制' } as const

// Independent business oracle: no production qualification/projection helpers.
export const B409 = {
  asOf: '2026-10-29T00:00:00.000Z',
  name: 'B409同主体三称号隔离',
  award: [{ eventType: 'award', year: 2026, batchSeq: 1 }],
  pending: [{ eventType: 'review', year: 2022, batchSeq: 1, decidedYear: null, reviewOutcome: null }],
  failed: [{ eventType: 'review', year: 2022, batchSeq: 1, decidedYear: 2025, reviewOutcome: 'failed' }],
  titles: [
    { title: 'little_giant', path: 'little-giant', group: 'eligible', sheet: '有效企业', label: '专精特新“小巨人”', qualification: '2026年第1批认定', counts: { eligible: 201, pending: 0, excluded: 0 } },
    { title: 'specialized_sme', path: 'specialized-sme', group: 'pending', sheet: '待确认', label: '专精特新中小企业', qualification: '2022年第1批原认定批次，结论年份待核复核结论待核', counts: { eligible: 0, pending: 1, excluded: 0 } },
    { title: 'innovative_sme', path: 'innovative-sme', group: 'excluded', sheet: '排除明细', label: '创新型中小企业', qualification: '2022年第1批原认定批次，2025年复核未通过', counts: { eligible: 0, pending: 0, excluded: 1 } },
  ],
} as const
export const B409_TAIL_NAMES = Array.from({ length: 200 }, (_, i) => 'B409尾成员' + String(i).padStart(3, '0'))
