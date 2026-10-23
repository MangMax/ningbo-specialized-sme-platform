import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { schema, useDb } from '../db'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

const dir = mkdtempSync(join(tmpdir(), 'candidates246-mcp-http-'))
const db = useDb({ dbPath: join(dir, 'roster.db') })
const enterprise = db.insert(schema.enterprise).values({ name: '合成业务候选', nameNorm: '合成业务候选', usccNorm: '91330211255994457P' }).returning().get()
const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning().get()
const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2025, batchSeq: 1 }).returning().get()
const observations = [1, 2, 3].map(n => {
  const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: `2026-10-0${n}`, status: 'success' }).returning().get()
  const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, relationKey: 'SQ246', enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields: { id: 'SQ246', year: '2025', whpc: '2025-1', sblx: '申请', original: 'large-private-field'.repeat(16384), ...(n === 3 ? { changed: true } : {}) } }).returning().get()
  return { query, relation }
})
const priors = observations.slice(0, 2).map((o, i) => db.insert(schema.recordCorrespondence).values({ edgeKey: `synthetic-prior-${i}`, type: 'event_process', role: 'context_only', eventId: event.id, relationId: o.relation.id, enterpriseId: enterprise.id, titleCode: 'specialized_sme', status: i === 0 ? 'rejected' : 'confirmed', revision: 2, targetIdentity: {}, provenance: {}, sourceFingerprint: 'legacy-fingerprint', ruleId: 'manual', ruleVersion: 'legacy', createdAt: '2026-10-01' }).returning().get())
const batch = db.insert(schema.platformExportBatch).values({ titleCode: 'specialized_sme', year: 2025, collectedOn: '2026-10-01', originalFilename: 'synthetic.xlsx', sha256: 'synthetic246', rowCount: 2, importStatus: 'imported' }).returning().get()
const exports = [2, 3].map(sourceRowNo => db.insert(schema.platformExportRow).values({ batchId: batch.id, sourceRowNo, usccRaw: enterprise.usccNorm }).returning().get())
let service: { baseUrl: string; stop: () => Promise<void> }
beforeAll(async () => {
  const cwd = resolve(import.meta.dirname, '..'), port = await reserveLoopbackPort()
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: join(dir, 'roster.db'), NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'), NUXT_API_TOKEN: 'synthetic246', NUXT_MCP_TOKEN: 'synthetic246' } })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-8000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(`${service.baseUrl}/_openapi.json`, { timeoutMs: 60000, child }) }
  catch (error) { await service.stop(); throw new Error(`${String(error)}\n${output}`) }
  // Historical observations are projected only through the real unified writer.
  const input = { idempotencyKey: 'synthetic246/history', sourceKind: 'platform_archive', sourceIdentity: 'synthetic/history', payload: { platformRecordObservations: observations.map(o => ({ relationId: o.relation.id })) } }
  expect((await rest('/api/roster/import/commit', input)).body.status).toBe('committed')
}, 90000)
afterAll(async () => { await service?.stop(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
async function rest(path: string, body?: unknown) {
  const response = await fetch(service.baseUrl + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic246' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { http: response.status, body: await response.json() }
}
async function rpc(method: string, params: unknown) {
  const response = await fetch(`${service.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer synthetic246', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  expect(response.status).toBe(200)
  const raw = await response.text()
  return JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
}
async function mcp(args: unknown) {
  return rpc('tools/call', { name: 'find_record_correspondence_candidates', arguments: args })
}
function input(queryIds = observations.slice(0, 2).map(o => o.query.id)) { return { eventId: event.id, queryIds, exportBatchIds: [], ruleVersion: '246' } }

it('real REST and MCP handlers return one scoped business version with all decisions', async () => {
  const http = await rest('/api/roster/correspondences/candidates', input()), wire = await mcp(input())
  expect(http.http).toBe(200)
  expect(wire.error).toBeUndefined()
  expect(wire.result.isError).not.toBe(true)
  expect(JSON.parse(wire.result.content[0].text)).toEqual(http.body)
  expect(wire.result.structuredContent).toEqual(http.body)
  expect(http.body).toMatchObject({ total: 1, rows: [{ edge: { relationId: observations[0]!.relation.id }, status: 'candidate', conflicts: ['correspondence_decision_conflict'], existingCorrespondenceIds: priors.map(p => p.id) }] })
  expect(http.body.rows[0].observationRefs.map((r: any) => [r.relationId, r.queriedAt, r.existingCorrespondences[0].status])).toEqual([[observations[0]!.relation.id, '2026-10-01', 'rejected'], [observations[1]!.relation.id, '2026-10-02', 'confirmed']])
  expect(JSON.stringify(http.body)).not.toContain('large-private-field')
  expect(db.select().from(schema.recordCorrespondence).all().map(p => [p.id, p.relationId, p.status, p.sourceFingerprint])).toEqual(priors.map(p => [p.id, p.relationId, p.status, 'legacy-fingerprint']))
})

it('real handlers keep source selection versions exports and pagination semantics', async () => {
  const selected = input([observations[1]!.query.id])
  const http = await rest('/api/roster/correspondences/candidates', selected)
  expect(http.body).toMatchObject({ total: 1, rows: [{ edge: { relationId: observations[1]!.relation.id }, existingCorrespondenceIds: [priors[1]!.id], conflicts: [] }] })
  expect(http.body.rows[0].observationRefs).toHaveLength(1)
  expect((await mcp(selected)).result.structuredContent).toEqual(http.body)
  const all = { ...input(observations.map(o => o.query.id)), exportBatchIds: [batch.id], page: 2, pageSize: 1 }
  const second = await rest('/api/roster/correspondences/candidates', all)
  expect(second.body).toMatchObject({ total: 4, page: 2, pageSize: 1, rows: [{ edge: { relationId: observations[2]!.relation.id }, conflicts: ['multiple_candidate_rows'] }] })
  expect((await mcp(all)).result.structuredContent).toEqual(second.body)
  for (const [index, row] of exports.entries()) {
    const body = { ...all, page: 3 + index }
    const result = await rest('/api/roster/correspondences/candidates', body)
    expect(result.body).toMatchObject({ total: 4, rows: [{ edge: { type: 'event_export_context', exportRowId: row.id }, conflicts: ['scope_version_not_proven'], existingCorrespondenceId: null, revision: null }] })
    expect(result.body.rows[0]).not.toHaveProperty('businessRecord')
    expect((await mcp(body)).result.structuredContent).toEqual(result.body)
  }
})

it('publishes REST and MCP discovery for business metadata observations and decision revisions', async () => {
  const spec = (await rest('/_openapi.json')).body
  const operation = spec.paths['/api/roster/correspondences/candidates'].post
  const row = operation.responses['200'].content['application/json'].schema.properties.rows.items.properties
  expect(row.businessRecord.properties.groupState.enum).toEqual(['verified', 'not_indexed', 'missing_key', 'conflict', 'unverifiable'])
  expect(row.observationRefs.items.properties.queriedAt.type).toBe('string')
  expect(row.existingCorrespondences.items.properties.status.enum).toContain('rejected')
  expect(row.existingCorrespondences.items.properties.revision.type).toBe('integer')
  expect(operation.requestBody.content['application/json'].schema.properties).not.toHaveProperty('asOf')
  const tool = (await rpc('tools/list', {})).result.tools.find((t: any) => t.name === 'find_record_correspondence_candidates')
  expect(tool.outputSchema.properties.rows.items.properties.businessRecord.properties.versionId).toBeDefined()
  expect(tool.outputSchema.properties.rows.items.properties.observationRefs.items.properties.businessRecord.properties.groupState.enum).toEqual(row.businessRecord.properties.groupState.enum)
  expect(tool.outputSchema.properties.rows.items.properties.existingCorrespondences.items.properties.revision.type).toBe('integer')
  expect(tool.inputSchema.properties).not.toHaveProperty('asOf')
})

it('keeps REST unsupported parameters and shared REST MCP invalid source errors', async () => {
  const invalid = { ...input(), asOf: '2026-10-01' }
  expect(await rest('/api/roster/correspondences/candidates', invalid)).toMatchObject({ http: 400, body: { error: { code: 'invalid_request' } } })
  // MCP toolkit drops keys outside its advertised input shape; no asOf is
  // advertised or added to this candidate entry point.
  const wire = await mcp({ ...input(), queryIds: [] })
  expect(wire.result.isError).toBe(true)
  expect(JSON.parse(wire.result.content[0].text).error.code).toBe('invalid_request')
  const missing = { ...input(), queryIds: [999999] }
  expect(await rest('/api/roster/correspondences/candidates', missing)).toMatchObject({ http: 404, body: { error: { code: 'not_found' } } })
  expect(JSON.parse((await mcp(missing)).result.content[0].text).error.code).toBe('not_found')
})
