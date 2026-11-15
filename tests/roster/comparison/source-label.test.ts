import { describe, expect, it } from 'vitest'
import {
  comparisonSourceEnterpriseDetails,
  comparisonSourceEnterpriseLine,
  comparisonSourceRawKey,
  comparisonSourceRawNameLine,
  comparisonSourceScope,
  comparisonSourceSecondaryIds,
  comparisonSourceTitle,
  comparisonSourceUnconfirmedLine,
} from '../../../lib/roster/record-comparison-display'

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
    ])
    expect(comparisonSourceEnterpriseLine(querySource)).toBe('企业名称未读取（待关联）')
  })

  it('uses the observed name condition as an existing evidence field', () => {
    expect(comparisonSourceScope({ name: '合成111-分页-0', rddqrq: '2025' }))
      .toContain('企业名称：合成111-分页-0')
  })

  it('keeps the confirmed successor and the merged platform row name side by side', () => {
    const merged = {
      ...querySource,
      confirmedEnterprises: [{
        relationId: 53,
        sequenceNo: 1,
        enterpriseId: 7,
        enterpriseName: '合成111-归并',
        nameRaw: '合成111-归并旧主体',
        matchBasis: 'manual',
        aliasConfirmed: true,
        mergedFromEnterpriseId: 8,
      }],
      recordNames: [],
    }
    expect(comparisonSourceEnterpriseLine(merged)).toBe('已确认主体 1 家：合成111-归并（#7）')
    expect(comparisonSourceRawNameLine(merged)).toContain('平台原行名称：合成111-归并旧主体 → 合成111-归并（#7）')
    expect(comparisonSourceRawNameLine(merged)).toContain('归并自 #8')
    expect(comparisonSourceSecondaryIds(merged)).not.toContain('未关联企业名称')
    expect(comparisonSourceEnterpriseDetails(merged)).toContain('平台原行名称：合成111-归并旧主体 · 已确认主体：合成111-归并（#7） · 归并自 #8')
  })

  it('labels raw platform names without a confirmed relation as unconfirmed, never as the official name', () => {
    const unconfirmed = { ...querySource, confirmedEnterprises: [], recordNames: ['合成111-待关联主体'] }
    expect(comparisonSourceEnterpriseLine(unconfirmed)).toBe('')
    expect(comparisonSourceUnconfirmedLine(unconfirmed)).toBe('平台记录名称（未确认主体）：合成111-待关联主体')
    expect(comparisonSourceRawNameLine(unconfirmed)).toBe('')
    expect(comparisonSourceEnterpriseDetails(unconfirmed)).toEqual(['平台记录名称（未确认主体）：合成111-待关联主体'])
  })

  it('bounds a large one-to-many summary while preserving every identity for the detail view', () => {
    const many = {
      ...querySource,
      confirmedEnterprises: Array.from({ length: 50 }, (_, index) => ({
        enterpriseId: index + 1,
        enterpriseName: `企业${index + 1}`,
        nameRaw: `原行${index + 1}`,
        aliasConfirmed: true,
        mergedFromEnterpriseId: null,
      })),
      recordNames: [],
    }
    expect(comparisonSourceEnterpriseLine(many)).toBe('已确认主体 50 家：企业1（#1）、企业2（#2）、企业3（#3） 等')
    expect(comparisonSourceEnterpriseDetails(many)).toHaveLength(50)
  })

  it('leaves non-query catalog rows untouched', () => {
    const document = { kind: 'official_document', label: '宁波市专精特新中小企业名单', subtitle: '甬经信〔2025〕1号' }
    expect(comparisonSourceTitle(document)).toBe('宁波市专精特新中小企业名单')
    expect(comparisonSourceRawKey(document)).toBe('')
    expect(comparisonSourceEnterpriseLine(document)).toBe('')
  })
})
