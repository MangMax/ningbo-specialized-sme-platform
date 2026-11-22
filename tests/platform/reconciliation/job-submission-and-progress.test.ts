import { closeApplicationLogging } from '../../../layers/core/lib/logging'
import {afterEach,afterAll,beforeEach,describe,expect,it,vi} from 'vitest'
import {clearJobSpecs,getJobSpec,jobSpecs,type JobSpec} from '../../../layers/core/server/utils/job-runner'
import {registerJobSpecs} from '../../../server/utils/job-specs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { record } from '../../../db/postgresql/ledger-tables'
import { platformCollection } from '../../../db/postgresql/platform-tables'
import { updatePostgresCredentialState } from '../../../layers/core/server/utils/credential-state-postgres'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import {platformReplay,emptyReply} from '../fixtures/source-replay'
describe('参数校验:错参数在**提交那一刻**就被挡住', () => {
  let spec: JobSpec

  beforeEach(() => {
    clearJobSpecs()
    registerJobSpecs()
    spec = getJobSpec('reconcile')!
  })

  it('接入后 status 是 ready 且带 run 与 paramsHint', () => {
    expect(spec.status).toBe('ready')
    expect(spec.postgres?.run).toBeTypeOf('function')
    expect(spec.paramsHint).toContain('titles')
    expect(spec.paramsHint).toContain('concurrency')
    expect(jobSpecs().map((entry) => entry.kind)).toEqual(['current-roster-export', 'difference-snapshot', 'event-annual-correspondence', 'event-archive-candidates', 'lead-lists-version-export', 'ocr', 'platform-query-batch', 'reconcile', 'render-pages', 'roster_export_cleanup', 'roster_task_history_cleanup'])
    expect(getJobSpec('event-archive-candidates')).toMatchObject({ status: 'ready', postgres: { run: expect.any(Function) }, deduplicateRequest: true })
    expect(getJobSpec('event-archive-candidates')!.parse({ queryId: 1, clientRequestId: 'catalog-archive' })).toMatchObject({ ok: true, params: { queryId: 1 } })
  })

  it('空参数合法(全量),comma 字符串也认', () => {
    expect(spec.parse({}).ok).toBe(true)
    const parsed = spec.parse({ titles: 'specialized_sme,little_giant', directions: 'extra_in_miit', limit: '5' })
    expect(parsed).toEqual({
      ok: true,
      params: { titles: ['specialized_sme', 'little_giant'], directions: ['extra_in_miit'], limit: 5 },
    })
  })

  it('未知称号 / 未知方向 ⇒ 明确报错并列出可用取值', () => {
    const badTitle = spec.parse({ titles: ['nope'] })
    expect(badTitle.ok).toBe(false)
    expect(badTitle.ok === false && badTitle.message).toContain('specialized_sme')

    const badDirection = spec.parse({ directions: ['sideways'] })
    expect(badDirection.ok).toBe(false)
    expect(badDirection.ok === false && badDirection.message).toContain('extra_in_miit')
  })

  it('usccs 只收 18 位大写字母数字(小样本实查点名)', () => {
    expect(spec.parse({ usccs: '91330211255994457P,91330211316904639T' })).toEqual({
      ok: true,
      params: { usccs: ['91330211255994457P', '91330211316904639T'] },
    })
    const malformed = spec.parse({ usccs: ['91330211255994457'] })
    expect(malformed.ok).toBe(false)
    expect(malformed.ok === false && malformed.message).toContain('18 位')
  })

  it('limit / concurrency / freshnessHours 越界或非整数 ⇒ 报错;write 必须是布尔', () => {
    expect(spec.parse({ limit: 0 }).ok).toBe(false)
    expect(spec.parse({ limit: 1.5 }).ok).toBe(false)
    expect(spec.parse({ concurrency: 13 }).ok).toBe(false)
    expect(spec.parse({ freshnessHours: -1 }).ok).toBe(false)
    expect(spec.parse({ write: 'yes' }).ok).toBe(false)
    expect(spec.parse({ write: false })).toEqual({ ok: true, params: { write: false } })
  })

  it('offset 允许 0(等于不跳)但拒绝负数与非整数;与 limit 配成分页', () => {
    expect(spec.parse({ offset: 0 })).toEqual({ ok: true, params: { offset: 0 } })
    expect(spec.parse({ limit: 150, offset: 150 })).toEqual({ ok: true, params: { limit: 150, offset: 150 } })
    expect(spec.parse({ offset: -1 }).ok).toBe(false)
    expect(spec.parse({ offset: 1.5 }).ok).toBe(false)
  })
})

afterAll(()=>clearJobSpecs())
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks()})
it('executes the current job with native read-only collection and reports actual progress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-reconcile-job-'))
  let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  try {
    postgres = await postgresRuntimeFixture({ dir })
    for (const [key, value] of Object.entries(postgres.env)) vi.stubEnv(key, value)
    vi.stubEnv('NUXT_DB_READONLY', '0')
    const db = usePostgresDirectoryDb()
    const [target] = await db.insert(enterprise).values({ name: 'Native job', nameNorm: 'native job', usccNorm: '91330211255994457P' }).returning()
    await db.insert(record).values({ enterpriseId: target!.id, source: 'miit', titleCode: 'specialized_sme' })
    await updatePostgresCredentialState(db, { 'sme-roster.miitCookie': 'synthetic-job-cookie' })
    const upstream = platformReplay(emptyReply)
    vi.stubGlobal('fetch', upstream.fetchImpl)
    clearJobSpecs()
    registerJobSpecs()
    const progress: number[][] = []
    const result = await getJobSpec('reconcile')!.postgres!.run({
      db, jobId: 'native-reconcile', filesDir: dir, logContext: {},
      signal: new AbortController().signal,
      progress: async (done, total) => { progress.push([done, total]) },
      checkpoint: async () => {},
      cancelled: async () => false,
      trackSubmissions: run => run(queued => expect(queued).toEqual([])),
    }, { titles: ['specialized_sme'], write: false }, undefined)
    expect(result.error).toBeUndefined()
    expect(result.result).toMatchObject({ usccCount: 1, queries: { network: 4, reused: 0 } })
    expect(progress[0]).toEqual([0, 1])
    expect(progress.at(-1)).toEqual([1, 1])
    expect(await db.select().from(platformCollection)).toEqual([])
  } finally {
    await closeApplicationLogging()
    await closePostgresDirectoryDb()
    postgres?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
