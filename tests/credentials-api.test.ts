import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { schema, useDb } from '../db'
import { handleCredentialsRequest } from '../server/utils/credentials-http'
import { startHttpFixture, type HttpFixture } from './helpers/http-fixture'
let dir: string
let db: ReturnType<typeof useDb>
let server: HttpFixture
const connections: Database.Database[] = []
afterEach(async () => {
  await server?.close()
  for (const connection of connections.splice(0)) if (connection.open) connection.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})
function connect() {
  const connection = new Database(join(dir, 'roster.sqlite'))
  connections.push(connection)
  return drizzle(connection, { schema })
}
async function serve() {
  server = await startHttpFixture({ routes: {
    '/api/settings/credentials': request => handleCredentialsRequest('state', request, { db, env: {} }),
    '/api/settings/credentials/ocrToken/reveal': request => handleCredentialsRequest('reveal', request, { db, env: {} }),
    '/api/settings/credentials/miitCookie/reveal': request => handleCredentialsRequest('reveal', request, { db, env: {} }, 'miitCookie'),
  } })
}
async function start() {
  dir = mkdtempSync(join(tmpdir(), 'credential-api-'))
  db = useDb({ dbPath: join(dir, 'roster.sqlite') })
  connections.push(db.$client)
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
  for (const key of ['ocrToken', 'miitCookie']) {
    const value = key === 'ocrToken' ? 'synthetic-ocr-first' : 'session=synthetic-cookie-first'
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
it('persists both credentials across database connection and HTTP server restart', async () => {
  await start()
  await request('PATCH', { ocrToken: 'synthetic-persisted-ocr', miitCookie: 'session=synthetic-persisted-cookie' })
  await server.close(); db.$client.close()
  db = connect(); await serve()
  const state = await (await request()).json()
  expect(state).toMatchObject({ ocrToken: { source: 'saved', hasSaved: true, masked: 'syn********ocr' }, miitCookie: { source: 'saved', hasSaved: true, masked: 'ses********kie' } })
  expect((await (await request('POST', {}, '/ocrToken/reveal')).json()).value).toBe('synthetic-persisted-ocr')
  expect((await (await request('POST', {}, '/miitCookie/reveal')).json()).value).toBe('session=synthetic-persisted-cookie')
})
it('keeps independent updates across separate database connections and concurrent HTTP requests', async () => {
  await start()
  const second = connect()
  const other = await startHttpFixture({ routes: { '/api/settings/credentials': req => handleCredentialsRequest('state', req, { db: second, env: {} }) } })
  try {
    const responses = await Promise.all([request('PATCH', { ocrToken: 'synthetic-ocr-kept' }), fetch(other.baseUrl + '/api/settings/credentials', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ miitCookie: 'session=synthetic-cookie' }) })])
    expect(responses.map(r => r.status)).toEqual([200, 200])
    expect(await (await request()).json()).toMatchObject({ ocrToken: { masked: 'syn********ept' }, miitCookie: { masked: 'ses********kie' } })
    await request('DELETE', { key: 'miitCookie' })
    expect((await (await request()).json()).ocrToken.masked).toBe('syn********ept')
  } finally { await other.close() }
})
it('rolls back the entire mixed update on a database failure and retries after recovery', async () => {
  await start()
  await request('PATCH', { ocrToken: 'synthetic-kept-ocr', miitCookie: 'session=synthetic-kept-cookie' })
  db.$client.exec("CREATE TRIGGER reject_cookie BEFORE INSERT ON service_credential WHEN NEW.key = 'miitCookie' BEGIN SELECT RAISE(ABORT, 'synthetic-sensitive-sql'); END")
  const failed = await request('PATCH', { ocrToken: 'synthetic-never-written', miitCookie: 'session=synthetic-never-written' })
  expect(failed.status).toBe(503)
  expect(failed.headers.get('cache-control')).toBe('no-store')
  expect(JSON.stringify(await failed.json())).not.toMatch(/synthetic|service_credential|SQL|INSERT/)
  expect((await (await request('POST', {}, '/ocrToken/reveal')).json()).value).toBe('synthetic-kept-ocr')
  expect((await (await request('POST', {}, '/miitCookie/reveal')).json()).value).toBe('session=synthetic-kept-cookie')
  db.$client.exec('DROP TRIGGER reject_cookie')
  expect((await request('PATCH', { ocrToken: 'synthetic-retried', miitCookie: 'session=synthetic-retried' })).status).toBe(200)
})
it('rejects writes on a read-only database while preserving saved values', async () => {
  await start()
  await request('PATCH', { ocrToken: 'synthetic-kept' })
  const readonly = useDb({ dbPath: join(dir, 'roster.sqlite'), readOnly: true }); connections.push(readonly.$client)
  for (const [method, body] of [['PATCH', { ocrToken: 'synthetic-rejected' }], ['DELETE', { key: 'ocrToken' }]] as const) {
    const response = handleCredentialsRequest('state', { method, body, headers: {} }, { db: readonly, env: {} })
    expect(response.status).toBe(503)
    expect(JSON.stringify(response)).not.toContain('synthetic')
  }
  expect((await (await request('POST', {}, '/ocrToken/reveal')).json()).value).toBe('synthetic-kept')
})
it('fails closed when the database is unavailable instead of falling back or exposing SQL errors', async () => {
  await start()
  db.$client.close()
  for (const action of ['state', 'reveal'] as const) {
    const response = handleCredentialsRequest(action, { method: action === 'state' ? 'GET' : 'POST', headers: {}, body: null }, { db, env: { NUXT_OCR_TOKEN: 'synthetic-fallback' } })
    expect(response.status).toBe(503)
    expect(JSON.stringify(response)).not.toMatch(/synthetic|closed|sqlite|roster.sqlite/)
  }
})
it('clears only database overrides and restores deployment fallback without changing the environment', async () => {
  await start()
  const env = { NUXT_OCR_TOKEN: 'synthetic-env-ocr', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: 'synthetic-second', MIIT_COOKIE: 'session=synthetic-env-cookie' }
  const ctx = { db, env }
  await request('PATCH', { ocrToken: 'synthetic-saved', miitCookie: 'session=synthetic-saved' })
  for (const key of ['ocrToken', 'miitCookie']) {
    const response = handleCredentialsRequest('state', { method: 'DELETE', body: { key }, headers: {} }, ctx)
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ [key]: { source: key === 'ocrToken' ? 'NUXT_OCR_TOKEN' : 'MIIT_COOKIE', hasSaved: false } })
  }
  expect(env).toEqual({ NUXT_OCR_TOKEN: 'synthetic-env-ocr', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: 'synthetic-second', MIIT_COOKIE: 'session=synthetic-env-cookie' })
})
it('rejects invalid payloads and omitted fields leave the saved credential unchanged', async () => {
  await start()
  await request('PATCH', { ocrToken: 'synthetic-kept' })
  for (const body of [null, [], 2, { path: '/tmp/wrong' }, { ocrToken: ' ' }, { ocrToken: null }, { miitCookie: '\r\nsession=bad', ocrToken: 'synthetic-not-written' }]) expect((await request('PATCH', body)).status).toBe(400)
  expect((await request('PATCH', {})).status).toBe(200)
  expect((await (await request('POST', {}, '/ocrToken/reveal')).json()).value).toBe('synthetic-kept')
  expect((await request('DELETE', {})).status).toBe(400)
})
it('configuration writes change only credential rows and never business or task tables', async () => {
  await start()
  db.insert(schema.enterprise).values({ name: 'Synthetic enterprise', nameNorm: 'synthetic enterprise' }).run()
  const snapshot = () => {
    const tables = db.$client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'service_credential' ORDER BY name").all() as { name: string }[]
    return tables.map(({ name }) => ({ name, rows: db.$client.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all() }))
  }
  const before = snapshot()
  await request('PATCH', { ocrToken: 'synthetic-db-only', miitCookie: 'session=synthetic-db-only' })
  await request('POST', {}, '/ocrToken/reveal')
  expect(db.select().from(schema.serviceCredential).all()).toHaveLength(2)
  expect(snapshot()).toEqual(before)
})
it.each([
  { label: 'one character', value: 'x', masked: '********' },
  { label: 'eight characters', value: '12345678', masked: '********' },
  { label: 'nine characters', value: '123456789', masked: '123********789' },
])('masks OCR and Cookie length boundaries ($label)', async ({ value, masked }) => {
  await start()
  const response = await request('PATCH', { ocrToken: value, miitCookie: value })
  expect(await response.json()).toMatchObject({ ocrToken: { masked }, miitCookie: { masked } })
})
