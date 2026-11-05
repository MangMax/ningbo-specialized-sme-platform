import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createNitro } from 'nitropack'
import {
  JOB_ID_RE,
  JOB_STATES,
  isJobId,
  isTerminalJobState,
  makeProgress,
  newJobId,
  normalizeJobParams,
  progressPercent,
  type JobState,
} from '../lib/job'
import {
  readApiToken,
  resolveApiAuth,
  specLeaksToken,
  unauthorizedApiMessage,
} from '../server/utils/api-auth'
import {
  __resetJobRunner,
  clearJobSpecs,
  ensureJobRunnerReady,
  getJobSpec,
  jobSpecs,
  registerJob,
  requestJobCancel,
  submitJob,
  whenIdle,
  type JobContext,
  type JobSpec,
} from '../server/utils/job-runner'
import {
  createJob,
  finishJob,
  getJob,
  listJobs,
  markJobRunning,
  reconcileInterruptedJobs,
  setJobProgress,
  toJobDto,
} from '../server/utils/job-store'
import { parseCsvQuery } from '../lib/csv'
import { parseRenderPagesParams } from '../server/utils/jobs/render-pages'
import { shouldHideOpenApiPath } from '../server/utils/openapi-guard'
import { registerJobSpecs } from '../server/utils/job-specs'
import { minimalPdf } from './helpers/minimal-pdf'

/**
 * 票 19 —— 面向代理的 HTTP 能力面(异步任务)+ Nitro 内建 OpenAPI。
 *
 * 分四层测:
 *
 *  1. **纯规则**(`lib/job.ts`)—— ULID 形状与可排序性、进度的向下取整、参数归一;
 *  2. **库**(`job-store.ts`)—— 状态迁移的守卫、按 kind/state 查、重启对账;
 *  3. **执行面**(`job-runner.ts`)—— 注册表、**串行队列**(并发语义)、取消的三种情形、
 *     部分失败 / 被取消时**保留部分产出**;
 *  4. **鉴权**(`api-auth.ts`)—— 与票 18 同一套判据,换成 HTTP 的头名;
 *  5. **OpenAPI 的暴露面** —— 用 `createNitro` 直接问 nitro 自己:**开发注册、
 *     生产不注册**。这比「构建一次再看 404」快得多,且判的是同一件事。
 *
 * 端到端(真提交任务、真渲染、真重启)走**真实服务**,证据写在票 19 里 ——
 * 那些要跑 pdfium + 真 PDF,不适合放进单测(票 13 已用自造夹具覆盖了渲染本身)。
 */

// ---------------------------------------------------------------------------
// 1. 纯规则:状态 / 进度 / id / 参数
// ---------------------------------------------------------------------------

describe('lib/job 纯规则', () => {
  it('状态只有五个,终态是 done / failed / cancelled', () => {
    expect([...JOB_STATES]).toEqual(['queued', 'running', 'done', 'failed', 'cancelled'])
    expect(isTerminalJobState('queued')).toBe(false)
    expect(isTerminalJobState('running')).toBe(false)
    for (const s of ['done', 'failed', 'cancelled'] as JobState[]) {
      expect(isTerminalJobState(s)).toBe(true)
    }
  })

  it('进度是 {done,total} 而不是百分数 —— 百分数由 progressPercent 现算', () => {
    expect(makeProgress(0, 3)).toEqual({ done: 0, total: 3 })
    // total 缺失 / 非法按 1 算(通用任务是 0% → 100% 两档)。
    expect(makeProgress(0, 0)).toEqual({ done: 0, total: 1 })
    expect(makeProgress(0, Number.NaN)).toEqual({ done: 0, total: 1 })
    // done 被夹在 total 之内(进度不会超过分母)。
    expect(makeProgress(9, 3)).toEqual({ done: 3, total: 3 })
    expect(makeProgress(-1, 3)).toEqual({ done: 0, total: 3 })
  })

  it('百分比**向下**取整 —— 只有真做完才是 100', () => {
    expect(progressPercent({ done: 0, total: 3 })).toBe(0)
    expect(progressPercent({ done: 1, total: 3 })).toBe(33)
    expect(progressPercent({ done: 2, total: 3 })).toBe(66)
    expect(progressPercent({ done: 3, total: 3 })).toBe(100)
    // 这两条正是不能用 round 的原因:99.5% 与 99.75% 都会被 round 成 100。
    expect(progressPercent({ done: 199, total: 200 })).toBe(99)
    expect(progressPercent({ done: 399, total: 400 })).toBe(99)
    // 空批量不做除法。
    expect(progressPercent({ done: 0, total: 0 })).toBe(0)
  })

  it('任务 id 是 26 位 Crockford base32,且**字典序 == 时间序**', () => {
    const id = newJobId()
    expect(id).toHaveLength(26)
    expect(JOB_ID_RE.test(id)).toBe(true)
    // Crockford 去掉了 I / L / O / U —— 它们不出现,免得与 1 / 0 混。
    expect(/[ILOU]/.test(id)).toBe(false)

    // 时间前缀让 id 可排序:同一毫秒的随机部分不影响「后生成的更大」。
    const t = 1_800_000_000_000
    const early = newJobId(t)
    const late = newJobId(t + 1)
    expect(early < late).toBe(true)
    expect(early.slice(0, 10)).toBe(newJobId(t).slice(0, 10))
  })

  it('id 形状校验只判形状(查无此任务是另一回事)', () => {
    expect(isJobId(newJobId())).toBe(true)
    expect(isJobId('01M4X446940XV2D8N0KBDQ2YCN')).toBe(true)
    for (const bad of ['', 'abc', '01M4X446940XV2D8N0KBDQ2YC', '01M4X446940XV2D8N0KBDQ2YCN!', 42, null, undefined]) {
      expect(isJobId(bad)).toBe(false)
    }
  })

  it('params 归一:缺省 = 空对象;数组与标量一律拒', () => {
    expect(normalizeJobParams(undefined)).toEqual({ ok: true, params: {} })
    expect(normalizeJobParams(null)).toEqual({ ok: true, params: {} })
    expect(normalizeJobParams({ a: 1 })).toEqual({ ok: true, params: { a: 1 } })
    expect(normalizeJobParams([1, 2]).ok).toBe(false)
    expect(normalizeJobParams('x').ok).toBe(false)
    expect(normalizeJobParams(3).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. render-pages 的参数校验(提交时就跑,错了得到同步 400)
// ---------------------------------------------------------------------------

describe('render-pages 参数校验', () => {
  const ok = (raw: Record<string, unknown>) => {
    const r = parseRenderPagesParams(raw)
    if (!r.ok) throw new Error(`本应通过:${r.message}`)
    return r.params
  }
  const fail = (raw: Record<string, unknown>) => {
    const r = parseRenderPagesParams(raw)
    if (r.ok) throw new Error('本应失败')
    return r.message
  }

  it('files 必须是非空数组,每项是非空字符串的 PDF 路径', () => {
    expect(fail({})).toContain('非空数组')
    expect(fail({ files: [] })).toContain('非空数组')
    expect(fail({ files: 'a.pdf' })).toContain('非空数组')
    expect(fail({ files: [1] })).toContain('非空字符串')
    expect(fail({ files: ['   '] })).toContain('非空字符串')
    expect(fail({ files: ['jxj/announcement/2024/1/a.xlsx'] })).toContain('不是 PDF')
    // 路径两端的空白被修掉(代理拼字符串时常带)。
    expect(ok({ files: ['  a.pdf '] }).files).toEqual(['a.pdf'])
  })

  it('dpi 走票 13 的同一套校验(越界抛错,不静默纠正)', () => {
    expect(ok({ files: ['a.pdf'] }).dpi).toBe(300)
    expect(ok({ files: ['a.pdf'], dpi: 400 }).dpi).toBe(400)
    expect(fail({ files: ['a.pdf'], dpi: 10 })).toContain('分辨率')
    expect(fail({ files: ['a.pdf'], dpi: 'abc' })).toContain('分辨率')
  })

  it('force 只收布尔', () => {
    expect(ok({ files: ['a.pdf'] }).force).toBe(false)
    expect(ok({ files: ['a.pdf'], force: true }).force).toBe(true)
    expect(fail({ files: ['a.pdf'], force: 'yes' })).toContain('布尔')
  })
})

// ---------------------------------------------------------------------------
// 3. 注册表
// ---------------------------------------------------------------------------

describe('任务种类注册表', () => {
  beforeEach(() => clearJobSpecs())

  it('登记后可查、可列出(按名字排序)', () => {
    registerJob({ kind: 'b', status: 'todo', summary: 'b', parse: (r) => ({ ok: true, params: r }) })
    registerJob({ kind: 'a', status: 'todo', summary: 'a', parse: (r) => ({ ok: true, params: r }) })
    expect(getJobSpec('a')?.kind).toBe('a')
    expect(jobSpecs().map((s) => s.kind)).toEqual(['a', 'b'])
    expect(getJobSpec('nope')).toBeUndefined()
  })

  it('同名重复登记**抛错**(静默覆盖会让「注册了但跑的是另一个」很难查)', () => {
    const spec: JobSpec = { kind: 'x', status: 'todo', summary: 'x', parse: (r) => ({ ok: true, params: r }) }
    registerJob(spec)
    expect(() => registerJob(spec)).toThrow(/重复登记/)
  })

  it('生产登记表:三个 kind 都已接入(reconcile 由 RL-03 收尾切片接上)', () => {
    registerJobSpecs()
    const kinds = jobSpecs()
    expect(kinds.map((s) => s.kind)).toEqual(['current-roster-export', 'event-annual-correspondence', 'event-archive-candidates', 'ocr', 'platform-query-batch', 'reconcile', 'render-pages'])
    // 票 14 把 ocr 从 todo 接上了;RL-03 收尾把 reconcile 也接上了(核心逻辑搬进 app)。
    // 三个已接入的 kind 都要有 run。
    for (const k of ['render-pages', 'ocr', 'reconcile']) {
      expect(getJobSpec(k)!.status).toBe('ready')
      expect(getJobSpec(k)!.run).toBeTypeOf('function')
    }
    // 「怎么拼 params」是给代理看的,不能只报名字。
    expect(getJobSpec('reconcile')!.paramsHint).toMatch(/titles/)
    // 幂等:重复调用不会撞「重复登记」。
    expect(() => registerJobSpecs()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 4. 库:状态迁移 / 查询 / 重启对账
// ---------------------------------------------------------------------------

let dbDir: string
let db: ReturnType<(typeof import('../db'))['useDb']>
let schema: typeof import('../db')['schema']

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'spztx-jobs-'))
  process.env.NUXT_DB_PATH = join(dbDir, 'test.db')
  const mod = await import('../db')
  db = mod.initializeDb({ create: true })
  schema = mod.schema
})

afterAll(() => rmSync(dbDir, { recursive: true, force: true }))

describe('job 表与状态迁移', () => {
  it('迁移 0004 建出 job 表,列为票 19 定的那些', () => {
    const cols = db
      .select()
      .from(schema.job)
      .all()
      .length
    expect(cols).toBe(0)
    // 直接问 SQLite:表存在、列齐全(迁移真跑过了)。
    const info = db.$client.prepare('pragma table_info(job)').all() as Array<{ name: string }>
    expect(info.map((c) => c.name).sort()).toEqual([
      'created_at',
      'error',
      'finished_at',
      'id',
      'kind',
      'params',
      'progress',
      'result',
      'started_at',
      'state',
    ])
  })

  it('createJob → 行落库,state=queued,progress 是 {done,total}', () => {
    const id = newJobId(1_800_000_100_000)
    const row = createJob(db, {
      id,
      kind: 'unit',
      params: { a: 1 },
      progress: { done: 0, total: 5 },
    })
    expect(row.id).toBe(id)
    expect(row.state).toBe('queued')
    expect(row.progress).toEqual({ done: 0, total: 5 })
    expect(row.params).toEqual({ a: 1 })
    expect(row.result).toBeNull()
    expect(row.error).toBeNull()
    expect(row.startedAt).toBeNull()
    expect(row.finishedAt).toBeNull()
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('markJobRunning 只从 queued 出发 —— 已被标失败的行不会被「复活」', () => {
    const id = newJobId(1_800_000_200_000)
    createJob(db, { id, kind: 'unit', params: {} })

    const running = markJobRunning(db, id)
    expect(running?.state).toBe('running')
    expect(running?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // 已经是 running 了,再 mark 一次**不认领**(返回 null)—— 这条守卫防的是
    // 「两个消费者同时把同一行捡起来跑」。
    expect(markJobRunning(db, id)).toBeNull()
    // started_at 也没被刷新。
    expect(getJob(db, id)!.startedAt).toBe(running?.startedAt)

    // 收尾成 failed 之后,markJobRunning 不再认领它。
    finishJob(db, id, { state: 'failed', error: '炸了' })
    expect(markJobRunning(db, id)).toBeNull()
  })

  it('finishJob 只从非终态出发(终态不被回退 / 覆盖)', () => {
    const id = newJobId(1_800_000_300_000)
    createJob(db, { id, kind: 'unit', params: {} })
    finishJob(db, id, { state: 'done', result: { v: 1 } })
    const done = getJob(db, id)!
    expect(done.state).toBe('done')
    expect(done.result).toEqual({ v: 1 })
    expect(done.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // 再收一次:不改状态,也不改 result。
    finishJob(db, id, { state: 'cancelled', error: '晚了' })
    const after = getJob(db, id)!
    expect(after.state).toBe('done')
    expect(after.result).toEqual({ v: 1 })
    expect(after.error).toBeNull()
  })

  it('setJobProgress 不碰终态(取消之后进度不会往回跳)', () => {
    const id = newJobId(1_800_000_400_000)
    createJob(db, { id, kind: 'unit', params: {}, progress: { done: 0, total: 4 } })
    setJobProgress(db, id, { done: 2, total: 4 })
    expect(getJob(db, id)!.progress).toEqual({ done: 2, total: 4 })

    finishJob(db, id, { state: 'cancelled', error: '停了' })
    setJobProgress(db, id, { done: 4, total: 4 })
    expect(getJob(db, id)!.progress).toEqual({ done: 2, total: 4 })
  })

  it('toJobDto:percent 是派生量,result/error 缺省给 null 而不是省略', () => {
    const id = newJobId(1_800_000_500_000)
    createJob(db, { id, kind: 'unit', params: {}, progress: { done: 1, total: 3 } })
    const dto = toJobDto(getJob(db, id)!)
    expect(dto.percent).toBe(33)
    expect(dto.progress).toEqual({ done: 1, total: 3 })
    expect(dto.result).toBeNull()
    expect(dto.error).toBeNull()
    expect(dto.startedAt).toBeNull()
  })
})

describe('listJobs:按 kind / state 查(JSON 文件做不到的那件事)', () => {
  let base: number
  beforeAll(() => {
    // 造 6 条:3 个 kind × 状态混合。用确定的时间戳让排序可断言。
    base = 1_800_001_000_000
    const rows: Array<[string, JobState, number]> = [
      ['alpha', 'queued', 0],
      ['alpha', 'running', 1],
      ['alpha', 'done', 2],
      ['beta', 'done', 3],
      ['beta', 'failed', 4],
      ['gamma', 'cancelled', 5],
    ]
    for (const [kind, state, offset] of rows) {
      const id = newJobId(base + offset * 1000)
      createJob(db, { id, kind, params: {}, progress: { done: 0, total: 1 } })
      if (state === 'queued') continue
      markJobRunning(db, id)
      if (state === 'running') continue
      finishJob(db, id, { state: state as 'done' | 'failed' | 'cancelled' })
    }
  })

  it('不筛 = 全部,按创建时间**倒序**(新的在前)', () => {
    const { rows, total } = listJobs(db, { kind: ['alpha', 'beta', 'gamma'], limit: 100 })
    expect(total).toBe(6)
    // gamma(最后创建)在最前;同 kind 内后建的在前。
    expect(rows.map((r) => `${r.kind}:${r.state}`)).toEqual([
      'gamma:cancelled',
      'beta:failed',
      'beta:done',
      'alpha:done',
      'alpha:running',
      'alpha:queued',
    ])
  })

  it('按 state 筛(多值命中任一)', () => {
    // 同一个库里还有别的 describe 造的行,所以这里**连 kind 一起限定**,
    // 断言才只说自己这组(否则就是在数整个文件的历史)。
    const { rows, total } = listJobs(db, {
      kind: ['alpha', 'beta', 'gamma'],
      state: ['queued', 'running'],
      limit: 100,
    })
    expect(total).toBe(2)
    expect(rows.map((r) => r.state).sort()).toEqual(['queued', 'running'])
  })

  it('按 kind 筛', () => {
    const { total } = listJobs(db, { kind: ['beta'], limit: 100 })
    expect(total).toBe(2)
  })

  it('kind + state 同时筛,以及 limit 只截返回、不截 total', () => {
    const { rows, total } = listJobs(db, { kind: ['alpha'], state: ['done'], limit: 100 })
    expect(total).toBe(1)
    expect(rows[0]!.state).toBe('done')

    const limited = listJobs(db, { kind: ['alpha'], limit: 1 })
    expect(limited.rows).toHaveLength(1)
    expect(limited.total).toBe(3)
  })
})

describe('reconcileInterruptedJobs:重启对账', () => {
  it('把 queued / running 标失败,**不动**终态;再跑一次是空操作', () => {
    const t = 1_800_002_000_000
    const mk = (kind: string, offset: number, state: JobState) => {
      const id = newJobId(t + offset * 1000)
      createJob(db, { id, kind, params: {} })
      if (state === 'queued') return id
      markJobRunning(db, id)
      if (state !== 'running') finishJob(db, id, { state: state as 'done' | 'failed' | 'cancelled' })
      return id
    }
    const queued = mk('crash', 0, 'queued')
    const running = mk('crash', 1, 'running')
    const done = mk('crash', 2, 'done')

    // 只统计本组的三个(库里还有别的用例造的行)。
    const before = db.$client.prepare('select count(*) n from job').get() as { n: number }
    const n = reconcileInterruptedJobs(db)
    expect(n).toBeGreaterThanOrEqual(2)

    expect(getJob(db, queued)!.state).toBe('failed')
    expect(getJob(db, queued)!.error).toContain('服务重启')
    expect(getJob(db, queued)!.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(getJob(db, running)!.state).toBe('failed')
    // 终态不动。
    expect(getJob(db, done)!.state).toBe('done')
    expect(getJob(db, done)!.error).toBeNull()
    // 行数不变(是标记,不是删除)。
    expect(db.$client.prepare('select count(*) n from job').get()).toEqual(before)

    // 再跑一次:没有可标的了。
    expect(reconcileInterruptedJobs(db)).toBe(0)
  })

  it('ensureJobRunnerReady 按 **db 实例**只对一次账', async () => {
    const other = mkdtempSync(join(tmpdir(), 'spztx-jobs-ready-'))
    const prev = process.env.NUXT_DB_PATH
    process.env.NUXT_DB_PATH = join(other, 'other.db')
    const mod = await import('../db')
    const fresh = mod.initializeDb({ create: true })

    const id = newJobId(1_800_003_000_000)
    createJob(fresh, { id, kind: 'unit', params: {} })

    expect(ensureJobRunnerReady(fresh)).toBe(1)
    expect(getJob(fresh, id)!.state).toBe('failed')
    // 第二次:已经对过,返回 0(不会再去扫一遍)。
    expect(ensureJobRunnerReady(fresh)).toBe(0)

    process.env.NUXT_DB_PATH = prev
    rmSync(other, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// 5. 执行面:串行队列 / 取消 / 部分失败
// ---------------------------------------------------------------------------

/** 可控的测试 kind:run 里 `await gate` 由用例自己放行。 */
function controllableKind(name: string) {
  let release: (() => void) | null = null
  let started = 0
  const gate = () => new Promise<void>((r) => (release = r))
  const spec: JobSpec = {
    kind: name,
    status: 'ready',
    summary: '测试用',
    parse: (raw) => ({ ok: true, params: raw }),
    total: (params) => Number(params.total ?? 1),
    run: async (ctx: JobContext) => {
      started += 1
      const progress = ctx.progress
      progress(started, started + 1)
      await gate()
      return { result: { ok: true } }
    },
  }
  return {
    spec,
    open: () => release?.(),
    startedCount: () => started,
  }
}

/** A kind can start several runs before a shared gate opens. */
function controllableConcurrentKind(name: string, startBarrierCount = 2) {
  let open = false
  let started = 0
  const waiters: Array<() => void> = []
  let resolveStartBarrier: (() => void) | null = null
  const startBarrier = new Promise<void>((resolve) => (resolveStartBarrier = resolve))
  const spec: JobSpec = {
    kind: name,
    status: 'ready',
    summary: '测试用',
    parse: (raw) => ({ ok: true, params: raw }),
    run: async () => {
      started += 1
      if (started >= startBarrierCount) resolveStartBarrier?.()
      if (!open) await new Promise<void>((resolve) => waiters.push(resolve))
      return { result: { ok: true } }
    },
  }
  return {
    spec,
    open: () => {
      open = true
      for (const release of waiters.splice(0)) release()
    },
    startBarrier,
    startedCount: () => started,
  }
}

describe('串行队列与并发语义', () => {
  let filesDir: string
  beforeEach(() => {
    __resetJobRunner()
    clearJobSpecs()
    filesDir = dbDir
  })

  it('两个任务连着提交:一个 running、一个 queued —— **不会同时跑**', async () => {
    const gate = controllableKind('gated')
    registerJob(gate.spec)

    const a = submitJob(db, { kind: 'gated', params: { total: 1 }, filesDir, id: newJobId(1_800_010_000_000) })
    const b = submitJob(db, { kind: 'gated', params: { total: 1 }, filesDir, id: newJobId(1_800_010_001_000) })

    // 让第一个任务真的进到 run 里(gate 挡住它)。
    await new Promise((r) => setTimeout(r, 20))
    expect(getJob(db, a.id)!.state).toBe('running')
    // 第二个仍在排队 —— 这就是「不互相破坏」的可观测形式。
    expect(getJob(db, b.id)!.state).toBe('queued')
    expect(gate.startedCount()).toBe(1)

    gate.open()
    await new Promise((r) => setTimeout(r, 20))
    // 第一个跑完,第二个才被捡起来(此时它也卡在 gate 上,已是 running)。
    expect(getJob(db, a.id)!.state).toBe('done')
    expect(getJob(db, b.id)!.state).toBe('running')
    expect(gate.startedCount()).toBe(2)

    gate.open()
    await whenIdle()
    expect(getJob(db, b.id)!.state).toBe('done')
  })

  it('最多 4 个 OCR job 并行,非 OCR job 等 OCR 清空后再运行', async () => {
    const gate = controllableConcurrentKind('ocr', 4)
    let nonOcrStarted = 0
    registerJob(gate.spec)
    registerJob({
      kind: 'render-pages',
      status: 'ready',
      summary: '测试用',
      parse: (raw) => ({ ok: true, params: raw }),
      run: async () => {
        nonOcrStarted += 1
        return { result: {} }
      },
    })

    const ocrJobs = Array.from({ length: 5 }, (_, index) =>
      submitJob(db, {
        kind: 'ocr',
        params: {},
        filesDir,
        id: newJobId(1_800_010_100_000 + index * 1000),
      }),
    )
    const render = submitJob(db, { kind: 'render-pages', params: {}, filesDir, id: newJobId(1_800_010_200_000) })

    try {
      const bothStarted = await Promise.race([
        gate.startBarrier.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ])
      expect(bothStarted).toBe(true)
      expect(gate.startedCount()).toBe(4)
      expect(ocrJobs.slice(0, 4).every((job) => getJob(db, job.id)!.state === 'running')).toBe(true)
      expect(getJob(db, ocrJobs[4]!.id)!.state).toBe('queued')
      expect(getJob(db, render.id)!.state).toBe('queued')
      expect(nonOcrStarted).toBe(0)
    } finally {
      gate.open()
      await whenIdle()
    }

    expect(getJob(db, render.id)!.state).toBe('done')
    expect(ocrJobs.every((job) => getJob(db, job.id)!.state === 'done')).toBe(true)
    expect(nonOcrStarted).toBe(1)
  })

  it('run 抛错 → 任务 failed 并记下原因;后续任务照常跑', async () => {
    registerJob({
      kind: 'boom',
      status: 'ready',
      summary: '测试用',
      parse: (r) => ({ ok: true, params: r }),
      run: async () => {
        throw new Error('渲染失败:加密的 PDF')
      },
    })
    registerJob({ kind: 'fine', status: 'ready', summary: '测试用', parse: (r) => ({ ok: true, params: r }), run: async () => ({ result: { ok: 1 } }) })

    const bad = submitJob(db, { kind: 'boom', params: {}, filesDir, id: newJobId(1_800_011_000_000) })
    const good = submitJob(db, { kind: 'fine', params: {}, filesDir, id: newJobId(1_800_011_001_000) })
    await whenIdle()

    const badRow = getJob(db, bad.id)!
    expect(badRow.state).toBe('failed')
    expect(badRow.error).toBe('渲染失败:加密的 PDF')
    expect(badRow.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // 一个失败不拖垮后面的。
    expect(getJob(db, good.id)!.state).toBe('done')
  })

  it('handler 报部分失败(error + result)→ 状态 failed,但**产出保留**', async () => {
    registerJob({
      kind: 'partial',
      status: 'ready',
      summary: '测试用',
      parse: (r) => ({ ok: true, params: r }),
      run: async () => ({
        result: { files: [{ ok: true }, { ok: false }], ok: 1, failed: 1 },
        error: '2 份里 1 份失败',
      }),
    })
    const j = submitJob(db, { kind: 'partial', params: {}, filesDir, id: newJobId(1_800_012_000_000) })
    await whenIdle()

    const row = getJob(db, j.id)!
    expect(row.state).toBe('failed')
    expect(row.error).toBe('2 份里 1 份失败')
    // 关键:失败路径**没有丢掉**已经做出来的那部分。
    expect(row.result).toEqual({ files: [{ ok: true }, { ok: false }], ok: 1, failed: 1 })
  })

  it('handler 自己带 cancelled 收尾 → 状态 cancelled,且 result 是**部分产出**', async () => {
    registerJob({
      kind: 'selfcancel',
      status: 'ready',
      summary: '测试用',
      parse: (r) => ({ ok: true, params: r }),
      run: async () => ({
        result: { files: [{ ok: true }], done: 1, cancelled: true },
        cancelled: true,
      }),
    })
    const j = submitJob(db, { kind: 'selfcancel', params: {}, filesDir, id: newJobId(1_800_013_000_000) })
    await whenIdle()

    const row = getJob(db, j.id)!
    expect(row.state).toBe('cancelled')
    expect(row.error).toContain('尽力而为')
    expect(row.result).toEqual({ files: [{ ok: true }], done: 1, cancelled: true })
    // 进度**不被顶到分母** —— 停在 0/1 是它真实的进度(顶成 1/1 就是说谎)。
    expect(row.progress).toEqual({ done: 0, total: 1 })
  })

  it('排队中的取消是真的取消 —— 从队列摘掉,任务从头到尾没跑过', async () => {
    let ran = false
    registerJob({
      kind: 'never-runs',
      status: 'ready',
      summary: '测试用',
      parse: (r) => ({ ok: true, params: r }),
      run: async () => {
        ran = true
        return { result: {} }
      },
    })
    const gate = controllableKind('hold')
    registerJob(gate.spec)

    // 先占住队列,再提交要取消的那个(于是后者必然停在 queued)。
    const holder = submitJob(db, { kind: 'hold', params: {}, filesDir, id: newJobId(1_800_014_000_000) })
    const target = submitJob(db, { kind: 'never-runs', params: {}, filesDir, id: newJobId(1_800_014_001_000) })
    await new Promise((r) => setTimeout(r, 20))
    expect(getJob(db, target.id)!.state).toBe('queued')

    const out = requestJobCancel(db, target.id)
    expect(out.ok).toBe(true)
    expect(out.ok && out.cancelled).toBe(true)
    expect(getJob(db, target.id)!.state).toBe('cancelled')

    gate.open()
    await whenIdle()
    expect(getJob(db, holder.id)!.state).toBe('done')
    // 被摘掉的那个从头到尾没跑过。
    expect(ran).toBe(false)
    expect(getJob(db, target.id)!.state).toBe('cancelled')
    expect(getJob(db, target.id)!.error).toContain('未执行')
  })

  it('运行中的取消:handler 在下一个检查点停下(尽力而为)', async () => {
    let reachedCheckpoint = false
    registerJob({
      kind: 'checkpoint',
      status: 'ready',
      summary: '测试用',
      parse: (r) => ({ ok: true, params: r }),
      run: async (ctx) => {
        await new Promise((r) => setTimeout(r, 10))
        if (ctx.cancelled()) {
          reachedCheckpoint = true
          return { result: { stopped: true }, cancelled: true }
        }
        return { result: { stopped: false } }
      },
    })

    const j = submitJob(db, { kind: 'checkpoint', params: {}, filesDir, id: newJobId(1_800_015_000_000) })
    // 立刻请求取消(它此刻在跑)。
    const out = requestJobCancel(db, j.id)
    expect(out.ok).toBe(true)
    expect(out.ok && 'cancelRequested' in out && out.cancelRequested).toBe(true)
    // 此时**还没**变 cancelled —— 得等 handler 走到检查点。
    expect(getJob(db, j.id)!.state).toBe('running')

    await whenIdle()
    expect(reachedCheckpoint).toBe(true)
    expect(getJob(db, j.id)!.state).toBe('cancelled')
  })

  it('取消已结束的任务:如实回报,不报错', async () => {
    registerJob({ kind: 'fast', status: 'ready', summary: '测试用', parse: (r) => ({ ok: true, params: r }), run: async () => ({ result: {} }) })
    const j = submitJob(db, { kind: 'fast', params: {}, filesDir, id: newJobId(1_800_016_000_000) })
    await whenIdle()

    const out = requestJobCancel(db, j.id)
    expect(out.ok).toBe(true)
    expect(out.ok && 'alreadyFinished' in out && out.alreadyFinished).toBe(true)
    expect(out.ok && out.cancelled).toBe(false)
    expect(out.ok && out.note).toContain('无法取消')
    expect(getJob(db, j.id)!.state).toBe('done')
  })

  it('取消不存在的任务:ok=false,带中文原因(路由转成 404)', () => {
    const out = requestJobCancel(db, '01M4X00000000000000000000Z')
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.message).toContain('任务不存在')
  })

  it('提交时未登记 / 尚未接入的 kind 直接抛(路由先判,这里是兜底)', () => {
    expect(() => submitJob(db, { kind: 'nope', params: {}, filesDir })).toThrow(/未登记/)
    registerJob({ kind: 'todo-kind', status: 'todo', summary: 'x', parse: (r) => ({ ok: true, params: r }) })
    expect(() => submitJob(db, { kind: 'todo-kind', params: {}, filesDir })).toThrow(/尚未接入/)
  })
})

describe('lib/csv —— 多值查询参数的解析规则(抽出来的那一份)', () => {
  it('逗号分隔与重复参数都认,空项剔除', () => {
    expect(parseCsvQuery('a,b')).toEqual(['a', 'b'])
    expect(parseCsvQuery(['a', 'b'])).toEqual(['a', 'b'])
    expect(parseCsvQuery(['a,b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(parseCsvQuery(' a , b ')).toEqual(['a', 'b'])
  })

  it('没有有效项时返回 undefined —— 「没筛」与「筛了个空的」不是一回事', () => {
    expect(parseCsvQuery(undefined)).toBeUndefined()
    expect(parseCsvQuery(null)).toBeUndefined()
    expect(parseCsvQuery('')).toBeUndefined()
    expect(parseCsvQuery('  ')).toBeUndefined()
    expect(parseCsvQuery(',,')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 6. 鉴权(HTTP 面的头名)
// ---------------------------------------------------------------------------

describe('api-auth 鉴权判据', () => {
  it('readApiToken 认 Bearer / 裸 token / X-API-Token;取不到给 null', () => {
    expect(readApiToken({ authorization: 'Bearer abc' })).toBe('abc')
    expect(readApiToken({ authorization: 'bearer abc' })).toBe('abc')
    expect(readApiToken({ authorization: 'abc' })).toBe('abc')
    expect(readApiToken({ 'x-api-token': 'abc' })).toBe('abc')
    expect(readApiToken({ authorization: 'Bearer abc', 'x-api-token': 'zzz' })).toBe('abc')
    for (const h of [undefined, {}, { authorization: '' }, { authorization: '  ' }, { authorization: 'Bearer' }]) {
      expect(readApiToken(h as never)).toBeNull()
    }
  })

  it('resolveApiAuth 把「没配 / 没带 / 带错 / 带对」分得开', () => {
    expect(resolveApiAuth({ given: null, configured: '' }).reason).toBe('no-token-configured')
    expect(resolveApiAuth({ given: null, configured: undefined }).reason).toBe('no-token-configured')
    expect(resolveApiAuth({ given: null, configured: 's' }).reason).toBe('token-missing')
    expect(resolveApiAuth({ given: 'wrong', configured: 's' }).reason).toBe('token-invalid')
    expect(resolveApiAuth({ given: 's', configured: 's' })).toEqual({ writeAuthorized: true, reason: 'authorized' })
    // 反向默认:服务端没配 = 写/任务类整体关闭,即便请求带了 token。
    expect(resolveApiAuth({ given: 'anything', configured: '' }).writeAuthorized).toBe(false)
    // 「配了个空串」不等于「人人可写」。
    expect(resolveApiAuth({ given: '', configured: '' }).writeAuthorized).toBe(false)
  })

  it('拒绝文案说清是哪一种没带', () => {
    expect(unauthorizedApiMessage('no-token-configured')).toContain('NUXT_API_TOKEN')
    expect(unauthorizedApiMessage('token-missing')).toContain('未带 token')
    expect(unauthorizedApiMessage('token-invalid')).toContain('不匹配')
  })

  it('★ 密钥不进 spec:specLeaksToken 能判出来,且对占位文案不误报', () => {
    const secret = 'super-secret-token-value'
    // 泄露了:spec 里出现了真 token。
    expect(specLeaksToken({ paths: { '/x': { get: { example: secret } } } }, secret)).toBe(true)
    expect(specLeaksToken(JSON.stringify({ a: { b: secret } }), secret)).toBe(true)
    // 没泄露:只有**占位文案**(头名与「<token>」这种说明),这是 spec 里应该有的样子。
    const placeholderSpec = {
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', description: '`NUXT_API_TOKEN` 的值。' },
        },
      },
    }
    expect(specLeaksToken(placeholderSpec, secret)).toBe(false)
    // 未配置 / 空 token:一律不报(空串在 JSON 里到处都是,拿它比全是误报)。
    expect(specLeaksToken(placeholderSpec, '')).toBe(false)
    expect(specLeaksToken(placeholderSpec, null)).toBe(false)
    expect(specLeaksToken(placeholderSpec, undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. OpenAPI 的暴露面(开发注册 / 生产不注册)
// ---------------------------------------------------------------------------

/** 路由文件的目录(测试从 cwd 跑,与 vitest.config.ts 的 root 一致)。 */
const ROUTE_DIR = join(process.cwd(), 'server/api')

describe('Nitro 内建 OpenAPI 的暴露面', () => {
  /** 按当前 nuxt.config 的口径问 nitro:它注册了哪些路由。 */
  async function openApiRoutes(dev: boolean): Promise<string[]> {
    // `{ dev }` 作为**第一参**传(nitro 从 config 里读 dev);第二参 `LoadConfigOptions`
    // 只收 watch / c12 / compatibilityDate / dotenv,不接受 dev。
    const nitro = await createNitro({
      rootDir: process.cwd(),
      compatibilityDate: '2026-10-14',
      dev,
      // 与 nuxt.config.ts 的 `nitro` 段逐字一致。
      experimental: { openAPI: true },
      openAPI: { meta: { title: 't', version: '1' }, ui: { swagger: false } },
    })
    const routes = nitro.options.handlers.map((h) => h.route ?? '')
    await nitro.close()
    return routes
  }

  it('★ 开发环境注册 /_openapi.json 与 /_scalar', async () => {
    const routes = await openApiRoutes(true)
    expect(routes).toContain('/_openapi.json')
    expect(routes).toContain('/_scalar')
    // swagger UI 显式关掉(与 scalar 同一份 spec 的两种渲染,留一个就够)。
    expect(routes).not.toContain('/_swagger')
  }, 60_000)

  it('★ 生产构建**不注册** —— 于是那两个端点在生产下是 404', async () => {
    // 本票不开生产。这条断言钉死这个默认:谁把 `openAPI.production` 打开了,
    // 这里就会红,而打开它必须同时自己加一道保护(见 .env.example 的警告)。
    const routes = await openApiRoutes(false)
    expect(routes).not.toContain('/_openapi.json')
    expect(routes).not.toContain('/_scalar')
  }, 60_000)

  it('nuxt.config 里确实是「开发开、生产不开」的那组设置', async () => {
    const cfg = (await import('../nuxt.config')).default as {
      nitro?: { experimental?: { openAPI?: boolean }; openAPI?: { production?: unknown; meta?: Record<string, string> } }
    }
    expect(cfg.nitro?.experimental?.openAPI).toBe(true)
    // 不设 production(而不是设成 false 之外的值)—— nitro 的判据是
    // `!dev && !production` 就 return,所以「不设」才是生产关闭。
    expect(cfg.nitro?.openAPI?.production).toBeUndefined()
    expect(cfg.nitro?.openAPI?.meta?.title).toBeTruthy()
    expect(cfg.nitro?.openAPI?.meta?.version).toBeTruthy()
  })

  it('★ 票面点名的公开路由**都带了** `defineRouteMeta` —— 这是 spec 的全部输入', async () => {
    // spec 的唯一来源就是各路由文件里的那个字面量块(nitro 的 handlers-meta 插件
    // 按 AST 抽)。所以「spec 含不含某条路由」等价于「那个路由文件里有没有那个块」。
    // 真正的 spec 内容(路径齐全、没有密钥)在**真实服务**上量过,见票 19 的交付记录。
    const routes = [
      'records.get.ts',
      'enterprises/[id].get.ts',
      'stats.get.ts',
      'quality.get.ts',
      'export.get.ts',
      'comparison.get.ts',
      'comparison/curated.patch.ts',
      'files/index.get.ts',
      'files/[id].patch.ts',
      'files/[id].delete.ts',
      'files/[...path].get.ts',
      'pdf-pages.get.ts',
      'pdf-pages.post.ts',
      'health.get.ts',
      'jobs/index.post.ts',
      'jobs/index.get.ts',
      'jobs/[id].get.ts',
      'jobs/[id].delete.ts',
      'jobs/kinds.get.ts',
    ]
    for (const rel of routes) {
      const source = await readFile(join(ROUTE_DIR, rel), 'utf8')
      expect(source, rel).toContain('defineRouteMeta({')
      // 宏必须写在**顶层**(nitro 只认顶层 ExpressionStatement),所以别塞进函数里。
      expect(/^defineRouteMeta\(/m.test(source), rel).toBe(true)
    }
  })

  it('生产守卫:那三条路径在生产回 404,在开发放行', () => {    // nitro 的「不注册」在 SPA(ssr:false)下的可观测结果是 **200 + index.html**
    // (兜底页),而不是 404 —— 守卫把「这里没有」说清楚。真实构建下的 404 见票 19
    // 的实测记录;这里是那条行为的判据本身。
    for (const p of ['/_openapi.json', '/_scalar', '/_swagger']) {
      expect(shouldHideOpenApiPath(p, { dev: false })).toBe(true)
      expect(shouldHideOpenApiPath(p, { dev: true })).toBe(false)
    }
    // 精确匹配,不是前缀 —— SPA 里真有别的页也不误伤。
    expect(shouldHideOpenApiPath('/api/health', { dev: false })).toBe(false)
    expect(shouldHideOpenApiPath('/_scalar/extra', { dev: false })).toBe(false)
    expect(shouldHideOpenApiPath('/', { dev: false })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 8. render-pages 的 handler:一份失败不停批(用真夹具 PDF)
// ---------------------------------------------------------------------------

describe('render-pages 的 run(真 pdfium + sharp)', () => {
  it('批量渲染 2 份夹具:逐份报结果;中间夹一份坏的**不停下整批**', async () => {
    const { renderPagesSpec } = await import('../server/utils/jobs/render-pages')
    const root = mkdtempSync(join(tmpdir(), 'spztx-render-batch-'))
    const rel = 'jxj/announcement/2024/1/fixture.pdf'
    const badRel = 'jxj/announcement/2024/1/broken.pdf'
    await mkdir(join(root, 'jxj/announcement/2024/1'), { recursive: true })
    await writeFile(join(root, rel), minimalPdf({ pages: 3 }))
    // 一份不是 PDF 的「PDF」:pdfium 打不开 → 这一项失败,但不该拖垮整批。
    await writeFile(join(root, badRel), Buffer.from('这不是 PDF'))

    const parsed = renderPagesSpec.parse({ files: [rel, badRel], dpi: 100 })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const seen: Array<[number, number]> = []
    const completion = await renderPagesSpec.run!(
      {
        jobId: 'test',
        filesDir: root,
        db,
        progress: (done, total) => seen.push([done, total]),
        cancelled: () => false,
      },
      parsed.params,
    )

    const result = completion.result as {
      files: Array<{ file: string; ok: boolean; pageCount?: number; error?: string }>
      total: number
      ok: number
      failed: number
    }
    expect(result.total).toBe(2)
    expect(result.ok).toBe(1)
    expect(result.failed).toBe(1)
    // 好的那份渲染到位。
    expect(result.files[0]!.ok).toBe(true)
    expect(result.files[0]!.pageCount).toBe(3)
    // 坏的那份**有原因**,且是逐项的。
    expect(result.files[1]!.ok).toBe(false)
    expect(result.files[1]!.error).toBeTruthy()
    // 整体记 failed(状态诚实),但明细在 result 里(信息完整)。
    expect(completion.error).toContain('1 份渲染失败')

    // 进度按份报:2 份 → 两次回调,分母都是 2。
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ])
    // 页图真的落盘了(3 页)。
    const pagesDir = join(root, 'jxj/announcement/2024/1/.fixture.pdf.pages')
    expect((await readdir(pagesDir)).filter((n) => /^p\d+\.png$/.test(n))).toHaveLength(3)

    rmSync(root, { recursive: true, force: true })
  }, 60_000)

  it('取消时**带着部分产出**收尾,而不是丢掉明细', async () => {
    const { renderPagesSpec } = await import('../server/utils/jobs/render-pages')
    const root = mkdtempSync(join(tmpdir(), 'spztx-render-cancel-'))
    const a = 'jxj/announcement/2024/1/a.pdf'
    const b = 'jxj/announcement/2024/1/b.pdf'
    await mkdir(join(root, 'jxj/announcement/2024/1'), { recursive: true })
    await writeFile(join(root, a), minimalPdf({ pages: 2 }))
    await writeFile(join(root, b), minimalPdf({ pages: 2 }))

    const parsed = renderPagesSpec.parse({ files: [a, b], dpi: 100 })
    if (!parsed.ok) throw new Error('参数本应通过')

    // 第一份渲染完之后再置取消标记 —— 模拟「处理完这份才发现被取消」。
    // 计数挂在 progress 上:handler 每做完一份报一次,于是第二份**开工前**
    // 的检查点就会看到 cancelled。
    let renders = 0
    const completion = await renderPagesSpec.run!(
      {
        jobId: 'test',
        filesDir: root,
        db,
        progress: () => {
          renders += 1
        },
        cancelled: () => renders > 0,
      },
      parsed.params,
    )

    const result = completion.result as { files: unknown[]; done?: number; cancelled?: boolean; total: number }
    expect(completion.cancelled).toBe(true)
    expect(result.cancelled).toBe(true)
    expect(result.total).toBe(2)
    // 只做了第一份,但那一份的明细**在**。
    expect(result.files).toHaveLength(1)
    expect(result.done).toBe(1)

    rmSync(root, { recursive: true, force: true })
  }, 60_000)

  it('幂等:同一份渲染两次,第二次 written=0', async () => {
    const { renderPagesSpec } = await import('../server/utils/jobs/render-pages')
    const root = mkdtempSync(join(tmpdir(), 'spztx-render-idem-'))
    const rel = 'jxj/announcement/2024/1/idem.pdf'
    await mkdir(join(root, 'jxj/announcement/2024/1'), { recursive: true })
    await writeFile(join(root, rel), minimalPdf({ pages: 2 }))

    const parsed = renderPagesSpec.parse({ files: [rel], dpi: 100 })
    if (!parsed.ok) throw new Error('参数本应通过')
    const ctx = {
      jobId: 'test',
      filesDir: root,
      db,
      progress: () => undefined,
      cancelled: () => false,
    }
    const first = (await renderPagesSpec.run!(ctx, parsed.params)).result as {
      files: Array<{ written: number; skipped: number; rendered: number }>
    }
    expect(first.files[0]!.written).toBe(2)
    const second = (await renderPagesSpec.run!(ctx, parsed.params)).result as {
      files: Array<{ written: number; skipped: number; rendered: number }>
    }
    expect(second.files[0]!.written).toBe(0)
    expect(second.files[0]!.skipped).toBe(2)

    // 页图目录里没有多余的临时文件残留。
    const pagesDir = join(root, 'jxj/announcement/2024/1/.idem.pdf.pages')
    const names = await readdir(pagesDir)
    expect(names.filter((n) => n.endsWith('.tmp'))).toHaveLength(0)
    expect(names.sort()).toEqual(['.pages.json', 'p001.png', 'p002.png'])
    // 清单里的源哈希与磁盘一致(幂等判据的载体)。
    const manifest = JSON.parse(await readFile(join(pagesDir, '.pages.json'), 'utf8')) as {
      sourceSha256: string
      dpi: number
    }
    expect(manifest.dpi).toBe(100)
    expect(manifest.sourceSha256).toMatch(/^[0-9a-f]{64}$/)

    rmSync(root, { recursive: true, force: true })
  }, 60_000)
})
