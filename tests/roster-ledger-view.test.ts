import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LEDGER_VIEW,
  EMPTY_LEDGER_STATE,
  LEDGER_VIEWS,
  filtersForView,
  LEDGER_VIEW_FILTERS,
  ledgerExportLabel,
  ledgerExportUrl,
  ledgerListQuery,
  ledgerQueryFromState,
  ledgerStateFromQuery,
  parseLedgerView,
  VIEW_PARAM,
  type LedgerState,
} from '../lib/roster/ledger-view'

/**
 * RL-17 合并台账的**视图 ↔ 筛选 ↔ 导出**映射。
 *
 * 两条最容易被忽略、坏掉也看不出来的性质,在这一层钉住:
 *  1. 「筛选与导出同口径」—— 导出 URL 与列表查询**由同一份 state 派生**,
 *     这里断言两者的参数集合逐字一致(导出不多也不少)。
 *  2. 「切换分组不换人」—— `按企业` 与 `按企业×称号` 的记录侧判据
 *     (`source` / `eventType` / `year`)必须逐字一致。
 */

const ALL_ON: LedgerState = {
  q: '宁波',
  title: ['little_giant', 'innovative_sme'],
  district: '余姚市',
  rosterState: 'current',
  source: ['miit'],
  eventType: ['award'],
  year: ['2023', '2024'],
  firstYear: ['2021'],
  firstStatus: ['pending'],
  direction: 'missing_in_miit',
  status: ['needs_review'],
  reason: ['platform_stale'],
}

describe('parseLedgerView', () => {
  it('缺省 / 空 / 不认识的值一律回到企业粒度', () => {
    expect(parseLedgerView(undefined)).toBe('enterprise')
    expect(parseLedgerView('')).toBe('enterprise')
    expect(parseLedgerView('   ')).toBe('enterprise')
    expect(parseLedgerView('nothing')).toBe('enterprise')
    expect(DEFAULT_LEDGER_VIEW).toBe('enterprise')
  })

  it('三个视图都认得', () => {
    for (const v of LEDGER_VIEWS) expect(parseLedgerView(v)).toBe(v)
  })
})

describe('ledgerStateFromQuery —— 地址栏读回', () => {
  it('多值按逗号分隔读回,空串当没筛', () => {
    const state = ledgerStateFromQuery({
      q: ' 宁波 ',
      title: 'little_giant,innovative_sme',
      district: '',
      source: 'miit',
      year: '2023,2024',
      direction: 'extra_in_miit',
    })
    expect(state.q).toBe('宁波')
    expect(state.title).toEqual(['little_giant', 'innovative_sme'])
    expect(state.district).toBe('')
    expect(state.source).toEqual(['miit'])
    expect(state.year).toEqual(['2023', '2024'])
    expect(state.direction).toBe('extra_in_miit')
    expect(state.status).toEqual([])
  })

  it('重复参数也认(与全部读接口的 parseCsvQuery 同一处规则)', () => {
    expect(ledgerStateFromQuery({ title: ['little_giant', 'innovative_sme'] }).title).toEqual([
      'little_giant',
      'innovative_sme',
    ])
  })

  it('首次认定两个判据能从地址栏读回(深链与「返回不丢上下文」)', () => {
    const state = ledgerStateFromQuery({ firstYear: '2021,2022', firstStatus: 'pending' })
    expect(state.firstYear).toEqual(['2021', '2022'])
    expect(state.firstStatus).toEqual(['pending'])
    // 没给就是没筛,不是默认塞一个值进去。
    expect(ledgerStateFromQuery({}).firstYear).toEqual([])
    expect(ledgerStateFromQuery({}).firstStatus).toEqual([])
  })
})

describe('ledgerQueryFromState —— 回写地址栏', () => {
  it('默认视图不写 view;别的视图写', () => {
    expect(ledgerQueryFromState('enterprise', EMPTY_LEDGER_STATE)[VIEW_PARAM]).toBeUndefined()
    expect(ledgerQueryFromState('title', EMPTY_LEDGER_STATE)[VIEW_PARAM]).toBe('title')
    expect(ledgerQueryFromState('difference', EMPTY_LEDGER_STATE)[VIEW_PARAM]).toBe('difference')
  })

  it('没筛的项不写进地址(免得分享出一串空参数)', () => {
    expect(ledgerQueryFromState('enterprise', EMPTY_LEDGER_STATE)).toEqual({})
  })

  it('两个分组拿到的记录侧判据逐字一致(切换分组不换人)', () => {
    const a = ledgerQueryFromState('enterprise', ALL_ON)
    const b = ledgerQueryFromState('title', ALL_ON)
    for (const key of ['q', 'title', 'source', 'eventType', 'year']) {
      expect(a[key]).toEqual(b[key])
    }
  })

  it('企业粒度才有属地与总表状态;差异粒度才有方向 / 状态 / 原因', () => {
    const ent = ledgerQueryFromState('enterprise', ALL_ON)
    expect(ent.district).toBe('余姚市')
    expect(ent.rosterState).toBe('current')
    expect(ent.direction).toBeUndefined()
    // RL-08:首次认定两个判据也是**企业粒度**的(行就是一家企业)。
    expect(ent.firstYear).toBe('2021')
    expect(ent.firstStatus).toBe('pending')

    const diff = ledgerQueryFromState('difference', ALL_ON)
    expect(diff.direction).toBe('missing_in_miit')
    expect(diff.status).toBe('needs_review')
    expect(diff.reason).toBe('platform_stale')
    // 差异行没有「来源 / 事件 / 年份」这三个属性,不该把 postal 参数带上。
    expect(diff.source).toBeUndefined()
    expect(diff.eventType).toBeUndefined()
    expect(diff.year).toBeUndefined()
    expect(diff.rosterState).toBeUndefined()
    expect(diff.firstYear).toBeUndefined()
    expect(diff.firstStatus).toBeUndefined()
    // 搜索对三个视图都生效。
    expect(diff.q).toBe('宁波')
  })

  it('往返一趟不丢信息', () => {
    for (const view of LEDGER_VIEWS) {
      const query = ledgerQueryFromState(view, ALL_ON)
      const back = ledgerStateFromQuery(query)
      expect(ledgerQueryFromState(view, back)).toEqual(query)
    }
  })
})

describe('LEDGER_VIEW_FILTERS —— 一张表说清「每个视图认哪些筛选」', () => {
  it('emitted 的每个参数都是该视图声明认的(取数与声明不许漂移)', () => {
    for (const view of LEDGER_VIEWS) {
      const emitted = Object.keys(ledgerQueryFromState(view, ALL_ON)).filter((k) => k !== VIEW_PARAM)
      for (const key of emitted) {
        expect(LEDGER_VIEW_FILTERS[view], `${view} 发出了没声明的 ${key}`).toContain(key)
      }
    }
  })

  it('两个分组的记录侧判据声明一致(切换分组不换人)', () => {
    for (const key of ['q', 'title', 'source', 'eventType', 'year']) {
      expect(LEDGER_VIEW_FILTERS.enterprise).toContain(key)
      expect(LEDGER_VIEW_FILTERS.title).toContain(key)
    }
  })

  it('切换视图清掉该视图用不到的条件(留一个看不见的条件 = 静默筛选)', () => {
    // 切到「按企业×称号」:属地与总表状态是**企业属性**,这里用不到;
    // 差异侧的三个判据更不用说。
    const toTitle = filtersForView('title', ALL_ON)
    expect(toTitle.district).toBe('')
    expect(toTitle.rosterState).toBe('')
    expect(toTitle.direction).toBe('')
    expect(toTitle.status).toEqual([])
    expect(toTitle.reason).toEqual([])
    // 记录侧判据留下(两种分组共用同一批人)。
    expect(toTitle.q).toBe(ALL_ON.q)
    expect(toTitle.source).toEqual(ALL_ON.source)
    expect(toTitle.eventType).toEqual(ALL_ON.eventType)
    expect(toTitle.year).toEqual(ALL_ON.year)

    // 首次认定是企业粒度的判据:切走时清掉,否则它会变成看不见、清不掉、切回来又生效的条件。
    expect(toTitle.firstYear).toEqual([])
    expect(toTitle.firstStatus).toEqual([])

    // 切到差异:属地 / 总表状态 / 记录侧判据都清掉。
    const toDiff = filtersForView('difference', ALL_ON)
    for (const key of ['district', 'rosterState'] as const) expect(toDiff[key]).toBe('')
    for (const key of ['source', 'eventType', 'year'] as const) expect(toDiff[key]).toEqual([])
    expect(toDiff.title).toEqual(ALL_ON.title)
    expect(toDiff.direction).toBe(ALL_ON.direction)
    expect(toDiff.status).toEqual(ALL_ON.status)

    // 切回企业:差异侧清掉,企业侧与记录侧都在。
    const toEnt = filtersForView('enterprise', ALL_ON)
    expect(toEnt.direction).toBe('')
    expect(toEnt.status).toEqual([])
    expect(toEnt.reason).toEqual([])
    expect(toEnt.district).toBe(ALL_ON.district)
    expect(toEnt.rosterState).toBe(ALL_ON.rosterState)
  })

  it('**首次认定只在「按企业」下存在**(刻意的收窄,不是漏了)', () => {
    /**
     * RL-08:首次认定是**企业 × 称号**的量(「这家企业在专精特新上的首次认定是哪年」),
     * 而 `按企业×称号` 那一栏的行来自 `/api/records`,它读的是**事件行**,不算首次认定
     * —— 放进去就是「同一个 URL,两种结果」。所以它只归企业分组,切走时被清掉。
     */
    expect(LEDGER_VIEW_FILTERS.enterprise).toEqual(
      expect.arrayContaining(['firstYear', 'firstStatus']),
    )
    expect(LEDGER_VIEW_FILTERS.title).not.toContain('firstYear')
    expect(LEDGER_VIEW_FILTERS.difference).not.toContain('firstStatus')
    expect(ledgerQueryFromState('title', ALL_ON).firstYear).toBeUndefined()
    expect(ledgerQueryFromState('difference', ALL_ON).firstStatus).toBeUndefined()
  })

  it('**属地只在「按企业」下存在**(刻意的收窄,不是漏了)', () => {
    /**
     * 两个读模型对「属地」的口径本来就不同:企业总表按**企业属地**(为空时退回最早记录的
     * 属地),记录读模型按**每条记录的属地**。实测 13 个区县里有 11 个给出不同的企业集合
     * —— 同一个 `district` 值在两个分组下不是同一批人。放进共用筛选条就会变成
     * 「同一个 URL,两种结果」,所以它只归企业分组;切走时由 `filtersForView` 清掉。
     */
    expect(LEDGER_VIEW_FILTERS.title).not.toContain('district')
    expect(LEDGER_VIEW_FILTERS.difference).not.toContain('district')
    expect(ledgerQueryFromState('title', ALL_ON).district).toBeUndefined()
  })
})

describe('ledgerExportUrl —— 筛选与导出同口径', () => {
  /** 参数集合。`view` 不算「筛选」:导出端点靠路径区分粒度,不读它。 */
  const paramPairs = (url: string) => {
    const p = new URL(url, 'http://x').searchParams
    p.delete(VIEW_PARAM)
    return [...p.entries()].sort()
  }
  const listPairs = (view: 'enterprise' | 'title') => {
    const p = new URLSearchParams(ledgerListQuery(view, ALL_ON))
    p.delete(VIEW_PARAM)
    return [...p.entries()].sort()
  }

  it('企业粒度导出到 /api/roster/export,参数与列表请求逐字一致', () => {
    const url = ledgerExportUrl('enterprise', ALL_ON)
    expect(url!.startsWith('/api/roster/export?')).toBe(true)
    expect(paramPairs(url!)).toEqual(listPairs('enterprise'))
  })

  it('企业×称号粒度导出到 /api/export,参数与列表请求逐字一致', () => {
    const url = ledgerExportUrl('title', ALL_ON)
    expect(url!.startsWith('/api/export?')).toBe(true)
    expect(paramPairs(url!)).toEqual(listPairs('title'))
  })

  it('两个分组的导出仍带着同一批记录侧判据', () => {
    const ent = new URLSearchParams(ledgerExportUrl('enterprise', ALL_ON)!.split('?')[1])
    const ttl = new URLSearchParams(ledgerExportUrl('title', ALL_ON)!.split('?')[1])
    for (const key of ['title', 'source', 'eventType', 'year', 'q']) {
      expect(ent.get(key)).toBe(ttl.get(key))
    }
  })

  it('首次认定筛选被导出**继承**(筛选进 URL,导出读的是同一个对象)', () => {
    const url = ledgerExportUrl('enterprise', ALL_ON)!
    const p = new URLSearchParams(url.split('?')[1])
    expect(p.get('firstYear')).toBe('2021')
    expect(p.get('firstStatus')).toBe('pending')
  })

  it('差异粒度不给导出(宁可不给按钮,也不给口径说不清的导出)', () => {
    expect(ledgerExportUrl('difference', ALL_ON)).toBeNull()
  })

  it('没有筛选时也给得出地址(导出全部)', () => {
    expect(ledgerExportUrl('enterprise', EMPTY_LEDGER_STATE)).toBe('/api/roster/export')
    expect(ledgerExportUrl('title', EMPTY_LEDGER_STATE)).toBe('/api/export')
  })

  it('按钮文案写明导出的粒度', () => {
    expect(ledgerExportLabel('enterprise')).toContain('企业')
    expect(ledgerExportLabel('title')).toContain('企业×称号')
  })
})
