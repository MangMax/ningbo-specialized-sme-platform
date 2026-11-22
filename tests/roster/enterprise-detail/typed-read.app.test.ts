import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { eq } from 'drizzle-orm'
import { submitSyntheticRecognizedCollection } from '../fixtures/recognized-source'
import type { RosterImportRelation } from '../../../layers/sme-roster/lib/roster-import-client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createApp, createError, createRouter, defineEventHandler, getRouterParam, setHeader, toNodeListener } from 'h3'
import { afterEach, expect, it, vi } from 'vitest'
import * as schema from '../fixtures/postgres-tables'
import { readPostgresRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-detail-postgres'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

type Source = 'apply_list' | 'business_list' | 'recognized_list'

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'enterprise-detail-455-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const postgres = await postgresRuntimeFixture({ dir })
  cleanup.push(async () => { await closePostgresDirectoryDb(); postgres.close() })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  const db = usePostgresDirectoryDb()
  const enterprise = (await db.insert(schema.enterprise).values({ name: '合成企业详情', nameNorm: '合成企业详情', usccNorm: 'SYN455' }).returning())[0]!
  let counter = 0
  async function row(options: { source?: Source; raw?: Record<string, unknown> | null; stored?: Partial<RosterImportRelation>; key?: string | null; rdjb?: string; queriedAt?: string } = {}) {
    const source=options.source??'business_list',sequence=++counter
    const raw=options.raw===undefined?{id:`KEY-${sequence}`,qymc:enterprise.name,tyshxydm:enterprise.usccNorm}:options.raw
    const queriedAt=options.queriedAt??`2026-10-${String(sequence).padStart(2,'0')}T00:00:00Z`
    const key=options.key===undefined?(typeof raw?.id==='string'?raw.id:`KEY-${sequence}`):options.key
    const input={sequenceNo:1,relationKey:key,enterpriseId:enterprise.id,nameRaw:enterprise.name,usccRaw:enterprise.usccNorm,rawFields:raw,...options.stored}
    let native
    if(source==='recognized_list'){
      if(typeof raw?.tyshxydm==='string')await db.update(schema.enterprise).set({ usccNorm: raw.tyshxydm }).where(eq(schema.enterprise.id, enterprise.id))
      native=await submitSyntheticRecognizedCollection(db,{rdjb:options.rdjb??'2',queriedAt,rows:[{enterpriseId:enterprise.id,raw:raw??{}}]})
    }else native=await seedPostgresPlatformQuery(db,{interface:source,queryKey:enterprise.usccNorm!,rdjb:options.rdjb??'2',queriedAt,status:'success',rawResponse:JSON.stringify(raw),relations:[input]})
    return {query:{id:native.queryId},relation:{...input,id:native.relationIds[0]!},projection:native.observations[0]!}
  }
  const detail = async () => (await readPostgresRosterEnterpriseDetail(db, enterprise.id))! as any
  const observation = async (relationId: number) => (await detail()).platform.businessRecords.flatMap((b: any) => b.observationRefs).find((o: any) => o.relationId === relationId)
  return { db, dir, enterprise, row, detail, observation }
}

it('enterprise detail exposes typed fields only for the current verified capture', { timeout: 30_000 }, async () => {
  const f = await fixture()
  const raw = { id: 'BL-1', qymc: '办理企业', tyshxydm: '91330211BL', sblx: '复核', year: '2024', sqsj: '2024-02-02', cszt: '已受理', whpc: '2024-1', personuuid: '2021批次', szsfmc: '浙江省宁波市' }
  const first = await f.row({ raw, queriedAt: '2026-10-01T00:00:00Z' })
  const firstTyped = (await f.observation(first.relation.id)).typedFields
  expect(firstTyped).toMatchObject({
    interface: 'business_list', projectionRuleVersion: 'platform-business-v1',
    nameRaw: '办理企业', usccRaw: '91330211BL', declareKind: 'review', year: 2024,
    appliedAt: '2024-02-02', status: '已受理', batch: '2024-1', province: '浙江省宁波市',
  })

  const replay = await f.row({ raw, queriedAt: '2026-10-02T00:00:00Z' })
  expect(replay.projection.versionId).toBe(first.projection.versionId)
  const repeated = (await f.detail()).platform
  expect(repeated.relations.map((row: { id: number }) => row.id)).toEqual([replay.relation.id])
  expect(repeated.businessRecords).toMatchObject([
    { observationRefs: [{ relationId: replay.relation.id, businessRecord: { versionId: first.projection.versionId } }] },
  ])
  expect(repeated.businessRecords[0].observationRefs[0].typedFields).toEqual({ ...firstTyped, relationId: replay.relation.id })

  const changed = await f.row({ raw: { ...raw, cszt: '已办结', whpc: '2024-2' }, queriedAt: '2026-10-03T00:00:00Z' })
  expect(changed.projection.versionId).not.toBe(first.projection.versionId)
  const current = (await f.detail()).platform
  expect(current.relations.map((row: { id: number }) => row.id)).toEqual([changed.relation.id])
  expect(current.businessRecords).toMatchObject([{
    representativeRelationId: changed.relation.id, versionCount: 1, observationCount: 1,
    observationRefs: [{
      relationId: changed.relation.id, enterpriseId: f.enterprise.id, businessRecord: { versionId: changed.projection.versionId },
      typedFields: { relationId: changed.relation.id, projectionVersionId: changed.projection.versionId, status: '已办结', batch: '2024-2' },
    }],
    versions: [{ representativeRelationId: changed.relation.id }],
  }])
})

it('apply and recognized projections expose their own typed fields without inventing unmodeled ones', { timeout: 30_000 }, async () => {
  const f = await fixture()
  const apply = (await f.row({ source: 'apply_list', raw: { id: 'AP-1', qymc: '申报企业', tyshxydm: '91330211AP', sblx: '申请', year: '2025', sqsj: '2025-03-01', cszt: '待审核' } }))
  const recognized = (await f.row({ source: 'recognized_list', raw: { id: 'DIR-1', qymc: '目录企业', tyshxydm: '91330211DIR', rddqrq: '2028-06-01 10:00:00', whpcyear: 2024, whpc: '2024-2', szq: '330203', rdxx: '原认定说明' } }))

  const applyTyped = (await f.observation(apply.relation.id)).typedFields
  expect(applyTyped).toMatchObject({ interface: 'apply_list', projectionRuleVersion: 'platform-apply-v1', declareKind: 'apply', year: 2025, appliedAt: '2025-03-01', status: '待审核', nameRaw: '申报企业', usccRaw: '91330211AP' })
  // The apply projection does not model batch/province; they stay outside modeledFields so
  // the detail UI explicitly falls back to the relation column.
  expect(applyTyped.modeledFields).not.toContain('batch')
  expect(applyTyped.modeledFields).not.toContain('province')

  expect((await f.observation(recognized.relation.id)).typedFields).toMatchObject({
    interface: 'recognized_list', projectionRuleVersion: 'platform-recognized-v1',
    nameRaw: '目录企业', usccRaw: '91330211DIR', validityDateRaw: '2028-06-01 10:00:00',
    maintenanceYear: 2024, maintenanceBatch: '2024-2', district: '330203', awardNote: '原认定说明',
  })
})

it('rejects conflicting imported process facts before publishing a native observation', { timeout: 30_000 }, async () => {
  const f=await fixture()
  await expect(f.row({raw:{id:'BL-CONFLICT',cszt:'终审通过',szsfmc:'浙江省'},stored:{status:'已退回',province:'江苏省'}})).rejects.toThrow('platform_field_conflict')
  expect((await f.detail()).platform.businessRecords).toEqual([])
})

it('HTTP enterprise detail returns typed observations and preserves source originals separately', async () => {
  const f = await fixture()
  const raw = { id: 'DIR-HTTP', qymc: 'HTTP 目录企业', tyshxydm: '91330211HTTP', rddqrq: '2030-12-31', whpcyear: 2025, whpc: '2025-1', szq: '330211', rdxx: 'HTTP 原认定说明', secret: 'CANONICAL-BODY-MUST-NOT-LEAK-455' }
  const projected = (await f.row({ source: 'recognized_list', raw, queriedAt: '2026-10-05T00:00:00Z' }))
  const marker = 'CANONICAL-BODY-MUST-NOT-LEAK-455'
  const direct = (await f.detail())
  for (const [key, value] of Object.entries({ defineEventHandler, getRouterParam, createError, setHeader })) vi.stubGlobal(key, value)
  const handler = (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id].get')).default
  const server = createServer(toNodeListener(createApp().use(createRouter().get('/api/roster/enterprises/:id', handler))))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/roster/enterprises/${f.enterprise.id}`)
  expect(response.status).toBe(200)
  const text = await response.text()
  const body = JSON.parse(text)
  expect(JSON.stringify(body.platform.businessRecords)).not.toContain(marker)
  expect(body.platform.relations[0].rawFields.secret).toBe(marker)
  expect(body.platform.relations.map((r: any) => r.id)).toEqual(direct.platform.relations.map((r: any) => r.id))
  expect(body.platform.businessRecords.map((b: any) => b.observationRefs.map((o: any) => [o.relationId, o.queryId, o.businessRecord.versionId, o.typedFields]))).toEqual(
    direct.platform.businessRecords.map((b: any) => b.observationRefs.map((o: any) => [o.relationId, o.queryId, o.businessRecord.versionId, o.typedFields])),
  )
  expect(body.platform.businessRecords.flatMap((b: any) => b.observationRefs).find((o: any) => o.relationId === projected.relation.id).typedFields).toMatchObject({
    validityDateRaw: '2030-12-31', maintenanceYear: 2025, maintenanceBatch: '2025-1', district: '330211', awardNote: 'HTTP 原认定说明',
  })
}, 30_000)
