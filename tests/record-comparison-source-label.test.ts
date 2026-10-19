import { describe, expect, it } from 'vitest'
import {
  comparisonSourceRawKey,
  comparisonSourceScope,
  comparisonSourceSecondaryIds,
  comparisonSourceTitle,
} from '../lib/roster/record-comparison-display'

const querySource = {
  kind: 'query',
  label: '已认定名单 · 专精特新中小企业 · SYN111000000000001',
  subtitle: 'recognized_list',
  titleName: '专精特新中小企业',
  rdjb: null,
  conditions: { uscc: '91330200TEST0001' },
}

describe('record comparison source labels', () => {
  it('names a platform query by interface, title and scope without decoding the SYN key', () => {
    const title = comparisonSourceTitle(querySource)
    expect(title).toContain('已认定企业列表')
    expect(title).toContain('专精特新中小企业')
    expect(title).toContain('按统一社会信用代码查询')
    expect(title).not.toContain('SYN111000000000001')
    expect(title).not.toContain('91330200TEST0001')
    expect(comparisonSourceRawKey(querySource)).toBe('SYN111000000000001')
    expect(comparisonSourceSecondaryIds(querySource)).toEqual([
      '查询键 SYN111000000000001',
      '统一社会信用代码 91330200TEST0001',
      '未关联企业名称',
    ])
  })

  it('uses the observed name condition as an existing evidence field', () => {
    expect(comparisonSourceScope({ name: '合成111-分页-0', rddqrq: '2025' }))
      .toContain('企业名称：合成111-分页-0')
  })

  it('leaves non-query catalog rows untouched', () => {
    const document = { kind: 'official_document', label: '宁波市专精特新中小企业名单', subtitle: '甬经信〔2025〕1号' }
    expect(comparisonSourceTitle(document)).toBe('宁波市专精特新中小企业名单')
    expect(comparisonSourceRawKey(document)).toBe('')
  })
})
