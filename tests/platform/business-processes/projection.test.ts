import { describe, expect, it } from 'vitest'
import { parseBusinessProcess } from '../../../lib/platform/business-projection'

describe('business_list typed projection parser', () => {
  it('projects only explicit source row facts and trims text', () => {
    expect(parseBusinessProcess({
      id: ' SQ-B-1 ',
      qymc: ' 合成办理企业 ',
      tyshxydm: ' 91330211255994457P ',
      szsfmc: ' 宁波市 ',
      cszt: ' 终审通过 ',
      whpc: ' 2025-1 ',
      sblx: ' 复核 ',
      sqsj: ' 2025-06-03 09:00:00 ',
      personuuid: ' 第四批 ',
      year: 2025,
      unknownField: '保留在原行',
    })).toEqual({
      declareKind: 'review',
      businessYear: 2025,
      appliedAt: '2025-06-03 09:00:00',
      status: '终审通过',
      batch: '2025-1',
      awardBatchLabel: '第四批',
      province: '宁波市',
      titleRaw: null,
      nameRaw: '合成办理企业',
      usccRaw: '91330211255994457P',
    })
  })

  it('keeps unknown sblx verbatim and never invents a title or year', () => {
    const parsed = parseBusinessProcess({ sblx: ' 补录 ', qymc: '合成企业', year: null })
    expect(parsed.declareKind).toBe('补录')
    expect(parsed.businessYear).toBeNull()
    expect(parsed).not.toHaveProperty('title')
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
    ['boolean', true],
    ['fraction', 2024.5],
    ['negative', -2024],
    ['non-numeric', '2024年'],
    ['decimal string', '2024.0'],
    ['exponent string', '2e3'],
    ['surrounding whitespace', ' 2024 '],
  ])('treats %s year as unknown', (_label, year) => {
    expect(parseBusinessProcess({ year }).businessYear).toBeNull()
  })

  it.each([
    ['number', 2024, 2024],
    ['decimal integer string', '2024', 2024],
  ])('accepts an explicit %s year', (_label, year, expected) => {
    expect(parseBusinessProcess({ year }).businessYear).toBe(expected)
  })

  it('keeps missing, blank and non-string values as null', () => {
    expect(parseBusinessProcess({ qymc: 42, cszt: '  ', whpc: null, sblx: ['申请'] })).toEqual({
      declareKind: null,
      businessYear: null,
      appliedAt: null,
      status: null,
      batch: null,
      awardBatchLabel: null,
      province: null,
      titleRaw: null,
      nameRaw: null,
      usccRaw: null,
    })
    expect(parseBusinessProcess(null)).toMatchObject({ nameRaw: null, usccRaw: null, status: null })
    expect(parseBusinessProcess([])).toMatchObject({ nameRaw: null, declareKind: null })
  })
})
