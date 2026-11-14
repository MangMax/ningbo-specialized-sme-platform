#!/usr/bin/env node
// Local compiled artifact, isolated synthetic SQLite. Never targets production.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawnOwnedChild as spawn, reserveLoopbackPort, stopOwnedChild, waitForHttp } from './lib/isolated-local-services.mjs'
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const { initializeDb, schema } = await createJiti(import.meta.url).import('../db/client.ts')
const dir = mkdtempSync(join(tmpdir(), 'event-100-public-')), dbPath = join(dir, 'test.db')
const db = initializeDb({ dbPath, create: true })
const enterprise = db.insert(schema.enterprise).values({ name: '公开接缝合成企业', nameNorm: '公开接缝合成企业' }).returning().get()
const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2021, decidedYear: 2021, batchSeq: 1 }).returning().get()
db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'synthetic/notice.pdf', page: 3 }).run()
const port = await reserveLoopbackPort(), base = `http://127.0.0.1:${port}`
const dev = process.argv.includes('--dev')
const child = spawn(process.execPath, dev ? ['node_modules/nuxt/bin/nuxt.mjs', 'dev', '--host', '127.0.0.1', '--port', String(port)] : ['.output/server/index.mjs'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NUXT_DB_PATH: dbPath, NUXT_FILES_DIR: dir, NUXT_BUILD_DIR: join(dir, 'nuxt'), NUXT_API_TOKEN: 'api-100', NUXT_MCP_TOKEN: 'mcp-100', MIIT_COOKIE: '', MIIT_COOKIE_FILE: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', () => {}); child.stderr.on('data', b => process.stderr.write(b))
let seq = 0
async function rest(path, body, token = 'api-100') {
  const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: r.status, body: await r.json(), headers: r.headers }
}
async function rpc(method, params, token = 'mcp-100') {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }) })
  const raw = await r.text(), data = raw.split('\n').find(s => s.startsWith('data: '))?.slice(6) ?? raw
  return { status: r.status, body: JSON.parse(data) }
}
async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args }); assert.equal(r.status, 200); assert.ok(!r.body.error, JSON.stringify(r.body)); assert.ok(!r.body.result.isError, JSON.stringify(r.body.result)); return JSON.parse(r.body.result.content[0].text)
}
try {
  await waitForHttp(base + '/api/health', { child, timeoutMs: 60000 })
  const tools = await rpc('tools/list', {})
  assert.ok(tools.body.result.tools.some(t => t.name === 'preflight_event_corrections'), 'event correction must be discoverable in real MCP tools/list')
  const publicTools = await rpc('tools/list', {}, '')
  assert.ok(!publicTools.body.result.tools.some(t => t.name === 'preflight_event_corrections'))
  const initial = await rest(`/api/roster/events/${event.id}`)
  assert.equal(initial.status, 200, 'exact event HTTP read')
  assert.equal(initial.body.event.year, 2021)
  const request = { idempotencyKey: 'public-100-1', sourceIdentity: 'synthetic:review', actor: { type: 'agent', id: 'public-test' }, basis: 'Verified official row', operations: [{ eventId: event.id, recordId: record.id, enterpriseId: enterprise.id, expectedRevision: 1, patch: { year: 2022, decidedYear: 2022 } }] }
  const denied = await rest('/api/roster/events/corrections/preflight', request, 'mcp-100'); assert.equal(denied.status, 401)
  const deniedMcp = await rpc('tools/call', { name: 'preflight_event_corrections', arguments: request }, 'api-100'); assert.equal(deniedMcp.status, 401)
  const unknown = await rpc('tools/call', { name: 'preflight_event_corrections', arguments: { ...request, unexpected: 'must-reject' } }); assert.equal(unknown.status, 400, 'MCP must reject unknown original argument before SDK stripping')
  const pre = await rest('/api/roster/events/corrections/preflight', request); assert.equal(pre.status, 200)
  assert.deepEqual(await call('preflight_event_corrections', request), pre.body)
  const receipt = await call('commit_event_corrections', { request, planHash: pre.body.planHash })
  assert.deepEqual((await rest('/api/roster/events/corrections/commit', { request, planHash: pre.body.planHash })).body, receipt)
  const exact = await rest(`/api/roster/events/${event.id}`)
  assert.equal(exact.headers.get('cache-control'), 'no-store')
  assert.equal(exact.body.event.revision, 2); assert.equal(exact.body.event.year, 2022)
  assert.equal(exact.body.lifecycle.dueYear, 2025); assert.deepEqual(exact.body.evidence, initial.body.evidence)
  assert.deepEqual(await call('get_official_event', { eventId: event.id }), exact.body)
  const history = await rest(`/api/roster/events/${event.id}/audit?pageSize=1`)
  assert.equal(history.body.total, 1); assert.deepEqual(await call('get_event_correction_audit', { eventId: event.id, pageSize: 1 }), history.body)
  const invalid = structuredClone(request); invalid.idempotencyKey = 'invalid'; invalid.operations[0].patch.sourceFile = 'forbidden.pdf'
  assert.equal((await rest('/api/roster/events/corrections/preflight', invalid)).status, 400)
  const missing = await rest('/api/roster/events/999999'); assert.equal(missing.status, 404)
  const stale = structuredClone(request); stale.idempotencyKey = 'stale'
  assert.equal((await rest('/api/roster/events/corrections/preflight', stale)).status, 409)
  // Independent client requests bind the same old revision; only one can commit.
  const racer = key => ({ ...structuredClone(request), idempotencyKey: key, operations: [{ ...request.operations[0], expectedRevision: 2, patch: { year: key === 'race-a' ? 2023 : 2024, decidedYear: key === 'race-a' ? 2023 : 2024 } }] })
  const a = racer('race-a'), b = racer('race-b')
  const pa = await call('preflight_event_corrections', a), pb = await call('preflight_event_corrections', b)
  const raced = await Promise.all([rest('/api/roster/events/corrections/commit', { request: a, planHash: pa.planHash }), rest('/api/roster/events/corrections/commit', { request: b, planHash: pb.planHash })])
  assert.deepEqual(raced.map(r => r.status).sort(), [200, 409])
  const current = await call('get_official_event', { eventId: event.id }); assert.equal(current.event.revision, 3)
  const change = { ...structuredClone(request), idempotencyKey: 'rollback-recover', operations: [{ ...request.operations[0], expectedRevision: 3, patch: { batchSeq: 2 } }] }
  const rollbackPlan = await call('preflight_event_corrections', change)
  db.$client.exec("CREATE TRIGGER fail_event_audit BEFORE INSERT ON event_correction_audit BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END")
  const failedMcp = await rpc('tools/call', { name: 'commit_event_corrections', arguments: { request: change, planHash: rollbackPlan.planHash } })
  assert.ok(failedMcp.body.result?.isError || failedMcp.body.error, 'MCP transaction failure')
  assert.deepEqual(await call('get_official_event', { eventId: event.id }), current)
  assert.equal((await call('get_event_correction_audit', { eventId: event.id })).total, 2)
  db.$client.exec('DROP TRIGGER fail_event_audit')
  const recovered = await call('commit_event_corrections', { request: change, planHash: rollbackPlan.planHash })
  assert.deepEqual((await rest('/api/roster/events/corrections/commit', { request: change, planHash: rollbackPlan.planHash })).body, recovered)
  const discovery = await rest('/_openapi.json')
  assert.equal(discovery.status, dev ? 200 : 404)
  if (dev) assert.ok(discovery.body.paths['/api/roster/events/corrections/preflight'])
  console.log(JSON.stringify({ passed: true, sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()), lane: dev ? 'local Nuxt dev HTTP/OpenAPI + real MCP tools/list/tools/call' : 'local compiled Nitro HTTP + real MCP tools/list/tools/call', checks: ['discovery', 'independent credentials', 'cross-transport preflight/commit/replay', 'exact event/evidence/lifecycle readback', 'bounded audit parity', 'invalid field', 'missing event', 'stale revision', 'concurrent client winner', 'MCP rollback/readback/same-key recovery', 'OpenAPI discovery', 'MCP unknown-root rejection'], productionChanged: false }))
} finally { await stopOwnedChild(child); db.$client.close(); rmSync(dir, { recursive: true, force: true }) }
