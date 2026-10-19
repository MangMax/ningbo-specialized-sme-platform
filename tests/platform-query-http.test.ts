import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, getQuery, defineEventHandler, createError } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { useDb, schema } from '../db'
const dir = mkdtempSync(join(tmpdir(), 'platform-query-http-'))
const db = useDb({ dbPath: join(dir, 'test.sqlite') })
let server: ReturnType<typeof createServer>, base: string
const id = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: 'synthetic:http', queriedAt: '2026-10-19', status: 'partial', rawResponse: '完整原文🙂', collectionEvidence: { titleScope: { rdjb: ['2'] }, pages: [] } as never }).returning().get().id
beforeAll(async () => {
  vi.stubEnv('NUXT_DB_PATH', join(dir, 'test.sqlite'))
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('getQuery', getQuery)
  vi.stubGlobal('createError', createError)
  const list = (await import('../server/api/platform/queries.get')).default
  const evidence = (await import('../server/api/platform/queries/[queryId]/evidence.get')).default
  const router = createRouter().get('/api/platform/queries', list).get('/api/platform/queries/:queryId/evidence', evidence)
  server = createServer(toNodeListener(createApp({ debug: false }).use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
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
