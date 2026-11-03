import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { useDb, schema } from '../db'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { readPlatformBusinessDetails } from '../server/utils/platform-business-detail-read'
import { getPlatformBusinessProcess, listPlatformBusinessProcesses } from '../server/utils/platform-business-processes'

const dir = mkdtempSync(join(tmpdir(), 'business-processes-shadow-'))
const db = useDb({ dbPath: join(dir, 'shadow.sqlite') })
afterAll(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

function seedBusiness(queryKey: string, queryRdbj: string, time: string, raw: Record<string, unknown>, scopes: string[]) {
  const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey, rdjb: queryRdbj, queriedAt: time, status: 'success' }).returning().get()
  for (const rdjb of scopes) db.insert(schema.platformQueryTitleScope).values({ queryId: query.id, rdjb }).onConflictDoNothing().run()
  const relation = db.insert(schema.platformRelation).values({
    queryId: query.id, sequenceNo: 1, relationKey: typeof raw.id === 'string' ? raw.id : null,
    nameRaw: typeof raw.qymc === 'string' ? raw.qymc : null, usccRaw: typeof raw.tyshxydm === 'string' ? raw.tyshxydm : null,
    rawFields: raw,
  }).returning().get()
  return { query, relation }
}

it('shadow-compares the old enterprise business reader with the new typed reader on the same observations', () => {
  const enterprise = db.insert(schema.enterprise).values({ name: '影子企业', nameNorm: '影子企业', usccNorm: '91330211255994457P' }).returning().get()
  const rawK1 = { id: 'SQ-SHADOW-1', qymc: '影子企业', tyshxydm: enterprise.usccNorm, sblx: '复核', year: 2023, sqsj: '2023-02-01', cszt: '终审通过', whpc: '2023-2', personuuid: '第三批', szsfmc: '浙江省' }
  const rawK2 = { id: 'SQ-SHADOW-2', qymc: '影子企业', tyshxydm: enterprise.usccNorm, sblx: '申请', year: 2022, sqsj: '2022-02-01', cszt: '待审核', whpc: '2022-1' }
  const one = seedBusiness(enterprise.usccNorm!, '2', '2026-10-01T00:00:00Z', rawK1, ['2'])
  const replay = seedBusiness(enterprise.usccNorm!, '2', '2026-10-02T00:00:00Z', rawK1, ['2'])
  const two = seedBusiness(enterprise.usccNorm!, '1', '2026-10-03T00:00:00Z', rawK2, ['1', '3'])
  const missing = seedBusiness('name:影子无编号', '2', '2026-10-04T00:00:00Z', { qymc: '影子无编号', sblx: '补录' }, ['2'])
  // Assign all four observations to the enterprise (the reader scopes by enterprise).
  for (const relation of [one.relation, replay.relation, two.relation, missing.relation]) {
    db.update(schema.platformRelation).set({ enterpriseId: enterprise.id }).where(eq(schema.platformRelation.id, relation.id)).run()
  }
  for (const relation of [one.relation, replay.relation, two.relation, missing.relation]) ensurePlatformObservation(db, relation.id)

  const queries = db.select().from(schema.platformQuery).all().map(query => ({ ...query, relationCount: 0 }))
  const relations = db.select().from(schema.platformRelation).all()
  const old = readPlatformBusinessDetails(db, enterprise.id, queries, relations).filter(detail => detail.businessRecord.interface === 'business_list')
  const fresh = listPlatformBusinessProcesses({ enterpriseId: enterprise.id }, db)
  const isolated = listPlatformBusinessProcesses({ enterpriseId: enterprise.id, view: 'isolated' }, db)
  const differences: string[] = []

  const oldKeys = old.filter(detail => detail.businessRecord.recordId != null).map(detail => detail.businessRecord.platformKey).sort()
  const newKeys = fresh.rows.map(row => (row as any).record.platformKey).sort()
  if (JSON.stringify(oldKeys) !== JSON.stringify(newKeys)) differences.push('record_identity')
  for (const detail of old.filter(detail => detail.businessRecord.recordId != null)) {
    const row = fresh.rows.find(candidate => (candidate as any).record.platformKey === detail.businessRecord.platformKey) as any
    if (!row || row.versionCount !== detail.versionCount || row.observationCount !== detail.observationCount) differences.push('version_or_observation_count')
    if (row) {
      const freshDetail = getPlatformBusinessProcess(db, row.record.id)
      const oldObservationIds = detail.observationRefs.map(observation => observation.relationId).sort((a, b) => a - b)
      const newObservationIds = freshDetail.observations.map(observation => observation.relationId).sort((a, b) => a - b)
      if (JSON.stringify(oldObservationIds) !== JSON.stringify(newObservationIds)) differences.push('observation_id_mismatch')
      const oldVersionIds = detail.versions.map(version => version.businessRecord.versionId).sort((a, b) => a! - b!)
      const newVersionIds = freshDetail.versions.map(version => version.versionId).sort((a, b) => a - b)
      if (JSON.stringify(oldVersionIds) !== JSON.stringify(newVersionIds)) differences.push('version_id_mismatch')
    }
  }
  if (old.some(detail => detail.businessRecord.recordId == null) && isolated.rows.length) differences.push('isolated_observation_separated')
  if (fresh.rows.some(row => (row as any).titleScopes.length) && old.every(detail => !('titleScopes' in detail.businessRecord))) differences.push('title_scope_only_in_new')
  if (fresh.rows.some(row => (row as any).matchedVersion.businessYear != null) && old.every(detail => !('businessYear' in detail.businessRecord))) differences.push('typed_fields_only_in_new')

  expect(differences).toEqual(['isolated_observation_separated', 'title_scope_only_in_new', 'typed_fields_only_in_new'])
  expect(fresh.rows.map(row => (row as any).record.platformKey).sort()).toEqual(['SQ-SHADOW-1', 'SQ-SHADOW-2'])
  expect(fresh.rows.find(row => (row as any).record.platformKey === 'SQ-SHADOW-1')).toMatchObject({ versionCount: 1, observationCount: 2 })
  expect(fresh.rows.find(row => (row as any).record.platformKey === 'SQ-SHADOW-2')).toMatchObject({ versionCount: 1, observationCount: 1, titleScopes: ['1', '3'] })
  expect(isolated.rows.map(row => (row as any).nameRaw)).toEqual(['影子无编号'])
  console.log('SHADOW_DIFF', JSON.stringify(differences))
})
