import { expect, it } from 'vitest'
import { singlePostgresFixtureRow, useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import * as schema from '../fixtures/postgres-tables'
import { readPostgresCurrentCandidateIds } from '../../../layers/sme-roster/lib/roster/current-candidates-postgres'
import type { CurrentTitle } from '../../../layers/sme-roster/lib/roster/current-titles'
import { captureReturnedTitles } from './fixtures/returned-titles'

const createDb = useIsolatedPostgresCases()
function fixture() {
  const db = createDb()
  const codes = ['91310115MA1H7KUG93','91310114MA1GYDE2XE','91440300MA5G2DGE3R','91330110MA2GMDFH58','913302125705899102']
  const enterprise = async (name: string) => singlePostgresFixtureRow(await db.insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: codes.shift()! }).returning())
  const candidates = (title: CurrentTitle) => db.transaction(tx => readPostgresCurrentCandidateIds(tx, title), {
    isolationLevel: 'repeatable read', accessMode: 'read only',
  })
  return { db, enterprise, candidates }
}
it.each(['queryBusList', 'businessList', 'queryList'] as const)('uses actual returned titles rather than requested scope for %s candidates', async source => {
  const { db, enterprise, candidates } = fixture()
  const owners = []
  for (const name of ['创新', '省专', '巨人', '未知']) owners.push(await enterprise(name))
  await captureReturnedTitles(db, source, owners.map((e, i) => ({ id: 'returned-'+i, tyshxydm: e.usccNorm!, qymc: e.name, rdjb: ['1','2','3',''][i]! })), owners.map(e => e.id))
  expect(await candidates('little_giant')).toEqual([owners[2]!.id])
  expect(await candidates('specialized_sme')).toEqual([owners[1]!, owners[2]!].map(e => e.id))
  expect(await candidates('innovative_sme')).toEqual(owners.slice(0,3).map(e => e.id))
})
it('keeps local records correspondence and differences with only higher-to-lower candidate inheritance', async () => {
  const { db, enterprise, candidates } = fixture()
  const giants = []
  for (const name of ['巨人记录', '巨人对应', '巨人原因']) giants.push(await enterprise(name))
  const specialized = await enterprise('仅省专'), innovative = await enterprise('仅创新')
  for (const [e, title] of [[giants[0]!, 'little_giant'], [specialized, 'specialized_sme'], [innovative, 'innovative_sme']] as const) await db.insert(schema.record).values({ enterpriseId: e.id, titleCode: title, source: 'jxj' })
  await db.insert(schema.recordCorrespondence).values({ enterpriseId: giants[1]!.id, titleCode: 'little_giant', edgeKey: 'local', type: 'event_process', role: 'candidate', status: 'rejected', revision: 1, targetIdentity: '{}', provenance: '{}', sourceFingerprint: 'f', ruleId: 'r', ruleVersion: 'v', createdAt: 'c' })
  await db.insert(schema.differenceReason).values({ enterpriseId: giants[2]!.id, titleCode: 'little_giant', direction: 'missing_in_miit', status: 'needs_review', recordedAt: '2026-01-01', createdAt: '2026-01-01' })
  expect(await candidates('little_giant')).toEqual(giants.map(e => e.id))
  expect(await candidates('specialized_sme')).toEqual([...giants, specialized].map(e => e.id))
  expect(await candidates('innovative_sme')).toEqual([...giants, specialized, innovative].map(e => e.id))
})
it('uses returned giant data even when the request selected only innovative', async () => {
  const { db, enterprise, candidates } = fixture(), owner = await enterprise('返回巨人')
  await captureReturnedTitles(db, 'queryBusList', [{ id: 'cross-scope', tyshxydm: owner.usccNorm!, qymc: owner.name, rdjb: '3' }], [owner.id], ['1'])
  expect(await candidates('little_giant')).toEqual([owner.id])
})

it('deduplicates a normalized owner across actual returned rows from all three interfaces', async () => {
  const { db, enterprise, candidates } = fixture(), owner = await enterprise('三源归属')
  await enterprise('无关联归属')
  for (const source of ['queryBusList', 'businessList', 'queryList'] as const) await captureReturnedTitles(db, source,
    [{ id: 'all-source-'+source, tyshxydm: owner.usccNorm!, qymc: owner.name, rdjb: '3' }], [null], ['3'])
  expect(await candidates('little_giant')).toEqual([owner.id])
})
