import { expect, it } from 'vitest'
import { normalizePlatformRelation } from '../../../layers/sme-roster/lib/platform/normalization'

const rawFields = { cszt: '终审通过', sblx: '复核', sqsj: '2025-11-21 09:54:16', year: '2025', whpc: '2025-2' }

it('recognized parsing does not borrow process status, matter, time or year from similar keys', () => {
  const raw = { ...rawFields, sfyx: '1', rddqrq: '2029-02-27' }
  expect(normalizePlatformRelation('recognized_list',{sequenceNo:1,rawFields:raw})).toMatchObject({status:null,declareKind:null,appliedAt:null,year:null,batch:null,rawFields:raw})
})
