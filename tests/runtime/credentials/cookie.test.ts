import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { postgresCredentialStorage, resolveRuntimeCredential, updatePostgresCredentialState } from '../../../layers/core/server/utils/credential-state-postgres'
import { handleCredentialsRequest } from '../../../layers/core/server/utils/credentials-http'
import { runPlatformLiveQuery } from '../../../layers/sme-roster/server/utils/platform-live-query'
import { platformFixture } from '../../platform/fixtures/source-replay'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

const dir = mkdtempSync(join(tmpdir(), 'cookie-credentials-'))
const key = 'sme-roster.miitCookie'
let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>>
beforeAll(async () => {
  runtime = await postgresRuntimeFixture({ dir })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', runtime.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
}, 20_000)
beforeEach(() => runtime.psql(['-c', 'TRUNCATE business.service_credential']))
afterAll(async () => {
  try {
    await closePostgresDirectoryDb()
    runtime?.close()
  } finally {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('resolves saved Cookie before environment and clears to deployment fallback', async () => {
  const ctx = { env: { MIIT_COOKIE: ' session=synthetic-env ' } }
  const resolve = () => resolveRuntimeCredential(key, ctx)
  const save = (value: string | null) => updatePostgresCredentialState(usePostgresDirectoryDb(), { [key]: value })
  expect(await resolve()).toMatchObject({ source: 'MIIT_COOKIE', value: 'session=synthetic-env' })
  await save('session=synthetic-saved')
  expect(await resolve()).toMatchObject({ source: 'saved', value: 'session=synthetic-saved' })
  await save(null)
  expect(await resolve()).toMatchObject({ source: 'MIIT_COOKIE', value: 'session=synthetic-env' })
  ctx.env.MIIT_COOKIE = ''
  expect(await resolve()).toMatchObject({ source: 'none', value: '' })
})

it('rejects invalid Cookie and mixed invalid requests without changing either saved credential', async () => {
  const ctx = { env: {} }
  const storage = postgresCredentialStorage()
  await storage.update({ [key]: 'session=synthetic-kept', 'core.ocrToken': 'synthetic-ocr-kept' })
  for (const miitCookie of [' ', '\r\nsession=bad', null, 42, 'x'.repeat(65537)]) {
    const response = await handleCredentialsRequest('state', {
      method: 'PATCH', headers: {}, body: { 'core.ocrToken': 'synthetic-not-written', [key]: miitCookie },
    }, ctx, storage)
    expect(response.status).toBe(400)
    expect((await resolveRuntimeCredential(key, ctx)).value).toBe('session=synthetic-kept')
    expect((await resolveRuntimeCredential('core.ocrToken', ctx)).value).toBe('synthetic-ocr-kept')
  }
})

it('keeps the database Cookie for every request in-flight and reads the update for the next live query', async () => {
  const save = (value: string) => updatePostgresCredentialState(usePostgresDirectoryDb(), { [key]: value })
  await save('session=synthetic-http-A')
  const seen: (string | undefined)[] = []
  const pending: Promise<unknown>[] = []
  const service = createServer((req, res) => {
    seen.push(req.headers.cookie)
    const send = () => res.end(platformFixture('business-list-rdjb1-empty.html'))
    if (seen.length === 1) {
      pending.push(save('session=synthetic-http-B').then(send, () => {
        res.statusCode = 500
        res.end()
      }))
    } else send()
  })
  await new Promise<void>(r => service.listen(0, '127.0.0.1', r))
  try {
    const query = (cookie?: string) => runPlatformLiveQuery({ source: 'businessList', uscc: '91330211255994457P', rdjb: 'all' }, {
      credentials: { env: { MIIT_COOKIE: 'session=fallback' } },
      cookie,
      transport: { baseUrl: `http://127.0.0.1:${(service.address() as AddressInfo).port}` },
    })
    for (const cookie of [undefined, undefined, 'session=controlled']) {
      expect(await query(cookie)).toMatchObject({ status: 'no_record', pages: [
        { rdjb: '1', status: 'success' }, { rdjb: '2', status: 'success' }, { rdjb: '3', status: 'success' },
      ] })
    }
    expect(await query('')).toMatchObject({ status: 'not_queried', error: { code: 'credential_unavailable' } })
    expect(seen).toEqual([
      ...Array(3).fill('session=synthetic-http-A'),
      ...Array(3).fill('session=synthetic-http-B'),
      ...Array(3).fill('session=controlled'),
    ])
  } finally {
    await Promise.all(pending)
    await new Promise<void>(r => service.close(() => r()))
  }
})
