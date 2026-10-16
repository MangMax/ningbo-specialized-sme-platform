import { describe, expect, it } from 'vitest'
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
