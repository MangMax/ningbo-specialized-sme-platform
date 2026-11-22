import { handlePostgresCorrespondenceRequest } from '../../../layers/sme-roster/server/utils/record-correspondence-runtime'
import { eq } from 'drizzle-orm'
import { expect,it } from 'vitest'
import { platformBusinessObservation, platformExportBatch, platformExportRow } from '../../../db/postgresql/platform-tables'
import * as schema from '../fixtures/postgres-tables'
import { useIsolatedPostgresCases, singlePostgresFixtureRow } from '../../support/isolated-postgres-cases'
import type { RosterImportPlatformQuery } from '../../../layers/sme-roster/lib/roster-import-client'
import { readPostgresRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-detail-postgres'
import { preflightPostgresCorrespondences, commitPostgresCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence-write-postgres'
import { listPostgresCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence-postgres'
import type { CorrespondenceRequest } from '../../../layers/sme-roster/server/utils/record-correspondence-model'
import { readFixtureAudit } from './fixtures/postgres-audit'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'

const createDb = useIsolatedPostgresCases()
async function fixture() {
  const db = createDb()
  await db.$client.query(`SELECT
    setval(pg_get_serial_sequence('business.platform_collection', 'public_id'), 100),
    setval(pg_get_serial_sequence('business.platform_business_observation', 'public_id'), 200)
  `)
  const enterprise = singlePostgresFixtureRow(await db.insert(schema.enterprise).values({ name: '原生合同企业', nameNorm: '原生合同企业', usccNorm: '91330211255994457P' }).returning())
  const record = singlePostgresFixtureRow(await db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning())
  const event = singlePostgresFixtureRow(await db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning())
  const query = (queriedAt: string, status = '终审通过'): RosterImportPlatformQuery => ({
    interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt, status: 'success', rawResponse: '<synthetic>original business source</synthetic>',
    relations: [{ sequenceNo: 1, relationKey: 'NATIVE-CONTRACT', enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, nameRaw: enterprise.name, matchBasis: 'uscc', verificationStatus: 'confirmed',
      rawFields: { id: 'NATIVE-CONTRACT', qymc: enterprise.name, tyshxydm: enterprise.usccNorm, sblx: '申请', year: '2024', sqsj: '2024-01-02', cszt: status, privateArchive: 'NATIVE-PRIVATE-SOURCE' } }],
  })
  return { db, enterprise, event, query }
}
function correspondence(key: string, eventId: number, relationId: number): CorrespondenceRequest {
  return { idempotencyKey: key, sourceIdentity: 'native-contract', actor: { type: 'agent', id: 'test' }, basis: 'Explicit same enterprise and title source', ruleId: 'native-contract', ruleVersion: '1',
    operations: [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId, relationId, role: 'supports_award' } }] }
}

it('stores native observation keys while returning public aliases and replaying correspondence without duplicate audit', async () => {
  const f = await fixture()
  const source = await seedPostgresPlatformQuery(f.db, f.query('2026-10-01T00:00:00Z'))
  const relationId = source.relationIds[0]!
  expect(relationId).toBe(201)
  const observation = singlePostgresFixtureRow(await f.db.select({ id: platformBusinessObservation.id }).from(platformBusinessObservation).where(eq(platformBusinessObservation.publicId, relationId)))
  expect(observation.id).not.toBe(relationId)
  const request = correspondence('native-confirm', f.event.id, relationId)
  const plan = await preflightPostgresCorrespondences(f.db, request)
  const receipt = await commitPostgresCorrespondences(f.db, request, plan.planHash)
  expect(receipt.correspondenceIds).toHaveLength(1)
  const id = receipt.correspondenceIds[0]!
  expect(singlePostgresFixtureRow(await f.db.select().from(schema.recordCorrespondence).where(eq(schema.recordCorrespondence.id, id)))).toMatchObject({ observationId: observation.id, status: 'confirmed', revision: 2 })
  expect(await listPostgresCorrespondences(f.db,{})).toEqual([expect.objectContaining({ id, relationId: 201, status: 'confirmed', requiresRevalidation: false })])
  const audit = await readFixtureAudit(f.db, id)
  expect(audit.map(row => row.toStatus)).toEqual(['candidate', 'confirmed'])
  expect(await commitPostgresCorrespondences(f.db, request, plan.planHash)).toEqual(receipt)
  expect(await readFixtureAudit(f.db, id)).toEqual(audit)
})

it.each(['apply_list', 'business_list'] as const)('keeps %s native detail content versions and typed source fields for repeated and changed observations', async sourceKind => {
  const f = await fixture()
  const query = (time: string, status?: string) => ({ ...f.query(time, status), interface: sourceKind, rdjb: sourceKind === 'apply_list' ? '' : '2', titleCode: sourceKind === 'apply_list' ? null : 'specialized_sme' })
  const first = await seedPostgresPlatformQuery(f.db, query('2026-10-01T00:00:00Z'))
  const repeated = await seedPostgresPlatformQuery(f.db, query('2026-10-02T00:00:00Z'))
  const changed = await seedPostgresPlatformQuery(f.db, query('2026-10-03T00:00:00Z', '已退回'))
  const detail = (await readPostgresRosterEnterpriseDetail(f.db, f.enterprise.id))!
  const observations = detail.platform.businessRecords.flatMap(record => record.observationRefs)
  expect(observations.map(row => row.relationId).sort((a, b) => a - b)).toEqual([201, 202, 203])
  expect(first.observations[0]!.versionId).toBe(repeated.observations[0]!.versionId)
  expect(changed.observations[0]!.versionId).not.toBe(first.observations[0]!.versionId)
  const byId = new Map(observations.map(row => [row.relationId, row]))
  expect(byId.get(201)?.typedFields).toMatchObject({ declareKind: 'apply', year: 2024, appliedAt: '2024-01-02', status: '终审通过', nameRaw: '原生合同企业' })
  expect(byId.get(202)?.typedFields).toMatchObject({ status: '终审通过' })
  expect(byId.get(203)?.typedFields).toMatchObject({ status: '已退回' })
  expect(detail.platform.businessRecords[0]).toMatchObject({ versionCount: 2, observationCount: 3 })
  expect(JSON.stringify(detail.platform.businessRecords)).not.toContain('NATIVE-PRIVATE-SOURCE')
})

it('validates exact interface and export candidates without confirming current-source equivalence', async () => {
  const f = await fixture()
  const queriedAt = '2026-10-18T00:00:00Z'
  const raw = { id: 'NATIVE-DIR', qymc: f.enterprise.name, tyshxydm: f.enterprise.usccNorm!, rdjb: '2', rddqrq: '2028-01-01', whpcyear: '2026', whpc: '2026-1' }
  const source = await seedPostgresPlatformQuery(f.db, {
    interface: 'recognized_list', queryKey: 'all', rdjb: '2', titleCode: 'specialized_sme', queriedAt, status: 'success',
    collectionEvidence: {
      source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] },
      queriedAt, completedAt: '2026-10-18T00:01:00Z', rows: [raw],
      pages: [{ source: 'queryBusList', rdjb: '2', page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, maxPage: 1, error: null }],
      fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
      limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 },
    },
    relations: [{ sequenceNo: 1, relationKey: raw.id, enterpriseId: f.enterprise.id, nameRaw: raw.qymc, usccRaw: raw.tyshxydm, rawFields: raw, matchBasis: 'uscc', verificationStatus: 'confirmed' }],
  })
  const directoryDetail = (await readPostgresRosterEnterpriseDetail(f.db, f.enterprise.id))!
  expect(directoryDetail.platform.businessRecords[0]?.observationRefs[0]?.typedFields).toMatchObject({ interface: 'recognized_list', validityDateRaw: '2028-01-01', maintenanceYear: 2026, maintenanceBatch: '2026-1', nameRaw: '原生合同企业' })
  const batch = singlePostgresFixtureRow(await f.db.insert(platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'native-export.xlsx', sha256: 'b'.repeat(64), importStatus: 'imported', createdAt: queriedAt }).returning())
  const exported = singlePostgresFixtureRow(await f.db.insert(platformExportRow).values({ batchId: batch.id, sourceRowNo: 1, createdAt: queriedAt, usccRaw: raw.tyshxydm, nameRaw: raw.qymc }).returning())
  const relationId = source.relationIds[0]!
  const edge = { type: 'recognized_export', relationId, exportRowId: exported.id, role: 'same_current_row' } as const
  const request = correspondence('native-current-row', f.event.id, relationId)
  await expect(preflightPostgresCorrespondences(f.db, { ...request, operations: [{ action: 'create', status: 'confirmed', edge }] })).rejects.toThrow(expect.objectContaining({ code: 'incomplete_coverage' }))
  for (const missing of [{ ...edge, relationId: 9999 }, { ...edge, exportRowId: 9999 }]) {
    await expect(preflightPostgresCorrespondences(f.db, { ...request, operations: [{ action: 'create', status: 'candidate', edge: missing }] })).rejects.toThrow(expect.objectContaining({ code: 'invalid_endpoint_type' }))
  }
  const proposal: CorrespondenceRequest = { ...request, operations: [{ action: 'create', status: 'candidate', edge }] }
  const plan = await preflightPostgresCorrespondences(f.db, proposal)
  const { correspondenceIds: [correspondenceId] } = await commitPostgresCorrespondences(f.db, proposal, plan.planHash)
  const decide: CorrespondenceRequest = { ...request, idempotencyKey: 'confirm-native-current-row', operations: [{ action: 'decide', status: 'confirmed', correspondenceId: correspondenceId!, expectedRevision: 1 }] }
  await expect(preflightPostgresCorrespondences(f.db, decide)).rejects.toThrow(expect.objectContaining({ code: 'incomplete_coverage' }))
  expect(await listPostgresCorrespondences(f.db,{})).toMatchObject([{ id: correspondenceId, relationId: 201, exportRowId: exported.id, status: 'candidate', requiresRevalidation: false }])
  expect((await readFixtureAudit(f.db, correspondenceId!)).map(row => row.toStatus)).toEqual(['candidate'])
  await f.db.update(platformExportRow).set({ district: 'changed selected source' }).where(eq(platformExportRow.id, exported.id))
  expect(await listPostgresCorrespondences(f.db,{})).toMatchObject([{ id: correspondenceId, relationId: 201, exportRowId: exported.id, status: 'candidate', requiresRevalidation: true }])
})

it('preflights and commits native correspondence from the same-origin browser without a configured token', async () => {
  const { createServer } = await import('node:http')
  const { createApp, defineEventHandler, toNodeListener } = await import('h3')
  const { vi } = await import('vitest')
  const { browserCorrespondenceRoute } = await import('../../../layers/sme-roster/server/utils/browser-correspondence')
  const f = await fixture(), source = await seedPostgresPlatformQuery(f.db, f.query('2026-10-01T00:00:00Z'))
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  const app = createApp()
  for (const action of ['preflight', 'commit'] as const) app.use('/' + action, browserCorrespondenceRoute(action))
  const server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing listener')
  const base = `http://127.0.0.1:${address.port}`
  const full = correspondence('browser-without-token', f.event.id, source.relationIds[0]!)
  const request = { idempotencyKey: full.idempotencyKey, basis: full.basis, operations: full.operations }
  const post = (action: string, body: unknown, origin = base) => fetch(base + '/' + action, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    expect((await post('preflight', request, 'https://foreign.invalid')).status).toBe(403)
    const plan = await post('preflight', request)
    expect(plan.status).toBe(200)
    const { planHash } = await plan.json()
    expect(typeof planHash).toBe('string')
    expect((await post('commit', { request, planHash })).status).toBe(200)
    expect(await f.db.select().from(schema.recordCorrespondence)).toHaveLength(1)
    expect((await handlePostgresCorrespondenceRequest({ action: 'preflight', method: 'POST', headers: {}, body: full })).status).toBe(401)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllGlobals() }
})
