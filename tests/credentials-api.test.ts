import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { handleCredentialsRequest } from '../server/utils/credentials-http'
import { startHttpFixture, type HttpFixture } from './helpers/http-fixture'
let dir: string
let server: HttpFixture
const admin = 'synthetic-admin-only'
afterEach(async () => { await server?.close(); if (dir) rmSync(dir, { recursive: true, force: true }) })
async function start(apiToken = admin) {
  dir = mkdtempSync(join(tmpdir(), 'credential-api-'))
  server = await startHttpFixture({ routes: {
    '/api/settings/credentials': request => handleCredentialsRequest('state', request, { apiToken, stateDir: dir, env: {} }),
    '/api/settings/credentials/ocrToken/reveal': request => handleCredentialsRequest('reveal', request, { apiToken, stateDir: dir, env: {} }),
    '/api/settings/credentials/miitCookie/reveal': request => handleCredentialsRequest('reveal', request, { apiToken, stateDir: dir, env: {} }, 'miitCookie'),
  } })
}
async function request(method = 'GET', body?: unknown, authorized = true, suffix = '') {
  return fetch(server.baseUrl + '/api/settings/credentials' + suffix, { method, headers: { ...(authorized ? { authorization: `Bearer ${admin}` } : {}), 'content-type': 'application/json' }, ...(body === undefined || method === 'GET' ? {} : { body: JSON.stringify(body) }) })
}
it('requires management authorization for state, reveal and all mutations and fails closed without configured admin', async () => {
  await start('')
  for (const [method, suffix] of [['GET', ''], ['PATCH', ''], ['DELETE', ''], ['POST', '/ocrToken/reveal']]) {
    const response = await request(method!, { ocrToken: 'synthetic-secret' }, true, suffix)
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('no-store')
  }
})
it('saves a masked state and returns plaintext only on explicit authorized reveal', async () => {
  await start()
  expect((await request('GET', undefined, false)).status).toBe(401)
  const initial = await (await request()).json()
  expect(initial.ocrToken).toMatchObject({ configured: false, source: 'none', masked: '', hasSaved: false })
  const saved = await request('PATCH', { ocrToken: 'synthetic-ocr-first' })
  expect(saved.status).toBe(200)
  const state = await saved.json()
  expect(state.ocrToken).toMatchObject({ configured: true, source: 'saved', masked: 'syn********rst', hasSaved: true })
  expect(JSON.stringify(state).includes('synthetic-ocr-first')).toBe(false)
  expect((await request('POST', {}, false, '/ocrToken/reveal')).status).toBe(401)
  const raw = await request('POST', {}, true, '/ocrToken/reveal')
  expect(raw.headers.get('cache-control')).toBe('no-store')
  expect((await raw.json()).value === 'synthetic-ocr-first').toBe(true)
})
it('rejects whitespace and unknown fields without replacing the saved value; omitted field is unchanged', async () => {
  await start()
  await request('PATCH', { ocrToken: 'synthetic-kept' })
  for (const body of [{ ocrToken: '  ' }, { ocrToken: null }, { path: '/tmp/wrong' }]) expect((await request('PATCH', body)).status).toBe(400)
  expect((await request('PATCH', {})).status).toBe(200)
  expect((await (await request('POST', {}, true, '/ocrToken/reveal')).json()).value === 'synthetic-kept').toBe(true)
})
it('masks short values completely and requires an explicit deletion key', async () => {
  await start()
  const response = await request('PATCH', { ocrToken: 'abc' })
  expect((await response.json()).ocrToken.masked).toBe('********')
  expect((await request('DELETE', {})).status).toBe(400)
  expect((await request('DELETE', { key: 'ocrToken' })).status).toBe(200)
  expect((await (await request()).json()).ocrToken.configured).toBe(false)
})
it('persists across server restart and concurrent independent requests, preserves old file on storage failure', async () => {
  await start()
  await Promise.all([request('PATCH', { ocrToken: 'synthetic-A' }), request('PATCH', {})])
  await server.close()
  server = await startHttpFixture({ routes: { '/api/settings/credentials': req => handleCredentialsRequest('state', req, { apiToken: admin, stateDir: dir, env: {} }) } })
  expect((await (await request()).json()).ocrToken.masked).toBe('syn********c-A')
  const { readFileSync, mkdirSync, statSync, readdirSync } = await import('node:fs')
  const file = join(dir, 'credentials.json')
  expect(statSync(file).mode & 0o777).toBe(0o600)
  const before = readFileSync(file, 'utf8')
  // A read-only filesystem is not reliable under root; a directory at the destination
  // deterministically exercises atomic replacement failure, keeping its contents intact.
  const failureDir = join(dir, 'failure')
  mkdirSync(join(failureDir, 'credentials.json'), { recursive: true })
  const failed = handleCredentialsRequest('state', { method: 'PATCH', headers: { authorization: `Bearer ${admin}` }, body: { ocrToken: 'synthetic-never-stored' } }, { apiToken: admin, stateDir: failureDir, env: {} })
  expect(failed.status).toBe(503)
  expect(JSON.stringify(failed).includes('synthetic-never-stored')).toBe(false)
  expect(readFileSync(file, 'utf8') === before).toBe(true)
  expect(readdirSync(dir).filter(x => x.endsWith('.tmp'))).toEqual([])
})
it('clear removes only the saved override and reveals deployment fallback without modifying environment', async () => {
  await start()
  const context = { apiToken: admin, stateDir: dir, env: { NUXT_OCR_TOKEN: 'synthetic-env-fallback', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: 'synthetic-second' } }
  await request('PATCH', { ocrToken: 'synthetic-saved' })
  const call = (method: string, body: unknown = null, action: 'state' | 'reveal' = 'state') => handleCredentialsRequest(action, { method, body, headers: { 'x-api-token': admin } }, context)
  expect(call('GET').body).toMatchObject({ ocrToken: { source: 'saved' } })
  expect(call('DELETE', { key: 'ocrToken' }).body).toMatchObject({ ocrToken: { source: 'NUXT_OCR_TOKEN', hasSaved: false } })
  expect((call('POST', {}, 'reveal').body as {value:string}).value === context.env.NUXT_OCR_TOKEN).toBe(true)
  expect(context.env.NUXT_OCR_TOKEN === 'synthetic-env-fallback').toBe(true)
})
it('failed atomic write preserves the existing value and a retry succeeds after directory permissions recover', async () => {
  await start()
  await request('PATCH', { ocrToken: 'synthetic-kept-on-disk' })
  const { chmodSync, readFileSync } = await import('node:fs')
  const file = join(dir, 'credentials.json')
  const old = readFileSync(file, 'utf8')
  chmodSync(dir, 0o500)
  try {
    expect((await request('PATCH', { ocrToken: 'synthetic-failed-replacement' })).status).toBe(503)
    expect(readFileSync(file, 'utf8') === old).toBe(true)
    expect((await (await request()).json()).ocrToken.masked).toBe('syn********isk')
  } finally { chmodSync(dir, 0o700) }
  expect((await request('PATCH', { ocrToken: 'synthetic-retried' })).status).toBe(200)
})
it('fails closed on malformed state and rejects repository paths rather than exposing fallback or file details', async () => {
  await start()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(dir, 'credentials.json'), '{synthetic-malformed-secret', { mode: 0o600 })
  const req = { method: 'GET', headers: { 'x-api-token': admin }, body: null }
  for (const stateDir of [dir, process.cwd()]) {
    const result = handleCredentialsRequest('state', req, { apiToken: admin, stateDir, env: { NUXT_OCR_TOKEN: 'synthetic-fallback' } })
    expect(result.status).toBe(503)
    expect(JSON.stringify(result).includes('synthetic')).toBe(false)
    expect(JSON.stringify(result).includes(stateDir)).toBe(false)
  }
})
it('configuration-only requests leave an isolated business SQLite byte-for-byte unchanged', async () => {
  await start()
  const { useDb } = await import('../db/client')
  const db = useDb({ dbPath: join(dir, 'synthetic.sqlite') })
  const before = db.$client.serialize()
  await request('PATCH', { ocrToken: 'synthetic-no-business-write', miitCookie: 'session=synthetic-no-business-write' })
  await request('POST', {}, true, '/ocrToken/reveal')
  expect((await request('PATCH', { miitCookie: 'session=synthetic-db-unchanged' })).status).toBe(200)
  expect((await request('POST', {}, true, '/miitCookie/reveal')).status).toBe(200)
  expect((await request('DELETE', { key: 'miitCookie' })).status).toBe(200)
  await request('DELETE', { key: 'ocrToken' })
  expect(db.$client.serialize().equals(before)).toBe(true)
  db.$client.close()
})
it.each([
  { label: 'one character', value: 'x', masked: '********' },
  { label: 'eight characters', value: '12345678', masked: '********' },
  { label: 'nine characters', value: '123456789', masked: '123********789' },
])('masks credential length boundaries without exposing a complete short value ($label)', async ({ value, masked }) => {
  await start()
  const response = await request('PATCH', { ocrToken: value })
  expect((await response.json()).ocrToken.masked).toBe(masked)
})
it('rejects non-object payloads, unsupported future fields, and has no implicit filesystem target', async () => {
  await start()
  for (const body of [null, [], 2, { unsupported: 'synthetic-out-of-scope' }]) expect((await request('PATCH', body)).status).toBe(400)
  const response = handleCredentialsRequest('state', { method: 'PATCH', headers: { 'x-api-token': admin }, body: { ocrToken: 'synthetic' } }, { apiToken: admin, env: {} })
  expect(response.status).toBe(503)
})

it('updates Cookie and OCR independently under concurrent HTTP requests and reveals Cookie only with authorization', async () => {
  await start()
  await server.close()
  server = await startHttpFixture({ routes: {
    '/api/settings/credentials': req => handleCredentialsRequest('state', req, { apiToken: admin, stateDir: dir, env: {} }),
    '/api/settings/credentials/miitCookie/reveal': req => handleCredentialsRequest('reveal', req, { apiToken: admin, stateDir: dir, env: {} }, 'miitCookie'),
  } })
  const responses = await Promise.all([request('PATCH', { ocrToken: 'synthetic-ocr-kept' }), request('PATCH', { miitCookie: 'session=synthetic-cookie' })])
  expect(responses.map(r => r.status)).toEqual([200, 200])
  const state = await (await request()).json()
  expect(state).toMatchObject({ ocrToken: { masked: 'syn********ept' }, miitCookie: { masked: 'ses********kie', source: 'saved' } })
  const denied = await request('POST', {}, false, '/miitCookie/reveal')
  expect(denied.status).toBe(401)
  expect(denied.headers.get('cache-control')).toBe('no-store')
  const revealed = await request('POST', {}, true, '/miitCookie/reveal')
  expect(revealed.headers.get('cache-control')).toBe('no-store')
  expect((await revealed.json()).value === 'session=synthetic-cookie').toBe(true)
  await request('DELETE', { key: 'miitCookie' })
  expect((await (await request()).json()).ocrToken.masked).toBe('syn********ept')
})
it('masks short Cookie values completely while preserving the separate OCR field', async () => {
  await start()
  for (const value of ['a', '12345678']) {
    const response = await request('PATCH', { miitCookie: value })
    expect(response.status).toBe(200)
    expect((await response.json()).miitCookie.masked).toBe('********')
    expect((await (await request('POST', {}, true, '/miitCookie/reveal')).json()).value === value).toBe(true)
  }
})
