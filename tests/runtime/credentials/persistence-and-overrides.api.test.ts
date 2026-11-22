import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { readPostgresCredentialState, updatePostgresCredentialState } from '../../../layers/core/server/utils/credential-state-postgres'
import type { CredentialReadContext } from '../../../layers/core/server/utils/credential-resolution'
import { handleCredentialsRequest as handle } from '../../../layers/core/server/utils/credentials-http'
import { startHttpFixture, type HttpFixture } from '../../support/http'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

const handleCredentialsRequest = (
  action: Parameters<typeof handle>[0], request: Parameters<typeof handle>[1],
  ctx: CredentialReadContext & { db: NodePgDatabase }, revealKey?: string,
) => handle(action, request, ctx, {
  read: () => readPostgresCredentialState(ctx.db),
  update: values => updatePostgresCredentialState(ctx.db, values),
}, revealKey)

const dir = mkdtempSync(join(tmpdir(), 'credential-api-'))
let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>>
let db: ReturnType<typeof connect>
let server: HttpFixture
const connections = new Set<pg.Pool>()

beforeAll(async () => { runtime = await postgresRuntimeFixture({ dir }) }, 20_000)
afterEach(async () => {
  await server?.close()
  await Promise.all([...connections].map(pool => pool.end()))
  connections.clear()
})
afterAll(() => {
  try { runtime?.close() } finally { rmSync(dir, { recursive: true, force: true }) }
})

function connect(readOnly = false) {
  const pool = new pg.Pool({
    connectionString: runtime.url,
    options: readOnly ? '-c default_transaction_read_only=on' : undefined,
  })
  connections.add(pool)
  return drizzle(pool)
}
async function disconnect(connection: ReturnType<typeof connect>) {
  connections.delete(connection.$client)
  await connection.$client.end()
}
async function serve() {
  server = await startHttpFixture({ routes: {
    '/api/settings/credentials': request => handleCredentialsRequest('state', request, { db, env: {} }),
    '/api/settings/credentials/core.ocrToken/reveal': request => handleCredentialsRequest('reveal', request, { db, env: {} }, 'core.ocrToken'),
    '/api/settings/credentials/sme-roster.miitCookie/reveal': request => handleCredentialsRequest('reveal', request, { db, env: {} }, 'sme-roster.miitCookie'),
  } })
}
async function start() {
  runtime.psql(['-c', 'DROP TRIGGER IF EXISTS reject_cookie ON business.service_credential; TRUNCATE business.service_credential'])
  db = connect()
  await serve()
}
async function request(method = 'GET', body?: unknown, suffix = '') {
  return fetch(server.baseUrl + '/api/settings/credentials' + suffix, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined || method === 'GET' ? {} : { body: JSON.stringify(body) }) })
}
it('reads, saves, reveals and clears both credentials without a management token', async () => {
  await start()
  const initial = await request()
  expect(initial.status).toBe(200)
  expect(initial.headers.get('cache-control')).toBe('no-store')
  for (const key of ['core.ocrToken', 'sme-roster.miitCookie']) {
    const value = key === 'core.ocrToken' ? 'synthetic-ocr-first' : 'session=synthetic-cookie-first'
    const saved = await request('PATCH', { [key]: value })
    expect(saved.status).toBe(200)
    expect(JSON.stringify(await saved.json()).includes(value)).toBe(false)
    const raw = await request('POST', {}, `/${key}/reveal`)
    expect(raw.status).toBe(200)
    expect(raw.headers.get('cache-control')).toBe('no-store')
    expect((await raw.json()).value).toBe(value)
    expect((await request('DELETE', { key })).status).toBe(200)
    expect((await (await request()).json())[key].configured).toBe(false)
  }
})
it('accepts only registered namespaced keys at the settings HTTP boundary', async () => {
  await start()
  const key = 'core.ocrToken'
  expect((await request('PATCH', { [key]: 'synthetic-allowed' })).status).toBe(200)
  expect((await request('GET')).headers.get('cache-control')).toBe('no-store')
  expect(await (await request()).json()).toMatchObject({
    [key]: { configured: true, source: 'saved' },
    'sme-roster.miitCookie': { configured: false, source: 'none' },
  })
  expect((await request('PATCH', { [key]: 'synthetic-not-written', 'core.unregistered': 'synthetic-unknown' })).status).toBe(400)
  expect((await request('DELETE', { key: 'core.unregistered' })).status).toBe(400)
  expect((await request('POST', {}, '/core.unregistered/reveal')).status).toBe(404)
  expect((await (await request('POST', {}, `/${key}/reveal`)).json()).value).toBe('synthetic-allowed')
})
it('persists both credentials across database connection and HTTP server restart', async () => {
  await start()
  await request('PATCH', { 'core.ocrToken': 'synthetic-persisted-ocr', 'sme-roster.miitCookie': 'session=synthetic-persisted-cookie' })
  await server.close()
  await disconnect(db)
  db = connect()
  await serve()
  const state = await (await request()).json()
  expect(state).toMatchObject({ 'core.ocrToken': { source: 'saved', hasSaved: true, masked: 'syn********ocr' }, 'sme-roster.miitCookie': { source: 'saved', hasSaved: true, masked: 'ses********kie' } })
  expect((await (await request('POST', {}, '/core.ocrToken/reveal')).json()).value).toBe('synthetic-persisted-ocr')
  expect((await (await request('POST', {}, '/sme-roster.miitCookie/reveal')).json()).value).toBe('session=synthetic-persisted-cookie')
})
it('keeps independent updates across separate database connections and concurrent HTTP requests', async () => {
  await start()
  const second = connect()
  const other = await startHttpFixture({ routes: { '/api/settings/credentials': req => handleCredentialsRequest('state', req, { db: second, env: {} }) } })
  try {
    const responses = await Promise.all([request('PATCH', { 'core.ocrToken': 'synthetic-ocr-kept' }), fetch(other.baseUrl + '/api/settings/credentials', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'sme-roster.miitCookie': 'session=synthetic-cookie' }) })])
    expect(responses.map(r => r.status)).toEqual([200, 200])
    expect(await (await request()).json()).toMatchObject({ 'core.ocrToken': { masked: 'syn********ept' }, 'sme-roster.miitCookie': { masked: 'ses********kie' } })
    await request('DELETE', { key: 'sme-roster.miitCookie' })
    expect((await (await request()).json())['core.ocrToken'].masked).toBe('syn********ept')
  } finally { await other.close() }
})
it('rolls back the entire mixed update on a database failure and retries after recovery', async () => {
  await start()
  await request('PATCH', { 'core.ocrToken': 'synthetic-kept-ocr', 'sme-roster.miitCookie': 'session=synthetic-kept-cookie' })
  await db.$client.query(`
    CREATE OR REPLACE FUNCTION business.reject_cookie() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'synthetic-sensitive-sql';
    END
    $$;
    CREATE TRIGGER reject_cookie BEFORE INSERT OR UPDATE ON business.service_credential
    FOR EACH ROW WHEN (NEW.key = 'sme-roster.miitCookie') EXECUTE FUNCTION business.reject_cookie();
  `)
  const failed = await request('PATCH', { 'core.ocrToken': 'synthetic-never-written', 'sme-roster.miitCookie': 'session=synthetic-never-written' })
  expect(failed.status).toBe(503)
  expect(failed.headers.get('cache-control')).toBe('no-store')
  expect(JSON.stringify(await failed.json())).not.toMatch(/synthetic|service_credential|SQL|INSERT/)
  expect((await (await request('POST', {}, '/core.ocrToken/reveal')).json()).value).toBe('synthetic-kept-ocr')
  expect((await (await request('POST', {}, '/sme-roster.miitCookie/reveal')).json()).value).toBe('session=synthetic-kept-cookie')
  await db.$client.query('DROP TRIGGER reject_cookie ON business.service_credential')
  expect((await request('PATCH', { 'core.ocrToken': 'synthetic-retried', 'sme-roster.miitCookie': 'session=synthetic-retried' })).status).toBe(200)
})
it('rejects writes on a read-only database while preserving saved values', async () => {
  await start()
  await request('PATCH', { 'core.ocrToken': 'synthetic-kept' })
  const readonly = connect(true)
  for (const [method, body] of [['PATCH', { 'core.ocrToken': 'synthetic-rejected' }], ['DELETE', { key: 'core.ocrToken' }]] as const) {
    const response = await handleCredentialsRequest('state', { method, body, headers: {} }, { db: readonly, env: {} })
    expect(response.status).toBe(503)
    expect(JSON.stringify(response)).not.toContain('synthetic')
  }
  expect((await (await request('POST', {}, '/core.ocrToken/reveal')).json()).value).toBe('synthetic-kept')
})
it('fails closed when the database is unavailable instead of falling back or exposing SQL errors', async () => {
  await start()
  await disconnect(db)
  for (const action of ['state', 'reveal'] as const) {
    const response = await handleCredentialsRequest(action, { method: action === 'state' ? 'GET' : 'POST', headers: {}, body: null }, { db, env: { NUXT_OCR_TOKEN: 'synthetic-fallback' } }, 'core.ocrToken')
    expect(response.status).toBe(503)
    expect(JSON.stringify(response)).not.toMatch(/synthetic|closed|Pool|service_credential/)
  }
})
it('clears only database overrides and restores deployment fallback without changing the environment', async () => {
  await start()
  const env = { NUXT_OCR_TOKEN: 'synthetic-env-ocr', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: 'synthetic-second', MIIT_COOKIE: 'session=synthetic-env-cookie' }
  const ctx = { db, env }
  await request('PATCH', { 'core.ocrToken': 'synthetic-saved', 'sme-roster.miitCookie': 'session=synthetic-saved' })
  for (const key of ['core.ocrToken', 'sme-roster.miitCookie']) {
    const response = await handleCredentialsRequest('state', { method: 'DELETE', body: { key }, headers: {} }, ctx)
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ [key]: { source: key === 'core.ocrToken' ? 'NUXT_OCR_TOKEN' : 'MIIT_COOKIE', hasSaved: false } })
  }
  expect(env).toEqual({ NUXT_OCR_TOKEN: 'synthetic-env-ocr', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: 'synthetic-second', MIIT_COOKIE: 'session=synthetic-env-cookie' })
})
it('rejects invalid payloads and omitted fields leave the saved credential unchanged', async () => {
  await start()
  await request('PATCH', { 'core.ocrToken': 'synthetic-kept' })
  for (const body of [null, [], 2, { path: '/tmp/wrong' }, { 'core.ocrToken': ' ' }, { 'core.ocrToken': null }, { 'sme-roster.miitCookie': '\r\nsession=bad', 'core.ocrToken': 'synthetic-not-written' }]) expect((await request('PATCH', body)).status).toBe(400)
  expect((await request('PATCH', {})).status).toBe(200)
  expect((await (await request('POST', {}, '/core.ocrToken/reveal')).json()).value).toBe('synthetic-kept')
  expect((await request('DELETE', {})).status).toBe(400)
})
it('configuration writes change only credential rows and never business or task tables', async () => {
  await start()
  await db.$client.query("INSERT INTO business.enterprise (name, name_norm) VALUES ('Synthetic enterprise', 'synthetic enterprise')")
  const snapshot = async () => {
    const { rows: tables } = await db.$client.query<{ tablename: string }>(`SELECT tablename FROM pg_tables
      WHERE schemaname = 'business' AND tablename <> 'service_credential' ORDER BY tablename`)
    return Promise.all(tables.map(async ({ tablename }) => ({
      tablename,
      rows: (await db.$client.query(`SELECT to_jsonb(t) AS row FROM business."${tablename.replaceAll('"', '""')}" AS t ORDER BY 1`)).rows,
    })))
  }
  const before = await snapshot()
  await request('PATCH', { 'core.ocrToken': 'synthetic-db-only', 'sme-roster.miitCookie': 'session=synthetic-db-only' })
  await request('POST', {}, '/core.ocrToken/reveal')
  expect(Object.keys(await readPostgresCredentialState(db))).toHaveLength(2)
  expect(await snapshot()).toEqual(before)
})
it.each([
  { label: 'one character', value: 'x', masked: '********' },
  { label: 'eight characters', value: '12345678', masked: '********' },
  { label: 'nine characters', value: '123456789', masked: '123********789' },
])('masks OCR and Cookie length boundaries ($label)', async ({ value, masked }) => {
  await start()
  const response = await request('PATCH', { 'core.ocrToken': value, 'sme-roster.miitCookie': value })
  expect(await response.json()).toMatchObject({ 'core.ocrToken': { masked }, 'sme-roster.miitCookie': { masked } })
})
