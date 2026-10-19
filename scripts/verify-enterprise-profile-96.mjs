#!/usr/bin/env node
// Synthetic, isolated public REST/MCP acceptance. No production traffic or SQL writes.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { minimalPdf } from '../tests/helpers/minimal-pdf.ts'
import { startIsolatedNuxt } from './lib/isolated-local-services.mjs'

const cwd = resolve(import.meta.dirname, '..'), root = mkdtempSync(join(tmpdir(), 'profile96-public-'))
const files = join(root, 'files'), apiToken = randomBytes(24).toString('hex'), mcpToken = randomBytes(24).toString('hex')
const report = { sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim().length > 0, checks: [] }
let service, base, seq = 0
async function check(name, fn) { await fn(); report.checks.push(name); console.log(`PASS ${name}`) }
async function rest(method, path, body, status = 200, token = apiToken) {
  const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const raw = await response.text()
  assert.equal(response.status, status, `${method} ${path}: ${raw.slice(0, 700)}`)
  if (path.includes('/profile') || method === 'PATCH') assert.equal(response.headers.get('cache-control'), 'no-store')
  return JSON.parse(raw)
}
const get = path => rest('GET', path)
const post = (path, body) => rest('POST', path, body)
async function rpc(method, params, token = null, status = 200) {
  const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }) })
  const raw = await response.text()
  assert.equal(response.status, status, `MCP ${method}: ${raw.slice(0, 700)}`)
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  const line = raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))?.slice(6) : raw
  return JSON.parse(line)
}
async function call(name, args, { auth = false, error = false } = {}) {
  const result = await rpc('tools/call', { name, arguments: args }, auth ? mcpToken : null)
  if (error) { assert.ok(result.error || result.result?.isError, `Expected MCP error from ${name}`); return result }
  assert.ok(!result.error, JSON.stringify(result.error))
  assert.ok(!result.result.isError, JSON.stringify(result.result.content))
  return JSON.parse(result.result.content[0].text)
}
function command(version, changes, other = {}) { return { expectedVersion: version, changes, idempotencyKey: `public96-${++seq}`, actor: { type: 'agent', id: 'synthetic96' }, basis: '合成资料确认及同主体依据', ...other } }
async function batch(label, payload) {
  const result = await post('/api/roster/import/commit', { idempotencyKey: `public96-import-${label}`, sourceKind: 'announcement', sourceIdentity: 'jxj/announcement/2024/1/synthetic96.pdf', payload })
  assert.equal(result.status, 'committed', JSON.stringify(result))
  return result
}
try {
  const sourceFile = 'jxj/announcement/2024/1/synthetic96.pdf', pdf = minimalPdf({ pages: 3 })
  mkdirSync(dirname(join(files, sourceFile)), { recursive: true }); writeFileSync(join(files, sourceFile), pdf)
  service = await startIsolatedNuxt({ cwd, env: { NUXT_DB_PATH: join(root, 'roster.db'), NUXT_FILES_DIR: files, NUXT_INCOMING_DIR: join(root, 'incoming'), NUXT_API_TOKEN: apiToken, NUXT_MCP_TOKEN: mcpToken, NUXT_MIIT_COOKIE: '', MIIT_COOKIE: '', MIIT_COOKIE_FILE: '', NUXT_OCR_TOKEN: '', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: '', NUXT_IGNORE_LOCK: '1' } })
  base = service.baseUrl
  const registered = await rest('POST', '/api/files/register', { relPath: sourceFile, source: 'jxj', kind: 'announcement', year: '2024', batch: '1' }, 201)
  assert.equal(registered.sha256, createHash('sha256').update(pdf).digest('hex'))
  const originalName = '九六公开旧名企业', newName = '九六公开现名企业'
  const imported = await batch('formal', { announcement: { sourceDocument: { source: 'jxj', title: '九六合成公布文件' }, records: [{ enterprise: { name: originalName, city: '宁波市', district: '海曙区' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2024, evidence: [{ sourceFile, listNo: 1, page: 2 }] }] }] } })
  const id = imported.items.find(item => item.kind === 'record_event').detail.enterpriseId
  const path = `/api/roster/enterprises/${id}`, initial = await get(path + '/profile')
  const platform = await batch('platform', { platformQueries: [{ interface: 'apply_list', queryKey: `name:${originalName}`, titleCode: 'specialized_sme', rdjb: '2', queriedAt: '2026-10-19T00:00:00Z', status: 'success', rawResponse: '合成平台原文96', relations: [{ enterpriseId: id, sequenceNo: 1, relationKey: 'S96-1', nameRaw: originalName, verificationStatus: 'confirmed', matchBasis: 'manual', declareKind: 'apply', year: 2024, status: '已通过', rawFields: { original: '平台原文行96' } }] }] })
  const relationId = platform.items.find(item => item.kind === 'platform_query').detail.relations[0]
  const eventId = (await get(path)).events[0].id
  const correspondenceRequest = { idempotencyKey: 'public96-correspondence', sourceIdentity: 'synthetic96', actor: { type: 'agent', id: 'synthetic96' }, basis: '同主体事件原始关系', ruleId: 'synthetic96', ruleVersion: '1', operations: [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId, relationId, role: 'context_only' } }] }
  const plan = await post('/api/roster/correspondences/preflight', correspondenceRequest)
  const correspondenceId = (await post('/api/roster/correspondences/commit', { request: correspondenceRequest, planHash: plan.planHash })).correspondenceIds[0]
  assert.equal((await get(`/api/roster/correspondences/${correspondenceId}`)).requiresRevalidation, false)
  let first, updated, sourceBefore
  await check('OpenAPI discovers strict profile PATCH and bounded read contracts', async () => {
    const spec = await get('/_openapi.json')
    assert.ok(spec.paths['/api/roster/enterprises/{id}'].patch)
    assert.ok(spec.paths['/api/roster/enterprises/{id}/profile'].get)
    assert.ok(spec.paths['/api/roster/enterprises/{id}/profile-history'].get)
    const schema = spec.paths['/api/roster/enterprises/{id}'].patch.requestBody.content['application/json'].schema
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(Object.keys(schema.properties.changes.properties).sort(), ['city', 'district', 'name'])
    assert.ok(schema.required.includes('actor') && schema.required.includes('basis'))
    assert.ok(!JSON.stringify(spec).includes(apiToken) && !JSON.stringify(spec).includes(mcpToken))
  })
  await check('MCP discovery and HTTP 401 write guard expose reads publicly and protect PATCH', async () => {
    const publicTools = (await rpc('tools/list', {})).result.tools.map(t => t.name)
    assert.ok(publicTools.includes('get_enterprise_profile') && publicTools.includes('get_enterprise_profile_history'))
    assert.ok(!publicTools.includes('patch_enterprise_profile'))
    assert.ok((await rpc('tools/list', {}, mcpToken)).result.tools.some(t => t.name === 'patch_enterprise_profile'))
    await rpc('tools/call', { name: 'patch_enterprise_profile', arguments: { enterpriseId: id, request: command(initial.version, { city: null }) } }, null, 401)
    await rest('PATCH', path, command(initial.version, { city: null }), 401, null)
    await rest('PATCH', path, command(initial.version, { city: null }), 401, mcpToken)
    assert.deepEqual(await call('get_enterprise_profile', { enterpriseId: id }), initial)
  })
  await check('REST PATCH preserves IDs and raw sources; MCP replays the exact committed receipt', async () => {
    sourceBefore = await get(path)
    first = command(initial.version, { name: newName, city: null }, { previousName: { name: originalName, sameSubject: true } })
    updated = await rest('PATCH', path, first)
    assert.deepEqual(updated.profile, { enterpriseId: id, name: newName, city: null, district: '海曙区' })
    assert.deepEqual(await call('patch_enterprise_profile', { enterpriseId: id, request: first }, { auth: true }), updated)
    const after = await get(path)
    for (const key of ['records', 'events', 'evidence', 'recognitions', 'platform']) assert.deepEqual(after[key], sourceBefore[key])
    assert.equal(after.aliases.length, 1)
    assert.equal(after.aliases[0].name, originalName)
    assert.equal(after.aliases[0].verificationStatus, 'confirmed')
    assert.equal(after.aliases[0].validFrom, null)
    assert.equal(after.aliases[0].validTo, null)
  })
  await check('MCP PATCH and HTTP readback retain omission/null and invalidate warm list/detail reads', async () => {
    const req = command(updated.version, { district: '鄞州区' })
    const next = await call('patch_enterprise_profile', { enterpriseId: id, request: req }, { auth: true })
    assert.deepEqual(await get(path + '/profile'), await call('get_enterprise_profile', { enterpriseId: id }))
    assert.deepEqual(next.profile, { enterpriseId: id, name: newName, city: null, district: '鄞州区' })
    for (const q of [originalName, newName]) {
      const args = { q, pageSize: 5 }, list = await get('/api/roster/enterprises?' + new URLSearchParams(args))
      assert.equal(list.counts.total, 1)
      assert.deepEqual(list.rows.map(row => row.enterpriseId), [id])
      assert.equal(list.rows[0].name, newName)
      assert.ok(list.rows[0].aliasNames.includes(originalName))
      assert.deepEqual(await call('list_enterprises', args), list)
    }
    assert.deepEqual(await call('get_enterprise_detail', { enterpriseId: id }), await get(path))
    assert.deepEqual(await rest('PATCH', path, first), updated)
  })
  await check('profile corrections retain correspondence history and trigger existing source-fingerprint revalidation', async () => {
    const correspondence = await get(`/api/roster/correspondences/${correspondenceId}`)
    assert.equal(correspondence.id, correspondenceId)
    assert.equal(correspondence.status, 'confirmed')
    assert.equal(correspondence.requiresRevalidation, true)
    assert.equal(correspondence.relation.nameRaw, originalName)
    assert.deepEqual(await call('get_record_correspondence', { id: correspondenceId }), correspondence)
  })
  await check('REST and MCP reject stale versions, old-value mismatch, unknown and identity fields', async () => {
    const current = await get(path + '/profile')
    assert.equal((await rest('PATCH', path, command(initial.version, { city: null }), 409)).error.code, 'version_conflict')
    assert.equal((await rest('PATCH', path, command(current.version, { city: null }, { expectedValues: { district: '错误旧值' } }), 409)).error.code, 'old_value_conflict')
    assert.equal((await rest('PATCH', path, { ...first, changes: { city: '异请求' } }, 409)).error.code, 'idempotency_conflict')
    for (const changes of [{ usccNorm: '拒绝' }, { regStatus: '注销' }, { city: null, rosterState: 'active' }, { name: null }]) {
      await rest('PATCH', path, command(current.version, changes), 400)
      await call('patch_enterprise_profile', { enterpriseId: id, request: command(current.version, changes) }, { auth: true, error: true })
    }
    await call('patch_enterprise_profile', { enterpriseId: id, request: command(initial.version, { district: null }) }, { auth: true, error: true })
    assert.deepEqual(await get(path + '/profile'), current)
  })
  await check('REST/MCP history pages agree, preserve two audits and do not expose raw request metadata', async () => {
    const audit = await get(path + '/profile-history?pageSize=1&page=1')
    assert.equal(audit.total, 2); assert.equal(audit.rows.length, 1)
    assert.deepEqual(await call('get_enterprise_profile_history', { enterpriseId: id, pageSize: 1, page: 1 }), audit)
    const older = await get(path + '/profile-history?pageSize=1&page=2')
    assert.equal(older.rows[0].before.name, originalName)
    assert.equal(older.rows[0].after.name, newName)
    assert.equal(older.rows[0].basis, first.basis)
    assert.deepEqual(older.rows[0].actor, first.actor)
    assert.equal(older.rows[0].retainedAliasId, updated.retainedAlias.id)
    assert.ok(!('idempotencyKey' in older.rows[0]) && !('requestHash' in older.rows[0]))
    await rest('GET', path + '/profile-history?pageSize=101', undefined, 400)
    await rest('GET', '/api/roster/enterprises/99999999/profile', undefined, 404)
    await call('get_enterprise_profile', { enterpriseId: 99999999 }, { error: true })
  })
  report.status = 'passed'
  console.log(JSON.stringify(report, null, 2))
  if (process.env.PROFILE96_REPORT) writeFileSync(process.env.PROFILE96_REPORT, JSON.stringify(report, null, 2))
} finally {
  await service?.stop()
  rmSync(root, { recursive: true, force: true })
}
