import { describe, expect, it } from 'vitest'
import { DIFFERENCE_REASONS } from '../lib/labels'
import { ROSTER_DIFFERENCE_FILTER_OPTIONS, rosterDifferenceFilterLabel } from '../lib/roster/ledger-contract'
import {
  DEFAULT_SORT,
  EMPTY_LEDGER_STATE,
  LEDGER_FILTER_KEYS,
  ledgerExportUrl,
  ledgerListQuery,
  ledgerQueryFromState,
  ledgerStateFromQuery,
  type LedgerState,
} from '../lib/roster/ledger-view'

const FILTERED: LedgerState = {
  ...EMPTY_LEDGER_STATE,
  q: '宁波开诚',
  title: ['little_giant', 'specialized_sme'],
  district: '海曙区',
  diffStatus: ['confirmed_reason', 'none'],
  sort: 'name',
}

describe('企业列表状态与 URL 映射', () => {
  it('多值按逗号读回,空条件不进入状态', () => {
    expect(ledgerStateFromQuery({
      q: ' 宁波开诚 ',
      title: 'little_giant,specialized_sme',
      district: '海曙区',
      diffStatus: 'confirmed_reason,none',
      sort: 'name',
      view: 'difference',
    })).toEqual(FILTERED)
  })

  it('未知排序退回默认值', () => {
    expect(ledgerStateFromQuery({ sort: 'random' }).sort).toBe(DEFAULT_SORT)
  })

  it('只有企业列表的筛选键会进入地址与请求,不再写三视图参数', () => {
    const query = ledgerQueryFromState(FILTERED)
    expect(Object.keys(query).sort()).toEqual(['q', 'title', 'district', 'diffStatus', 'sort'].sort())
    expect(Object.keys(query).filter((key) => key !== 'sort').every((key) => LEDGER_FILTER_KEYS.includes(key as never))).toBe(true)
    expect(query).not.toHaveProperty('view')
    expect(query.title).toBe('little_giant,specialized_sme')
    expect(query.diffStatus).toBe('confirmed_reason,none')
    expect(ledgerListQuery(FILTERED)).toEqual(query)
  })

  it('地址往返保留筛选与排序', () => {
    const query = ledgerQueryFromState(FILTERED)
    expect(ledgerQueryFromState(ledgerStateFromQuery(query))).toEqual(query)
  })

  it('导出只带当前筛选,不带分页,空筛选仍有有效地址', () => {
    const url = ledgerExportUrl(FILTERED)
    const params = new URL(url, 'http://local').searchParams
    expect(url.startsWith('/api/roster/export?')).toBe(true)
    expect(params.get('q')).toBe(FILTERED.q)
    expect(params.get('district')).toBe(FILTERED.district)
    expect(params.get('sort')).toBe(FILTERED.sort)
    expect(params.has('page')).toBe(false)
    expect(ledgerExportUrl(EMPTY_LEDGER_STATE)).toBe('/api/roster/export')
  })
})


describe('企业差异状态菜单与原因筛选',()=>{
  it('菜单覆盖每一种可见原因，其他在按钮和筛选chip中使用中文',()=>{
    for(const [value,label] of Object.entries(DIFFERENCE_REASONS)) {
      expect(ROSTER_DIFFERENCE_FILTER_OPTIONS).toContainEqual({value,label})
      expect(rosterDifferenceFilterLabel(value)).toBe(label)
    }
    expect(rosterDifferenceFilterLabel('other')).toBe('其他')
  })
  it('其他与现有状态的多选经过URL、刷新及导出保持同一值',()=>{
    const state={...EMPTY_LEDGER_STATE,diffStatus:['other','query_failed']}
    const query=ledgerListQuery(state)
    expect(query.diffStatus).toBe('other,query_failed')
    expect(ledgerStateFromQuery(query).diffStatus).toEqual(['other','query_failed'])
    expect(new URL(ledgerExportUrl(state),'http://local').searchParams.get('diffStatus')).toBe(query.diffStatus)
  })
})
