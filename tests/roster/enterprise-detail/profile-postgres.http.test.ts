import { createApp, createRouter, defineEventHandler, getQuery, getRouterParam, readBody, setHeader, toWebHandler } from 'h3'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'

const url = process.env.TEST_PROFILE_POSTGRES_URL
let request: ReturnType<typeof toWebHandler>
let client: pg.Client
let id: number
const previous = '验收企业旧名'

beforeAll(async () => {
  if (!url) return
  client = new pg.Client({ connectionString: url })
  await client.connect()
  const seeded = await client.query("INSERT INTO business.enterprise (name,name_norm,city,district) VALUES ($1,$1,'宁波市','海曙区') RETURNING id", [previous])
  id = Number(seeded.rows[0].id)
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  for (const [key, builtin] of Object.entries({ defineEventHandler, getQuery, getRouterParam, readBody, setHeader })) vi.stubGlobal(key, builtin)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'pg-profile-fixture' }))
  vi.doMock('@db', () => ({ useDb: () => { throw new Error('Unexpected SQLite access in PostgreSQL mode') } }))
  const router = createRouter()
    .get('/api/roster/enterprises/:id/profile', (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id]/profile.get')).default)
    .get('/api/roster/enterprises/:id/profile-history', (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id]/profile-history.get')).default)
    .patch('/api/roster/enterprises/:id', (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id].patch')).default)
    .get('/api/roster/enterprises/:id/aliases', (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id]/aliases/index.get')).default)
    .get('/api/roster/enterprises/:id/aliases/:aliasId', (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id]/aliases/[aliasId].get')).default)
    .get('/api/roster/enterprises/:id/aliases/:aliasId/history', (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id]/aliases/[aliasId]/history.get')).default)
    .patch('/api/roster/enterprises/:id/aliases/:aliasId', (await import('../../../layers/sme-roster/server/api/roster/enterprises/[id]/aliases/[aliasId].patch')).default)
  request = toWebHandler(createApp().use(router))
})
afterAll(async () => {
  await closePostgresDirectoryDb()
  await client?.end()
  vi.doUnmock('@db')
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function call(path: string, body?: object) {
  const response = await request(new Request('http://localhost/api/roster/enterprises/' + id + path, {
    method: body === undefined ? 'GET' : 'PATCH',
    headers: { authorization: 'Bearer pg-profile-fixture', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  return { status: response.status, value: await response.json() }
}

it.skipIf(!url)('serializes version checks and preserves profile receipts and confirmed names in PostgreSQL', async () => {
  const before = await call('/profile')
  expect(before).toMatchObject({ status: 200, value: { profile: { enterpriseId: id, name: previous, city: '宁波市', district: '海曙区' } } })
  const input = { expectedVersion: before.value.version, changes: { name: '验收企业新名', city: null },
    previousName: { name: previous, sameSubject: true }, idempotencyKey: 'profile-native-rename',
    actor: { type: 'agent', id: 'fixture' }, basis: '核对前后名称' }
  const noConfirmation = await call('', { ...input, previousName: undefined })
  expect(noConfirmation).toMatchObject({ status: 422, value: { error: { code: 'previous_name_confirmation_required' } } })
  const responses = await Promise.all([call('', input), call('', input)])
  const renamed = responses[0]!
  expect(responses[1]).toEqual(renamed)
  expect(renamed).toMatchObject({ status: 200, value: {
    profile: { enterpriseId: id, name: '验收企业新名', city: null }, retainedAlias: { name: previous, created: true },
  } })
  const attempts = await Promise.all(['江北区', '鄞州区'].map((district, index) => call('', {
    expectedVersion: renamed.value.version, idempotencyKey: 'profile-native-competitor-' + index,
    changes: { district }, actor: input.actor, basis: input.basis,
  })))
  expect(attempts.map(result => result.status).sort()).toEqual([200, 409])
  expect(await call('', input)).toEqual(renamed)
  const history = await call('/profile-history?page=2&pageSize=1')
  expect(history).toMatchObject({ status: 200, value: { page: 2, total: 2, rows: [{
    before: before.value.profile, after: renamed.value.profile, actor: input.actor, aliasCreated: true,
  }] } })
  expect(history.value.rows[0]).not.toHaveProperty('requestHash')
})

it.skipIf(!url)('reads and revises a stable alias with replayable history in PostgreSQL', async () => {
  const original = '验收录入的别名'
  const { rows } = await client.query(`
    INSERT INTO business.enterprise_alias (enterprise_id,name,name_norm,source_kind,created_at)
    VALUES ($1,$2,$2,'manual','2026-01-01T00:00:00Z') RETURNING id`, [id, original])
  const aliasId = Number(rows[0].id)
  const path = '/aliases/' + aliasId
  const pending = await call('/aliases?status=pending')
  expect(pending).toMatchObject({ status: 200, value: { total: 1, rows: [{ id: aliasId, originalName: original }] } })
  const request = { action: 'confirm', expectedVersion: 1, idempotencyKey: 'alias-native-confirm', actor: 'fixture', basis: '核对同一主体' }
  const confirmed = await call(path, request)
  expect(confirmed).toMatchObject({ status: 200, value: { replayed: false, alias: { id: aliasId, name: original, verificationStatus: 'confirmed', version: 2 } } })
  expect(await call(path, request)).toEqual({ ...confirmed, value: { ...confirmed.value, replayed: true } })
  const invalid = await call(path, { ...request, action: 'correct', expectedVersion: 2,
    idempotencyKey: 'alias-native-invalid', changes: { sourceRefId: 100, sourceKind: 'platform_apply' } })
  expect(invalid).toMatchObject({ status: 400, value: { data: { code: 'alias_source_evidence_required' } } })
  expect(await call(path)).toEqual({ status: 200, value: confirmed.value.alias })
  const withdrawn = await call(path, { ...request, action: 'withdraw', expectedVersion: 2, idempotencyKey: 'alias-native-withdraw' })
  expect(withdrawn).toMatchObject({ status: 200, value: { alias: { id: aliasId, originalName: original, verificationStatus: 'withdrawn', version: 3 } } })
  expect(await call(path + '/history?page=2&pageSize=1')).toMatchObject({ status: 200, value: { total: 2, rows: [{
    before: { verificationStatus: 'confirmed', version: 2 }, after: { verificationStatus: 'withdrawn', version: 3 },
  }] } })
})
