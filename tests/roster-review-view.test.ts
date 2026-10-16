/**
 * 复核清单页的**页面行为**(RL-09)—— 纯函数层。
 *
 * 页面的三件事在这里定,也都是**用户可观察**的:
 *  1. 默认看**哪一年**(下一年度);
 *  2. 地址栏与页面状态怎么来回(刷新 / 分享 / 前进后退落到同一批结果);
 *  3. **导出的地址与列表的地址同源** —— 票面 #9 的「导出与页面筛选结果一致」,
 *     在页面上就是这一条:两个 URL 的筛选参数逐个相同,差别只有分页。
 *
 * 真排版的事实(窄屏溢出等)不在这里量 —— 那是 `scripts/verify-review-ui.mjs` 的活。
 */
import { describe, expect, it } from 'vitest'
import {
  REVIEW_PAGE_SIZE_PRESETS,
  DEFAULT_REVIEW_PAGE_SIZE,
  defaultTargetYear,
  reviewAnchorYearNote,
  reviewEvidenceText,
  reviewExportUrl,
  reviewListQuery,
  reviewPendingReasonLabels,
  reviewQueryFromState,
  reviewStateFromQuery,
  reviewTitleOptions,
  reviewYearOptions,
} from '../lib/roster/review-view'
import {
  REVIEW_PENDING_REASONS,
  REVIEW_PENDING_REASON_ORDER,
  REVIEW_STATUSES,
  REVIEW_STATUS_ORDER,
} from '../lib/labels'
import { REVIEW_PENDING_REASON_VALUES, REVIEW_STATUS_VALUES } from '../lib/roster/review-list'

/** 固定「现在」,用例不读系统时钟。 */
const NOW = '2026-10-16T00:00:00Z'

describe('默认目标年份 = 下一年', () => {
  it('2026 年的默认清单是 2027 年(清单是提前一年要办的事)', () => {
    expect(defaultTargetYear(NOW)).toBe(2027)
    expect(reviewStateFromQuery({}, NOW).year).toBe('2027')
  })
})

describe('地址栏 ⇄ 页面状态', () => {
  it('缺 year 用默认年;非法年份也退回默认年(不把页面打成空的)', () => {
    expect(reviewStateFromQuery({ year: 'abc' }, NOW).year).toBe('2027')
    expect(reviewStateFromQuery({ year: '2028' }, NOW).year).toBe('2028')
  })

  it('称号只认字典里的取值,未知的丢掉而不是带进请求(否则接口 400,页面白屏)', () => {
    const s = reviewStateFromQuery({ year: '2027', title: 'specialized_sme,nope' }, NOW)
    expect(s.title).toEqual(['specialized_sme'])
    expect(reviewStateFromQuery({ year: '2027', title: 'nope' }, NOW).title).toEqual([])
    expect(reviewStateFromQuery({ year: '2027', title: 'a,b' }, NOW).title).toEqual([])
  })

  it('status 只认 due / pending,未知退回 due', () => {
    expect(reviewStateFromQuery({ year: '2027', status: 'pending' }, NOW).status).toBe('pending')
    expect(reviewStateFromQuery({ year: '2027', status: 'nope' }, NOW).status).toBe('due')
  })

  it('pageSize 有上限,非法值退回默认', () => {
    expect(reviewStateFromQuery({ year: '2027', pageSize: '9999' }, NOW).pageSize).toBe(200)
    expect(reviewStateFromQuery({ year: '2027', pageSize: '0' }, NOW).pageSize).toBe(DEFAULT_REVIEW_PAGE_SIZE)
    expect(reviewStateFromQuery({ year: '2027', page: '-3' }, NOW).page).toBe(1)
  })

  it('回写地址时只写有值的东西:默认分层与默认每页不写进去', () => {
    const s = reviewStateFromQuery({ year: '2027' }, NOW)
    expect(reviewQueryFromState(s)).toEqual({ year: '2027' })
    const s2 = { ...s, status: 'pending' as const, title: ['little_giant'], page: 3, pageSize: 100 }
    expect(reviewQueryFromState(s2)).toEqual({
      year: '2027',
      title: 'little_giant',
      status: 'pending',
      page: '3',
      pageSize: '100',
    })
  })

  it('往返一致:state → 地址 → state 不变', () => {
    const s = reviewStateFromQuery({ year: '2029', title: 'innovative_sme', status: 'pending', page: '2' }, NOW)
    const back = reviewStateFromQuery(reviewQueryFromState(s) as Record<string, unknown>, NOW)
    expect(back).toEqual(s)
  })
})

describe('导出与列表同源(票面 #9 的「导出与页面筛选结果一致」)', () => {
  it('两个地址的筛选参数逐个相同,差别只有分页', () => {
    const s = reviewStateFromQuery(
      { year: '2027', title: 'specialized_sme,innovative_sme', status: 'pending', page: '4', pageSize: '25' },
      NOW,
    )
    const listUrl = new URLSearchParams(reviewListQuery(s))
    const exportUrl = new URL(reviewExportUrl(s), 'http://x')

    const exportParams = new URLSearchParams(exportUrl.search)
    // 导出不带分页(导的是当前筛选下的全部)
    expect(exportParams.has('page')).toBe(false)
    expect(exportParams.has('pageSize')).toBe(false)
    // 其余筛选参数与列表**逐字一致**(包括多值称号与分层)
    exportParams.delete('page')
    exportParams.delete('pageSize')
    expect(exportParams.get('year')).toBe(listUrl.get('year'))
    expect(exportParams.get('title')).toBe(listUrl.get('title'))
    expect(exportParams.get('status')).toBe(listUrl.get('status'))
    expect(exportUrl.pathname).toBe('/api/roster/reviews/export')
  })

  it('默认分层也要带上 —— 否则导出会比列表多出一整个「待确认」', () => {
    const s = reviewStateFromQuery({ year: '2027' }, NOW)
    const exportParams = new URLSearchParams(new URL(reviewExportUrl(s), 'http://x').search)
    expect(exportParams.get('status')).toBeNull() // 不写 = 接口默认 due,与列表一致
    expect(exportParams.get('year')).toBe('2027')
  })

  it('没有任何筛选时也给得出导出地址', () => {
    expect(reviewExportUrl({ year: '', title: [], status: 'due', page: 1, pageSize: 50 })).toBe(
      '/api/roster/reviews/export',
    )
  })
})

describe('控件候选', () => {
  it('目标年份候选覆盖默认年附近,并**总是带上当前那一年**(深链到范围外也不显示成别年)', () => {
    const options = reviewYearOptions('2022', NOW).map((o) => o.value)
    expect(options).toContain(2027) // 默认年(下一年)
    expect(options).toContain(2022) // 下界 = 默认年 − 5
    expect(options).toContain(2037) // 上界 = 默认年 + 10
    expect(options).toContain(2030) // 深链到默认范围之外的年份
    expect(options).toEqual([...options].sort((a, b) => a - b))
  })

  it('称号候选来自字典,顺序即展示顺序', () => {
    expect(reviewTitleOptions().map((o) => o.value)).toEqual([
      'little_giant',
      'specialized_sme',
      'innovative_sme',
    ])
  })

  it('每页候选里含默认值', () => {
    expect(REVIEW_PAGE_SIZE_PRESETS).toContain(DEFAULT_REVIEW_PAGE_SIZE)
  })
})

describe('展示文案', () => {
  it('出处写出文件 / 附件 / 序号 / 页;缺项不补、不猜', () => {
    expect(
      reviewEvidenceText({ sourceFile: 'jxj/a.pdf', attachment: '附件一', listNo: 74, page: 74 }),
    ).toBe('jxj/a.pdf / 附件一 / 序号74 / 第74页')
    expect(
      reviewEvidenceText({ sourceFile: 'jxj/a.docx', attachment: null, listNo: null, page: null }),
    ).toBe('jxj/a.docx')
  })

  it('锚点年份的来历如实写出来', () => {
    expect(reviewAnchorYearNote('decided_year')).toBe('按结论年份')
    expect(reviewAnchorYearNote('event_year')).toBe('按事件所涉年份')
  })

  it('待确认原因的文案取字典,顺序不变', () => {
    expect(reviewPendingReasonLabels(['no_batch', 'no_evidence'])).toEqual([
      '认定/复核事件缺批次序号',
      '认定/复核事件没有出处记录',
    ])
  })
})

describe('两张表与取值集不许漂移', () => {
  it('待确认原因的标签表 ↔ 读模型的取值:逐字一致', () => {
    expect([...Object.keys(REVIEW_PENDING_REASONS)].sort()).toEqual([...REVIEW_PENDING_REASON_VALUES].sort())
    expect([...REVIEW_PENDING_REASON_ORDER].sort()).toEqual([...REVIEW_PENDING_REASON_VALUES].sort())
    for (const code of REVIEW_PENDING_REASON_VALUES) {
      expect(REVIEW_PENDING_REASONS[code]).toBeTruthy()
    }
  })

  it('分层标签表的键 = 分层取值 = 展示顺序', () => {
    expect([...Object.keys(REVIEW_STATUSES)].sort()).toEqual([...REVIEW_STATUS_VALUES].sort())
    expect([...REVIEW_STATUS_ORDER].sort()).toEqual([...REVIEW_STATUS_VALUES].sort())
  })
})
