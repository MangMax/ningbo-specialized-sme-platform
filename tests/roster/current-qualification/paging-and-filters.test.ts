import { afterAll, beforeEach, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { schema as s } from '../../../db/client'
import { listCurrentQualified, type CurrentQualifiedFilter } from '../../../lib/roster/current-qualified-query'
import { specializedExportFixture, year } from '../current-export/fixtures/specialized-export'

// Use only its native seed and connection; never launch its app host.
const f = specializedExportFixture()
beforeEach(f.resetBusiness)
afterAll(f.close)
function query(params: CurrentQualifiedFilter) { return { body: listCurrentQualified(f.db.$client, params) } }

it('pages each title by complete eligible count without borrowing another title', async () => {
  const a = f.candidate('甲企业')
  const b = f.candidate('乙企业')
  const c = f.candidate('丙企业', undefined, 'little_giant')
  f.addRecord(a.enterprise.id, '甲企业', undefined, 'little_giant')
  f.candidate('失败企业', [{ eventType: 'award', year: year - 4, batchSeq: 1 }, { eventType: 'review', year: year - 4, batchSeq: 1, decidedYear: year - 1, reviewOutcome: 'failed' }])
  const first = await query({ titleCode: 'specialized_sme', page: 1, pageSize: 1 })
  expect(first.body).toMatchObject({ total: 2, page: 1, pageSize: 1, rows: [{ enterpriseId: a.enterprise.id, name: '甲企业', group: 'eligible' }] })
  const deep = await query({ titleCode: 'specialized_sme', page: 2, pageSize: 1 })
  expect(deep.body.rows.map((row: any) => row.enterpriseId)).toEqual([b.enterprise.id])
  const little = await query({ titleCode: 'little_giant' })
  expect(little.body.rows.map((row: any) => row.enterpriseId)).toEqual([a.enterprise.id, c.enterprise.id])
  expect((await query({ titleCode: 'innovative_sme' })).body).toMatchObject({ total: 0, rows: [] })
})

it('filters confirmed alias, USCC and district together and preserves qualification evidence', async () => {
  const a = f.candidate('新现名')
  f.db.insert(s.enterpriseAlias).values({ enterpriseId: a.enterprise.id, name: '旧公布名', nameNorm: '旧公布名', sourceKind: 'manual', verificationStatus: 'confirmed' }).run()
  f.db.update(s.record).set({ nameRaw: '旧公布名' }).where(eq(s.record.enterpriseId, a.enterprise.id)).run()
  const b = f.candidate('其他企业')
  f.db.insert(s.enterpriseAlias).values({ enterpriseId: b.enterprise.id, name: '旧公布名', nameNorm: '旧公布名', sourceKind: 'manual', verificationStatus: 'pending' }).run()
  const result = await query({ titleCode: 'specialized_sme', q: '旧公布名', district: '鄞州区' })
  expect(result.body.total).toBe(1)
  expect(result.body.rows[0]).toMatchObject({ enterpriseId: a.enterprise.id, aliases: ['旧公布名'], publishedNames: ['旧公布名'], firstYear: year, publication: '已见本称号宁波公布记录' })
  expect(result.body.rows[0]!.references.join(' ')).toContain('evidence:')
  expect((await query({ titleCode: 'specialized_sme', q: a.enterprise.usccNorm!, district: '海曙区' })).body.total).toBe(0)
})

it('sorts names with stable enterprise ID ties before deep pagination and never exposes raw platform fields', async () => {
  const z = f.candidate('Zeta企业')
  const b = f.candidate('Alpha企业')
  const a = f.candidate('Alpha企业副本')
  f.db.update(s.enterprise).set({ name: 'Alpha企业', nameNorm: 'Alpha企业' }).where(eq(s.enterprise.id, a.enterprise.id)).run()
  f.db.update(s.record).set({ nameRaw: 'Alpha企业' }).where(eq(s.record.enterpriseId, a.enterprise.id)).run()
  const result = await query({ titleCode: 'specialized_sme', sort: 'name_asc', page: 2, pageSize: 1 })
  expect(result.body.total).toBe(3)
  expect(result.body.rows.map((row: any) => row.enterpriseId)).toEqual([a.enterprise.id])
  expect((await query({ titleCode: 'specialized_sme', sort: 'name_desc' })).body.rows.map((row: any) => row.enterpriseId)).toEqual([z.enterprise.id, b.enterprise.id, a.enterprise.id])
  expect(JSON.stringify(result.body)).not.toContain('rawFields')
})
