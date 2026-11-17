import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initializeDb, schema } from '../../../db/client'
import { createTargetCurrentCandidateReader } from '../../../lib/roster/current-candidates-target'
import { normalizeUscc } from '../../../lib/domain'
import { captureReturnedTitles } from './fixtures/returned-titles'

const cleanups: (() => void)[] = []
afterEach(() => { for (const clean of cleanups.splice(0)) clean() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'returned-title-candidates-')), db = initializeDb({ create: true, dbPath: join(dir, 'native.sqlite') })
  cleanups.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  const codes = ['91310115MA1H7KUG93','91310114MA1GYDE2XE','91440300MA5G2DGE3R','91330110MA2GMDFH58','913302125705899102']
  const enterprise = (name: string) => db.insert(schema.enterprise).values({ name, nameNorm: name, usccNorm: codes.shift()! }).returning().get()
  return { db, enterprise, reader: createTargetCurrentCandidateReader(db) }
}
it.each(['queryBusList', 'businessList', 'queryList'] as const)('uses actual returned titles rather than requested scope for %s candidates', source => {
  const { db, enterprise, reader } = fixture()
  const owners = ['创新', '省专', '巨人', '未知'].map(enterprise)
  captureReturnedTitles(db, source, owners.map((e, i) => ({ id: 'returned-'+i, tyshxydm: e.usccNorm!, qymc: e.name, rdjb: ['1','2','3',''][i]! })), owners.map(e => e.id))
  const before = db.$client.prepare('SELECT total_changes() n').get()
  expect([...reader.iterate('little_giant')]).toEqual([{ id: owners[2]!.id }])
  expect([...reader.iterate('specialized_sme')]).toEqual([owners[1]!, owners[2]!].map(e => ({ id: e.id })))
  expect([...reader.iterate('innovative_sme')]).toEqual(owners.slice(0,3).map(e => ({ id: e.id })))
  expect(reader.count('little_giant')).toBe(1)
  expect(reader.page('specialized_sme', 1, 1)).toEqual({ total: 2, rows: [{ id: owners[2]!.id }] })
  expect(db.$client.prepare('SELECT total_changes() n').get()).toEqual(before)
})
it('keeps local records correspondence and differences with only higher-to-lower candidate inheritance', () => {
  const { db, enterprise, reader } = fixture()
  const giants = ['巨人记录', '巨人对应', '巨人原因'].map(enterprise), specialized = enterprise('仅省专'), innovative = enterprise('仅创新')
  for (const [e, title] of [[giants[0]!, 'little_giant'], [specialized, 'specialized_sme'], [innovative, 'innovative_sme']] as const) db.insert(schema.record).values({ enterpriseId: e.id, titleCode: title, source: 'jxj' }).run()
  db.insert(schema.recordCorrespondence).values({ enterpriseId: giants[1]!.id, titleCode: 'little_giant', edgeKey: 'local', type: 'event_process', role: 'candidate', status: 'rejected', revision: 1, targetIdentity: {}, provenance: {}, sourceFingerprint: 'f', ruleId: 'r', ruleVersion: 'v', createdAt: 'c' }).run()
  db.insert(schema.differenceReason).values({ enterpriseId: giants[2]!.id, titleCode: 'little_giant', direction: 'missing_in_miit', status: 'needs_review', recordedAt: 't' }).run()
  expect([...reader.iterate('little_giant')]).toEqual(giants.map(e => ({ id: e.id })))
  expect([...reader.iterate('specialized_sme')]).toEqual([...giants, specialized].map(e => ({ id: e.id })))
  expect([...reader.iterate('innovative_sme')]).toEqual([...giants, specialized, innovative].map(e => ({ id: e.id })))
})
it('uses returned giant data even when the request selected only innovative', () => {
  const { db, enterprise, reader } = fixture(), owner = enterprise('返回巨人')
  captureReturnedTitles(db, 'queryBusList', [{ id: 'cross-scope', tyshxydm: owner.usccNorm!, qymc: owner.name, rdjb: '3' }], [owner.id], ['1'])
  expect([...reader.iterate('little_giant')]).toEqual([{ id: owner.id }])
})

it('normalizes owners once across actual returned rows from all three interfaces', () => {
  const { db, enterprise, reader } = fixture(), owner = enterprise('三源归属'), unrelated = enterprise('无关联归属')
  for (const source of ['queryBusList', 'businessList', 'queryList'] as const) captureReturnedTitles(db, source,
    [{ id: 'all-source-'+source, tyshxydm: owner.usccNorm!, qymc: owner.name, rdjb: '3' }], [null], ['3'])
  let normalizations = 0
  db.$client.function('roster84_uscc', { deterministic: true }, value => {
    if (value === unrelated.usccNorm) normalizations++
    return normalizeUscc(value as string | null)
  })
  expect([...reader.iterate('little_giant')]).toEqual([{ id: owner.id }])
  expect(normalizations).toBe(1)
})
