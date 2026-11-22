import { createHash } from 'node:crypto'
import { readExportWorkbook } from '../../support/read-workbook'
import { listCurrentQualified, type CurrentQualifiedResult } from '../../../layers/sme-roster/lib/roster/current-qualified-query'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { commitRecordCorrespondences, listRecordCorrespondenceRefs, preflightRecordCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence'
import { commitComparisonScopeProofs, preflightComparisonScopeProofs } from '../../../layers/sme-roster/server/utils/comparison-scope-proof'
import { readPostgresCorrespondenceRefs } from '../../../layers/sme-roster/server/utils/record-correspondence-postgres-refs'
import { nativeAppAdapter } from '../../support/native-app'
import { createClassifiedFile } from '../../../layers/sme-roster/server/utils/roster-file-classification'
import { spawnCompiledApp } from '../../support/owned-process.mjs'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { initializeDb, schema } from '../../../db/client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

const dir = mkdtempSync(join(tmpdir(), 'spec63-proof-http-'))
const dbPath = join(dir, 'synthetic.db')
const db = initializeDb({ create: true,  dbPath })
const file = createClassifiedFile(db, { relPath: 'synthetic/notice.pdf', filename: 'notice.pdf', ext: 'pdf', bytes: 12, sha256: 'a'.repeat(64) }, { source: 'jxj', kind: 'announcement' })
const freezeFile = createClassifiedFile(db, { relPath: 'synthetic/archive/freeze-v1', filename: 'freeze-v1.txt', ext: 'txt', bytes: 24, sha256: 'c'.repeat(64) }, { source: 'miit', kind: 'export' })
const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Synthetic complete notice', path: file.relPath, issueDate: '2024-05-01' }).returning().get()
const enterprise = db.insert(schema.enterprise).values({ name: '甲企业', nameNorm: '甲企业', usccNorm: '91330211255994475A' }).returning().get()
const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, page: 3, listNo: 2 }).run()
const conditions = { combination: 'and' }
const sourceRows = [
  { id: 'proof-1', tyshxydm: enterprise.usccNorm!, qymc: '甲企业' },
  { id: 'proof-2', tyshxydm: '91330211255994476B', qymc: '接口独有' },
  { id: 'proof-3', tyshxydm: '91330211255994477C', qymc: '接口名称' },
  { id: 'proof-4', tyshxydm: '91330211255994479E', qymc: 'REST 显式证明' },
  { id: 'proof-5', tyshxydm: '91330211255994480F', qymc: 'MCP 省略证明' },
].map(row => ({ ...row, rdjb: '2', whpcyear: '2024' }))
const collection = { source: 'queryBusList' as const, status: 'success' as const, effectiveConditions: { combination: 'and' as const }, titleScope: { mode: 'selected' as const, rdjb: ['2'] }, queriedAt: '2026-10-18T00:00:00Z', completedAt: '2026-10-18T00:01:00Z', rows: sourceRows, pages: [{ source: 'queryBusList' as const, rdjb: '2', page: 1, maxPage: 1, status: 'success' as const, fetchedCount: 5, declaredTotal: 5, error: null }], fetchedCount: 5, declaredTotal: 5, completeness: 'complete' as const, fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } }
const native = submitNativePlatformQuery(db, { interface: 'recognized_list', queryKey: 'all', rdjb: '2', titleCode: 'specialized_sme', queriedAt: collection.queriedAt, status: 'success', collectionEvidence: collection, relations: sourceRows.map((rawFields, i) => ({ sequenceNo: i + 1, relationKey: rawFields.id, rawFields, nameRaw: rawFields.qymc, usccRaw: rawFields.tyshxydm, enterpriseId: i === 0 ? enterprise.id : null, verificationStatus: i === 0 ? 'confirmed' : 'pending', matchBasis: i === 0 ? 'uscc' : 'none' })) })
const query = { id: native.queryId }
const [matchedRelation, , otherRelation, restExplicitRelation, mcpOmittedRelation] = native.relationIds.map(id => ({ id }))
// A process source explicitly supplies the historical award year. Directory
// maintenance years cannot be promoted into this historical field.
const historicalCollection = submitNativePlatformQuery(db, { interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-18T00:00:00Z', status: 'success', rawResponse: '{"synthetic":"2024 award process"}', relations: [{ sequenceNo: 1, relationKey: 'HISTORICAL-2024', enterpriseId: enterprise.id, nameRaw: enterprise.name, usccRaw: enterprise.usccNorm, year: 2024, status: '终审通过', verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields: { id: 'HISTORICAL-2024' } }] })
const historicalRelationId = historicalCollection.relationIds[0]!
const batch = db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'synthetic.xlsx', sha256: 'b'.repeat(64), importStatus: 'imported' }).returning().get()
const addExport = (sourceRowNo: number, uscc: string, name: string) => db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo, usccRaw: uscc, nameRaw: name }).returning().get()
const matchedExport = addExport(2, enterprise.usccNorm!, '甲企业')
const otherExport = addExport(3, '91330211255994477C', '导出名称')
addExport(4, '91330211255994478D', '导出独有')
const restExplicitExport = addExport(5, '91330211255994479E', 'REST 显式证明')
const mcpOmittedExport = addExport(6, '91330211255994480F', 'MCP 省略证明')
let service: { baseUrl: string; stop: () => Promise<void> }
let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let runtimeDb: pg.Pool | undefined
const sourceQuery = `queryIds=${query.id},${historicalCollection.queryId}&exportBatchIds=${batch.id}&officialSourceDocumentIds=${doc.id}`
const api = (path: string) => `${service.baseUrl}/api/roster/${path}`
const history = new Map<string, { kind: 'proof' | 'correspondence'; request: unknown }>()
function remember(kind: 'proof' | 'correspondence', envelope: unknown) {
  const { request } = envelope as { request: { idempotencyKey: string } }
  history.set(request.idempotencyKey, { kind, request })
}
async function post(path: string, body: unknown, authorized = true) {
  const response = await fetch(api(path), { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer synthetic-api-token' } : {}) }, body: JSON.stringify(body) })
  if (response.ok && path === 'comparison-scope-proofs/commit') remember('proof', body)
  if (response.ok && path === 'correspondences/commit') remember('correspondence', body)
  return response
}
async function json(response: Response) { return response.json() as Promise<any> }
const baseDecision = (id: string) => ({ idempotencyKey: id, sourceIdentity: `synthetic/${id}`, actor: { type: 'agent', id: 'synthetic-agent' }, basis: 'Reviewed archived original sources, scope, and same platform freeze', ruleId: 'manual-review', ruleVersion: '1' })
const officialRequest = { ...baseDecision('official-proof'), operations: [{ action: 'create', kind: 'official_coverage', status: 'confirmed', evidence: { titleCode: 'specialized_sme', fromYear: 2024, throughYear: 2024, enterpriseIds: null, fullRange: true, sourceDocuments: [{ id: doc.id, fileId: file.id, sha256: file.sha256, reference: { field: 'record_evidence.source_file', page: 3, listNo: 2 } }] } }] }
const currentRequest = { ...baseDecision('current-proof'), operations: [{ action: 'create', kind: 'current_source_equivalence', status: 'confirmed', evidence: { queryId: query.id, exportBatchId: batch.id, titleCode: 'specialized_sme', queryReference: 'platform_query.collectionEvidence', exportReference: 'platform_export_batch.sha256', scope: { queryAccount: 'synthetic-account', exportAccount: 'synthetic-account', queryRegion: 'synthetic-region', exportRegion: 'synthetic-region', queryFilters: conditions, exportFilters: conditions, windowStart: '2026-10-18T00:00:00Z', windowEnd: '2026-10-18T23:59:59Z', platformVersion: 'synthetic-freeze-v1', freezeReference: freezeFile.relPath, freezeFileId: freezeFile.id, freezeSha256: freezeFile.sha256 } } }] }
async function rpc(method: string, params?: Record<string, unknown>, authorized = false) {
  const response = await fetch(`${service.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(authorized ? { authorization: 'Bearer synthetic-mcp-token' } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const raw = await response.text()
  const payload = raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))?.slice(6) : raw
  const body = JSON.parse(payload!)
  if (response.ok && body.result && !body.result.isError && !body.error) {
    if (params?.name === 'commit_comparison_scope_proofs') remember('proof', params.arguments)
    if (params?.name === 'save_record_correspondences') remember('correspondence', params.arguments)
  }
  return { status: response.status, body }
}
const mcpValue = (result: any) => JSON.parse(result.body.result.content[0].text)

beforeAll(async () => {
  runtime = await postgresRuntimeFixture({ dir, sourcePath: dbPath })
  runtimeDb = new pg.Pool({ connectionString: runtime.url })
  const cwd = resolve(import.meta.dirname, '../../..')
  const port = await reserveLoopbackPort()
  const child = spawnCompiledApp(port, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...runtime.env, NUXT_BUILD_DIR: join(dir, 'nuxt-build'), NUXT_API_TOKEN: 'synthetic-api-token', NUXT_MCP_TOKEN: 'synthetic-mcp-token', NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'), NUXT_ROSTER_EXPORT_DIR: join(dir, 'exports') } })
  let startupOutput = ''
  for (const stream of [child.stdout,child.stderr]) stream.on('data', data => { startupOutput = (startupOutput+data).slice(-8000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(service.baseUrl + '/api/health', { timeoutMs: 60000, child }) } catch (error) { await service.stop(); throw new Error(`${String(error)}\n${startupOutput}`) }
}, 90000)
afterAll(async () => {
  try { if (service) await service.stop() }
  finally { await runtimeDb?.end(); runtime?.close(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) }
})

describe('stored comparison scope proofs through real HTTP and MCP', () => {
  let officialProofId: number
  let currentProofId: number
  it('keeps comparison unknown before proof and rejects unauthenticated proof preflight', async () => {
    const baseline = await json(await fetch(api(`record-comparison?${sourceQuery}`)))
    expect(baseline.platformWithoutOfficial.rows.every((row: any) => row.qualification === 'unresolved')).toBe(true)
    expect(baseline.currentSourceConsistency.recognizedObservations.every((row: any) => row.qualification === 'not_comparable')).toBe(true)
    const denied = await post('comparison-scope-proofs/preflight', officialRequest, false)
    expect(denied.status).toBe(401)
    expect(denied.headers.get('cache-control')).toContain('no-store')
    expect((await json(denied)).error.code).toBe('unauthorized')
    const malformed = await fetch(api('comparison-scope-proofs/preflight'), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-api-token' }, body: '{invalid' })
    expect(malformed.status).toBe(400)
    expect(malformed.headers.get('cache-control')).toContain('no-store')
    expect((await json(malformed)).error.code).toBe('invalid_request')
    expect((await rpc('tools/call', { name: 'preflight_comparison_scope_proofs', arguments: currentRequest })).status).toBe(401)
  })
  it('registers official scope over REST and current equivalence over MCP with audit and replay', async () => {
    const plan = await json(await post('comparison-scope-proofs/preflight', officialRequest))
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/)
    const receipt = await json(await post('comparison-scope-proofs/commit', { request: officialRequest, planHash: plan.planHash }))
    officialProofId = receipt.proofIds[0]
    expect(await json(await post('comparison-scope-proofs/commit', { request: officialRequest, planHash: plan.planHash }))).toEqual(receipt)
    const proof = await json(await fetch(api(`comparison-scope-proofs/${officialProofId}`)))
    expect(proof).toMatchObject({ status: 'confirmed', valid: true, revision: 2 })
    expect((await json(await fetch(api(`comparison-scope-proofs/${officialProofId}/audit`)))).rows.map((row: any) => row.toStatus)).toEqual(['candidate', 'confirmed'])
    expect(mcpValue(await rpc('tools/call', { name: 'get_comparison_scope_proof_audit', arguments: { id: officialProofId } })))
      .toEqual(await json(await fetch(api(`comparison-scope-proofs/${officialProofId}/audit`))))
    const restAuditPage = await json(await fetch(api(`comparison-scope-proofs/${officialProofId}/audit?page=2&pageSize=1`)))
    const mcpAuditPage = mcpValue(await rpc('tools/call', { name: 'get_comparison_scope_proof_audit', arguments: { id: officialProofId, page: 2, pageSize: 1 } }))
    expect(mcpAuditPage).toEqual(restAuditPage)
    expect(mcpAuditPage).toMatchObject({ total: 2, page: 2, pageSize: 1, rows: [{ toStatus: 'confirmed' }] })
    const listed = await rpc('tools/list', {}, true)
    expect(listed.body.result.tools.map((tool: any) => tool.name)).toContain('preflight_comparison_scope_proofs')
    const badCurrent = structuredClone(currentRequest) as any
    badCurrent.operations[0].evidence.scope.freezeSha256 = 'd'.repeat(64)
    expect((await json(await post('comparison-scope-proofs/preflight', badCurrent))).error.code).toBe('source_mismatch')
    const mcpPlan = mcpValue(await rpc('tools/call', { name: 'preflight_comparison_scope_proofs', arguments: currentRequest }, true))
    const mcpReceipt = mcpValue(await rpc('tools/call', { name: 'commit_comparison_scope_proofs', arguments: { request: currentRequest, planHash: mcpPlan.planHash } }, true))
    currentProofId = mcpReceipt.proofIds[0]
    expect(mcpValue(await rpc('tools/call', { name: 'get_comparison_scope_proof', arguments: { id: currentProofId } })).valid).toBe(true)
  })
  it('qualifies public official and current results only with stored confirmed proof IDs', async () => {
    const withProof = await json(await fetch(api(`record-comparison?${sourceQuery}&proofIds=${officialProofId},${currentProofId}`)))
    expect(withProof.platformWithoutOfficial.rows.filter((row: any) => row.qualification === 'platform_without_official').map((row: any) => row.relation.id)).toContain(historicalRelationId)
    expect(withProof.currentSourceConsistency.recognizedObservations.map((row: any) => row.qualification)).toContain('matched')
    expect(withProof.currentSourceConsistency.recognizedObservations.map((row: any) => row.qualification)).toContain('interface_only')
    expect(withProof.currentSourceConsistency.recognizedObservations.map((row: any) => row.qualification)).toContain('field_conflict')
    expect(withProof.currentSourceConsistency.exportObservations.map((row: any) => row.qualification)).toContain('export_only')
    const viaMcp = mcpValue(await rpc('tools/call', { name: 'list_record_comparison', arguments: { queryIds: [query.id, historicalCollection.queryId], exportBatchIds: [batch.id], officialSourceDocumentIds: [doc.id], proofIds: [officialProofId, currentProofId] } }))
    expect(viaMcp.platformWithoutOfficial.rows.map((row: any) => row.relation.id)).toContain(historicalRelationId)
    expect(viaMcp.currentSourceConsistency.recognizedObservations.map((row: any) => row.qualification)).toContain('matched')
    const fake = await json(await fetch(api(`record-comparison?${sourceQuery}&proofIds=999999`)))
    expect(fake.currentSourceConsistency.recognizedObservations.every((row: any) => row.qualification === 'not_comparable')).toBe(true)
    const beforeDecision = await json(await fetch(api(`record-comparison?${sourceQuery}&proofIds=${currentProofId}&asOf=2026-10-18T00%3A00%3A00Z`)))
    expect(beforeDecision.currentSourceConsistency.recognizedObservations.every((row: any) => row.qualification === 'not_comparable')).toBe(true)
  })
  it('retains candidate proof when REST confirmation omits IDs and rejects explicit empty IDs', async () => {
    const candidate = { ...baseDecision('edge-candidate'), proofIds: [currentProofId], operations: [{ action: 'create', status: 'candidate', edge: { type: 'recognized_export', relationId: matchedRelation!.id, exportRowId: matchedExport.id, role: 'same_current_row' } }] }
    const plan = await json(await post('correspondences/preflight', candidate))
    const receipt = await json(await post('correspondences/commit', { request: candidate, planHash: plan.planHash }))
    const edgeId = receipt.correspondenceIds[0]
    const noProof = { ...baseDecision('edge-confirm-no-proof'), proofIds: [], operations: [{ action: 'decide', correspondenceId: edgeId, expectedRevision: 1, status: 'confirmed' }] }
    const denied = await post('correspondences/preflight', noProof)
    expect(denied.status).toBe(422)
    expect((await json(denied)).error.code).toBe('incomplete_coverage')
    const confirmed = { ...baseDecision('edge-confirm-proof'), operations: noProof.operations }
    const confirmedPlan = await json(await post('correspondences/preflight', confirmed))
    expect(confirmedPlan.planHash).toMatch(/^[a-f0-9]{64}$/)
    expect((await post('correspondences/commit', { request: confirmed, planHash: confirmedPlan.planHash })).status).toBe(200)
    expect(await json(await fetch(api(`correspondences/${edgeId}`)))).toMatchObject({ status: 'confirmed', requiresRevalidation: false })
    expect((await json(await fetch(api(`correspondences/${edgeId}/audit`)))).rows.at(-1).evidence.comparisonProofIds).toEqual([currentProofId])
  })
  it('confirms another proof-backed candidate with explicit IDs over MCP', async () => {
    const candidate = { ...baseDecision('mcp-edge-candidate'), proofIds: [currentProofId], operations: [{ action: 'create', status: 'candidate', edge: { type: 'recognized_export', relationId: otherRelation!.id, exportRowId: otherExport.id, role: 'same_current_row' } }] }
    const candidatePlan = mcpValue(await rpc('tools/call', { name: 'preflight_record_correspondences', arguments: candidate }, true))
    const edgeId = mcpValue(await rpc('tools/call', { name: 'save_record_correspondences', arguments: { request: candidate, planHash: candidatePlan.planHash } }, true)).correspondenceIds[0]
    const confirm = { ...baseDecision('mcp-edge-confirm'), proofIds: [currentProofId], operations: [{ action: 'decide', correspondenceId: edgeId, expectedRevision: 1, status: 'confirmed' }] }
    const plan = mcpValue(await rpc('tools/call', { name: 'preflight_record_correspondences', arguments: confirm }, true))
    mcpValue(await rpc('tools/call', { name: 'save_record_correspondences', arguments: { request: confirm, planHash: plan.planHash } }, true))
    expect(await json(await fetch(api(`correspondences/${edgeId}`)))).toMatchObject({ status: 'confirmed', requiresRevalidation: false })
    expect((await json(await fetch(api(`correspondences/${edgeId}/audit`)))).rows.at(-1).evidence.comparisonProofIds).toEqual([currentProofId])
  })
  it('confirms a proof-backed candidate with explicit IDs over REST', async () => {
    const candidate = { ...baseDecision('rest-explicit-candidate'), proofIds: [currentProofId], operations: [{ action: 'create', status: 'candidate', edge: { type: 'recognized_export', relationId: restExplicitRelation!.id, exportRowId: restExplicitExport.id, role: 'same_current_row' } }] }
    const candidatePlan = await json(await post('correspondences/preflight', candidate))
    const edgeId = (await json(await post('correspondences/commit', { request: candidate, planHash: candidatePlan.planHash }))).correspondenceIds[0]
    const confirm = { ...baseDecision('rest-explicit-confirm'), proofIds: [currentProofId], operations: [{ action: 'decide', correspondenceId: edgeId, expectedRevision: 1, status: 'confirmed' }] }
    const plan = await json(await post('correspondences/preflight', confirm))
    expect((await post('correspondences/commit', { request: confirm, planHash: plan.planHash })).status).toBe(200)
    expect(await json(await fetch(api(`correspondences/${edgeId}`)))).toMatchObject({ status: 'confirmed', requiresRevalidation: false })
    expect((await json(await fetch(api(`correspondences/${edgeId}/audit`)))).rows.at(-1).evidence.comparisonProofIds).toEqual([currentProofId])
  })
  it('confirms a proof-backed candidate with omitted IDs over MCP', async () => {
    const candidate = { ...baseDecision('mcp-omitted-candidate'), proofIds: [currentProofId], operations: [{ action: 'create', status: 'candidate', edge: { type: 'recognized_export', relationId: mcpOmittedRelation!.id, exportRowId: mcpOmittedExport.id, role: 'same_current_row' } }] }
    const candidatePlan = mcpValue(await rpc('tools/call', { name: 'preflight_record_correspondences', arguments: candidate }, true))
    const edgeId = mcpValue(await rpc('tools/call', { name: 'save_record_correspondences', arguments: { request: candidate, planHash: candidatePlan.planHash } }, true)).correspondenceIds[0]
    const confirm = { ...baseDecision('mcp-omitted-confirm'), operations: [{ action: 'decide', correspondenceId: edgeId, expectedRevision: 1, status: 'confirmed' }] }
    const empty = await rpc('tools/call', { name: 'preflight_record_correspondences', arguments: { ...baseDecision('mcp-empty-confirm'), proofIds: [], operations: confirm.operations } }, true)
    expect(empty.body.result.isError).toBe(true)
    expect(empty.body.result.content[0].text).toContain('Confirmed current-source equivalence proof required')
    const plan = mcpValue(await rpc('tools/call', { name: 'preflight_record_correspondences', arguments: confirm }, true))
    mcpValue(await rpc('tools/call', { name: 'save_record_correspondences', arguments: { request: confirm, planHash: plan.planHash } }, true))
    expect(await json(await fetch(api(`correspondences/${edgeId}`)))).toMatchObject({ status: 'confirmed', requiresRevalidation: false })
    expect((await json(await fetch(api(`correspondences/${edgeId}/audit`)))).rows.at(-1).evidence.comparisonProofIds).toEqual([currentProofId])
  })
  it('invalidates source-bound proof after original row drift while retaining audit', async () => {
    await runtimeDb!.query('UPDATE business.platform_export_row SET name_raw = $1 WHERE id = $2', ['changed after confirmation', matchedExport.id])
    const proof = await json(await fetch(api(`comparison-scope-proofs/${currentProofId}`)))
    expect(proof).toMatchObject({ status: 'confirmed', valid: false, invalidReason: 'source_drift_or_missing' })
    const after = await json(await fetch(api(`record-comparison?${sourceQuery}&proofIds=${officialProofId},${currentProofId}`)))
    expect(after.currentSourceConsistency.recognizedObservations.every((row: any) => row.qualification === 'not_comparable')).toBe(true)
    const edge = await json(await fetch(api(`correspondences?type=recognized_export`)))
    expect(edge.rows[0].requiresRevalidation).toBe(true)
    expect((await json(await fetch(api(`comparison-scope-proofs/${currentProofId}/audit`)))).total).toBe(2)
    await runtimeDb!.query('UPDATE business.platform_export_row SET name_raw = $1 WHERE id = $2', ['甲企业', matchedExport.id])
    expect((await json(await fetch(api(`comparison-scope-proofs/${currentProofId}`)))).valid).toBe(true)
  })

  const pgBin = process.env.TEST_IMPORT_RECEIPTS_PG_BIN
  it.runIf(!!pgBin)('preserves migrated scope proof coverage, pagination, receipts and drift over HTTP and MCP', async () => {
    // Build the historical source by executing the accepted commands against
    // SQLite offline. Only the clock comes from the already tested live run.
    for (const [key, { kind, request }] of history) {
      const { rows: [timing] } = await runtimeDb!.query<{ created_at: string; committed_at: string }>(
        'SELECT created_at, committed_at FROM business.import_batch WHERE idempotency_key = $1 AND status = $2', [key, 'committed'],
      )
      expect(timing).toBeDefined()
      try {
        vi.setSystemTime(new Date(timing!.created_at))
        if (kind === 'proof') {
          const input = request as Parameters<typeof preflightComparisonScopeProofs>[1]
          const plan = preflightComparisonScopeProofs(db, input)
          vi.setSystemTime(new Date(timing!.committed_at))
          commitComparisonScopeProofs(db, input, plan.planHash)
        } else {
          const input = request as Parameters<typeof preflightRecordCorrespondences>[1]
          const plan = preflightRecordCorrespondences(db, input)
          vi.setSystemTime(new Date(timing!.committed_at))
          commitRecordCorrespondences(db, input, plan.planHash)
        }
      } finally { vi.useRealTimers() }
    }
    const pgDir = mkdtempSync(join(tmpdir(), 'scope-history-'))
    let target: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
    let closeNative: (() => Promise<void>) | undefined
    let client: pg.Client | undefined
    try {
      target = await postgresRuntimeFixture({ dir: pgDir, sourcePath: dbPath, bin: pgBin })
      const appEnv = target.env
      const native = nativeAppAdapter({ dir: pgDir, token: 'synthetic-api-token', launch: ({ cwd, port }) => ({
        args: [join(cwd, '.output/server/index.mjs')],
        env: { ...appEnv, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), NUXT_MCP_TOKEN: 'synthetic-mcp-token' },
      }) })
      closeNative = native.close
      client = new pg.Client({ connectionString: target.url })
      await client.connect()
      await client.query('set search_path=business,public')
      const postgres = drizzle(client)
      const expectedRefs = listRecordCorrespondenceRefs(db, { enterpriseId: enterprise.id })
      expect(expectedRefs).toHaveLength(1)
      expect(expectedRefs[0]).toMatchObject({ requiresRevalidation: false, status: 'confirmed' })
      expect(await readPostgresCorrespondenceRefs(postgres, [enterprise.id])).toEqual(expectedRefs)
      await native.start()
      const path = 'comparison-scope-proofs'
      const calls = [
        ['correspondences?view=summary&type=recognized_export&pageSize=2', 'list_record_correspondences', { view: 'summary', type: 'recognized_export', pageSize: 2 }],
        ['correspondences?type=recognized_export&pageSize=2', 'list_record_correspondences', { type: 'recognized_export', pageSize: 2 }],
        [`correspondences/${expectedRefs[0]!.id}`, 'get_record_correspondence', { id: expectedRefs[0]!.id }],
        [`correspondences/events/${event.id}`, 'get_record_correspondence_source', { kind: 'event', id: event.id }],
        [`correspondences/relations/${matchedRelation!.id}`, 'get_record_correspondence_source', { kind: 'relation', id: matchedRelation!.id }],
        [`correspondences/relations/${historicalRelationId}`, 'get_record_correspondence_source', { kind: 'relation', id: historicalRelationId }],
        [`correspondences/export-rows/${matchedExport.id}`, 'get_record_correspondence_source', { kind: 'export_row', id: matchedExport.id }],
        [`${path}/${officialProofId}`, 'get_comparison_scope_proof', { id: officialProofId }],
        [`${path}/${currentProofId}`, 'get_comparison_scope_proof', { id: currentProofId }],
        [`${path}?status=confirmed&page=2&pageSize=1`, 'list_comparison_scope_proofs', { status: 'confirmed', page: 2, pageSize: 1 }],
        [`${path}/${currentProofId}/audit?page=2&pageSize=1`, 'get_comparison_scope_proof_audit', { id: currentProofId, page: 2, pageSize: 1 }],
        [`${path}/batches/current-proof`, 'get_comparison_scope_proof_batch', { idempotencyKey: 'current-proof' }],
      ] as const
      async function nativeCall(name: string, args: Record<string, unknown>) {
        const rpcResponse = await native.request('/mcp', {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-06-18', authorization: 'Bearer synthetic-mcp-token' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        })
        const raw = await rpcResponse.text()
        const text = raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw
        return mcpValue({ body: JSON.parse(text) })
      }
      for (const [suffix, name, args] of calls) {
        const source = await fetch(api(suffix), { headers: { authorization: 'Bearer synthetic-api-token' } })
        const response = await native.request('/api/roster/' + suffix)
        const expected = await source.json()
        const actual = await response.json()
        expect(source.status, suffix).toBe(200)
        expect(response.status, JSON.stringify(actual)).toBe(200)
        expect(actual, suffix).toEqual(expected)
        if (name === 'get_comparison_scope_proof') expect(actual).toMatchObject({ valid: true, status: 'confirmed', sourceSummary: expect.any(Object) })
        expect(await nativeCall(name, args), name).toEqual(expected)
      }
      for (const filter of ['', '?kind=query&pageSize=1&page=2', '?kind=official_document', `?kind=export_batch&ids=${batch.id}`, `?kind=query&ids=${query.id}`]) {
        const suffix = 'record-comparison/sources' + filter
        const nativeSource = await native.request('/api/roster/' + suffix)
        const actual = await nativeSource.json()
        expect(nativeSource.status, JSON.stringify(actual)).toBe(200)
        expect(actual, suffix).toEqual(await json(await fetch(api(suffix))))
      }
      const comparisonArgs = { queryIds: [query.id, historicalCollection.queryId], exportBatchIds: [batch.id],
        officialSourceDocumentIds: [doc.id], proofIds: [officialProofId, currentProofId], page: 1, pageSize: 1, businessPageSize: 2 }
      const comparisonPath = `record-comparison?${sourceQuery}&proofIds=${comparisonArgs.proofIds.join(',')}&pageSize=1&businessPageSize=2`
      for (const cutoff of ['', '&asOf=2026-10-18T23%3A59%3A59Z']) {
        const suffix = comparisonPath + cutoff
        const nativeComparison = await native.request('/api/roster/' + suffix)
        const expected = await json(await fetch(api(suffix)))
        const actual = await json(nativeComparison)
        expect(nativeComparison.status, JSON.stringify(actual)).toBe(200)
        expect(actual, suffix).toEqual(expected)
        if (!cutoff) expect(await nativeCall('list_record_comparison', comparisonArgs)).toEqual(expected)
      }
      const legacyPath = `record-comparison/legacy-impact?${sourceQuery}&pageSize=1`
      const legacy = await native.request('/api/roster/' + legacyPath)
      const legacyBody = await json(legacy)
      expect(legacy.status, JSON.stringify(legacyBody)).toBe(200)
      expect(legacyBody).toEqual(await json(await fetch(api(legacyPath))))
      const selection = { eventId: event.id, queryIds: [query.id, historicalCollection.queryId], exportBatchIds: [batch.id], ruleVersion: 'manual', page: 1, pageSize: 2 }
      for (const [suffix, tool, args] of [
        ['candidates', 'find_record_correspondence_candidates', selection],
        ['discover', 'discover_event_archive_candidates', { eventId: event.id, pageSize: 2, queryPageSize: 1 }],
      ] as const) {
        const expected = await json(await post('correspondences/' + suffix, args, false))
        const actual = await native.request('/api/roster/correspondences/' + suffix, { method: 'POST', body: JSON.stringify(args) })
        const selected = await json(actual)
        expect(actual.status, JSON.stringify(selected)).toBe(200)
        expect(selected).toEqual(expected)
        expect(await nativeCall(tool, args)).toEqual(expected)
      }
      const currentFilter = { titleCode: 'specialized_sme' as const, pageSize: 1, q: enterprise.name }
      const current = await native.request('/api/roster/current-enterprises?' + new URLSearchParams({
        titleCode: currentFilter.titleCode, pageSize: String(currentFilter.pageSize), q: currentFilter.q,
      }))
      const actualPage = await current.json() as CurrentQualifiedResult
      expect(current.status, JSON.stringify(actualPage) + '\n' + native.output).toBe(200)
      expect(actualPage.rows.map(row => row.enterpriseId)).toContain(enterprise.id)
      const mcpPage = await nativeCall('list_current_qualified_enterprises', currentFilter) as CurrentQualifiedResult
      for (const page of [actualPage, mcpPage]) {
        vi.setSystemTime(new Date(page.snapshotStartedAt))
        try { expect(page).toEqual(listCurrentQualified(db.$client, currentFilter)) }
        finally { vi.useRealTimers() }
      }

      const sheets = async (response: Response, hash: string) => {
        expect(response.status).toBe(200)
        const bytes = Buffer.from(await response.arrayBuffer())
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash)
        const workbook = await readExportWorkbook(bytes)
        workbook.getWorksheet('口径说明')!.getCell('B2').value = '生成时间'
        return workbook.worksheets.map(sheet => ({ name: sheet.name, cells: sheet.getSheetValues() }))
      }
      const terminal = async (fetchJob: () => Promise<Response>) => {
        const until = Date.now() + 15_000
        while (Date.now() < until) {
          const response = await fetchJob()
          expect(response.status).toBe(200)
          const job = await response.json()
          if (['done', 'failed', 'cancelled'].includes(job.state)) return job
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        throw new Error('Current workbook did not reach terminal state')
      }
      const headers = { authorization: 'Bearer synthetic-api-token', 'content-type': 'application/json' }
      for (const title of ['little-giant', 'specialized-sme', 'innovative-sme']) {
        const endpoint = 'exports/current/' + title
        const request = { method: 'POST', headers, body: JSON.stringify({ clientRequestId: 'migrated-workbook-' + title }) }
        const sourceSubmission = await fetch(api(endpoint), request)
        const targetSubmission = await native.request('/api/roster/' + endpoint, request)
        expect(sourceSubmission.status).toBe(202)
        expect(targetSubmission.status).toBe(202)
        const [{ jobId: sourceId }, { jobId: targetId }] = await Promise.all([sourceSubmission.json(), targetSubmission.json()])
        const [sourceJob, targetJob] = await Promise.all([
          terminal(() => fetch(service.baseUrl + '/api/jobs/' + sourceId, { headers })),
          terminal(() => native.request('/api/jobs/' + targetId)),
        ])
        expect(sourceJob.state, JSON.stringify(sourceJob.error)).toBe('done')
        expect(targetJob.state, JSON.stringify(targetJob.error)).toBe('done')
        expect(targetJob.result.statusCounts).toEqual(sourceJob.result.statusCounts)
        const [sourceSheets, targetSheets] = await Promise.all([
          sheets(await fetch(service.baseUrl + '/api/job-artifacts/' + sourceId, { headers }), sourceJob.result.artifact.sha256),
          sheets(await native.request('/api/job-artifacts/' + targetId), targetJob.result.artifact.sha256),
        ])
        expect(targetSheets).toEqual(sourceSheets)
        const filtered = await native.request('/api/task-center?titleCode=' + title.replaceAll('-', '_'))
        expect(await filtered.json()).toMatchObject({ exportReady: true, total: 1, rows: [{
          id: targetId, export: { canDownload: true, artifact: { sha256: targetJob.result.artifact.sha256 } },
        }] })
      }
      const submitProof = (action: 'preflight' | 'commit', body: object) =>
        native.request('/api/roster/comparison-scope-proofs/' + action, { method: 'POST', body: JSON.stringify(body) })
      const candidate = { ...officialRequest, ...baseDecision('postgres-native-candidate'),
        operations: officialRequest.operations.map(operation => ({ ...operation, status: 'candidate' })) }
      const originalPlan = await json(await post('comparison-scope-proofs/preflight', candidate))
      const nativePlans = await Promise.all([submitProof('preflight', candidate), submitProof('preflight', candidate)])
      expect(nativePlans.map(response => response.status)).toEqual([200, 200])
      const [nativePlan, replayedPlan] = await Promise.all(nativePlans.map(json))
      expect(nativePlan).toEqual(replayedPlan)
      expect(nativePlan.planHash).toBe(originalPlan.planHash)
      const request = { request: candidate, planHash: nativePlan.planHash }
      const writes = await Promise.all([submitProof('commit', request), submitProof('commit', request)])
      expect(writes.map(response => response.status)).toEqual([200, 200])
      const [receipt, replayed] = await Promise.all(writes.map(json))
      expect(receipt).toEqual(replayed)

      const proofId = receipt.proofIds[0]
      const decisions = ['confirmed', 'revoked'].map(status => ({ ...baseDecision('postgres-native-' + status),
        operations: [{ action: 'decide', proofId, expectedRevision: 1, status }],
      }))
      const plans = await Promise.all(decisions.map(async decision => {
        const response = await submitProof('preflight', decision)
        expect(response.status).toBe(200)
        return { request: decision, planHash: (await json(response)).planHash }
      }))
      const contested = await Promise.all(plans.map(plan => submitProof('commit', plan)))
      expect(contested.map(response => response.status).sort()).toEqual([200, 409])
      const persisted = await nativeCall('get_comparison_scope_proof_audit', { id: proofId })
      expect(persisted.rows).toHaveLength(2)
      expect(persisted.rows.map((row: { resultingRevision: number }) => row.resultingRevision)).toEqual([1, 2])
      expect(native.db.$client.prepare('SELECT count(*) AS n FROM comparison_scope_proof').get()).toEqual({ n: 0 })

      const submitCorrespondence = (action: 'preflight' | 'commit', body: object) =>
        native.request('/api/roster/correspondences/' + action, { method: 'POST', body: JSON.stringify(body) })
      const draft = { ...baseDecision('postgres-edge'), operations: [{ action: 'create', status: 'candidate', edge: {
        type: 'event_process', eventId: event.id, relationId: historicalRelationId, role: 'supports_award',
      } }] }
      const reference = await json(await post('correspondences/preflight', draft))
      const draftPlan = await nativeCall('preflight_record_correspondences', draft)
      expect(draftPlan.planHash).toBe(reference.planHash)
      expect(draftPlan.targets).toEqual(reference.targets)
      const draftReceipt = await nativeCall('save_record_correspondences', { request: draft, planHash: draftPlan.planHash })
      const correspondenceId = draftReceipt.correspondenceIds[0]
      const decisionsFor = ['confirmed', 'rejected'].map(status => ({ ...baseDecision('postgres-edge-' + status), operations: [
        { action: 'decide', correspondenceId, expectedRevision: 1, status },
      ] }))
      const edgePlans = await Promise.all(decisionsFor.map(async decision => {
        const response = await submitCorrespondence('preflight', decision)
        const body = await json(response)
        expect(response.status, JSON.stringify(body)).toBe(200)
        return { request: decision, planHash: body.planHash }
      }))
      const confirmResponses = await Promise.all(edgePlans.map(plan => submitCorrespondence('commit', plan)))
      expect(confirmResponses.map(response => response.status).sort()).toEqual([200, 409])
      const winner = confirmResponses.findIndex(response => response.status === 200)
      const winningReceipt = await json(confirmResponses[winner]!)
      expect(await json(await submitCorrespondence('commit', edgePlans[winner]!))).toEqual(winningReceipt)
      const audit = await nativeCall('get_record_correspondence_audit', { id: correspondenceId })
      expect(audit.rows.map((row: { resultingRevision: number }) => row.resultingRevision)).toEqual([1, 2])
      expect(native.db.$client.prepare('SELECT count(*) AS n FROM record_correspondence').get()).toEqual({ n: 0 })

      await client.query('UPDATE business.platform_export_row SET name_raw = $1 WHERE id = $2', ['changed after confirmation', matchedExport.id])
      const refsAfterDrift = await readPostgresCorrespondenceRefs(postgres, [enterprise.id])
      expect(refsAfterDrift).toEqual([
        ...expectedRefs.map(ref => ({ ...ref, requiresRevalidation: true })),
        expect.objectContaining({ id: correspondenceId, status: decisionsFor[winner]!.operations[0]!.status, requiresRevalidation: false }),
      ])
      const summary = await native.request('/api/roster/correspondences?view=summary&relationId=' + matchedRelation!.id)
      expect(await summary.json()).toMatchObject({ total: 1, rows: [{ requiresRevalidation: true }] })
      const drift = await native.request('/api/roster/' + path + '/' + currentProofId)
      expect(await drift.json()).toMatchObject({ status: 'confirmed', valid: false, invalidReason: 'source_drift_or_missing' })
      expect((await native.request('/api/roster/' + path + '/batches/current-proof', { headers: {} })).status).toBe(401)

    } finally {
      try { await client?.end(); await closeNative?.() }
      finally { target?.close(); rmSync(pgDir, { recursive: true, force: true }) }
    }
  }, 120_000)
})
