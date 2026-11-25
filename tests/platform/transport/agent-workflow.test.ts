import { closeApplicationLogging } from '../../../layers/core/lib/logging'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { updatePostgresCredentialState } from '../../../layers/core/server/utils/credential-state-postgres'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { startPlatformBatchApi } from './fixtures/batch-api'
import { stopJobs } from '../../../layers/core/server/utils/postgres-jobs'
const dir = mkdtempSync(join(tmpdir(), 'platform-agent-'))
let db: ReturnType<typeof usePostgresDirectoryDb>
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
const nativeFetch = globalThis.fetch
const scenarios = JSON.parse(readFileSync('.agents/skills/roster-ingestion-pipeline/examples/platform-scenarios.json', 'utf8'))
const workflowUrl = new URL('../../../.agents/skills/roster-ingestion-pipeline/examples/investigate-platform.mjs', import.meta.url).href
let api: Awaited<ReturnType<typeof startPlatformBatchApi>>
let workflow: any
let expired = true; let failedPage = true
const platformRequests: { source: string; name: string; page: number }[] = []
beforeAll(async () => {
  postgres = await postgresRuntimeFixture({ dir })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_POSTGRES_LOG_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  vi.stubEnv('MIIT_COOKIE', '')
  vi.stubEnv('MIIT_COOKIE_FILE', '')
  db = usePostgresDirectoryDb()
  await updatePostgresCredentialState(db, { 'sme-roster.miitCookie': 'session=synthetic-agent-server-only' })
  api = await startPlatformBatchApi({ apiToken: 'synthetic-agent-task-token', filesDir: dir })
  workflow = await import(workflowUrl)
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    if (url.startsWith(api.baseUrl)) return nativeFetch(url, init)
    expect(url).toMatch(/^https?:\/\/[^/]+\/(?:.*\/)?(?:YzzxqyApplayBLH\/queryList|ZjtxxjrBusInfoManageBLH\/(?:businessList|queryBusList))$/)
    expect(init.headers.Cookie).toBe('session=synthetic-agent-server-only')
    const source = url.endsWith('/queryList') ? 'queryList' : url.endsWith('/businessList') ? 'businessList' : 'queryBusList'
    const p = new URLSearchParams(init.body); const name = p.get('qymc') ?? ''; const page = Number(p.get('pageNum'))
    platformRequests.push({ source, name, page })
    if (name.includes('会话过期') && expired) return new Response('<form id="loginForm"><input name="password"></form>')
    if (name.includes('第二页失败') && page === 2 && failedPage) return new Response('synthetic error', { status: 503 })
    const total = name.includes('第二页失败') || p.get('tyshxydm') === '91330000TEST000001' ? 2 : 1
    const grid = source === 'queryList' ? 'applyGrid' : source === 'businessList' ? 'businessListGrid' : 'businessGrid'
    return new Response(JSON.stringify({ zrarData: { grid: { [grid]: { page, pageSize: 1, maxPage: total, maxCount: total, pageSet: [{ qymc: '合成企业', tyshxydm: '91330000TEST000001', relation: `${source}:${p.get('rdjb')}:${page}` }] } } } }))
  })
}, 30_000)
afterAll(async () => {
  await api?.close()
  await stopJobs()
  await closeApplicationLogging()
  await closePostgresDirectoryDb()
  postgres?.close()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})
it('reproducible agent workflow completes single batch expired second-page and multiple-relation scenarios using app routes only', async () => {
  const options = { baseUrl: api.baseUrl, apiToken: 'synthetic-agent-task-token', maxPolls: 200, pollIntervalMs: 25 }
  const single = await workflow.querySingle({ ...options, query: scenarios.single })
  expect(single).toMatchObject({ status: 'success', completeness: 'complete', fetchedCount: 1 })
  const batch = await workflow.investigatePlatform({ ...options, queries: scenarios.batch })
  expect(batch).toMatchObject({ state: 'done', completeness: 'complete', progress: { done: 3, total: 3 } })
  expect(batch.items[1].segments.flatMap((s: any) => s.rows)).toHaveLength(6)
  const interrupted = await workflow.investigatePlatform({ ...options, queries: [scenarios.expired, scenarios.secondPageFailure, scenarios.multipleRelations] })
  expect(interrupted.items.map((i: any) => i.status)).toEqual(['auth_failed', 'partial', 'success'])
  expect(interrupted.items[1].unfinished).toEqual([{ source: 'queryList', rdjb: null, page: 2 }])
  const completeItem = interrupted.items[2]
  expect(completeItem.segments[0].rows.map((r: any) => r.relation)).toEqual(['queryList:null:1', 'queryList:null:2'])
  expired = false; failedPage = false; platformRequests.length = 0
  const recovered = await workflow.retryUnfinishedBatch({ ...options, batch: interrupted })
  expect(recovered).toMatchObject({ batchId: interrupted.batchId, state: 'done', completeness: 'complete' })
  expect(recovered.items.map((i: any) => i.itemId)).toEqual(interrupted.itemIds)
  expect(recovered.items[2]).toEqual(completeItem)
  expect(recovered.items[1].segments[0]).toEqual(interrupted.items[1].segments[0])
  expect(platformRequests).toEqual([{ source: 'queryList', name: '合成会话过期', page: 1 }, { source: 'queryList', name: '合成第二页失败', page: 2 }])
  expect(api.paths.length).toBeGreaterThan(10)
  for (const path of api.paths) expect(path).toMatch(/^\/api\/platform\/(?:query|capabilities|batches(?:\/[0-9A-HJKMNP-TV-Z]{26}(?:\/retry|\/items\/[0-9A-HJKMNP-TV-Z]{26})?)?)$/)
  expect(JSON.stringify(recovered)).not.toContain('synthetic-agent-server-only')
  expect(await db.select({ id: enterprise.id }).from(enterprise)).toEqual([])
}, 20_000)
