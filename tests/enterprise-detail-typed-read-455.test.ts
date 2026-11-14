import { initializeDb } from '../db/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createApp, createError, createRouter, defineEventHandler, getRouterParam, setHeader, toNodeListener } from 'h3'
import { afterEach, expect, it, vi } from 'vitest'
import { schema, useDb } from '../db'
import { ensurePlatformObservation } from '../upgrade/frozen/server/platform-business-record'
import { getRosterEnterpriseDetail } from '../lib/roster/enterprise-roster'
import { normalizePlatformRelation } from '../lib/platform/normalization'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

type Source = 'apply_list' | 'business_list' | 'recognized_list'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'enterprise-detail-455-'))
  const db = initializeDb({ create: true, dbPath: join(dir, 'roster.db') })
  cleanup.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  const enterprise = db.insert(schema.enterprise).values({ name: '合成企业详情', nameNorm: '合成企业详情', usccNorm: 'SYN455' }).returning().get()
  let counter = 0
  function row(options: { source?: Source; raw?: Record<string, unknown> | null; stored?: Partial<typeof schema.platformRelation.$inferInsert>; key?: string | null; indexed?: boolean; rdjb?: string; queriedAt?: string } = {}) {
    const source = options.source ?? 'business_list'
    const sequence = ++counter
    const key = options.key === undefined ? (typeof options.raw?.id === 'string' ? options.raw.id : `KEY-${sequence}`) : options.key
    const query = db.insert(schema.platformQuery).values({ interface: source, queryKey: enterprise.usccNorm!, rdjb: options.rdjb ?? '2', queriedAt: options.queriedAt ?? `2026-10-${String(sequence).padStart(2, '0')}T00:00:00Z`, status: 'success' }).returning().get()
    const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, relationKey: key, enterpriseId: enterprise.id, nameRaw: enterprise.name, usccRaw: enterprise.usccNorm, rawFields: options.raw === undefined ? { id: key, qymc: enterprise.name, tyshxydm: enterprise.usccNorm } : options.raw, ...options.stored }).returning().get()
    const projection = options.indexed === false ? null : ensurePlatformObservation(db, relation.id)
    return { query, relation, projection }
  }
  const detail = () => getRosterEnterpriseDetail(db, enterprise.id)! as any
  const observation = (relationId: number) => detail().platform.businessRecords.flatMap((b: any) => b.observationRefs).find((o: any) => o.relationId === relationId)
  return { db, dir, enterprise, row, detail, observation }
}

it('typed fields follow the content version and repeat for repeated observations of that version', () => {
  const f = fixture()
  const raw = { id: 'BL-1', qymc: '办理企业', tyshxydm: '91330211BL', sblx: '复核', year: '2024', sqsj: '2024-02-02', cszt: '已受理', whpc: '2024-1', personuuid: '2021批次', szsfmc: '浙江省宁波市' }
  const first = f.row({ raw, queriedAt: '2026-10-01T00:00:00Z' })
  const replay = f.row({ raw, queriedAt: '2026-10-02T00:00:00Z' })
  const changed = f.row({ raw: { ...raw, cszt: '已办结', whpc: '2024-2' }, queriedAt: '2026-10-03T00:00:00Z' })
  expect(replay.projection!.versionId).toBe(first.projection!.versionId)
  expect(changed.projection!.versionId).not.toBe(first.projection!.versionId)

  const firstTyped = f.observation(first.relation.id).typedFields
  expect(firstTyped).toMatchObject({
    interface: 'business_list', projectionRuleVersion: 'platform-business-v1',
    nameRaw: '办理企业', usccRaw: '91330211BL', declareKind: 'review', year: 2024,
    appliedAt: '2024-02-02', status: '已受理', batch: '2024-1', province: '浙江省宁波市',
  })
  const factWithoutRelation = (fact: NonNullable<typeof firstTyped>) => {
    const { relationId: _relationId, ...rest } = fact
    return rest
  }
  expect(factWithoutRelation(f.observation(replay.relation.id).typedFields)).toEqual(factWithoutRelation(firstTyped))
  expect(f.observation(changed.relation.id).typedFields).toMatchObject({ status: '已办结', batch: '2024-2' })
  expect(f.detail().platform.businessRecords.flatMap((b: any) => b.observationRefs).every((o: any) => o.enterpriseId === f.enterprise.id)).toBe(true)

  const business = f.detail().platform.businessRecords[0]
  expect(business.versionCount).toBe(2)
  expect(business.observationRefs.map((o: any) => [o.relationId, o.businessRecord.versionId, o.typedFields?.status])).toEqual([
    [first.relation.id, first.projection!.versionId, '已受理'],
    [replay.relation.id, first.projection!.versionId, '已受理'],
    [changed.relation.id, changed.projection!.versionId, '已办结'],
  ])
})

it('apply and recognized projections expose their own typed fields without inventing unmodeled ones', () => {
  const f = fixture()
  const apply = f.row({ source: 'apply_list', raw: { id: 'AP-1', qymc: '申报企业', tyshxydm: '91330211AP', sblx: '申请', year: '2025', sqsj: '2025-03-01', cszt: '待审核' } })
  const recognized = f.row({ source: 'recognized_list', raw: { id: 'DIR-1', qymc: '目录企业', tyshxydm: '91330211DIR', rddqrq: '2028-06-01 10:00:00', whpcyear: 2024, whpc: '2024-2', szq: '330203', rdxx: '原认定说明' } })

  const applyTyped = f.observation(apply.relation.id).typedFields
  expect(applyTyped).toMatchObject({ interface: 'apply_list', projectionRuleVersion: 'platform-apply-v1', declareKind: 'apply', year: 2025, appliedAt: '2025-03-01', status: '待审核', nameRaw: '申报企业', usccRaw: '91330211AP' })
  // The apply projection does not model batch/province; they stay outside modeledFields so
  // the detail UI explicitly falls back to the relation column.
  expect(applyTyped.modeledFields).not.toContain('batch')
  expect(applyTyped.modeledFields).not.toContain('province')

  expect(f.observation(recognized.relation.id).typedFields).toMatchObject({
    interface: 'recognized_list', projectionRuleVersion: 'platform-recognized-v1',
    nameRaw: '目录企业', usccRaw: '91330211DIR', validityDateRaw: '2028-06-01 10:00:00',
    maintenanceYear: 2024, maintenanceBatch: '2024-2', district: '330203', awardNote: '原认定说明',
  })
})

it('historical rows without a projection keep the legacy normalized read and no typed fields', () => {
  const f = fixture()
  const raw = { id: 'BL-LEGACY', qymc: '历史企业', tyshxydm: '91330211OLD', sblx: '申请', year: '2019', sqsj: '2019-01-01', cszt: '已受理', whpc: '2019-1', szsfmc: '浙江省' }
  const legacy = f.row({ raw, indexed: false })
  const unindexed = f.row({ raw: { ...raw, id: 'BL-NO-OBS' }, indexed: false })
  const detail = f.detail()
  const normalized = normalizePlatformRelation('business_list', legacy.relation as any)
  const relation = detail.platform.relations.find((r: any) => r.id === legacy.relation.id)
  expect(relation).toMatchObject({ province: '浙江省', status: '已受理', batch: '2019-1', declareKind: 'apply', appliedAt: '2019-01-01' })
  expect(relation).toMatchObject({ province: normalized.province, status: normalized.status, batch: normalized.batch, declareKind: normalized.declareKind, appliedAt: normalized.appliedAt })
  expect(f.observation(legacy.relation.id).typedFields).toBeNull()
  expect(f.observation(unindexed.relation.id)?.typedFields ?? null).toBeNull()
  expect(detail.platform.businessRecords).toHaveLength(2)
})

it('a projected empty/unknown source field stays null and never falls back to the imported column', () => {
  const f = fixture()
  const projected = f.row({ source: 'recognized_list', raw: { id: 'DIR-EMPTY', qymc: '   ', tyshxydm: '', rddqrq: '', whpcyear: '2024.5', whpc: null, szq: '  ', rdxx: null }, stored: { nameRaw: '导入名称', usccRaw: 'IMPORTED-USCC', batch: 'stored-batch', year: 2020 } })
  const typed = f.observation(projected.relation.id).typedFields
  expect(typed).toMatchObject({
    interface: 'recognized_list', projectionRuleVersion: 'platform-recognized-v1',
    nameRaw: null, usccRaw: null, validityDateRaw: null, maintenanceYear: null,
    maintenanceBatch: null, district: null, awardNote: null,
  })
  expect(typed.modeledFields).toEqual(expect.arrayContaining(['nameRaw', 'usccRaw', 'validityDateRaw', 'maintenanceYear', 'maintenanceBatch', 'district', 'awardNote']))
  // The legacy relation columns are still present, proving the null typed value was not backfilled.
  const relation = f.detail().platform.relations.find((r: any) => r.id === projected.relation.id)
  expect(relation).toMatchObject({ nameRaw: '导入名称', usccRaw: 'IMPORTED-USCC', batch: 'stored-batch', year: 2020 })
})

it('stored-vs-raw conflicts stay explicit while typed fields show the archived raw value', () => {
  const f = fixture()
  const conflicted = f.row({ raw: { id: 'BL-CONFLICT', qymc: '冲突企业', tyshxydm: '91330211CF', sblx: '申请', year: '2024', cszt: '终审通过', szsfmc: '浙江省' }, stored: { status: '已退回', province: '江苏省' } })
  const observation = f.observation(conflicted.relation.id)
  expect(observation.conflicts).toContain('platform_field_conflict')
  expect(observation.typedFields).toMatchObject({ status: '终审通过', province: '浙江省' })
  const relation = f.detail().platform.relations.find((r: any) => r.id === conflicted.relation.id)
  // Normalized stored process facts remain null on conflict; only the explicit raw values are typed.
  expect(relation).toMatchObject({ status: null, province: null })
  expect(relation.normalizationConflicts).toEqual(expect.arrayContaining([
    { field: 'status', storedValue: '已退回', rawValue: '终审通过' },
    { field: 'province', storedValue: '江苏省', rawValue: '浙江省' },
  ]))
})

it('HTTP enterprise detail returns the same observations and typed fields without loading canonical raw content', async () => {
  const f = fixture()
  const raw = { id: 'DIR-HTTP', qymc: 'HTTP 目录企业', tyshxydm: '91330211HTTP', rddqrq: '2030-12-31', whpcyear: 2025, whpc: '2025-1', szq: '330211', rdxx: 'HTTP 原认定说明' }
  const projected = f.row({ source: 'recognized_list', raw, queriedAt: '2026-10-05T00:00:00Z' })
  f.row({ source: 'recognized_list', raw: { ...raw, id: 'DIR-LEGACY' }, indexed: false, queriedAt: '2026-10-06T00:00:00Z' })
  const marker = 'CANONICAL-BODY-MUST-NOT-LEAK-455'
  f.db.$client.prepare('update platform_business_record_version set canonical_raw_json=?').run(marker)
  const direct = f.detail()
  vi.stubEnv('NUXT_DB_PATH', join(f.dir, 'roster.db'))
  for (const [key, value] of Object.entries({ defineEventHandler, getRouterParam, createError, setHeader })) vi.stubGlobal(key, value)
  const handler = (await import('../server/api/roster/enterprises/[id].get')).default
  const server = createServer(toNodeListener(createApp().use(createRouter().get('/api/roster/enterprises/:id', handler))))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/roster/enterprises/${f.enterprise.id}`)
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(text).not.toContain(marker)
  const body = JSON.parse(text)
  expect(body.platform.relations.map((r: any) => r.id)).toEqual(direct.platform.relations.map((r: any) => r.id))
  expect(body.platform.businessRecords.map((b: any) => b.observationRefs.map((o: any) => [o.relationId, o.queryId, o.businessRecord.versionId, o.typedFields]))).toEqual(
    direct.platform.businessRecords.map((b: any) => b.observationRefs.map((o: any) => [o.relationId, o.queryId, o.businessRecord.versionId, o.typedFields])),
  )
  expect(body.platform.businessRecords.flatMap((b: any) => b.observationRefs).find((o: any) => o.relationId === projected.relation.id).typedFields).toMatchObject({
    validityDateRaw: '2030-12-31', maintenanceYear: 2025, maintenanceBatch: '2025-1', district: '330211', awardNote: 'HTTP 原认定说明',
  })
})
