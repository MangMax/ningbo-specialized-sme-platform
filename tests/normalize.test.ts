import { describe, expect, it } from 'vitest'
import {
  classifyEvent,
  isNingboDistrict,
  normalizeDistrict,
  normalizeName,
  normalizeUscc,
  parseBatch,
} from '../lib/normalize'

describe('normalizeUscc', () => {
  it('strips whitespace, zero-width and full-width chars, and uppercases', () => {
    expect(normalizeUscc(' 91330203MA2H6X1T2u​ ')).toBe('91330203MA2H6X1T2U')
    expect(normalizeUscc('９１３３０２')).toBe(null) // full-width digits are rejected by shape
  })

  it('treats placeholders as absent', () => {
    for (const v of ['', '#N/A', '0', 'N/A', null, undefined]) expect(normalizeUscc(v)).toBe(null)
  })

  it('rejects values that are not a plausible USCC', () => {
    expect(normalizeUscc('123')).toBe(null)
  })
})

describe('normalizeName', () => {
  it('drops whitespace, brackets and trailing marks', () => {
    expect(normalizeName('宁波 东为(宁波)智能装备有限公司 √')).toBe('宁波东为宁波智能装备有限公司')
    expect(normalizeName('浙江 梦神家居（股份）有限公司')).toBe('浙江梦神家居股份有限公司')
  })
})

describe('parseBatch', () => {
  it('parses year-batch', () => {
    expect(parseBatch('2024-1')).toEqual({ year: 2024, seq: 1 })
    expect(parseBatch('2025年度第二批')).toEqual({ year: 2025, seq: 2 })
  })

  it('treats a year range as a range, not a batch', () => {
    expect(parseBatch('2021-2022宁波市“专精特新”入库培育企业名单')).toEqual({ year: 2021, seq: null })
  })

  it('returns null seq when no batch present', () => {
    expect(parseBatch('2022年度宁波市创新型中小企业名单')).toEqual({ year: 2022, seq: null })
  })
})

describe('classifyEvent', () => {
  it('prefers nurture, then review, else award', () => {
    expect(classifyEvent('2021-2022…入库培育企业名单')).toBe('nurture')
    expect(classifyEvent('2021年度第一批…复核通过名单')).toBe('review')
    expect(classifyEvent('2024年第二批…名单')).toBe('award')
  })
})

describe('normalizeDistrict', () => {
  it('fixes the 酆州区 typo to 鄞州区', () => {
    expect(normalizeDistrict('酆州区')).toBe('鄞州区')
  })

  it('completes short forms of Ningbo districts', () => {
    expect(normalizeDistrict('象山')).toBe('象山县')
    expect(normalizeDistrict('鄞州')).toBe('鄞州区')
    expect(normalizeDistrict(' 慈溪 ')).toBe('慈溪市')
  })

  it('leaves canonical names and out-of-city names untouched', () => {
    expect(normalizeDistrict('鄞州区')).toBe('鄞州区')
    expect(normalizeDistrict('拱墅区')).toBe('拱墅区')
  })

  it('recognises Ningbo districts and functional zones only', () => {
    expect(isNingboDistrict('鄞州区')).toBe(true)
    expect(isNingboDistrict('前湾新区')).toBe(true)
    expect(isNingboDistrict('杭州湾')).toBe(true)
    expect(isNingboDistrict('拱墅区')).toBe(false)
  })
})
