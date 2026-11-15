import { initializeDb } from '../../../upgrade/legacy-client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { useDb, schema } from '../../../upgrade/legacy-client'
import { ensurePlatformObservation } from '../../../upgrade/frozen/server/platform-business-record'
import { readPlatformBusinessDetails } from '../../../upgrade/frozen/server/platform-business-detail-read'
import { getPlatformBusinessProcess, listPlatformBusinessProcesses } from '../../../upgrade/frozen/server/platform-business-processes'

const dir = mkdtempSync(join(tmpdir(), 'business-processes-shadow-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'shadow.sqlite') })
afterAll(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

function seedBusiness(queryKey: string, queryRdbj: string, time: string, raw: Record<string, unknown>, scopes: string[], relationKey: string | null = typeof raw.id === 'string' ? raw.id : null) {
  const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey, rdjb: queryRdbj, queriedAt: time, status: 'success' }).returning().get()
  for (const rdjb of scopes) db.insert(schema.platformQueryTitleScope).values({ queryId: query.id, rdjb }).onConflictDoNothing().run()
  const relation = db.insert(schema.platformRelation).values({
    queryId: query.id, sequenceNo: 1, relationKey,
    nameRaw: typeof raw.qymc === 'string' ? raw.qymc : null, usccRaw: typeof raw.tyshxydm === 'string' ? raw.tyshxydm : null,
    rawFields: raw,
  }).returning().get()
  return { query, relation }
}

it('shadow-compares old and new readers on the same observations, including filters, pagination, conflicts and decisions', () => {
  const enterprise = db.insert(schema.enterprise).values({ name: '影子企业', nameNorm: '影子企业', usccNorm: '91330211255994457P' }).returning().get()
  const rawK1 = { id: 'SQ-SHADOW-1', qymc: '影子企业', tyshxydm: enterprise.usccNorm, sblx: '复核', year: 2023, sqsj: '2023-02-01', cszt: '终审通过', whpc: '2023-2', personuuid: '第三批', szsfmc: '浙江省' }
  const rawK2 = { id: 'SQ-SHADOW-2', qymc: '影子企业', tyshxydm: enterprise.usccNorm, sblx: '申请', year: 2022, sqsj: '2022-02-01', cszt: '待审核', whpc: '2022-1' }
  const one = seedBusiness(enterprise.usccNorm!, '2', '2026-10-01T00:00:00Z', rawK1, ['2'])
  const replay = seedBusiness(enterprise.usccNorm!, '2', '2026-10-02T00:00:00Z', rawK1, ['2'])
  const two = seedBusiness(enterprise.usccNorm!, '1', '2026-10-03T00:00:00Z', rawK2, ['1', '3'])
  const missing = seedBusiness('name:影子无编号', '2', '2026-10-04T00:00:00Z', { qymc: '影子无编号', sblx: '补录' }, ['2'], null)
  const conflict = seedBusiness('name:影子冲突', '1', '2026-10-05T00:00:00Z', { id: 'RAW-CONFLICT', qymc: '影子冲突' }, ['1'], 'REL-CONFLICT')
  const all = [one, replay, two, missing, conflict]
  for (const relation of all) {
    db.update(schema.platformRelation).set({ enterpriseId: enterprise.id }).where(eq(schema.platformRelation.id, relation.relation.id)).run()
    ensurePlatformObservation(db, relation.relation.id)
  }
  db.insert(schema.recordCorrespondence).values({
    edgeKey: 'shadow-decision', type: 'event_process', role: 'supports_award', relationId: one.relation.id, enterpriseId: enterprise.id,
    titleCode: 'specialized_sme', status: 'confirmed', revision: 2, targetIdentity: {}, provenance: {},
    sourceFingerprint: 'synthetic', ruleId: 'manual', ruleVersion: '1', createdAt: '2026-10-02T00:00:00Z', decidedAt: '2026-10-02T00:00:00Z',
  }).run()

  const queries = db.select().from(schema.platformQuery).all().map(query => ({ ...query, relationCount: 0 }))
  const relations = db.select().from(schema.platformRelation).all()
  const old = readPlatformBusinessDetails(db, enterprise.id, queries, relations).filter(detail => detail.businessRecord.interface === 'business_list')
  const oldResolved = old.filter(detail => detail.businessRecord.recordId != null)
  const oldIsolated = old.filter(detail => detail.businessRecord.recordId == null)
  const fresh = listPlatformBusinessProcesses({ enterpriseId: enterprise.id }, db)
  const isolated = listPlatformBusinessProcesses({ enterpriseId: enterprise.id, view: 'isolated' }, db)

  // Record identity, counts and old ID locations are equal, not merely "no difference pushed".
  expect(fresh.rows.map(row => (row as any).record.platformKey).sort()).toEqual(oldResolved.map(detail => detail.businessRecord.platformKey).sort())
  expect(fresh.total).toBe(oldResolved.length)
  for (const detail of oldResolved) {
    const row = fresh.rows.find(candidate => (candidate as any).record.platformKey === detail.businessRecord.platformKey) as any
    expect(row.versionCount, detail.businessRecord.platformKey ?? '').toBe(detail.versionCount)
    expect(row.observationCount, detail.businessRecord.platformKey ?? '').toBe(detail.observationCount)
    const freshDetail = getPlatformBusinessProcess(db, row.record.id)
    expect(freshDetail.observations.map(observation => observation.relationId).sort((a, b) => a - b)).toEqual(detail.observationRefs.map(observation => observation.relationId).sort((a, b) => a - b))
    expect(freshDetail.versions.map(version => version.versionId).sort((a, b) => a - b)).toEqual(detail.versions.map(version => version.businessRecord.versionId!).sort((a, b) => a! - b!))
  }

  // Pagination and filtered subsets agree with the old reader's membership.
  const firstPage = listPlatformBusinessProcesses({ enterpriseId: enterprise.id, page: 1, pageSize: 1 }, db)
  const secondPage = listPlatformBusinessProcesses({ enterpriseId: enterprise.id, page: 2, pageSize: 1 }, db)
  expect(firstPage.total).toBe(oldResolved.length)
  expect(firstPage.rows).toHaveLength(1)
  expect(secondPage.rows).toHaveLength(1)
  expect([firstPage.rows[0], secondPage.rows[0]].map(row => (row as any).record.platformKey).sort()).toEqual(oldResolved.map(detail => detail.businessRecord.platformKey).sort())
  expect(listPlatformBusinessProcesses({ enterpriseId: enterprise.id, platformKey: 'SQ-SHADOW-1' }, db).rows).toHaveLength(oldResolved.filter(detail => detail.businessRecord.platformKey === 'SQ-SHADOW-1').length)
  expect(listPlatformBusinessProcesses({ enterpriseId: enterprise.id, rdjb: '1' }, db).rows.map(row => (row as any).record.platformKey)).toEqual(['SQ-SHADOW-2'])
  expect(oldResolved.filter(detail => detail.observationRefs.some(observation => observation.titleCode === 'innovative_sme')).map(detail => detail.businessRecord.platformKey)).toEqual(['SQ-SHADOW-2'])

  // Observation-scoped decisions survive on both sides without propagating to other observations.
  expect(oldResolved.find(detail => detail.businessRecord.platformKey === 'SQ-SHADOW-1')!.observationRefs.some(observation => observation.existingCorrespondenceIds.includes(1))).toBe(true)
  const freshK1 = getPlatformBusinessProcess(db, (fresh.rows.find(row => (row as any).record.platformKey === 'SQ-SHADOW-1') as any).record.id)
  expect(freshK1.observations.find(observation => observation.relationId === one.relation.id)?.correspondenceRefs).toEqual([{ id: 1, status: 'confirmed', revision: 2 }])
  expect(freshK1.observations.filter(observation => observation.relationId !== one.relation.id).every(observation => observation.correspondenceRefs.length === 0)).toBe(true)

  // Approved semantic differences: isolated observations are separated and the new reader adds typed/query-scope fields.
  expect(isolated.rows.map(row => (row as any).identityState).sort()).toEqual(['conflict', 'missing_key'])
  expect(oldIsolated).toHaveLength(2)
  expect(fresh.rows.some(row => (row as any).titleScopes.length)).toBe(true)
  expect(fresh.rows.find(row => (row as any).record.platformKey === 'SQ-SHADOW-1')).toMatchObject({ titleScopes: ['2'], matchedVersion: { businessYear: 2023, declareKind: 'review', batch: '2023-2' } })
  expect(oldResolved.every(detail => !('titleScopes' in detail.businessRecord))).toBe(true)
  expect(oldResolved.every(detail => !('businessYear' in detail.businessRecord))).toBe(true)
  console.log('SHADOW_DIFF', JSON.stringify(['isolated_observation_separated', 'typed_and_title_scope_additive_only']))
})
