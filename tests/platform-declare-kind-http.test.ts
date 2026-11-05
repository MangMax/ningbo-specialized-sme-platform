import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { initializeDb } from '../db/client'
import { createRosterImportClient, type RosterImportRequest } from '../lib/roster-import-client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

// Every business write uses the app API on a new isolated SQLite database.
const dir = mkdtempSync(join(tmpdir(), 'declare-kind-249-'))
const token = 'synthetic-declare-kind-249'
let service: { baseUrl: string; stop: () => Promise<void> }
let client: ReturnType<typeof createRosterImportClient>
beforeAll(async () => {
  const cwd = resolve(import.meta.dirname, '..'), port = await reserveLoopbackPort()
  initializeDb({ dbPath: join(dir, 'roster.db'), create: true }).$client.close()
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: join(dir, 'roster.db'), NUXT_DB_READONLY: '0',
    NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'), NUXT_API_TOKEN: token, NUXT_MCP_TOKEN: token,
  } })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-8000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(`${service.baseUrl}/_openapi.json`, { timeoutMs: 60000, child }) }
  catch (error) { await service.stop(); throw new Error(`${String(error)}\n${output}`) }
  expect(output).toContain(service.baseUrl)
  const response = await fetch(`${service.baseUrl}/_openapi.json`)
  expect(response.status).toBe(200)
  const contract = await response.json()
  expect(contract.paths['/api/roster/import/preflight'].post).toBeDefined()
  expect(contract.paths['/api/roster/import/commit'].post).toBeDefined()
  expect(contract.paths['/api/platform/queries/{queryId}/evidence'].get).toBeDefined()
  client = createRosterImportClient({ baseUrl: service.baseUrl, token })
}, 90000)
afterAll(async () => { await service?.stop(); rmSync(dir, { recursive: true, force: true }) })

function input(label: string, source: 'apply_list' | 'business_list', relations: NonNullable<NonNullable<RosterImportRequest['payload']['platformQueries']>[number]['relations']>): RosterImportRequest {
  return { idempotencyKey: `249:${label}`, sourceKind: 'alias_evidence', sourceIdentity: `synthetic:249:${label}`, payload: { platformQueries: [{ interface: source, queryKey: `synthetic:249:${label}`, queriedAt: '2026-10-23T00:00:00.000Z', status: 'success', rawResponse: '原始响应 🙂\n', relations }] } }
}
async function read(label: string) {
  const response = await fetch(`${service.baseUrl}/api/platform/queries?queryKey=${encodeURIComponent(`synthetic:249:${label}`)}&includeRawResponse=true`)
  expect(response.status).toBe(200)
  return response.json()
}
async function original(queryId: number, relationId: number) {
  const response = await fetch(`${service.baseUrl}/api/platform/queries/${queryId}/evidence?field=relation&relationId=${relationId}`)
  expect(response.status).toBe(200)
  const chunk = await response.json()
  expect(chunk.hasMore).toBe(false)
  return JSON.parse(Buffer.from(chunk.data, 'base64').toString('utf8'))
}
async function api(path: string, body?: unknown, method = 'POST') {
  const response = await fetch(service.baseUrl + path, { method: body ? method : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  expect(response.status).toBe(200)
  return response.json()
}

it.each(['apply_list', 'business_list'] as const)('equivalent declare kinds archive and replay over real HTTP without changing raw evidence: %s', async (source) => {
  const pairs = [['申请', 'apply'], ['更新', 'update'], ['复核', 'review']] as const
  const relations = pairs.flatMap(([chinese, english], i) => [
    { sequenceNo: i * 2 + 1, declareKind: chinese, rawFields: { sblx: english, cszt: '终审通过', sourceOnly: '留证 🙂\n' } },
    { sequenceNo: i * 2 + 2, declareKind: english, rawFields: { sblx: chinese, cszt: '终审通过', sourceOnly: '留证 🙂\n' } },
  ])
  const request = input(source, source, relations)
  expect((await client.preflight(request)).preflight.conflicts).toEqual([])
  expect((await client.commit(request)).status).toBe('committed')
  const page = await read(source)
  const archived = page.rows[0]
  expect(archived.query.rawResponse).toBe('原始响应 🙂\n')
  expect(archived.relations).toHaveLength(6)
  const originals = []
  for (const [i, row] of archived.relations.entries()) {
    expect(row).toMatchObject({ declareKind: pairs[Math.floor(i / 2)]![1], rawFields: relations[i]!.rawFields, normalizationConflicts: [] })
    const evidence = await original(archived.query.id, row.id)
    expect(evidence).toMatchObject({ declareKind: row.declareKind, rawFields: relations[i]!.rawFields })
    originals.push(evidence)
  }
  expect((await client.commit(request)).status).toBe('committed')
  expect(await read(source)).toEqual(page)
  for (const [i, row] of archived.relations.entries()) expect(await original(archived.query.id, row.id)).toEqual(originals[i])
})

it('unknown and prototype-named declare kinds survive HTTP archive and exact evidence reads', async () => {
  const values = ['新事项', '__proto__', 'constructor', 'toString', 'APPLY']
  const relations = values.map((value, i) => ({ sequenceNo: i + 1, declareKind: value, rawFields: { sblx: value } }))
  const request = input('unknown', 'business_list', relations)
  expect((await client.preflight(request)).preflight.conflicts).toEqual([])
  expect((await client.commit(request)).status).toBe('committed')
  const archived = (await read('unknown')).rows[0]
  expect(archived.relations).toHaveLength(values.length)
  for (const [i, row] of archived.relations.entries()) {
    expect(row).toMatchObject({ declareKind: values[i], rawFields: relations[i]!.rawFields, normalizationConflicts: [] })
    expect(await original(archived.query.id, row.id)).toMatchObject({ declareKind: values[i], rawFields: relations[i]!.rawFields })
  }
})

it('real nonempty type and status conflicts still reject HTTP archives atomically', async () => {
  for (const [label, stored, raw, status] of [
    ['different-known', '申请', 'update', '终审通过'],
    ['different-unknown', 'constructor', '申请', '终审通过'],
    ['different-status', '申请', 'apply', '已退回'],
  ]) {
    const request = input(label!, 'apply_list', [{ sequenceNo: 1, declareKind: stored, status, rawFields: { sblx: raw, cszt: '终审通过' } }])
    expect((await client.preflight(request)).preflight.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'platform_field_conflict' }) })]))
    expect((await client.commit(request)).status).toBe('failed')
    expect((await read(label!)).total).toBe(0)
  }
})

it('identical full raw reuses a content version across stored synonyms while changed raw stays distinct', async () => {
  const raw = { id: 'synthetic-249-content', sblx: '申请', sourceOnly: '完整原始内容' }
  const requests = [
    input('content-first', 'apply_list', [{ sequenceNo: 1, relationKey: raw.id, declareKind: 'apply', rawFields: raw }]),
    input('content-second', 'apply_list', [{ sequenceNo: 1, relationKey: raw.id, declareKind: '申请', rawFields: raw }]),
    input('content-changed', 'apply_list', [{ sequenceNo: 1, relationKey: raw.id, declareKind: '申请', rawFields: { ...raw, sblx: 'apply' } }]),
  ]
  for (const request of requests) {
    request.sourceKind = 'platform_archive'
    expect((await client.preflight(request)).preflight.conflicts).toEqual([])
    expect((await client.commit(request)).status).toBe('committed')
  }
  const db = new Database(join(dir, 'roster.db'), { readonly: true, fileMustExist: true })
  try {
    const versions = () => db.prepare('SELECT o.record_id, o.version_id FROM platform_business_observation o JOIN platform_relation r ON r.id = o.relation_id WHERE r.relation_key = ? ORDER BY r.id').all(raw.id)
    const before = versions() as { record_id: number; version_id: number }[]
    expect(before).toHaveLength(3)
    expect(before[0]!.version_id).toBeGreaterThan(0)
    expect(before[0]).toEqual(before[1])
    expect(before[2]!.record_id).toBe(before[0]!.record_id)
    expect(before[2]!.version_id).not.toBe(before[0]!.version_id)
    for (const label of ['content-first', 'content-second', 'content-changed']) {
      const archived = (await read(label)).rows[0], row = archived.relations[0]
      expect(row).toMatchObject({ declareKind: 'apply', normalizationConflicts: [] })
      expect((await original(archived.query.id, row.id)).rawFields).toEqual(label === 'content-changed' ? { ...raw, sblx: 'apply' } : raw)
    }
    expect(versions()).toEqual(before)
  } finally { db.close() }
})

it('synonym reads preserve full raw source fingerprints and cannot clear stale source qualification', async () => {
  const name = '合成同义来源资格企业', uscc = '91330211000000001F'
  const announcement: RosterImportRequest = { idempotencyKey: '249:official', sourceKind: 'announcement', sourceIdentity: 'synthetic:249:official', payload: { announcement: { sourceDocument: { source: 'jxj', title: '合成来源资格公告' }, records: [{ enterprise: { name, uscc }, titleCode: 'innovative_sme', events: [{ eventType: 'award', year: 2025 }] }] } } }
  expect(await client.commit(announcement)).toMatchObject({ status: 'committed' })
  const request = input('fingerprint', 'apply_list', [{ sequenceNo: 1, declareKind: '申请', usccRaw: uscc, rawFields: { sblx: 'apply', originalOnly: '完整原档仍参与指纹' } }])
  request.payload.platformQueries![0]!.rdjb = '1'
  request.payload.platformQueries![0]!.titleCode = 'innovative_sme'
  expect((await client.commit(request)).status).toBe('committed')
  const archived = (await read('fingerprint')).rows[0], relationId = archived.relations[0].id
  const db = new Database(join(dir, 'roster.db'), { readonly: true, fileMustExist: true })
  try {
    const event = db.prepare('SELECT e.id, r.enterprise_id AS enterpriseId FROM record_event e JOIN record r ON r.id = e.record_id').get() as { id: number; enterpriseId: number }
    const decision = { idempotencyKey: '249:confirm', sourceIdentity: 'synthetic:249:confirm', actor: { type: 'agent', id: 'synthetic-249' }, basis: '合成流程同义与原档核对', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', role: 'supports_award', eventId: event.id, relationId } }] }
    const plan = await api('/api/roster/correspondences/preflight', decision)
    const receipt = await api('/api/roster/correspondences/commit', { request: decision, planHash: plan.planHash })
    const id = receipt.correspondenceIds[0]
    const persisted = () => db.prepare('SELECT source_fingerprint AS fingerprint, provenance FROM record_correspondence WHERE id = ?').get(id) as { fingerprint: string; provenance: string }
    const before = persisted()
    const { comparisonProofIds: _proofs, ...provenance } = JSON.parse(before.provenance)
    expect(provenance.relation.rawFields).toEqual(request.payload.platformQueries![0]!.relations![0]!.rawFields)
    expect(provenance.relation).not.toHaveProperty('normalizationConflicts')
    expect(before.fingerprint).toBe(createHash('sha256').update(JSON.stringify(provenance)).digest('hex'))
    expect(plan.targets[0].sourceFingerprint).toBe(before.fingerprint)
    const originalBytes = await original(archived.query.id, relationId)
    expect(await api(`/api/roster/correspondences/${id}`)).toMatchObject({ status: 'confirmed', requiresRevalidation: false })
    expect((await api(`/api/roster/correspondences/relations/${relationId}`)).source).toMatchObject({ declareKind: 'apply', normalizationConflicts: [] })
    expect(persisted()).toEqual(before)
    const profile = await api(`/api/roster/enterprises/${event.enterpriseId}/profile`)
    await api(`/api/roster/enterprises/${event.enterpriseId}`, { idempotencyKey: '249:source-change', expectedVersion: profile.version, changes: { city: '合成资料更正' }, actor: { type: 'agent', id: 'synthetic-249' }, basis: '合成来源变更资格反例' }, 'PATCH')
    expect(await api(`/api/roster/correspondences/${id}`)).toMatchObject({ status: 'confirmed', requiresRevalidation: true })
    expect((await api(`/api/roster/correspondences/relations/${relationId}`)).source).toMatchObject({ declareKind: 'apply', normalizationConflicts: [] })
    expect(await api(`/api/roster/correspondences/${id}`)).toMatchObject({ requiresRevalidation: true })
    expect(persisted()).toEqual(before)
    expect(await original(archived.query.id, relationId)).toEqual(originalBytes)
  } finally { db.close() }
})
