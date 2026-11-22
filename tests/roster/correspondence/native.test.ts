import { handleRecordCorrespondenceRequest } from '../../../layers/sme-roster/server/utils/record-correspondence-api'
import { createClassifiedFile } from '../../../layers/sme-roster/server/utils/roster-file-classification'
import { eq } from 'drizzle-orm'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,expect,it } from 'vitest'
import { initializeDb } from '../../../db/client'
import * as schema from '../../../db/schema'
import type { RosterImportPlatformQuery } from '../../../layers/sme-roster/lib/roster-import-client'
import { getRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-roster-sqlite'
import { commitComparisonScopeProofs,preflightComparisonScopeProofs,readComparisonScopeProof,type ProofRequest } from '../../../layers/sme-roster/server/utils/comparison-scope-proof'
import { commitRecordCorrespondences,getRecordCorrespondenceAudit,listRecordCorrespondences,preflightRecordCorrespondences,type CorrespondenceRequest } from '../../../layers/sme-roster/server/utils/record-correspondence'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-correspondence-'))
  const db = initializeDb({ create: true, dbPath: join(root, 'native.sqlite') })
  cleanups.push(() => { db.$client.close(); rmSync(root, { recursive: true, force: true }) })
  db.$client.exec("UPDATE platform_legacy_alias_sequence SET high_water=100 WHERE namespace='query'; UPDATE platform_legacy_alias_sequence SET high_water=200 WHERE namespace='relation'")
  const enterprise = db.insert(schema.enterprise).values({ name: '原生合同企业', nameNorm: '原生合同企业', usccNorm: '91330211255994457P' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
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

it('stores native observation keys while returning public aliases and replaying correspondence without duplicate audit', () => {
  const f = fixture()
  const source = submitNativePlatformQuery(f.db, f.query('2026-10-01T00:00:00Z'))
  const relationId = source.relationIds[0]!
  expect(relationId).toBe(201)
  expect(source.observations[0]!.observationId).not.toBe(relationId)
  const request = correspondence('native-confirm', f.event.id, relationId)
  const plan = preflightRecordCorrespondences(f.db, request)
  const receipt = commitRecordCorrespondences(f.db, request, plan.planHash)
  expect(receipt.correspondenceIds).toHaveLength(1)
  const id = receipt.correspondenceIds[0]!
  expect(f.db.select().from(schema.recordCorrespondence).where(eq(schema.recordCorrespondence.id, id)).get()).toMatchObject({ observationId: source.observations[0]!.observationId, status: 'confirmed', revision: 2 })
  expect(listRecordCorrespondences(f.db)).toEqual([expect.objectContaining({ id, relationId: 201, status: 'confirmed', requiresRevalidation: false })])
  const audit = getRecordCorrespondenceAudit(f.db, id)
  expect(audit.map(row => row.toStatus)).toEqual(['candidate', 'confirmed'])
  expect(commitRecordCorrespondences(f.db, request, plan.planHash)).toEqual(receipt)
  expect(getRecordCorrespondenceAudit(f.db, id)).toEqual(audit)
})

it.each(['apply_list', 'business_list'] as const)('keeps %s native detail content versions and typed source fields for repeated and changed observations', sourceKind => {
  const f = fixture()
  const query = (time: string, status?: string) => ({ ...f.query(time, status), interface: sourceKind, rdjb: sourceKind === 'apply_list' ? '' : '2', titleCode: sourceKind === 'apply_list' ? null : 'specialized_sme' })
  const first = submitNativePlatformQuery(f.db, query('2026-10-01T00:00:00Z'))
  const repeated = submitNativePlatformQuery(f.db, query('2026-10-02T00:00:00Z'))
  const changed = submitNativePlatformQuery(f.db, query('2026-10-03T00:00:00Z', '已退回'))
  const detail = getRosterEnterpriseDetail(f.db, f.enterprise.id)!
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

it('revalidates native recognized-export proof and correspondence when the selected export row changes', () => {
  const f = fixture()
  const queriedAt = '2026-10-18T00:00:00Z'
  const raw = { id: 'NATIVE-DIR', qymc: f.enterprise.name, tyshxydm: f.enterprise.usccNorm!, rdjb: '2', rddqrq: '2028-01-01', whpcyear: '2026', whpc: '2026-1' }
  const source = submitNativePlatformQuery(f.db, {
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
  const directoryDetail = getRosterEnterpriseDetail(f.db, f.enterprise.id)!
  expect(directoryDetail.platform.businessRecords[0]?.observationRefs[0]?.typedFields).toMatchObject({ interface: 'recognized_list', validityDateRaw: '2028-01-01', maintenanceYear: 2026, maintenanceBatch: '2026-1', nameRaw: '原生合同企业' })
  const batch = f.db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'native-export.xlsx', sha256: 'b'.repeat(64), importStatus: 'imported' }).returning().get()
  const exported = f.db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo: 1, usccRaw: raw.tyshxydm, nameRaw: raw.qymc }).returning().get()
  const freeze = createClassifiedFile(f.db, { relPath: 'synthetic/native-freeze', filename: 'native-freeze.txt', ext: 'txt', bytes: 24, sha256: 'c'.repeat(64) }, { source: 'miit', kind: 'export' })
  const proof: ProofRequest = { idempotencyKey: 'native-proof', sourceIdentity: 'native-freeze', actor: { type: 'agent', id: 'test' }, basis: 'Explicit synthetic same-account full-title snapshot', ruleId: 'native-contract', ruleVersion: '1', operations: [{
    action: 'create', kind: 'current_source_equivalence', status: 'confirmed', evidence: {
      queryId: source.queryId, exportBatchId: batch.id, titleCode: 'specialized_sme', queryReference: 'platform_query.collectionEvidence', exportReference: 'platform_export_batch.sha256',
      scope: { queryAccount: 'account', exportAccount: 'account', queryRegion: 'Ningbo', exportRegion: 'Ningbo', queryFilters: { combination: 'and' }, exportFilters: { combination: 'and' }, windowStart: queriedAt, windowEnd: '2026-10-18T23:59:59Z', platformVersion: 'native-freeze-v1', freezeReference: freeze.relPath, freezeFileId: freeze.id, freezeSha256: freeze.sha256! },
    },
  }] }
  const proofPlan = preflightComparisonScopeProofs(f.db, proof)
  const proofId = commitComparisonScopeProofs(f.db, proof, proofPlan.planHash).proofIds[0]!
  expect(readComparisonScopeProof(f.db, proofId)).toMatchObject({ valid: true, status: 'confirmed' })
  const request: CorrespondenceRequest = { ...correspondence('native-current-row', f.event.id, source.relationIds[0]!), proofIds: [proofId], operations: [{ action: 'create', status: 'confirmed', edge: { type: 'recognized_export', relationId: source.relationIds[0]!, exportRowId: exported.id, role: 'same_current_row' } }] }
  const plan = preflightRecordCorrespondences(f.db, request)
  commitRecordCorrespondences(f.db, request, plan.planHash)
  expect(listRecordCorrespondences(f.db)[0]).toMatchObject({ relationId: 201, exportRowId: exported.id, requiresRevalidation: false })
  f.db.update(schema.platformExportRow).set({ district: 'changed selected source' }).where(eq(schema.platformExportRow.id, exported.id)).run()
  expect(readComparisonScopeProof(f.db, proofId)).toMatchObject({ valid: false, invalidReason: 'source_drift_or_missing' })
  expect(listRecordCorrespondences(f.db)[0]).toMatchObject({ relationId: 201, requiresRevalidation: true })
})

it('preflights and commits native correspondence from the same-origin browser without a configured token', async () => {
  const { createServer } = await import('node:http')
  const { createApp, defineEventHandler, toNodeListener } = await import('h3')
  const { vi } = await import('vitest')
  const { browserCorrespondenceRoute } = await import('../../../layers/sme-roster/server/utils/browser-correspondence')
  const { handleRecordCorrespondenceRequest } = await import('../../../layers/sme-roster/server/utils/record-correspondence-api')
  const f = fixture(), source = submitNativePlatformQuery(f.db, f.query('2026-10-01T00:00:00Z'))
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  const app = createApp()
  for (const action of ['preflight', 'commit'] as const) app.use('/' + action, browserCorrespondenceRoute(action, input => handleRecordCorrespondenceRequest(input, { db: f.db, browserAuthorized: true })))
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
    expect(f.db.select().from(schema.recordCorrespondence).all()).toHaveLength(1)
    expect(handleRecordCorrespondenceRequest({ action: 'preflight', method: 'POST', headers: {}, body: full }, { db: f.db }).status).toBe(401)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllGlobals() }
})
