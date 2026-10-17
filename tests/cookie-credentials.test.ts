import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'vitest'
import { credentialStatus, resolvePlatformCookie, updateCredential } from '../server/utils/credential-state'
import { handleCredentialsRequest } from '../server/utils/credentials-http'
import { queryAllRdjb } from '../lib/platform/client'
import { EMPTY_APPLY_RESPONSE, platformFixture } from './helpers/platform-replay'
const dir = mkdtempSync(join(tmpdir(), 'cookie-credentials-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => { rmSync(join(dir, 'state'), { recursive: true, force: true }) })
const context = () => ({ stateDir: join(dir, 'state'), env: {} })
it('resolves saved Cookie before environment and file, survives a new context, clears to fallback and never changes the file', () => {
  const file = join(dir, 'cookie.txt')
  writeFileSync(file, '  session=synthetic-file  \n', { mode: 0o600 })
  const ctx = { ...context(), env: { MIIT_COOKIE: ' session=synthetic-env ', MIIT_COOKIE_FILE: file } }
  expect(credentialStatus(ctx).miitCookie.source).toBe('MIIT_COOKIE')
  updateCredential('miitCookie', 'session=synthetic-saved', ctx)
  expect(resolvePlatformCookie(undefined, { ...ctx }) === 'session=synthetic-saved').toBe(true)
  expect(resolvePlatformCookie('session=synthetic-override', ctx) === 'session=synthetic-override').toBe(true)
  expect(resolvePlatformCookie(() => '', ctx)).toBe('')
  expect(resolvePlatformCookie(' ', ctx)).toBe('')
  updateCredential('miitCookie', null, ctx)
  expect(resolvePlatformCookie(undefined, ctx) === 'session=synthetic-env').toBe(true)
  ctx.env.MIIT_COOKIE = ''
  expect(credentialStatus(ctx).miitCookie.source).toBe('MIIT_COOKIE_FILE')
  expect(resolvePlatformCookie(undefined, ctx) === 'session=synthetic-file').toBe(true)
  expect(readFileSync(file, 'utf8') === '  session=synthetic-file  \n').toBe(true)
  rmSync(file)
  expect(credentialStatus(ctx).miitCookie).toMatchObject({ configured: false, source: 'none' })
})
it('fails closed on unreadable Cookie file without exposing file details', () => {
  const file = join(dir, 'unreadable.txt'); writeFileSync(file, 'session=synthetic-file'); chmodSync(file, 0)
  try {
    const response = handleCredentialsRequest('state', { method: 'GET', headers: { 'x-api-token': 'synthetic-admin' }, body: null }, { ...context(), env: { MIIT_COOKIE_FILE: file } })
    expect(response.status).toBe(503)
    expect(JSON.stringify(response).includes(file)).toBe(false)
  } finally { chmodSync(file, 0o600); rmSync(file) }
})
it('rejects invalid Cookie and mixed invalid requests without changing either saved credential', () => {
  const ctx = { ...context() }
  updateCredential('miitCookie', 'session=synthetic-kept', ctx)
  updateCredential('ocrToken', 'synthetic-ocr-kept', ctx)
  for (const miitCookie of [' ', '\r\nsession=bad', null, 42, 'x'.repeat(65537)]) {
    const response = handleCredentialsRequest('state', { method: 'PATCH', headers: { 'x-api-token': 'synthetic-admin' }, body: { ocrToken: 'synthetic-not-written', miitCookie } }, ctx)
    expect(response.status).toBe(400)
    expect(resolvePlatformCookie(undefined, ctx) === 'session=synthetic-kept').toBe(true)
    expect(credentialStatus(ctx).ocrToken.masked).toBe('syn********ept')
  }
})
it('sends saved Cookie to a controlled HTTP service, fixes an in-flight operation and hot updates the next query', async () => {
  const ctx = context()
  updateCredential('miitCookie', 'session=synthetic-http-A', ctx)
  let expected = 'session=synthetic-http-A'
  const seen: boolean[] = []
  const service = createServer((req, res) => {
    seen.push(req.headers.cookie === expected)
    updateCredential('miitCookie', 'session=synthetic-http-B', ctx)
    res.end(req.url?.includes('businessList') ? platformFixture('business-list-rdjb1-empty.html') : EMPTY_APPLY_RESPONSE)
  })
  await new Promise<void>(r => service.listen(0, '127.0.0.1', r))
  try {
    const query = () => queryAllRdjb({ uscc: '91330211255994457P', cookie: () => resolvePlatformCookie(undefined, ctx), baseUrl: `http://127.0.0.1:${(service.address() as AddressInfo).port}` })
    expect((await query()).map(o => o.status)).toEqual(Array(4).fill('no_record'))
    expected = 'session=synthetic-http-B'
    expect((await query()).map(o => o.status)).toEqual(Array(4).fill('no_record'))
    expect(seen).toEqual(Array(8).fill(true))
  } finally { await new Promise<void>(r => service.close(() => r())) }
})
it('keeps the saved override if clearing would expose an unreadable fallback', () => {
  const file = join(dir, 'broken-clear.txt'); writeFileSync(file, 'session=synthetic-file'); chmodSync(file, 0)
  const ctx = { ...context(), env: { MIIT_COOKIE_FILE: file } }
  try {
    updateCredential('miitCookie', 'session=synthetic-kept', ctx)
    const response = handleCredentialsRequest('state', { method: 'DELETE', headers: { 'x-api-token': 'synthetic-admin' }, body: { key: 'miitCookie' } }, ctx)
    expect(response.status).toBe(503)
    expect(resolvePlatformCookie(undefined, ctx) === 'session=synthetic-kept').toBe(true)
  } finally { chmodSync(file, 0o600); rmSync(file) }
})
