import { describe, expect, it } from 'vitest'
import { parseRecognizedRecord, RECOGNIZED_PROJECTION_RULE } from '../../../lib/platform/recognized-projection'

describe('recognized_list typed projection parser', () => {
  it('projects only explicit source row facts and trims text', () => {
    expect(parseRecognizedRecord({
      id: ' UUID-RECOGNIZED-1 ',
      qymc: ' 合成认定企业 ',
      tyshxydm: ' 91330211255994457P ',
      rddqrq: ' 2027-06-30 ',
      whpcyear: ' 2024 ', // outer whitespace is not a decimal integer
      whpc: ' 2 ',
      szq: ' 33020000 ',
      rdxx: ' 原认定说明 ',
      rdjb: ' 2 ',
      unknownField: '保留在原行',
    })).toEqual({
      validityDateRaw: '2027-06-30',
      maintenanceYear: null,
      maintenanceBatch: '2',
      district: '33020000',
      awardNote: '原认定说明',
      titleRaw: '2',
      nameRaw: '合成认定企业',
      usccRaw: '91330211255994457P',
    })
  })

  it('preserves the validity value verbatim and never parses or derives a date', () => {
    for (const value of ['2027', '2027-06', '2027-06-30', '2027/06/30', '2027年6月', '2027-06-30 00:00:00']) {
      const parsed = parseRecognizedRecord({ rddqrq: ` ${value} ` })
      expect(parsed.validityDateRaw, value).toBe(value)
    }
    const parsed = parseRecognizedRecord({ rddqrq: '2027-06-30', whpc: '2024-2' })
    expect(parsed).not.toHaveProperty('validityDate')
    expect(parsed).not.toHaveProperty('awardDate')
    expect(parsed.maintenanceYear).toBeNull()
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
    ['boolean', true],
    ['fraction', 2024.5],
    ['negative', -2024],
    ['zero', 0],
    ['non-numeric', '2024年'],
    ['decimal string', '2024.0'],
    ['exponent string', '2e3'],
    ['surrounding whitespace', ' 2024 '],
    ['safe integer overflow', Number.MAX_SAFE_INTEGER + 1],
    ['array', ['2024']],
  ])('treats %s whpcyear as unknown', (_label, whpcyear) => {
    expect(parseRecognizedRecord({ whpcyear }).maintenanceYear).toBeNull()
  })

  it.each([
    ['number', 2024, 2024],
    ['decimal integer string', '2024', 2024],
  ])('accepts an explicit %s whpcyear', (_label, whpcyear, expected) => {
    expect(parseRecognizedRecord({ whpcyear }).maintenanceYear).toBe(expected)
  })

  it('never infers a maintenance year from the validity value, batch, id or collection metadata', () => {
    expect(parseRecognizedRecord({ rddqrq: '2027', whpc: '2024-2', id: 'SQ-2024', queriedAt: '2024-01-01T00:00:00Z', batch: '2024-1' }).maintenanceYear).toBeNull()
  })

  it('keeps missing, blank and non-string values as null and never confuses row title with a query scope', () => {
    expect(parseRecognizedRecord({ qymc: 42, tyshxydm: '   ', rddqrq: 2027, whpc: null, szq: false, rdxx: [], rdjb: 2 })).toEqual({
      validityDateRaw: null,
      maintenanceYear: null,
      maintenanceBatch: null,
      district: null,
      awardNote: null,
      titleRaw: null,
      nameRaw: null,
      usccRaw: null,
    })
    expect(parseRecognizedRecord(null)).toMatchObject({ nameRaw: null, titleRaw: null, validityDateRaw: null })
    expect(parseRecognizedRecord([])).toMatchObject({ nameRaw: null, maintenanceBatch: null })
  })

  it('exposes the stable recognized projection rule version', () => {
    expect(RECOGNIZED_PROJECTION_RULE).toBe('platform-recognized-v1')
  })
})
