// @vitest-environment jsdom
import { platformPresentationFields } from '../../../layers/sme-roster/lib/roster/platform-records'
import { expect, it } from 'vitest'

const rawFields = { id: 'RAW-ID', qymc: '企业原名', cszt: '终审通过', sqsj: '2026-05-08 10:32:24', whpc: '2026-1', rdtime: '2026-05-25 19:20:54', zsrxm: '未核姓名', cz: '未核操作', rdsj: '', rdrq: null, nested: { retained: [false, 0, null] } }

it('selects only verified nonempty business fields without mutating raw and retains false and zero', () => {
  const raw = { ...rawFields, sfty: false, zyzb: 0, qylx: '   ', rddqrq: '', unknown: 'unknown' }
  const before = JSON.stringify(raw)
  const fields = platformPresentationFields(raw)
  expect(fields.map(field => [field.key, field.value])).toEqual([
    ['qymc', '企业原名'], ['sqsj', '2026-05-08 10:32:24'], ['cszt', '终审通过'], ['rdtime', '2026-05-25 19:20:54'], ['whpc', '2026-1'], ['sfty', 'false'], ['zyzb', '0'],
  ])
  expect(JSON.stringify(raw)).toBe(before)
})
