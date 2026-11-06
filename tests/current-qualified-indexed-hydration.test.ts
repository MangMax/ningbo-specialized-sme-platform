import { afterAll, expect, it, vi } from 'vitest'
import { currentExport118Fixture, year } from './helpers/current-export-118'
import { listCurrentQualified } from '../lib/roster/current-qualified-query'
import { readCurrentQualificationAssessment } from '../lib/roster/current-qualification'
import { schema as s } from '../db/client'

const f = currentExport118Fixture()
afterAll(() => f.close())

it('hydrates complete three-title assessments through indexed coverage without changing snapshots', () => {
  f.resetBusiness()
  const c = f.candidate('Indexed coverage')
  const insertQuery = (queryKey: string, titleCode: 'specialized_sme' | 'little_giant' | null, rdjb: string) => f.db.insert(s.platformQuery).values({
    interface: 'recognized_list', queryKey, titleCode, rdjb, queriedAt: '2026-01-01T00:00:00Z', status: 'failed',
  }).returning().get()
  const canonical = insertQuery(c.enterprise.usccNorm!, 'specialized_sme', '2')
  const variant = insertQuery('  ' + c.enterprise.usccNorm!.toLowerCase() + '  ', 'specialized_sme', '2')
  const name = insertQuery('name:' + c.enterprise.nameNorm, null, '')
  const related = insertQuery('unrelated-key', 'little_giant', '3')
  f.db.insert(s.platformRelation).values({ queryId: related.id, enterpriseId: c.enterprise.id, sequenceNo: 1 }).run()
  insertQuery('foreign-key', 'specialized_sme', '2')
  const db = f.db.$client
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${year}-06-01T00:00:00Z`))
  const prepare = db.prepare.bind(db)
  try {
    const expected = readCurrentQualificationAssessment(db, c.enterprise.id, Date.now())
    const prepared = vi.spyOn(db, 'prepare').mockImplementation(prepare)
    try {
      const result = listCurrentQualified(db, { titleCode: 'specialized_sme' })
      expect(result.total).toBe(1)
      expect(result.rows[0]!.qualificationAssessment).toEqual(expected)
      const titles = result.rows[0]!.qualificationAssessment.titles
      expect(titles.find(t => t.titleCode === 'specialized_sme')!.platform.observations.map(q => q.queryId)).toEqual([name.id, variant.id, canonical.id])
      expect(titles.find(t => t.titleCode === 'little_giant')!.platform.observations.map(q => q.queryId)).toEqual([related.id, name.id])
      expect(titles.find(t => t.titleCode === 'innovative_sme')!.platform.observations.map(q => q.queryId)).toEqual([name.id])
      const coverageSql = prepared.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith('with selected as materialized'))
      expect(coverageSql).toHaveLength(3)
      expect(coverageSql.every(sql => sql.includes('indexed by platform_query_key_idx') && sql.includes('indexed by platform_relation_enterprise_idx'))).toBe(true)
    } finally { prepared.mockRestore() }
  } finally { vi.useRealTimers() }
})

it.each([50, 51, 52])('preserves coverage ordering and truncation for %i attempts matching both identity branches', count => {
  f.resetBusiness()
  const c = f.candidate('Coverage boundary ' + count)
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    const query = f.db.insert(s.platformQuery).values({ interface: 'recognized_list', queryKey: c.enterprise.usccNorm!, titleCode: 'specialized_sme', rdjb: '2', queriedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), status: 'failed' }).returning().get()
    ids.push(query.id)
    f.db.insert(s.platformRelation).values({ queryId: query.id, enterpriseId: c.enterprise.id, sequenceNo: 1 }).run()
  }
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${year}-06-01T00:00:00Z`))
  try {
    const expected = readCurrentQualificationAssessment(f.db.$client, c.enterprise.id, Date.now())
    const actual = listCurrentQualified(f.db.$client, { titleCode: 'specialized_sme' }).rows[0]!.qualificationAssessment
    expect(actual).toEqual(expected)
    const platform = actual.titles.find(t => t.titleCode === 'specialized_sme')!.platform
    expect(platform.observations.map(q => q.queryId)).toEqual(ids.reverse().slice(0, 50))
    expect(platform.truncated).toBe(count > 50)
  } finally { vi.useRealTimers() }
})

it('retains name and linked-query coverage when the enterprise has no credit code', () => {
  f.resetBusiness()
  const c = f.candidate('No credit code')
  f.db.$client.prepare('update enterprise set uscc_norm=null where id=?').run(c.enterprise.id)
  const named = f.db.insert(s.platformQuery).values({ interface: 'apply_list', queryKey: 'name:' + c.enterprise.nameNorm, queriedAt: '2026-01-01T00:00:00Z', status: 'failed' }).returning().get()
  const linked = f.db.insert(s.platformQuery).values({ interface: 'apply_list', queryKey: 'different-name', queriedAt: '2026-01-01T00:00:00Z', status: 'failed' }).returning().get()
  f.db.insert(s.platformRelation).values({ queryId: linked.id, enterpriseId: c.enterprise.id, sequenceNo: 1 }).run()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${year}-06-01T00:00:00Z`))
  try {
    const expected = readCurrentQualificationAssessment(f.db.$client, c.enterprise.id, Date.now())
    const actual = listCurrentQualified(f.db.$client, { titleCode: 'specialized_sme' }).rows[0]!.qualificationAssessment
    expect(actual).toEqual(expected)
    expect(actual.titles.map(title => title.platform.observations.map(q => q.queryId))).toEqual([[linked.id, named.id], [linked.id, named.id], [linked.id, named.id]])
  } finally { vi.useRealTimers() }
})
