import { submitNativePlatformQuery } from '../../helpers/native-platform-fixture'
import { initializeDb } from '../../../db/client'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, defineEventHandler, getQuery, getRouterParam, setHeader, createError, toNodeListener } from 'h3'
import { schema, useDb } from '../../../db'

const dir = mkdtempSync(join(tmpdir(), 'enterprise-profile-96-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'roster.db') })
let server: Server
let base: string
let sequence = 0
function seed(name = `九六合成旧名${++sequence}`) {
  return db.insert(schema.enterprise).values({ name, nameNorm: name, city: '宁波市', district: '海曙区' }).returning().get()
}
async function request(path: string, body?: unknown, auth = true) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'PATCH', headers: {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(auth ? { authorization: 'Bearer synthetic-api-96' } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') }
}
const profile = async (id: number) => (await request(`/api/roster/enterprises/${id}/profile`)).body
const history = async (id: number, query = '') => (await request(`/api/roster/enterprises/${id}/profile-history${query}`)).body
const patch = (id: number, body: unknown, auth = true) => request(`/api/roster/enterprises/${id}`, body, auth)
function command(expectedVersion: string, changes: object, other: object = {}) {
  return { expectedVersion, changes, idempotencyKey: `profile-96-${++sequence}`, actor: { type: 'agent', id: 'synthetic-96' }, basis: '同一企业资料核对依据', ...other }
}
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  for (const [key, value] of Object.entries({ getQuery, getRouterParam, setHeader, createError })) vi.stubGlobal(key, value)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic-api-96' }))
  vi.doMock('@db', () => ({ useDb: () => db }))
  const get = (await import('../../../server/api/roster/enterprises/[id]/profile.get')).default
  const update = (await import('../../../server/api/roster/enterprises/[id].patch')).default
  const audit = (await import('../../../server/api/roster/enterprises/[id]/profile-history.get')).default
  const list = (await import('../../../server/api/roster/enterprises.get')).default
  const detail = (await import('../../../server/api/roster/enterprises/[id].get')).default
  server = createServer(toNodeListener(createApp({ debug: false }).use(createRouter()
    .get('/api/roster/enterprises/:id/profile', get)
    .get('/api/roster/enterprises/:id/profile-history', audit)
    .get('/api/roster/enterprises', list)
    .get('/api/roster/enterprises/:id', detail)
    .patch('/api/roster/enterprises/:id', update))))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

it('PATCH refuses ambiguous old-name retention across enterprises without partial changes', async () => {
  const owner = seed('九六共同旧名'), other = seed('九六另一企业')
  db.insert(schema.enterpriseAlias).values({ enterpriseId: other.id, name: owner.name, nameNorm: owner.nameNorm, sourceKind: 'manual', verificationStatus: 'confirmed' }).run()
  const before = await profile(owner.id)
  const result = await patch(owner.id, command(before.version, { name: '九六独立新名', city: null }, { previousName: { name: owner.name, sameSubject: true } }))
  expect(result).toMatchObject({ status: 409, body: { error: { code: 'identity_conflict' } } })
  expect(await profile(owner.id)).toEqual(before)
  expect(await history(owner.id)).toMatchObject({ total: 0, rows: [] })
})
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.doUnmock('@db'); vi.unstubAllGlobals(); db.$client.close(); rmSync(dir, { recursive: true, force: true })
})

it('PATCH updates whitelisted profile fields and retains explicitly confirmed old name atomically', async () => {
  const owner = seed()
  const before = await profile(owner.id)
  expect(before.profile).toEqual({ enterpriseId: owner.id, name: owner.name, city: '宁波市', district: '海曙区' })
  const input = command(before.version, { name: '九六更正后的规范名称', city: null }, { previousName: { name: owner.name, sameSubject: true } })
  const result = await patch(owner.id, input)
  expect(result.status).toBe(200)
  expect(result.cache).toBe('no-store')
  expect(result.body.profile).toEqual({ enterpriseId: owner.id, name: '九六更正后的规范名称', city: null, district: '海曙区' })
  expect(result.body.retainedAlias).toMatchObject({ name: owner.name, created: true })
  expect(result.body.version).not.toBe(before.version)
  expect(await profile(owner.id)).toMatchObject({ profile: result.body.profile, version: result.body.version })
  expect(await history(owner.id)).toMatchObject({ total: 1, rows: [{ actor: input.actor, basis: input.basis, before: before.profile, after: result.body.profile, retainedAliasId: result.body.retainedAlias.id }] })
})

it('PATCH replay returns the original receipt after later edits and rejects same-key different requests', async () => {
  const owner = seed(), before = await profile(owner.id)
  const input = command(before.version, { city: '杭州市' })
  const first = await patch(owner.id, input)
  const second = await patch(owner.id, command(first.body.version, { district: null }))
  expect(second.status).toBe(200)
  expect(await patch(owner.id, input)).toEqual(first)
  expect(await patch(owner.id, { ...input, changes: { city: null } })).toMatchObject({ status: 409, body: { error: { code: 'idempotency_conflict' } } })
  expect(await patch(seed().id, input)).toMatchObject({ status: 409, body: { error: { code: 'idempotency_conflict' } } })
  expect(await history(owner.id)).toMatchObject({ total: 2 })
  expect(await profile(owner.id)).toEqual({ profile: second.body.profile, version: second.body.version })
})

it('PATCH has one concurrent winner and rejects stale versions and mismatched old values without consuming a key', async () => {
  const owner = seed(), before = await profile(owner.id)
  const a = command(before.version, { city: '绍兴市' }), b = command(before.version, { district: null })
  const results = await Promise.all([patch(owner.id, a), patch(owner.id, b)])
  expect(results.map(r => r.status).sort()).toEqual([200, 409])
  expect(results.find(r => r.status === 409)!.body.error.code).toBe('version_conflict')
  expect(await history(owner.id)).toMatchObject({ total: 1 })
  const now = await profile(owner.id), key = `old-value-${++sequence}`
  expect(await patch(owner.id, command(now.version, { city: null }, { idempotencyKey: key, expectedValues: { name: '错误旧名' } }))).toMatchObject({ status: 409, body: { error: { code: 'old_value_conflict' } } })
  expect(await profile(owner.id)).toEqual(now)
  expect((await patch(owner.id, command(now.version, { city: null }, { idempotencyKey: key, expectedValues: { city: now.profile.city, name: owner.name } }))).status).toBe(200)
})

it('PATCH detects identity-key changes and returning to an earlier profile does not revive an old version', async () => {
  const owner = seed(), before = await profile(owner.id)
  db.$client.prepare('UPDATE enterprise SET uscc_norm=? WHERE id=?').run(`SYNTHETIC96${owner.id}`, owner.id)
  expect(await patch(owner.id, command(before.version, { city: null }))).toMatchObject({ status: 409, body: { error: { code: 'version_conflict' } } })
  const current = await profile(owner.id)
  const first = await patch(owner.id, command(current.version, { city: '温州市' }))
  const back = await patch(owner.id, command(first.body.version, { city: current.profile.city }))
  expect(back.body.profile).toEqual(current.profile)
  expect(back.body.version).not.toBe(current.version)
  expect((await patch(owner.id, command(current.version, { district: null }))).status).toBe(409)
})

it('PATCH deduplicates confirmed old names without modifying original alias evidence or dates', async () => {
  const owner = seed(), before = await profile(owner.id)
  const alias = db.insert(schema.enterpriseAlias).values({ enterpriseId: owner.id, name: owner.name, nameNorm: owner.nameNorm, sourceKind: 'announcement', sourceRefId: 42, verificationStatus: 'confirmed', validFrom: '2020', validTo: '2023', note: '原始依据保持' }).returning().get()
  const beforeDetail = (await request(`/api/roster/enterprises/${owner.id}`)).body
  const input = command(before.version, { name: '九六去重现名' }, { previousName: { name: owner.name, sameSubject: true } })
  const first = await patch(owner.id, input)
  expect(first.body.retainedAlias).toEqual({ id: alias.id, name: owner.name, created: false })
  expect((await request(`/api/roster/enterprises/${owner.id}`)).body.aliases).toEqual(beforeDetail.aliases)
  expect(await patch(owner.id, input)).toEqual(first)
  expect(await history(owner.id)).toMatchObject({ total: 1 })
})

it.each([{ label: 'pending', status: 'pending' }, { label: 'withdrawn', status: 'withdrawn' }])('PATCH leaves a $label old-name natural key to alias lifecycle', async ({ status }) => {
  const owner = seed(), before = await profile(owner.id)
  const alias = db.insert(schema.enterpriseAlias).values({ enterpriseId: owner.id, name: owner.name, nameNorm: owner.nameNorm, sourceKind: 'manual', verificationStatus: 'pending' }).returning().get()
  // SQLite fixture models #99's additional status before its reserved migration is merged.
  db.$client.prepare('UPDATE enterprise_alias SET verification_status=? WHERE id=?').run(status, alias.id)
  const originalAliases = (await request(`/api/roster/enterprises/${owner.id}`)).body.aliases
  const result = await patch(owner.id, command(before.version, { name: `九六生命周期新名${++sequence}`, city: null }, { previousName: { name: owner.name, sameSubject: true } }))
  expect(result).toMatchObject({ status: 409, body: { error: { code: 'alias_lifecycle_required' } } })
  expect(await profile(owner.id)).toEqual(before)
  expect(await history(owner.id)).toMatchObject({ total: 0 })
  expect((await request(`/api/roster/enterprises/${owner.id}`)).body.aliases).toEqual(originalAliases)
})

it('PATCH preserves formal rows, source evidence, platform originals and readback by both names', async () => {
  const owner = seed(), before = await profile(owner.id)
  const record = db.insert(schema.record).values({ enterpriseId: owner.id, titleCode: 'specialized_sme', source: 'jxj', nameRaw: owner.name, district: '历史属地' }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'synthetic96.pdf', attachment: '原附件', listNo: 11, page: 3 }).run()
  submitNativePlatformQuery(db, { interface: 'apply_list', queryKey: `name:${owner.nameNorm}`, queriedAt: '2026-10-19', status: 'success', rawResponse: '平台原文96', relations: [{ enterpriseId: owner.id, sequenceNo: 1, nameRaw: owner.name, rawFields: { original: '平台原始行96' } }] })
  const detailBefore = (await request(`/api/roster/enterprises/${owner.id}`)).body
  await request('/api/roster/enterprises?pageSize=25') // Warm an existing reader before commit.
  const input = command(before.version, { name: '九六跨接缝新名', city: '宁波市', district: '鄞州区' }, { previousName: { name: owner.name, sameSubject: true } })
  const updated = await patch(owner.id, input)
  expect(updated.status).toBe(200)
  const detailAfter = (await request(`/api/roster/enterprises/${owner.id}`)).body
  for (const key of ['records', 'events', 'evidence', 'platform', 'recognitions']) expect(detailAfter[key]).toEqual(detailBefore[key])
  expect(detailAfter.differences).toEqual(detailBefore.differences.map((row: any) => ({ ...row, name: '九六跨接缝新名', district: '鄞州区' })))
  expect(detailAfter.enterprise).toMatchObject({ enterpriseId: owner.id, name: '九六跨接缝新名', district: '鄞州区', city: '宁波市' })
  for (const q of [owner.name, '九六跨接缝新名']) {
    const list = await request(`/api/roster/enterprises?q=${encodeURIComponent(q)}`)
    expect(list.body).toMatchObject({ counts: { total: 1 }, rows: [{ enterpriseId: owner.id, name: '九六跨接缝新名', aliasNames: [owner.name] }] })
  }
})

it('PATCH rolls back name, retained alias and audit when the audit store rejects the transaction', async () => {
  const owner = seed(), before = await profile(owner.id)
  const input = command(before.version, { name: '九六事务重试后现名', city: null }, { previousName: { name: owner.name, sameSubject: true } })
  db.$client.exec(`CREATE TRIGGER synthetic96_fail_audit BEFORE INSERT ON enterprise_profile_audit BEGIN SELECT RAISE(ABORT, 'synthetic96 audit storage failure'); END`)
  try {
    expect((await patch(owner.id, input)).status).toBe(500)
    expect(await profile(owner.id)).toEqual(before)
    expect(await history(owner.id)).toMatchObject({ total: 0 })
    expect((await request(`/api/roster/enterprises/${owner.id}`)).body.aliases).toEqual([])
  } finally { db.$client.exec('DROP TRIGGER synthetic96_fail_audit') }
  expect((await patch(owner.id, input)).status).toBe(200)
  expect(await history(owner.id)).toMatchObject({ total: 1 })
})

it('profile history is scoped, bounded, ordered and omits stored request hashes and idempotency keys', async () => {
  const owner = seed(), unrelated = seed()
  for (const id of [owner.id, owner.id, unrelated.id, owner.id]) {
    const before = await profile(id)
    expect((await patch(id, command(before.version, { city: `合成城市${++sequence}` }))).status).toBe(200)
  }
  const all = await history(owner.id), first = await history(owner.id, '?pageSize=2'), second = await history(owner.id, '?pageSize=2&page=2')
  expect(first).toMatchObject({ total: 3, page: 1, pageSize: 2 })
  expect(second).toMatchObject({ total: 3, page: 2, pageSize: 2 })
  expect([...first.rows, ...second.rows]).toEqual(all.rows)
  expect(all.rows.map((r: any) => r.id)).toEqual([...all.rows.map((r: any) => r.id)].sort((a, b) => b - a))
  expect(all.rows.every((r: any) => r.enterpriseId === owner.id && !('requestHash' in r) && !('idempotencyKey' in r))).toBe(true)
  expect(await history(owner.id, '?page=4&pageSize=2')).toMatchObject({ rows: [], total: 3 })
  for (const query of ['?pageSize=101', '?page=0', '?page=1.5', '?page=10001', '?includeRaw=true']) expect((await request(`/api/roster/enterprises/${owner.id}/profile-history${query}`)).status).toBe(400)
})

it('PATCH requires authentication, explicit actor and basis, and a real stable enterprise ID', async () => {
  const owner = seed(), before = await profile(owner.id), input = command(before.version, { city: null })
  expect((await patch(owner.id, input, false)).status).toBe(401)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: '' }))
  try { expect((await patch(owner.id, input)).status).toBe(401) }
  finally { vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic-api-96' })) }
  for (const invalid of [{ ...input, actor: undefined }, { ...input, basis: '' }]) expect((await patch(owner.id, invalid)).status).toBe(400)
  expect((await patch(999999999, input)).status).toBe(404)
  for (const id of ['0', '-1', '1.2', '1e2', '9007199254740993']) expect((await request(`/api/roster/enterprises/${id}/profile`)).status).toBe(400)
  expect(await profile(owner.id)).toEqual(before)
  expect(await history(owner.id)).toMatchObject({ total: 0 })
})

it.each([
  { label: 'identity-uscc', changes: { usccNorm: 'SYNTHETIC' } },
  { label: 'identity-id', changes: { enterpriseId: 123 } },
  { label: 'derived-name', changes: { nameNorm: '不可写' } },
  { label: 'registration-status', changes: { regStatus: '注销' } },
  { label: 'platform-process', changes: { platformStatus: '通过' } },
  { label: 'difference-state', changes: { differenceStatus: 'confirmed_no_diff' } },
  { label: 'derived-roster', changes: { rosterState: 'current' } },
  { label: 'quality-flags', changes: { qualityFlags: [] } },
  { label: 'unknown', changes: { extra: '字段', city: null } },
  { label: 'null-name', changes: { name: null } },
  { label: 'blank-city', changes: { city: '' } },
  { label: 'empty', changes: {} },
  { label: 'overlong-district', changes: { district: '区'.repeat(101) } },
  { label: 'control-character', changes: { city: '宁\u0000波' } },
  { label: 'isolated-surrogate', changes: { name: '名\uD800' } },
])('PATCH rejects $label fields without partial changes', async ({ changes }) => {
  const owner = seed(), before = await profile(owner.id)
  const result = await patch(owner.id, command(before.version, changes))
  expect(result.status).toBe(400)
  expect(result.body.error.code).toBe('invalid_request')
  expect(await profile(owner.id)).toEqual(before)
  expect(await history(owner.id)).toMatchObject({ total: 0 })
})

it('PATCH accepts exact legacy old-name whitespace and preserves the original value in retained evidence', async () => {
  const owner = seed('  九六 legacy 原名称  '), before = await profile(owner.id)
  const result = await patch(owner.id, command(before.version, { name: '  九六修订规范名（新）  ' }, { expectedValues: { name: owner.name }, previousName: { name: owner.name, sameSubject: true } }))
  expect(result.status).toBe(200)
  expect(result.body.profile.name).toBe('九六修订规范名（新）')
  expect((await request(`/api/roster/enterprises/${owner.id}`)).body.aliases).toEqual([expect.objectContaining({ name: owner.name, nameNorm: '九六legacy原名称', validFrom: null, validTo: null, verificationStatus: 'confirmed' })])
})

it('PATCH requires exact same-enterprise confirmation for names and rejects normalized-empty names', async () => {
  const owner = seed(), before = await profile(owner.id)
  for (const previousName of [undefined, { name: '错误旧名', sameSubject: true }]) {
    expect(await patch(owner.id, command(before.version, { name: '九六未经确认现名', city: null }, { previousName }))).toMatchObject({ status: 422, body: { error: { code: 'previous_name_confirmation_required' } } })
  }
  expect((await patch(owner.id, command(before.version, { name: '（）' }, { previousName: { name: owner.name, sameSubject: true } }))).status).toBe(422)
  expect((await patch(owner.id, command(before.version, { city: null }, { previousName: { name: owner.name, sameSubject: true } }))).status).toBe(422)
  expect(await profile(owner.id)).toEqual(before)
  expect(await history(owner.id)).toMatchObject({ total: 0 })
})

it('profile audit preserves its historical enterprise ID after dedicated identity removal', async () => {
  const owner = seed(), before = await profile(owner.id)
  const input = command(before.version, { city: null }), first = await patch(owner.id, input)
  expect(first.status).toBe(200)
  // Model the dedicated merge's final source removal, outside ordinary PATCH.
  db.$client.prepare('DELETE FROM enterprise WHERE id=?').run(owner.id)
  expect((await request(`/api/roster/enterprises/${owner.id}/profile`)).status).toBe(404)
  expect(await history(owner.id)).toMatchObject({ total: 1, rows: [{ enterpriseId: owner.id, before: before.profile, after: first.body.profile }] })
  expect(await patch(owner.id, input)).toEqual(first)
})

it('profile history rejects an oversized encoded page and lets callers request a smaller complete page', async () => {
  const owner = seed('名'.repeat(300))
  let current = await profile(owner.id)
  for (let i = 0; i < 30; i++) {
    const result = await patch(owner.id, command(current.version, { city: '城'.repeat(100), district: '区'.repeat(100) }, { actor: { type: 'agent', id: '人'.repeat(200) }, basis: '据'.repeat(2000) }))
    expect(result.status).toBe(200)
    current = { profile: result.body.profile, version: result.body.version }
  }
  const tooLarge = await request(`/api/roster/enterprises/${owner.id}/profile-history?pageSize=100`)
  expect(tooLarge).toMatchObject({ status: 413, body: { error: { code: 'response_too_large' } } })
  const smaller = await request(`/api/roster/enterprises/${owner.id}/profile-history?pageSize=10`)
  expect(smaller.status).toBe(200)
  expect(smaller.body.rows).toHaveLength(10)
  expect(smaller.body.total).toBe(30)
  expect(Buffer.byteLength(JSON.stringify(smaller.body))).toBeLessThanOrEqual(256 * 1024)
})

it('profile and history reads stay scoped as unrelated malformed archives and audit rows grow', async () => {
  const owner = seed(), before = await profile(owner.id)
  const changed = await patch(owner.id, command(before.version, { district: null }))
  const expectedProfile = { profile: changed.body.profile, version: changed.body.version }, expectedHistory = await history(owner.id, '?pageSize=1')
  const durations: number[][] = [[], []]
  const sample = async (index: number) => {
    for (let i = 0; i < 5; i++) {
      const start = performance.now()
      expect(await profile(owner.id)).toEqual(expectedProfile)
      expect(await history(owner.id, '?pageSize=1')).toEqual(expectedHistory)
      durations[index]!.push(performance.now() - start)
    }
  }
  await sample(0)
  db.$client.transaction(() => {
    const enterprise = db.$client.prepare('INSERT INTO enterprise(name,name_norm,quality_flags) VALUES(?,?,?)')
    const audit = db.$client.prepare('INSERT INTO enterprise_profile_audit(enterprise_id,idempotency_key,request_hash,before_version,after_version,"before","after",actor,basis,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    for (let i = 0; i < 1000; i++) {
      const id = Number(enterprise.run(`无关合成96-${i}`, `无关合成96-${i}`, '{malformed unrelated flags').lastInsertRowid)
      audit.run(id, `unrelated96-${i}`, 'x', 'x', 'x', '{malformed unrelated profile', '{malformed unrelated profile', '{malformed actor', 'x'.repeat(4096), '2026-10-19')
      if (i < 50) submitNativePlatformQuery(db, { interface: 'apply_list', queryKey: `unrelated96-${i}`, queriedAt: '2026-10-19', status: 'failed', rawResponse: 'r'.repeat(64 * 1024) })
    }
  })()
  await sample(1)
  expect(Buffer.byteLength(JSON.stringify(expectedHistory))).toBeLessThan(4096)
  // Supplementary real SQLite plan evidence for the exact read/receipt access paths.
  const plan = (query: string, ...params: unknown[]) => db.$client.prepare('EXPLAIN QUERY PLAN ' + query).all(...params).map((row: any) => row.detail).join('\n')
  expect(plan('SELECT id FROM enterprise_profile_audit WHERE enterprise_id=? ORDER BY id DESC LIMIT 1', owner.id)).toContain('enterprise_profile_audit_enterprise_idx')
  expect(plan('SELECT id FROM enterprise_profile_audit WHERE idempotency_key=?', 'unrelated96-1')).toContain('enterprise_profile_audit_key_uq')
  const measurement = { ticket: 96, sourceHead: process.env.PROFILE96_SOURCE_SHA ?? 'unrecorded', samplesPerDistribution: 5, distribution: { unrelatedEnterprises: 1000, unrelatedAudits: 1000, unrelatedRawQueries: 50, rawQueryBytes: 65536 }, combinedProfileHistoryHttpMs: durations, limitation: 'small synthetic boundedness observation; no capacity or tail SLO claim' }
  if (process.env.PROFILE96_MEASUREMENTS) writeFileSync(process.env.PROFILE96_MEASUREMENTS, JSON.stringify(measurement, null, 2))
})
