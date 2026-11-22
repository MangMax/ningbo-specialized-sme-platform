import { submitNativePlatformQuery } from '../fixtures/native-query'
import { initializeDb } from '../../../db/client'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, getQuery, setHeader, defineEventHandler, createError } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
const dir = mkdtempSync(join(tmpdir(), 'platform-query-http-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'test.sqlite') })
let server: ReturnType<typeof createServer>, base: string
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
const earlier = submitNativePlatformQuery(db, {
  interface: 'apply_list', queryKey: 'synthetic:http', queriedAt: '2026-10-19', status: 'partial', rawResponse: '完整原文🙂',
  relations: [{ sequenceNo: 1, relationKey: 'apply-42', nameRaw: '合成企业', rawFields: { id: 'apply-42', qymc: '合成企业', hiddenOriginal: { text: '离线字段' } } }],
})
const id = earlier.queryId
const laterId = submitNativePlatformQuery(db, { interface: 'apply_list', queryKey: 'synthetic:http', queriedAt: '2026-10-20', status: 'partial', rawResponse: '再次采集' }).queryId
beforeAll(async () => {
  postgres = await postgresRuntimeFixture({dir, sourcePath: join(dir, 'test.sqlite')})
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('getQuery', getQuery)
  vi.stubGlobal('createError', createError)
  const list = (await import('../../../layers/sme-roster/server/api/platform/queries.get')).default
  const router = createRouter().get('/api/platform/queries-no-store', defineEventHandler(event => { setHeader(event, 'cache-control', 'no-store'); return list(event) })).get('/api/platform/queries', list)
  server = createServer(toNodeListener(createApp({ debug: false }).use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as any).port}`
}, 30_000)
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await closePostgresDirectoryDb()
  postgres?.close()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})
it('the exact query ID opens the earlier extracted record when two captures share a query key', async () => {
  const history = await fetch(`${base}/api/platform/queries?queryKey=synthetic%3Ahttp&view=summary`)
  expect(history.status).toBe(200)
  expect((await history.json()).rows.map((row: { query: { id: number } }) => row.query.id)).toEqual([laterId, id])
  const response = await fetch(`${base}/api/platform/queries?queryId=${id}&view=summary`)
  expect(response.status).toBe(200)
  const summary = await response.json()
  expect(summary).toMatchObject({ total: 1, counts: { partial: 1 }, rows: [{ relationsIncluded: false, query: { id, status: 'partial', relationCount: 1 } }] })
  expect(summary.rows).toHaveLength(1)
  const full = await fetch(`${base}/api/platform/queries?queryId=${id}&view=full`)
  expect(full.status).toBe(200)
  const body = await full.json()
  expect(body).toMatchObject({
    total: 1,
    rows: [{ query: { id, relationCount: 1 }, relations: [{ id: earlier.relationIds[0], queryId: id, sequenceNo: 1, relationKey: 'apply-42', nameRaw: '合成企业' }] }],
  })
  expect(body.rows[0].query).not.toHaveProperty('rawResponse')
  expect(JSON.stringify(body)).not.toMatch(/离线字段|完整原文/)
})

it('rejects unsupported query selectors and serves no historical byte replay route', async () => {
  for (const query of ['view=garbage', 'queryId=0', 'queryId=1.5', 'includeRawResponse=true', 'interface=garbage', 'titleCode=garbage', 'status=garbage']) {
    expect((await fetch(`${base}/api/platform/queries?${query}`)).status).toBe(400)
  }
  expect((await fetch(`${base}/api/platform/queries/${id}/evidence?field=rawResponse`)).status).toBe(404)
})

it('public summary returns the same evidence with credentials and no-store directives', async () => {
  const url = `${base}/api/platform/queries?view=summary`
  const first = await fetch(url)
  expect(first.headers.get('cache-control')).toBeNull()
  const expected = await first.json()
  expect(await (await fetch(url)).json()).toEqual(expected)
  for (const headers of [{ 'cache-control': 'no-store' }, { 'cache-control': 'no-cache' }, { authorization: 'Bearer synthetic' }, { cookie: 'synthetic=only' }] as Record<string, string>[]) {
    const response = await fetch(url, { headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expected)
  }
})

it('preserves an existing response no-store directive', async () => {
  const response = await fetch(`${base}/api/platform/queries-no-store?view=summary`)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect((await response.json()).rows[0].query.status).toBe('partial')
})
