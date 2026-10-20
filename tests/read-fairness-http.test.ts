import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createError, defineEventHandler, getQuery, setHeader, toNodeListener } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { useDb } from '../db/client'
import { createRosterImportClient } from '../lib/roster-import-client'
import { startRosterApi } from './helpers/roster-http-server'
const active = vi.hoisted(() => ({ db: null as ReturnType<typeof useDb> | null }))
vi.mock('@db', () => ({ useDb: () => active.db }))
const dir = mkdtempSync(join(tmpdir(), 'read-fairness-'))
const db = useDb({ dbPath: join(dir, 'fixture.db') })
active.db = db
let imports: Awaited<ReturnType<typeof startRosterApi>>, server: Server, base: string
beforeAll(async () => {
  imports = await startRosterApi({ db, apiToken: 'synthetic-fairness' })
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('getQuery', getQuery)
  vi.stubGlobal('setHeader', setHeader)
  vi.stubGlobal('createError', createError)
  const handler = (await import('../server/api/roster/differences.get')).default
  server = createServer(toNodeListener(createApp().use('/api/roster/differences', handler)))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  await imports.close(); db.$client.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals()
})
it('retains literal public differences and sees an API commit on every read after its acknowledgement', async () => {
  const read = async () => { const res = await fetch(base + '/api/roster/differences?pageSize=20'); expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store'); return res.json() }
  expect(await read()).toMatchObject({ rows: [], total: 0 })
  const client = createRosterImportClient({ baseUrl: imports.baseUrl, token: 'synthetic-fairness' })
  for (const [id, name] of [[1, '公平合成甲'], [2, '公平合成乙']] as const) {
    const receipt = await client.commit({ idempotencyKey: `fairness-${id}`, sourceKind: 'announcement', sourceIdentity: `synthetic-fairness-${id}`, payload: { announcement: { sourceDocument: { source: 'jxj', title: `Synthetic ${id}` }, records: [{ enterprise: { name }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2022 }] }] } } })
    expect(receipt).toMatchObject({ status: 'committed', summary: { failed: 0 } })
    const results = await Promise.all(Array.from({ length: 5 }, read))
    for (const value of results) {
      expect(value.total).toBe(id)
      expect(value.rows.map((row: any) => [row.name, row.direction, row.status])).toEqual(id === 1 ? [['公平合成甲', 'missing_in_miit', 'not_queried']] : [['公平合成乙', 'missing_in_miit', 'not_queried'], ['公平合成甲', 'missing_in_miit', 'not_queried']])
      expect(value.counts.specialized_sme).toEqual({ missing_in_miit: id, extra_in_miit: 0 })
    }
  }
})
it('keeps original invalid-query status and message before scheduling', async () => {
  const res = await fetch(base + '/api/roster/differences?title=invalid')
  expect(res.status).toBe(400)
  expect(await res.json()).toMatchObject({ statusMessage: 'Unknown title; expected little_giant, specialized_sme, innovative_sme' })
})
