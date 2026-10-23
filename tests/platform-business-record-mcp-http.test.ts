import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { schema, useDb } from '../db'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

const dir = mkdtempSync(join(tmpdir(), 'identity244-mcp-http-'))
const db = useDb({ dbPath: join(dir, 'roster.db') })
const originalQuery = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'synthetic', queriedAt: 'old-time', status: 'success' }).returning().get()
const original = db.insert(schema.platformRelation).values({ queryId: originalQuery.id, sequenceNo: 1, relationKey: 'SQ1', rawFields: { id: 'SQ1', year: '2022' }, year: null }).returning().get()
let service: { baseUrl: string; stop: () => Promise<void> }
beforeAll(async () => {
  const cwd = resolve(import.meta.dirname, '..'), port = await reserveLoopbackPort()
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: join(dir, 'roster.db'), NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'), NUXT_API_TOKEN: 'synthetic244', NUXT_MCP_TOKEN: 'synthetic244' } })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-8000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(`${service.baseUrl}/_openapi.json`, { timeoutMs: 60000, child }) }
  catch (error) { await service.stop(); throw new Error(`${String(error)}\n${output}`) }
}, 90000)
afterAll(async () => { await service?.stop(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
async function rest(path: string, body?: unknown) {
  const response = await fetch(service.baseUrl + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic244' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { http: response.status, body: await response.json() }
}
async function rpc(method: string, params: unknown) {
  const response = await fetch(`${service.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer synthetic244', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  expect(response.status).toBe(200)
  const raw = await response.text()
  return JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
}
async function mcp(name: string, args: unknown) {
  const payload = await rpc('tools/call', { name, arguments: args })
  expect(payload.error).toBeUndefined()
  return { isError: !!payload.result.isError, body: JSON.parse(payload.result.content[0].text) }
}
function historical(key: string) { return { idempotencyKey: key, sourceKind: 'platform_archive', sourceIdentity: 'synthetic244/archive', payload: { platformRecordObservations: [{ relationId: original.id }] } } }

it('publishes matching strict REST OpenAPI and MCP schemas for bounded historical projection', async () => {
  const spec = (await rest('/_openapi.json')).body
  for (const action of ['preflight', 'commit']) {
    const request = spec.paths[`/api/roster/import/${action}`].post.requestBody.content['application/json'].schema
    expect(request.properties.sourceKind.enum).toContain('platform_archive')
    expect(request.properties.payload.properties.platformRecordObservations).toMatchObject({ minItems: 1, maxItems: 100, items: { additionalProperties: false, required: ['relationId'] } })
    const response = spec.paths[`/api/roster/import/${action}`].post.responses['200'].content['application/json'].schema
    if (action === 'preflight') expect(response.properties.preflight.properties.canonicalProjection.items.properties.identityState.enum).toEqual(['resolved', 'missing_key', 'conflict'])
    else {
      expect(response.properties.summary.properties.canonicalProjection.properties.observationsCreated.type).toBe('integer')
      expect(response.properties.items.items.properties.detail.properties.canonicalProjection.items.properties.versionId.nullable).toBe(true)
    }
  }
  const tools = (await rpc('tools/list', {})).result.tools
  for (const name of ['preflight_roster_batch', 'save_roster_batch']) {
    const tool = tools.find((tool: any) => tool.name === name)
    expect(tool.inputSchema.properties.sourceKind.enum).toContain('platform_archive')
    expect(tool.inputSchema.properties.payload.properties.platformRecordObservations).toMatchObject({ minItems: 1, maxItems: 100, items: { additionalProperties: false, required: ['relationId'] } })
  }
})

it('REST and real MCP handlers share preflight commit reuse drift and receipt semantics', async () => {
  const req = historical('same-rest-mcp')
  const restPlan = await rest('/api/roster/import/preflight', req)
  const mcpPlan = await mcp('preflight_roster_batch', req)
  expect(restPlan.http).toBe(200); expect(mcpPlan).toEqual({ isError: false, body: restPlan.body })
  expect(db.get(sql`SELECT count(*) n FROM platform_business_observation`)).toEqual({ n: 0 })
  const restSave = await rest('/api/roster/import/commit', req)
  expect(restSave.body.status).toBe('committed')
  expect(await mcp('save_roster_batch', req)).toEqual({ isError: false, body: restSave.body })
  const receipt = await mcp('get_roster_import_receipt', { idempotencyKey: req.idempotencyKey })
  expect(receipt).toMatchObject({ isError: false, body: { status: 'committed', summary: { canonicalProjection: { recordsCreated: 1, versionsCreated: 1, observationsCreated: 1 } } } })
  const onlyMcp = await mcp('save_roster_batch', historical('mcp-owned-commit'))
  expect(onlyMcp).toMatchObject({ isError: false, body: { status: 'committed', summary: { canonicalProjection: { recordsCreated: 0, versionsCreated: 0, observationsReused: 1 } } } })
  db.run(sql`UPDATE platform_relation SET relation_key='changed' WHERE id=${original.id}`)
  const drift = historical('mcp-drift')
  const restFailure = await rest('/api/roster/import/preflight', drift)
  expect(restFailure.body.preflight.conflicts[0].error.code).toBe('projection_source_drift')
  expect(await mcp('preflight_roster_batch', drift)).toEqual({ isError: false, body: restFailure.body })
})

it('real MCP rejects invalid projection payloads and missing sources without a successful noop', async () => {
  const result = await rpc('tools/call', { name: 'save_roster_batch', arguments: { ...historical('invalid-mcp'), payload: { platformRecordObservations: [{ relationId: original.id, contentHash: 'client' }] } } })
  expect(result.error || result.result?.isError).toBeTruthy()
  const missing = await mcp('save_roster_batch', { ...historical('mcp-missing'), payload: { platformRecordObservations: [{ relationId: 999999 }] } })
  expect(missing).toMatchObject({ isError: false, body: { status: 'failed', items: [{ ok: false, error: { code: 'projection_source_missing' } }] } })
})

it('projects recognized UUID identities separately while retaining the original evidence validation', async () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000'
  const raw = { id: uuid, qymc: '合成企业', tyshxydm: '91330211255994457P' }
  function recognized(time: string) {
    const evidence = { source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: time, completedAt: time, rows: [raw], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, status: 'success', fetchedCount: 1, maxPage: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 } }
    return { interface: 'recognized_list', queryKey: 'all', rdjb: '2', titleCode: 'specialized_sme', queriedAt: time, status: 'success', collectionEvidence: evidence, relations: [{ sequenceNo: 1, relationKey: uuid, nameRaw: raw.qymc, usccRaw: raw.tyshxydm, rawFields: raw }] }
  }
  const input = { idempotencyKey: 'recognized-real', sourceKind: 'platform_archive', sourceIdentity: 'synthetic-recognized', payload: { platformQueries: [recognized('2026-10-01T00:00:00Z'), recognized('2026-10-02T00:00:00Z'), { interface: 'business_list', queryKey: 'all', queriedAt: 'time', relations: [{ sequenceNo: 1, relationKey: uuid, rawFields: raw }, { sequenceNo: 2, relationKey: 'SQ1', rawFields: { ...raw, id: 'SQ1' } }] }] } }
  const saved = await mcp('save_roster_batch', input)
  expect(saved).toMatchObject({ isError: false, body: { status: 'committed' } })
  const records = db.all<{ id: number; interface: string; platform_key: string }>(sql`SELECT id,interface,platform_key FROM platform_business_record WHERE platform_key=${uuid} ORDER BY id`)
  expect(records.map(row => row.interface)).toEqual(['recognized_list', 'business_list']); expect(new Set(records.map(row => row.id)).size).toBe(2)
  expect(db.get(sql`SELECT count(*) n FROM platform_business_observation WHERE record_id=${records[0]!.id}`)).toEqual({ n: 2 })
  const tampered = recognized('2026-10-03T00:00:00Z'); tampered.relations[0]!.rawFields = { ...raw, qymc: 'tampered' }
  const invalid = await rest('/api/roster/import/commit', { ...input, idempotencyKey: 'recognized-invalid', payload: { platformQueries: [tampered] } })
  expect(invalid.body.status).toBe('failed'); expect(invalid.body.items[0].error.code).toBe('collection_evidence_invalid')
})
