import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, defineEventHandler, readBody, setHeader, setResponseStatus, getQuery, getRouterParam, getHeader, createError } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { schema, useDb } from '../db'
import { handleRosterImportRequest } from '../server/utils/roster-import-http'
import type { RosterImportPlatformQuery, RosterImportRequest } from '../lib/roster-import-client'

const dir = mkdtempSync(join(tmpdir(), 'declarations-http-'))
const dbPath = join(dir, 'declarations.sqlite')
vi.stubEnv('NUXT_DB_PATH', dbPath)
const db = useDb({ dbPath })
const token = 'synthetic-declarations-token'
let server: ReturnType<typeof createServer>, base: string

function applyQuery(time: string, raw: Record<string, unknown>, key = 'name:合成企业'): RosterImportPlatformQuery {
  return { interface: 'apply_list', queryKey: key, queriedAt: time, status: 'success', relations: [{ sequenceNo: 1, relationKey: typeof raw.id === 'string' ? raw.id : null, usccRaw: typeof raw.tyshxydm === 'string' ? raw.tyshxydm : null, nameRaw: typeof raw.qymc === 'string' ? raw.qymc : null, rawFields: raw }] }
}
function request(key: string, queries: RosterImportPlatformQuery[]): RosterImportRequest {
  return { idempotencyKey: key, sourceKind: 'platform_archive', sourceIdentity: 'tests/declarations', payload: { platformQueries: queries } }
}
async function post(path: string, body: unknown) {
  const response = await fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { http: response.status, ...(await response.json() as any) }
}
async function get(path: string) {
  const response = await fetch(base + path)
  return { http: response.status, ...(await response.json() as any) }
}

beforeAll(async () => {
  vi.stubEnv('NUXT_API_TOKEN', token)
  for (const [key, value] of Object.entries({ defineEventHandler, readBody, setHeader, setResponseStatus, getQuery, getRouterParam, getHeader, createError })) vi.stubGlobal(key, value)
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (value: unknown) => value }))
  const importRoute = defineEventHandler(async event => {
    const out = await handleRosterImportRequest('commit', {
      method: 'POST', headers: { authorization: getHeader(event, 'authorization') }, body: await readBody(event),
    }, { db, apiToken: token })
    setResponseStatus(event, out.status)
    for (const [name, value] of Object.entries(out.headers)) setHeader(event, name, value)
    return out.body
  })
  const listRoute = (await import('../server/api/platform/declarations.get')).default
  const detailRoute = (await import('../server/api/platform/declarations/[recordId].get')).default
  const router = createRouter()
    .post('/api/roster/import/commit', importRoute)
    .get('/api/platform/declarations', listRoute)
    .get('/api/platform/declarations/:recordId', detailRoute)
  server = createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60000)

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.$client.close(); rmSync(dir, { recursive: true, force: true })
})

it('filters, paginates and exposes matched versions without raw JSON', async () => {
  const enterpriseA = db.insert(schema.enterprise).values({ name: '甲合成企业', nameNorm: '甲合成企业', usccNorm: '91330211255994457P' }).returning().get()
  const enterpriseB = db.insert(schema.enterprise).values({ name: '乙合成企业', nameNorm: '乙合成企业', usccNorm: '91330211255994458Q' }).returning().get()
  const rawA = { id: 'SQ-A', qymc: '甲合成企业', tyshxydm: enterpriseA.usccNorm, sblx: '申请', year: '2024', sqsj: '2024-03-01 09:00:00', cszt: '终审通过', secretRaw: 'UNEXPOSED_RAW_VALUE' }
  const rawB = { id: 'SQ-B', qymc: '乙合成企业', tyshxydm: enterpriseB.usccNorm, sblx: '复核', year: 2025, sqsj: '2025-04-01 09:00:00', cszt: '待审核' }
  const first = await post('/api/roster/import/commit', request('seed-a', [applyQuery('2026-10-01T00:00:00Z', rawA), applyQuery('2026-10-01T00:00:01Z', rawB, 'name:乙合成企业')]))
  expect(first.http).toBe(200); expect(first.status).toBe('committed')
  const changed = await post('/api/roster/import/commit', request('seed-a-v2', [applyQuery('2026-10-02T00:00:00Z', { ...rawA, cszt: '已退回' })]))
  expect(changed.status).toBe('committed')

  const all = await get('/api/platform/declarations')
  expect(all.http).toBe(200); expect(all.total).toBe(2)
  expect(JSON.stringify(all)).not.toContain('UNEXPOSED_RAW_VALUE')
  const recordA = all.rows.find((row: any) => row.record.platformKey === 'SQ-A')
  expect(recordA).toMatchObject({ kind: 'record', matchedVersion: { declareKind: '申请', declarationYear: 2024, status: '已退回' }, matchedVersionCount: 2, versionCount: 2, observationCount: 2 })
  expect(recordA.enterpriseIds).toEqual([enterpriseA.id])

  expect((await get('/api/platform/declarations?year=2024')).rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-A'])
  expect((await get('/api/platform/declarations?year=2025')).rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-B'])
  expect((await get('/api/platform/declarations?declareKind=复核')).rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-B'])
  expect((await get('/api/platform/declarations?status=终审通过')).rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-A'])
  expect((await get('/api/platform/declarations?status=已退回')).rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-A'])
  expect((await get('/api/platform/declarations?platformKey=SQ-B')).rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-B'])
  expect((await get('/api/platform/declarations?q=甲合成')).rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-A'])
  expect((await get(`/api/platform/declarations?enterpriseId=${enterpriseB.id}`)).rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-B'])
  const page = await get('/api/platform/declarations?pageSize=1&page=2')
  expect(page.total).toBe(2); expect(page.rows).toHaveLength(1)

  const detail = await get(`/api/platform/declarations/${recordA.record.id}`)
  expect(detail.http).toBe(200)
  expect(detail.versions).toHaveLength(2)
  expect(detail.observations).toHaveLength(2)
  expect(detail.counts).toMatchObject({ versions: 2, observations: 2, versionsTruncated: false, observationsTruncated: false })
  expect(detail.observations.every((observation: any) => observation.version != null)).toBe(true)
  expect(JSON.stringify(detail)).not.toContain('UNEXPOSED_RAW_VALUE')
})

it('isolates missing-key and conflicting-key observations and rejects invalid filters', async () => {
  const missing = await post('/api/roster/import/commit', request('seed-missing', [applyQuery('2026-10-03T00:00:00Z', { qymc: '无编号企业', sblx: '补充申报', year: '2024', cszt: '待补充' }, 'name:无编号企业')]))
  expect(missing.status).toBe('committed')
  const conflicted = applyQuery('2026-10-04T00:00:00Z', { id: 'RAW-CONFLICT', qymc: '冲突企业' }, 'name:冲突企业')
  conflicted.relations![0]!.relationKey = 'RELATION-CONFLICT'
  expect((await post('/api/roster/import/commit', request('seed-conflict', [conflicted]))).status).toBe('committed')

  const isolated = await get('/api/platform/declarations?view=isolated')
  expect(isolated.http).toBe(200); expect(isolated.total).toBe(2)
  expect(isolated.rows.map((row: any) => row.identityState).sort()).toEqual(['conflict', 'missing_key'])
  expect(isolated.rows.every((row: any) => row.kind === 'observation')).toBe(true)
  expect(isolated.rows.some((row: any) => row.declareKind === '补充申报')).toBe(true)
  expect((await get('/api/platform/declarations?view=isolated&year=2024')).total).toBe(1)

  expect((await get('/api/platform/declarations?year=abc')).http).toBe(400)
  expect((await get('/api/platform/declarations?view=bad')).http).toBe(400)
  expect((await get('/api/platform/declarations?pageSize=201')).http).toBe(400)
  expect((await get('/api/platform/declarations/999999')).http).toBe(404)
})

it('MCP tools reuse the same read service and input contract', async () => {
  const listTool = (await import('../server/mcp/tools/list_platform_declarations')).default
  const detailTool = (await import('../server/mcp/tools/get_platform_declaration')).default
  const listed: any = await (listTool.handler as any)({ year: 2024, page: 1, pageSize: 25, view: 'records' })
  expect(listed.rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-A'])
  const detail: any = await (detailTool.handler as any)({ recordId: listed.rows[0].record.id })
  expect(detail.record.platformKey).toBe('SQ-A')
  expect(detail.versions).toHaveLength(2)
})
