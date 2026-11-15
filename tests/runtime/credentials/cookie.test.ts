import { initializeDb } from '../../../db/client'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest'
import { useDb } from '../../../db'
import { credentialStatus, resolvePlatformCookie, updateCredential } from '../../../server/utils/credential-state'
import { handleCredentialsRequest } from '../../../server/utils/credentials-http'
import { queryAllRdjb } from '../../../lib/platform/client'
import { EMPTY_APPLY_RESPONSE, platformFixture } from '../../helpers/platform-replay'
const dir = mkdtempSync(join(tmpdir(), 'cookie-credentials-'))
let db: ReturnType<typeof useDb>
let sequence = 0
beforeEach(() => { db = initializeDb({ create: true, dbPath: join(dir, `${sequence++}.sqlite`) }) })
afterEach(() => db.$client.close())
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const context = () => ({ db, env: {} })
it('resolves database Cookie before environment, preserves controlled overrides and clears to fallback', () => {
  const ctx = { ...context(), env: { MIIT_COOKIE: ' session=synthetic-env ' } }
  expect(credentialStatus(ctx).miitCookie.source).toBe('MIIT_COOKIE')
  updateCredential('miitCookie', 'session=synthetic-saved', ctx)
  expect(resolvePlatformCookie(undefined, { ...ctx })).toBe('session=synthetic-saved')
  expect(resolvePlatformCookie('session=synthetic-override', ctx)).toBe('session=synthetic-override')
  expect(resolvePlatformCookie(() => '', ctx)).toBe('')
  expect(resolvePlatformCookie('', ctx)).toBe('')
  expect(resolvePlatformCookie(' ', ctx)).toBe('')
  updateCredential('miitCookie', null, ctx)
  expect(resolvePlatformCookie(undefined, ctx)).toBe('session=synthetic-env')
  ctx.env.MIIT_COOKIE = ''
  expect(credentialStatus(ctx).miitCookie).toMatchObject({ configured: false, source: 'none' })
})
it('rejects invalid Cookie and mixed invalid requests without changing either saved credential', () => {
  const ctx = context()
  updateCredential('miitCookie', 'session=synthetic-kept', ctx)
  updateCredential('ocrToken', 'synthetic-ocr-kept', ctx)
  for (const miitCookie of [' ', '\r\nsession=bad', null, 42, 'x'.repeat(65537)]) {
    const response = handleCredentialsRequest('state', { method: 'PATCH', headers: {}, body: { ocrToken: 'synthetic-not-written', miitCookie } }, ctx)
    expect(response.status).toBe(400)
    expect(resolvePlatformCookie(undefined, ctx)).toBe('session=synthetic-kept')
    expect(credentialStatus(ctx).ocrToken.masked).toBe('syn********ept')
  }
})
it('sends database Cookie to a controlled HTTP service, fixes an in-flight operation and hot updates the next query', async () => {
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
