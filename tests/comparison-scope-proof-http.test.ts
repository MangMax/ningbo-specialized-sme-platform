import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { useDb, schema } from '../db/client'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

const dir = mkdtempSync(join(tmpdir(), 'spec63-proof-http-'))
const dbPath = join(dir, 'synthetic.db')
const db = useDb({ dbPath })
const file = db.insert(schema.storedFile).values({ relPath: 'synthetic/notice.pdf', filename: 'notice.pdf', ext: 'pdf', bytes: 12, sha256: 'a'.repeat(64), source: 'jxj', kind: 'announcement' }).returning().get()
const freezeFile = db.insert(schema.storedFile).values({ relPath: 'synthetic/archive/freeze-v1', filename: 'freeze-v1.txt', ext: 'txt', bytes: 24, sha256: 'c'.repeat(64), source: 'miit', kind: 'export' }).returning().get()
const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: 'Synthetic complete notice', path: file.relPath, issueDate: '2024-05-01' }).returning().get()
const enterprise = db.insert(schema.enterprise).values({ name: '甲企业', nameNorm: '甲企业', usccNorm: '91330211255994475A' }).returning().get()
const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, page: 3, listNo: 2 }).run()
const conditions = { combination: 'and' }
const collection = { source: 'queryBusList', status: 'success', effectiveConditions: conditions, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-10-18T00:00:00Z', completedAt: '2026-10-18T00:01:00Z', rows: [], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 5, declaredTotal: 5, error: null }], fetchedCount: 5, declaredTotal: 5, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } } as typeof schema.platformQuery.$inferInsert.collectionEvidence
const query = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: 'all', rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-18T00:00:00Z', status: 'success', collectionEvidence: collection }).returning().get()
const addRelation = (sequenceNo: number, uscc: string, name: string, enterpriseId: number | null = null) => db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo, enterpriseId, usccRaw: uscc, nameRaw: name, year: 2024, status: '已认定', verificationStatus: 'confirmed', matchBasis: 'uscc' }).returning().get()
const matchedRelation = addRelation(1, enterprise.usccNorm!, '甲企业', enterprise.id)
addRelation(2, '91330211255994476B', '接口独有')
const otherRelation = addRelation(3, '91330211255994477C', '接口名称')
const restExplicitRelation = addRelation(4, '91330211255994479E', 'REST 显式证明')
const mcpOmittedRelation = addRelation(5, '91330211255994480F', 'MCP 省略证明')
const batch = db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-18', originalFilename: 'synthetic.xlsx', sha256: 'b'.repeat(64), importStatus: 'imported' }).returning().get()
const addExport = (sourceRowNo: number, uscc: string, name: string) => db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo, usccRaw: uscc, nameRaw: name }).returning().get()
const matchedExport = addExport(2, enterprise.usccNorm!, '甲企业')
const otherExport = addExport(3, '91330211255994477C', '导出名称')
addExport(4, '91330211255994478D', '导出独有')
const restExplicitExport = addExport(5, '91330211255994479E', 'REST 显式证明')
const mcpOmittedExport = addExport(6, '91330211255994480F', 'MCP 省略证明')
let service: { baseUrl: string; stop: () => Promise<void> }
const sourceQuery = `queryIds=${query.id}&exportBatchIds=${batch.id}&officialSourceDocumentIds=${doc.id}`
const api = (path: string, token = true) => `${service.baseUrl}/api/roster/${path}`
const post = (path: string, body: unknown, authorized = true) => fetch(api(path), { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer synthetic-api-token' } : {}) }, body: JSON.stringify(body) })
async function json(response: Response) { return response.json() as Promise<any> }
const baseDecision = (id: string) => ({ idempotencyKey: id, sourceIdentity: `synthetic/${id}`, actor: { type: 'agent', id: 'synthetic-agent' }, basis: 'Reviewed archived original sources, scope, and same platform freeze', ruleId: 'manual-review', ruleVersion: '1' })
const officialRequest = { ...baseDecision('official-proof'), operations: [{ action: 'create', kind: 'official_coverage', status: 'confirmed', evidence: { titleCode: 'specialized_sme', fromYear: 2024, throughYear: 2024, enterpriseIds: null, fullRange: true, sourceDocuments: [{ id: doc.id, fileId: file.id, sha256: file.sha256, reference: { field: 'record_evidence.source_file', page: 3, listNo: 2 } }] } }] }
const currentRequest = { ...baseDecision('current-proof'), operations: [{ action: 'create', kind: 'current_source_equivalence', status: 'confirmed', evidence: { queryId: query.id, exportBatchId: batch.id, titleCode: 'specialized_sme', queryReference: 'platform_query.collectionEvidence', exportReference: 'platform_export_batch.sha256', scope: { queryAccount: 'synthetic-account', exportAccount: 'synthetic-account', queryRegion: 'synthetic-region', exportRegion: 'synthetic-region', queryFilters: conditions, exportFilters: conditions, windowStart: '2026-10-18T00:00:00Z', windowEnd: '2026-10-18T23:59:59Z', platformVersion: 'synthetic-freeze-v1', freezeReference: freezeFile.relPath, freezeFileId: freezeFile.id, freezeSha256: freezeFile.sha256 } } }] }
async function rpc(method: string, params?: Record<string, unknown>, authorized = false) {
  const response = await fetch(`${service.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(authorized ? { authorization: 'Bearer synthetic-mcp-token' } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const raw = await response.text()
  const payload = raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))?.slice(6) : raw
  return { status: response.status, body: JSON.parse(payload!) }
}
const mcpValue = (result: any) => JSON.parse(result.body.result.content[0].text)

beforeAll(async () => {
  const cwd = resolve(import.meta.dirname, '..')
  const port = await reserveLoopbackPort()
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_DB_PATH: dbPath, NUXT_API_TOKEN: 'synthetic-api-token', NUXT_MCP_TOKEN: 'synthetic-mcp-token', NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming') } })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(api(`record-comparison?${sourceQuery}`), { timeoutMs: 60000 }) } catch (error) { await service.stop(); throw error }
}, 90000)
afterAll(async () => { if (service) await service.stop(); rmSync(dir, { recursive: true, force: true }) })

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
    expect(withProof.platformWithoutOfficial.rows.filter((row: any) => row.qualification === 'platform_without_official').map((row: any) => row.relation.id)).toContain(matchedRelation.id)
    expect(withProof.currentSourceConsistency.recognizedObservations.map((row: any) => row.qualification)).toContain('matched')
    expect(withProof.currentSourceConsistency.recognizedObservations.map((row: any) => row.qualification)).toContain('interface_only')
    expect(withProof.currentSourceConsistency.recognizedObservations.map((row: any) => row.qualification)).toContain('field_conflict')
    expect(withProof.currentSourceConsistency.exportObservations.map((row: any) => row.qualification)).toContain('export_only')
    const viaMcp = mcpValue(await rpc('tools/call', { name: 'list_record_comparison', arguments: { queryIds: [query.id], exportBatchIds: [batch.id], officialSourceDocumentIds: [doc.id], proofIds: [officialProofId, currentProofId] } }))
    expect(viaMcp.platformWithoutOfficial.rows.map((row: any) => row.relation.id)).toContain(matchedRelation.id)
    expect(viaMcp.currentSourceConsistency.recognizedObservations.map((row: any) => row.qualification)).toContain('matched')
    const fake = await json(await fetch(api(`record-comparison?${sourceQuery}&proofIds=999999`)))
    expect(fake.currentSourceConsistency.recognizedObservations.every((row: any) => row.qualification === 'not_comparable')).toBe(true)
    const beforeDecision = await json(await fetch(api(`record-comparison?${sourceQuery}&proofIds=${currentProofId}&asOf=2026-10-18T00%3A00%3A00Z`)))
    expect(beforeDecision.currentSourceConsistency.recognizedObservations.every((row: any) => row.qualification === 'not_comparable')).toBe(true)
  })
  it('retains candidate proof when REST confirmation omits IDs and rejects explicit empty IDs', async () => {
    const candidate = { ...baseDecision('edge-candidate'), proofIds: [currentProofId], operations: [{ action: 'create', status: 'candidate', edge: { type: 'recognized_export', relationId: matchedRelation.id, exportRowId: matchedExport.id, role: 'same_current_row' } }] }
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
    const candidate = { ...baseDecision('mcp-edge-candidate'), proofIds: [currentProofId], operations: [{ action: 'create', status: 'candidate', edge: { type: 'recognized_export', relationId: otherRelation.id, exportRowId: otherExport.id, role: 'same_current_row' } }] }
    const candidatePlan = mcpValue(await rpc('tools/call', { name: 'preflight_record_correspondences', arguments: candidate }, true))
    const edgeId = mcpValue(await rpc('tools/call', { name: 'save_record_correspondences', arguments: { request: candidate, planHash: candidatePlan.planHash } }, true)).correspondenceIds[0]
    const confirm = { ...baseDecision('mcp-edge-confirm'), proofIds: [currentProofId], operations: [{ action: 'decide', correspondenceId: edgeId, expectedRevision: 1, status: 'confirmed' }] }
    const plan = mcpValue(await rpc('tools/call', { name: 'preflight_record_correspondences', arguments: confirm }, true))
    mcpValue(await rpc('tools/call', { name: 'save_record_correspondences', arguments: { request: confirm, planHash: plan.planHash } }, true))
    expect(await json(await fetch(api(`correspondences/${edgeId}`)))).toMatchObject({ status: 'confirmed', requiresRevalidation: false })
    expect((await json(await fetch(api(`correspondences/${edgeId}/audit`)))).rows.at(-1).evidence.comparisonProofIds).toEqual([currentProofId])
  })
  it('confirms a proof-backed candidate with explicit IDs over REST', async () => {
    const candidate = { ...baseDecision('rest-explicit-candidate'), proofIds: [currentProofId], operations: [{ action: 'create', status: 'candidate', edge: { type: 'recognized_export', relationId: restExplicitRelation.id, exportRowId: restExplicitExport.id, role: 'same_current_row' } }] }
    const candidatePlan = await json(await post('correspondences/preflight', candidate))
    const edgeId = (await json(await post('correspondences/commit', { request: candidate, planHash: candidatePlan.planHash }))).correspondenceIds[0]
    const confirm = { ...baseDecision('rest-explicit-confirm'), proofIds: [currentProofId], operations: [{ action: 'decide', correspondenceId: edgeId, expectedRevision: 1, status: 'confirmed' }] }
    const plan = await json(await post('correspondences/preflight', confirm))
    expect((await post('correspondences/commit', { request: confirm, planHash: plan.planHash })).status).toBe(200)
    expect(await json(await fetch(api(`correspondences/${edgeId}`)))).toMatchObject({ status: 'confirmed', requiresRevalidation: false })
    expect((await json(await fetch(api(`correspondences/${edgeId}/audit`)))).rows.at(-1).evidence.comparisonProofIds).toEqual([currentProofId])
  })
  it('confirms a proof-backed candidate with omitted IDs over MCP', async () => {
    const candidate = { ...baseDecision('mcp-omitted-candidate'), proofIds: [currentProofId], operations: [{ action: 'create', status: 'candidate', edge: { type: 'recognized_export', relationId: mcpOmittedRelation.id, exportRowId: mcpOmittedExport.id, role: 'same_current_row' } }] }
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
    db.update(schema.platformExportRow).set({ nameRaw: 'changed after confirmation' }).where(eq(schema.platformExportRow.id, matchedExport.id)).run()
    const proof = await json(await fetch(api(`comparison-scope-proofs/${currentProofId}`)))
    expect(proof).toMatchObject({ status: 'confirmed', valid: false, invalidReason: 'source_drift_or_missing' })
    const after = await json(await fetch(api(`record-comparison?${sourceQuery}&proofIds=${officialProofId},${currentProofId}`)))
    expect(after.currentSourceConsistency.recognizedObservations.every((row: any) => row.qualification === 'not_comparable')).toBe(true)
    const edge = await json(await fetch(api(`correspondences?type=recognized_export`)))
    expect(edge.rows[0].requiresRevalidation).toBe(true)
    expect((await json(await fetch(api(`comparison-scope-proofs/${currentProofId}/audit`)))).total).toBe(2)
    db.update(schema.platformExportRow).set({ nameRaw: '甲企业' }).where(eq(schema.platformExportRow.id, matchedExport.id)).run()
    expect((await json(await fetch(api(`comparison-scope-proofs/${currentProofId}`)))).valid).toBe(true)
    db.update(schema.platformRelation).set({ status: 'changed archived original row' }).where(eq(schema.platformRelation.id, matchedRelation.id)).run()
    expect((await json(await fetch(api(`comparison-scope-proofs/${currentProofId}`)))).valid).toBe(false)
  })
})
