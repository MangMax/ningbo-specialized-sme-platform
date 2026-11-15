import { submitNativePlatformQuery } from '../fixtures/native-query'
import { initializeDb } from '../../../db/client'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, getQuery, setHeader, defineEventHandler, createError } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { useDb, schema } from '../../../db'
import { platformSummaryCache } from '../../../server/utils/platform-summary-cache'
const dir = mkdtempSync(join(tmpdir(), 'platform-query-http-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'test.sqlite') })
let server: ReturnType<typeof createServer>, base: string
const id = submitNativePlatformQuery(db, { interface: 'apply_list', queryKey: 'synthetic:http', queriedAt: '2026-10-19', status: 'partial', rawResponse: '完整原文🙂' }).queryId
beforeAll(async () => {
  vi.stubEnv('NUXT_DB_PATH', join(dir, 'test.sqlite'))
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('getQuery', getQuery)
  vi.stubGlobal('createError', createError)
  const list = (await import('../../../server/api/platform/queries.get')).default
  const evidence = (await import('../../../server/api/platform/queries/[queryId]/evidence.get')).default
  const router = createRouter().get('/api/platform/queries-no-store', defineEventHandler(event => { setHeader(event, 'cache-control', 'no-store'); return list(event) })).get('/api/platform/queries', list).get('/api/platform/queries/:queryId/evidence', evidence)
  server = createServer(toNodeListener(createApp({ debug: false }).use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); platformSummaryCache.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
it('public HTTP summary and exact ID preserve partial state and complete evidence without authorization', async () => {
  const response = await fetch(`${base}/api/platform/queries?queryId=${id}&view=summary`)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ total: 1, counts: { partial: 1 }, rows: [{ relationsIncluded: false, query: { id, status: 'partial', relationCount: 0 } }] })
  const chunk = await fetch(`${base}/api/platform/queries/${id}/evidence?field=rawResponse&offset=0&length=65536`)
  expect(chunk.headers.get('cache-control')).toBe('no-store')
  expect(await chunk.json()).toMatchObject({ data: Buffer.from('完整原文🙂').toString('base64'), hasMore: false })
})
it('public HTTP rejects unsupported selectors and ranges with typed 400 and missing IDs with 404', async () => {
  for (const query of ['view=garbage', 'queryId=0', 'queryId=1.5', 'view=summary&includeRawResponse=true', 'interface=garbage', 'titleCode=garbage', 'status=garbage']) expect((await fetch(`${base}/api/platform/queries?${query}`)).status).toBe(400)
  for (const query of ['field=garbage', 'field=rawResponse&offset=-1', 'field=rawResponse&length=65537', 'field=relation', 'field=relations&pageSize=201']) expect((await fetch(`${base}/api/platform/queries/${id}/evidence?${query}`)).status).toBe(400)
  expect((await fetch(`${base}/api/platform/queries/9999/evidence?field=rawResponse`)).status).toBe(404)
  expect((await fetch(`${base}/api/platform/queries/garbage/evidence?field=rawResponse`)).status).toBe(400)
})

it('public REST opts into summary storage while credentials and no-store bypass it', async () => {
  const before = platformSummaryCache.stats()
  const url = `${base}/api/platform/queries?view=summary`
  const first = await fetch(url)
  expect(first.headers.get('cache-control')).toBeNull()
  const expected = await first.json()
  expect(await (await fetch(url)).json()).toEqual(expected)
  expect(platformSummaryCache.stats().hits).toBe(before.hits + 1)
  expect(platformSummaryCache.stats().misses).toBe(before.misses + 1)
  for (const headers of [{ 'cache-control': 'no-store' }, { 'cache-control': 'no-cache' }, { authorization: 'Bearer synthetic' }, { cookie: 'synthetic=only' }] as Record<string, string>[]) {
    const response = await fetch(url, { headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expected)
  }
  expect(platformSummaryCache.stats().hits).toBe(before.hits + 1)
  expect(platformSummaryCache.stats().bypasses).toBe(before.bypasses + 4)
})

it('an existing response no-store policy prevents summary storage', async () => {
  const before = platformSummaryCache.stats()
  const response = await fetch(`${base}/api/platform/queries-no-store?view=summary`)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect((await response.json()).rows[0].query.status).toBe('partial')
  expect(platformSummaryCache.stats().hits).toBe(before.hits)
  expect(platformSummaryCache.stats().misses).toBe(before.misses)
  expect(platformSummaryCache.stats().bypasses).toBe(before.bypasses + 1)
})
