import { expect, it } from 'vitest'
import { parseRecognizedQualificationFields } from '../../../layers/sme-roster/lib/platform/recognized-projection'

const raw = { id: 'recognized-808', rdtime: '2023-12-28 08:50:25', rddqrq: '2026-12-28', sfyx: '1', sxsj: '', sxyy: '', szsfmc: '浙江省', szsmc: '宁波市', szqmc: '海曙区', szq: '133020300' }
const expected = { sourceRecognizedAt: '2023-12-28 08:50:25', sourceValidFlag: '1', sourceInvalidatedAt: '', sourceInvalidationReason: '', sourceProvinceName: '浙江省', sourceCityName: '宁波市', sourceDistrictName: '海曙区', qualificationFieldsRule: 'recognized-qualification-fields-v1' }
it('preserves recognized dates flags and geographic names verbatim', () => {
  expect(parseRecognizedQualificationFields(raw)).toEqual(expected)
  expect(parseRecognizedQualificationFields({ rdtime: ' 2026-03-06 ', sfyx: 0, sxsj: '2026-11-16 12:00:01', sxyy: ' 取消 ', szq: '133020300' })).toEqual({ sourceRecognizedAt: ' 2026-03-06 ', sourceValidFlag: 0, sourceInvalidatedAt: '2026-11-16 12:00:01', sourceInvalidationReason: ' 取消 ', sourceProvinceName: null, sourceCityName: null, sourceDistrictName: null, qualificationFieldsRule: 'recognized-qualification-fields-v1' })
})
it('retains day and instant precision without inventing missing fields', () => {
  expect(parseRecognizedQualificationFields({ rdtime: '2026-03-06' }).sourceRecognizedAt).toBe('2026-03-06')
  expect(parseRecognizedQualificationFields(null)).toEqual({ sourceRecognizedAt: null, sourceValidFlag: null, sourceInvalidatedAt: null, sourceInvalidationReason: null, sourceProvinceName: null, sourceCityName: null, sourceDistrictName: null, qualificationFieldsRule: 'recognized-qualification-fields-v1' })
})
