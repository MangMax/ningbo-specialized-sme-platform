import { describe, expect, it } from 'vitest'
import { APPLY_PROJECTION_RULE, parseApplyRecord } from '../../../lib/platform/apply-record'

describe('apply_list typed projection parser', () => {
  it('derives only explicit source fields without inferring a title or year', () => {
    expect(parseApplyRecord({
      id: 'SQ1',
      qymc: '  合成企业  ',
      tyshxydm: ' 91330211255994457P ',
      sblx: ' 申请 ',
      year: 2024,
      sqsj: ' 2024-03-01 09:00:00 ',
      cszt: ' 终审通过 ',
      szsfmc: ' 宁波市 ',
      queriedAt: '2024-03-01T10:00:00Z',
      batch: '2024-1',
      title: '小巨人',
    })).toEqual({
      declareKind: 'apply',
      declarationYear: 2024,
      appliedAt: '2024-03-01 09:00:00',
      status: '终审通过',
      titleRaw: null,
      nameRaw: '合成企业',
      usccRaw: '91330211255994457P',
    })
  })

  it('preserves unknown sblx and status strings verbatim after trimming', () => {
    expect(parseApplyRecord({ sblx: ' 补充申报 ', cszt: ' 待补充 ' })).toMatchObject({
      declareKind: '补充申报',
      status: '待补充',
    })
  })

  it('distinguishes null from blank values and accepts only explicit decimal integer years', () => {
    expect(parseApplyRecord({
      qymc: '', tyshxydm: '   ', sblx: '', year: ' 2024 ', sqsj: '', cszt: null, szsfmc: '',
    })).toEqual({
      declareKind: null,
      declarationYear: 2024,
      appliedAt: null,
      status: null,
      titleRaw: null,
      nameRaw: null,
      usccRaw: null,
    })
    expect(parseApplyRecord({ year: 2025 }).declarationYear).toBe(2025)
    for (const year of [0, -1, 2024.5, Number.NaN, Number.POSITIVE_INFINITY, '', '   ', '2024.5', '2024年', 'abc', true, null, undefined, {}, []]) {
      expect(parseApplyRecord({ year }).declarationYear).toBeNull()
    }
  })

  it('does not infer a year from sqsj or collection metadata', () => {
    expect(parseApplyRecord({ sqsj: '2024/01/02', queriedAt: '2024-01-02T00:00:00Z', batch: '2024-1' }).declarationYear).toBeNull()
  })

  it('exposes the stable apply projection rule version', () => {
    expect(APPLY_PROJECTION_RULE).toBe('platform-apply-v1')
  })
})