/**
 * B-02 / #120 —— 「一次执行没有产出，不许抹掉已有检查点」的 **runner/store 合同**。
 *
 * 只经**公开面**验证,不碰平台私有注册表、不改 `spec.prepare`、不直接写 job 表造证据:
 *
 *  - 任务经 `registerJob` 登记一个**隔离的测试 kind**,用 `submitJob` + `whenIdle` 跑完 ——
 *    与生产 kind 走的是同一个 runner;
 *  - 检查点由 kind 自己在执行中用公开的 `ctx.progress` + `setJobResult` 落库
 *    (平台 `runBatch` 的 `persist()` 就是这套),随后 throw / 返回 cancelled;
 *  - 断言只读公开的 `getJob → toJobDto`(即 `GET /api/jobs/:id` 的响应体来源)。
 *
 * 这里**不**用测试 kind 冒充"生产平台失败证据":平台真实的执行次数上限与证据保留
 * 在 `platform-batch-query.test.ts` 里用真实 submit/status/retry + 真实 handler 验证。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeDb } from '../../../db/client'
import {
  __resetJobRunner,
  clearJobSpecs,
  registerJob,
  requeueFinishedJob,
  submitJob,
  whenIdle,
  type JobCompletion,
  type JobSpec,
} from '../../../server/utils/job-runner'
import { getJob, toJobDto } from '../../../server/utils/job-store'

const dir = mkdtempSync(join(tmpdir(), 'job-contract-'))
const db = initializeDb({ create: true,  dbPath: join(dir, 'test.sqlite') })

/** kind 在一次执行里先落下的检查点。 */
const checkpoint = {
  items: [{ id: 'a', status: 'complete' }, { id: 'b', status: 'partial' }],
  unfinished: [{ page: 2 }],
  attempt: 1,
}
/** 取消时 handler 手上真实的半成品(第 2 项还没做完)。 */
const cancelledSoFar = { items: [{ id: 'a', status: 'complete' }, { id: 'b', status: 'not_queried' }], unfinished: [{ page: 2 }], attempt: 1 }
const refreshed = { items: [{ id: 'a', status: 'complete' }, { id: 'b', status: 'complete' }], unfinished: [], attempt: 2 }

type Ending = 'throw' | 'cancel' | 'complete' | 'clear'

/** 隔离测试 kind:执行中 persist 检查点,再按 `ending` 收尾。 */
function contractKind(name: string, ending: Ending): JobSpec {
  return {
    kind: name,
    status: 'ready',
    summary: '测试用(合同)',
    parse: raw => ({ ok: true, params: raw }),
    total: () => 2,
    run: async (ctx): Promise<JobCompletion> => {
      // 与 `runBatch` 的 `persist()` 同构:执行中把检查点写进库里。
      ctx.progress(1, 2)
      return await (async () => {
        const { setJobResult } = await import('../../../server/utils/job-store')
        setJobResult(db, ctx.jobId, checkpoint)
        if (ending === 'throw') throw new Error('synthetic execution interruption')
        // 真实 handler 的取消语义:带上**已经做完的那部分**(这里的 partial 项是残缺的)。
        if (ending === 'cancel') return { result: cancelledSoFar, cancelled: true }
        if (ending === 'complete') return { result: refreshed }
        return { result: null }
      })()
    },
  }
}

/** 跑一次该 kind 的任务并返回 id 与公开 DTO。 */
async function runOnce(name: string, ending: Ending) {
  registerJob(contractKind(name, ending))
  const row = submitJob(db, { kind: name, params: {}, filesDir: dir })
  await whenIdle()
  return { id: row.id, dto: toJobDto(getJob(db, row.id)!) }
}

beforeAll(() => { __resetJobRunner(); clearJobSpecs() })
afterEach(() => { __resetJobRunner(); clearJobSpecs() })
afterAll(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

describe('一次执行没有产出时,finishJob 保留已检查点的 result', () => {
  it('执行抛异常 → failed,保留 result 与 progress,只更新终态与错误', async () => {
    const { dto } = await runOnce('contract-throw', 'throw')
    expect(dto).toMatchObject({
      state: 'failed',
      error: 'synthetic execution interruption',
      result: checkpoint,
      progress: { done: 1, total: 2 },
    })
  })

  it('执行返回 cancelled → cancelled,result 是 handler 带上的半成品,progress 不顶到分母', async () => {
    const { dto } = await runOnce('contract-cancel', 'cancel')
    expect(dto.state).toBe('cancelled')
    expect(dto.result).toEqual(cancelledSoFar)
    expect(dto.progress).toEqual({ done: 1, total: 2 })
  })

  it('重试中在取消检查点前抛异常 → cancelled 之外的检查点不被抹掉', async () => {
    // 第一次执行留下了完整检查点,第二次执行**根本没来得及产出**就抛异常。
    registerJob(contractKind('contract-cancel-retry', 'throw'))
    const row = submitJob(db, { kind: 'contract-cancel-retry', params: {}, filesDir: dir })
    await whenIdle()
    const first = toJobDto(getJob(db, row.id)!)
    expect(first.result).toEqual(checkpoint)
    clearJobSpecs()
    registerJob(contractKind('contract-cancel-retry', 'throw'))
    expect(requeueFinishedJob(db, { id: row.id, kind: 'contract-cancel-retry', params: {}, filesDir: dir })).toBe(true)
    await whenIdle()
    const second = toJobDto(getJob(db, row.id)!)
    expect(second.state).toBe('failed')
    expect(second.result).toEqual(first.result)
  })

  it('已结束的任务再取消不生效:终态与 result 都不动', async () => {
    // 队列侧的取消收尾(`finishJob(db, id, { state:'cancelled', error })`)同样不给 result。
    // 这里验公开取消面对已结束任务的行为:不重写终态、不碰 result。
    const { requestJobCancel } = await import('../../../server/utils/job-runner')
    registerJob(contractKind('contract-queued', 'throw'))
    const row = submitJob(db, { kind: 'contract-queued', params: {}, filesDir: dir })
    await whenIdle()
    expect(getJob(db, row.id)!.result).toEqual(checkpoint)
    // 已结束的任务再取消不生效(如实回报当前状态),result 不动。
    expect(requestJobCancel(db, row.id)).toMatchObject({ ok: true, alreadyFinished: true, state: 'failed' })
    const dto = toJobDto(getJob(db, row.id)!)
    expect(dto.state).toBe('failed')
    expect(dto.result).toEqual(checkpoint)
  })
})

describe('正常产出与显式清空仍然生效(没有被"保留"语义吞掉)', () => {
  it('执行有产出 → done,result 被这次的新产出覆盖', async () => {
    const { dto } = await runOnce('contract-complete', 'complete')
    expect(dto.state).toBe('done')
    expect(dto.result).toEqual(refreshed)
    expect(dto.progress).toEqual({ done: 2, total: 2 })
  })

  it('执行显式 result: null → done 且真的清空("没给"与"给了空"是两件事)', async () => {
    const { dto } = await runOnce('contract-clear', 'clear')
    expect(dto.state).toBe('done')
    expect(dto.result).toBeNull()
  })
})

describe('显式重试之后,上一次的检查点仍然完整', () => {
  it('重试执行再次抛异常:result 逐字段等于上一次,进度不回退', async () => {
    registerJob(contractKind('contract-retry', 'throw'))
    const row = submitJob(db, { kind: 'contract-retry', params: {}, filesDir: dir })
    await whenIdle()
    const first = toJobDto(getJob(db, row.id)!)
    expect(first.result).toEqual(checkpoint)

    // 公开的重试接缝:同一 id、重新捕获依赖后重开并再跑一次。
    expect(requeueFinishedJob(db, { id: row.id, kind: 'contract-retry', params: {}, filesDir: dir })).toBe(true)
    await whenIdle()
    const second = toJobDto(getJob(db, row.id)!)
    expect(second).toMatchObject({ state: 'failed', error: 'synthetic execution interruption', progress: { done: 1, total: 2 } })
    expect(second.result).toEqual(first.result)
  })

  it('重试执行有产出:结果被覆盖,不是沿用旧检查点', async () => {
    registerJob(contractKind('contract-retry-ok', 'throw'))
    const row = submitJob(db, { kind: 'contract-retry-ok', params: {}, filesDir: dir })
    await whenIdle()
    clearJobSpecs()
    registerJob(contractKind('contract-retry-ok', 'complete'))
    expect(requeueFinishedJob(db, { id: row.id, kind: 'contract-retry-ok', params: {}, filesDir: dir })).toBe(true)
    await whenIdle()
    const dto = toJobDto(getJob(db, row.id)!)
    expect(dto.state).toBe('done')
    expect(dto.result).toEqual(refreshed)
  })

  it('依赖捕获(prepare)抛错:任务不重开,终态与原 result 原样保留', async () => {
    registerJob(contractKind('contract-prepare', 'throw'))
    const row = submitJob(db, { kind: 'contract-prepare', params: {}, filesDir: dir })
    await whenIdle()
    const before = toJobDto(getJob(db, row.id)!)

    clearJobSpecs()
    registerJob({
      ...contractKind('contract-prepare', 'complete'),
      prepare: () => { throw Object.assign(new Error('dependency capture failed'), { statusCode: 503 }) },
    })
    expect(() => requeueFinishedJob(db, { id: row.id, kind: 'contract-prepare', params: {}, filesDir: dir }))
      .toThrow('dependency capture failed')
    const after = toJobDto(getJob(db, row.id)!)
    expect(after.state).toBe(before.state)
    expect(after.result).toEqual(before.result)
    expect(after.progress).toEqual(before.progress)
  })
})
