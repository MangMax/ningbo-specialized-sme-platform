import { describe, expect, it } from 'vitest'
import { filterComparisonRows } from '../../../lib/comparison-filter'

const rows = [
  {
    name: '中化(浙江)膜产业发展有限公司',
    uscc: '91330211000000012X',
    district: '鄞州区',
    titleCode: 'specialized_sme',
    direction: 'missing_in_miit',
    curated: false,
    platform: { aliases: [{ name: 'confirmed historical name', verificationStatus: 'confirmed' }] },
  },
  {
    name: '另一家企业有限公司',
    uscc: null,
    district: '海曙区',
    titleCode: 'specialized_sme',
    direction: 'missing_in_miit',
    curated: true,
    platform: { aliases: [{ name: 'pending historical name', verificationStatus: 'pending' }] },
  },
]

describe('比对列表筛选口径', () => {
  it('名称归一化、区县与方向过滤共用同一函数', () => {
    expect(filterComparisonRows(rows, {
      q: '中化（浙江）',
      district: '鄞州区',
      direction: 'missing_in_miit',
    }).map((row) => row.name)).toEqual(['中化(浙江)膜产业发展有限公司'])
  })

  it('只允许 confirmed 曾用名参与搜索,且默认隐藏已核实行', () => {
    expect(filterComparisonRows(rows, { q: 'confirmed historical name' })).toHaveLength(1)
    expect(filterComparisonRows(rows, { q: 'pending historical name' })).toHaveLength(0)
    expect(filterComparisonRows(rows, { showCurated: true })).toHaveLength(2)
  })
})
