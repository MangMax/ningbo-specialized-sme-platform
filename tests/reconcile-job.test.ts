/**
 * `reconcile` 这个 **job kind**(`POST /api/jobs {kind:'reconcile'}`)。
 *
 * `server/utils/job-specs.ts` 里它从票 16 起就登记着 `todo`,本票把它接上:
 * 核心逻辑在 `server/utils/platform-reconcile.ts`,这里只守「入口」那几件事 ——
 * 参数校验发生在**提交那一刻**(错参数同步 400,不是先建一个注定失败的任务)、
 * 进度分母可见、取消是**尽力而为**且保留已完成的部分明细。
 *
 * 平台响应来自夹具(通过 `globalThis.fetch` 注入),凭据用 `MIIT_COOKIE` 环境变量注入;
 * 都不落库、不进日志。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { schema, useDb } from '../db'
import { clearJobSpecs, getJobSpec, jobSpecs, type JobContext, type JobSpec } from '../server/utils/job-runner'
import { registerJobSpecs } from '../server/utils/job-specs'
import { runPlatformReconcile } from '../server/utils/platform-reconcile'
import { EMPTY_APPLY_RESPONSE, platformFixture as fixture, platformReplay, type PlatformCall } from './helpers/platform-replay'

const dir = mkdtempSync(join(tmpdir(), 'spztx-reconcile-job-'))
const db = useDb({ dbPath: join(dir, 'job.db') })
const USCC = '91330211255994457P'

const enterpriseId = db
  .insert(schema.enterprise)
  .values({ name: '宁波上航测绘股份有限公司', nameNorm: '宁波上航测绘股份有限公司', usccNorm: USCC, district: '镇海区' })
  .returning({ id: schema.enterprise.id })
  .get().id
db.insert(schema.record).values({ enterpriseId, source: 'miit', titleCode: 'specialized_sme', district: '镇海区' }).run()

/**
 * 把夹具挂到 `globalThis.fetch` —— job **不接收**注入的 fetch(参数要走 JSON),
 * 它走默认全局,所以这里替掉全局,复用的仍是同一份 `platformReplay` 脚手架。
 */
function stubGlobalFetch(): PlatformCall[] {
  const replay = platformReplay((call: PlatformCall) => ({
    text:
      call.interface === 'business_list'
        ? call.rdjb === '3'
          ? fixture('business-list-rdjb3.html')
          : fixture(`business-list-rdjb${call.rdjb}-empty.html`)
        : EMPTY_APPLY_RESPONSE,
  }))
  vi.stubGlobal('fetch', replay.fetchImpl)
  return replay.calls
}

function clearEvidence() {
  for (const table of [schema.enterpriseAlias, schema.differenceReason, schema.platformRelation, schema.platformQuery, schema.importBatch, schema.job]) {
    db.delete(table).run()
  }
}

beforeEach(() => {
  vi.stubEnv('NUXT_DB_PATH', join(dir, 'job.db'))
  db.delete(schema.serviceCredential).run()
})
afterAll(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('参数校验:错参数在**提交那一刻**就被挡住', () => {
  let spec: JobSpec

  beforeEach(() => {
    clearJobSpecs()
    registerJobSpecs()
    spec = getJobSpec('reconcile')!
  })

  it('接入后 status 是 ready 且带 run 与 paramsHint', () => {
    expect(spec.status).toBe('ready')
    expect(spec.run).toBeTypeOf('function')
    expect(spec.paramsHint).toContain('titles')
    expect(spec.paramsHint).toContain('concurrency')
    expect(jobSpecs().map((entry) => entry.kind)).toEqual(['ocr', 'platform-query-batch', 'reconcile', 'render-pages'])
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

describe('任务执行:进度、报告与取消', () => {
  /** 一个不依赖 job runner 队列的上下文(队列那半边由 `agent-http.test.ts` 守着)。 */
  function context(overrides: Partial<JobContext> = {}): JobContext {
    const progress: [number, number][] = []
    return {
      jobId: 'test-job',
      filesDir: dir,
      db,
      progress: (done, total) => progress.push([done, total]),
      cancelled: () => false,
      ...overrides,
      // @ts-expect-error 测试专用:把记录器挂在上下文上便于断言
      recorded: progress,
    }
  }

  it('跑起来:进度分母是先算出来的目标数,报告落进 result', async () => {
    clearEvidence()
    stubGlobalFetch()
    vi.stubEnv('MIIT_COOKIE', 'zxqy_JSESSIONID=injected')
    const ctx = context()
    const completion = await getJobSpec('reconcile')!.run!(ctx, { titles: ['specialized_sme'] })
    expect(completion.error).toBeUndefined()
    const report = completion.result as Awaited<ReturnType<typeof runPlatformReconcile>>
    expect(report.usccCount).toBe(1)
    expect(report.counts.confirmed).toBe(0)
    expect(report.write!.status).toBe('committed')
    const recorded = (ctx as unknown as { recorded: [number, number][] }).recorded
    expect(recorded[0]).toEqual([0, 1])
    expect(recorded[recorded.length - 1]).toEqual([1, 1])
  })

  it('取消:如实标 cancelled(而不是 done),且不隐瞒已判定的部分', async () => {
    clearEvidence()
    stubGlobalFetch()
    vi.stubEnv('MIIT_COOKIE', 'zxqy_JSESSIONID=injected')
    const completion = await getJobSpec('reconcile')!.run!(context({ cancelled: () => true }), {})
    expect(completion.cancelled).toBe(true)
    expect((completion.result as { cancelled: boolean }).cancelled).toBe(true)
    expect(db.select().from(schema.differenceReason).all()).toHaveLength(0)
  })

  it('无凭据 ⇒ job 失败并说清要设哪个环境变量(不写「一片未查询」的假结果)', async () => {
    clearEvidence()
    stubGlobalFetch()
    vi.stubEnv('MIIT_COOKIE', '')
    await expect(getJobSpec('reconcile')!.run!(context(), {})).rejects.toThrow(/MIIT_COOKIE/)
    expect(db.select().from(schema.platformQuery).all()).toHaveLength(0)
  })
})

it('queued reconcile uses its submission Cookie while subsequent jobs use the replacement and no secrets enter task history or evidence', async () => {
  const { registerJob, submitJob, whenIdle } = await import('../server/utils/job-runner')
  const { getJob } = await import('../server/utils/job-store')
  const { updateCredential } = await import('../server/utils/credential-state')
  clearEvidence(); clearJobSpecs(); registerJobSpecs()
  updateCredential('miitCookie', 'session=synthetic-queued-A', { db, env: {} })
  let release!: () => void
  registerJob({ kind: 'holder', status: 'ready', summary: 'synthetic gate', parse: () => ({ ok: true, params: {} }), run: async () => { await new Promise<void>(r => { release = r }); return { result: {} } } })
  submitJob(db, { kind: 'holder', params: {}, filesDir: dir })
  const seen: boolean[] = []
  let expected = 'session=synthetic-queued-A'
  vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
    seen.push(init.headers.Cookie === expected)
    updateCredential('miitCookie', 'session=synthetic-new-B', { db, env: {} })
    return { ok: true, status: 200, text: async () => url.includes('businessList') ? fixture('business-list-rdjb1-empty.html') : EMPTY_APPLY_RESPONSE }
  })
  const queued = submitJob(db, { kind: 'reconcile', params: { write: false }, filesDir: dir })
  updateCredential('miitCookie', 'session=synthetic-new-B', { db, env: {} })
  release(); await whenIdle()
  expect(getJob(db, queued.id)?.state).toBe('done')
  expect(seen).toEqual([true, true, true, true])
  expected = 'session=synthetic-new-B'
  submitJob(db, { kind: 'reconcile', params: { write: false }, filesDir: dir }); await whenIdle()
  expect(seen).toEqual(Array(8).fill(true))
  const serialized = JSON.stringify({ jobs: db.select().from(schema.job).all(), queries: db.select().from(schema.platformQuery).all(), relations: db.select().from(schema.platformRelation).all() })
  expect(serialized.includes('synthetic-queued-A') || serialized.includes('synthetic-new-B')).toBe(false)
})
it('persists only sanitized platform failure evidence and never turns expired sessions into no_record', async () => {
  const { updateCredential } = await import('../server/utils/credential-state')
  clearEvidence(); clearJobSpecs(); registerJobSpecs()
  const secret = 'session=synthetic-persisted-failure'
  updateCredential('miitCookie', secret, { db, env: {} })
  vi.stubGlobal('fetch', async () => ({ ok: false, status: 403, text: async () => `${secret} not authorized` }))
  const ctx: JobContext = { db, filesDir: dir, jobId: 'synthetic-failure', progress: () => {}, cancelled: () => false }
  const failed = await getJobSpec('reconcile')!.run!(ctx, { write: true })
  expect((failed.result as { counts: { queryFailed: number; noRecord: number } }).counts).toMatchObject({ queryFailed: 1, noRecord: 0 })
  expect(db.select().from(schema.platformQuery).all()).toHaveLength(4)
  expect(JSON.stringify({ jobs: db.select().from(schema.job).all(), queries: db.select().from(schema.platformQuery).all(), relations: db.select().from(schema.platformRelation).all() }).includes(secret)).toBe(false)
  clearEvidence()
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => '<html><form id="loginForm"><input name="j_password" type="password"></form></html>' }))
  const expired = await getJobSpec('reconcile')!.run!(ctx, { write: true })
  expect((expired.result as { counts: { queryFailed: number; noRecord: number } }).counts).toMatchObject({ queryFailed: 1, noRecord: 0 })
  expect(db.select().from(schema.platformQuery).all().every(row => row.status === 'failed')).toBe(true)
})
it('persists sanitized successful raw platform responses without credential echoes', async () => {
  const { updateCredential } = await import('../server/utils/credential-state')
  clearEvidence(); clearJobSpecs(); registerJobSpecs()
  const secret = 'session=synthetic-success-evidence'
  updateCredential('miitCookie', secret, { db, env: {} })
  vi.stubGlobal('fetch', async (url: string) => ({ ok: true, status: 200, text: async () => url.includes('businessList') ? fixture('business-list-rdjb1-empty.html') + `<!--${secret}-->` : EMPTY_APPLY_RESPONSE }))
  const result = await getJobSpec('reconcile')!.run!({ db, filesDir: dir, jobId: 'synthetic-success', progress: () => {}, cancelled: () => false }, { write: true })
  expect((result.result as { counts: { noRecord: number } }).counts.noRecord).toBe(1)
  expect(db.select().from(schema.platformQuery).all()).toHaveLength(4)
  expect(JSON.stringify({ jobs: db.select().from(schema.job).all(), queries: db.select().from(schema.platformQuery).all(), relations: db.select().from(schema.platformRelation).all() }).includes(secret)).toBe(false)
})
