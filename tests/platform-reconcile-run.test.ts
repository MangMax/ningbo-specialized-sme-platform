import { initializeDb } from '../db/client'
/**
 * `server/utils/platform-reconcile.ts` —— **可运行的平台比对与原因回写**的端到端。
 *
 * 这一组用例跑的就是票面要求的那条链,而且**每一步都真的落库**:
 *
 *   比对口径的差异集合(真的 `getComparison`)→ 实查两接口(注入 fetch 喂**真实夹具**)
 *   → 落 `platform_query` / `platform_relation` → 逐条判原因与措施 → **一个批次**
 *   经统一导入 API 写回 → 再用**只读接口** `GET /api/platform/queries` 读回来。
 *
 * 写回走的是 `POST /api/roster/import/{preflight,commit}` 的核心函数
 * (`inProcessReconcileWriter`,路由与 `handleRosterImportRequest` 都只是它的薄转调),
 * 不是另写一条 SQL 通路;证据指针用契约 §8.7 的**批内自然键**,所以**一批就够**,
 * 不需要「先写查询、读回 id、再写别名」两批。
 *
 * 不进网络、不用真凭据:平台响应来自 `tests/fixtures/platform/`(父代理已登录会话代取的
 * 真实响应,已裁剪、不含凭证);凭据用注入值,不落库、不进日志。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { schema, useDb } from '../db'
import { whenIdle } from '../server/utils/job-runner'
import type { PlatformRelationRow, PlatformQueriesResult } from '../lib/platform/read'
import {
  collectReconcileTargets,
  runPlatformReconcile,
  type ReconcileReport,
} from '../server/utils/platform-reconcile'
import { startEvidenceServer, type EvidenceServer } from './helpers/platform-evidence-server'
import {
  EMPTY_APPLY_RESPONSE,
  platformFixture as fixture,
  platformReplay,
  type PlatformCall,
  type PlatformReplay,
} from './helpers/platform-replay'

const USCC = '91330211255994457P'
const OTHER_USCC = '91330211316904639T'
const OLD_NAME = '宁波上航测绘有限公司'
const NEW_NAME = '宁波上航测绘股份有限公司'
const THIRD = '宁波第三甲科技有限公司'
const THIRD_USCC = '91330211000000009Z'

const dir = mkdtempSync(join(tmpdir(), 'spztx-platform-reconcile-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'run.db') })

// ---------------------------------------------------------------------------
// 场景数据:两家 miit 侧企业 + 一家无统代的 jxj 侧企业
// ---------------------------------------------------------------------------

function seed(name: string, uscc: string | null, source: 'jxj' | 'miit') {
  const id = db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc, district: '镇海区' })
    .returning({ id: schema.enterprise.id })
    .get().id
  db.insert(schema.record).values({ enterpriseId: id, source, titleCode: 'specialized_sme', district: '镇海区' }).run()
  return id
}

const canonical = seed(NEW_NAME, USCC, 'miit')
const legacy = seed(OLD_NAME, null, 'jxj')
const third = seed(THIRD, THIRD_USCC, 'miit')

// ---------------------------------------------------------------------------
// 平台回应:默认走**真实夹具**(USCC 那家 rdjb=3 有 6 条含旧名;其余一律 0 行)
// ---------------------------------------------------------------------------

const EMPTY_BUSINESS = fixture('business-list-rdjb1-empty.html')

/** 默认回复:USCC 走真实夹具(rdjb=3 有 6 条含旧名);其余 USCC 一律 0 行。 */
const defaultReply = (call: PlatformCall) => {
  if (call.uscc !== USCC) {
    return { text: call.interface === 'business_list' ? EMPTY_BUSINESS : EMPTY_APPLY_RESPONSE }
  }
  if (call.interface === 'business_list') {
    return {
      text: call.rdjb === '3' ? fixture('business-list-rdjb3.html') : fixture(`business-list-rdjb${call.rdjb}-empty.html`),
    }
  }
  return { text: fixture('apply-list.json') }
}

const platformQueries = () => db.select().from(schema.platformQuery).all()
const platformRelations = () => db.select().from(schema.platformRelation).all()
const differences = () => db.select().from(schema.differenceReason).all()
const aliases = () => db.select().from(schema.enterpriseAlias).all()

/** 每个用例都在**干净的库**上跑:清掉前一个用例写下的证据行。 */
function clearEvidence() {
  // Typed projections reference content versions with ON DELETE RESTRICT; clear them first.
  for (const table of [schema.enterpriseAlias, schema.differenceReason, schema.platformApplyProjection, schema.platformBusinessProjection, schema.platformRecognizedProjection, schema.platformBusinessObservation, schema.platformBusinessRecordVersion, schema.platformBusinessRecord, schema.platformRelation, schema.platformQuery, schema.importReceipt, schema.importBatch]) {
    db.delete(table).run()
  }
}

const baseOptions = () => ({
  db,
  fetchImpl: fake.fetchImpl,
  cookie: 'zxqy_JSESSIONID=injected-for-test',
  write: true,
  now: () => new Date('2026-10-16T02:00:00.000Z'),
  retries: 0,
})

let fake: PlatformReplay = platformReplay(defaultReply)
let server: EvidenceServer
let currentQuery: Record<string, unknown> = {}

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getQuery', () => currentQuery)
  vi.stubGlobal('createError', (opts: { statusCode?: number; statusMessage?: string }) =>
    Object.assign(new Error(opts.statusMessage ?? 'Bad request'), opts),
  )
  vi.stubGlobal('useRuntimeConfig', () => ({
    curatedPath: join(dir, 'no-curation.json'),
    reconcilePath: join(dir, 'no-reconcile.json'),
  }))
  vi.doMock('@db', () => ({ useDb: () => db }))
  const queriesRoute = (await import('../server/api/platform/queries.get')).default as unknown as (event: unknown) => unknown
  server = await startEvidenceServer({
    db,
    apiToken: 'read-only',
    getRoutes: {
      '/api/platform/queries': (url) => {
        currentQuery = Object.fromEntries(url.searchParams.entries())
        return queriesRoute({})
      },
    },
  })
})

afterEach(async () => {
  await whenIdle()
  expect(db.select({ state: schema.job.state }).from(schema.job).all()
    .filter(row => row.state === 'queued' || row.state === 'running')).toEqual([])
})
afterAll(async () => {
  await server?.close()
  vi.unstubAllGlobals()
  vi.doUnmock('@db')
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 目标收集
// ---------------------------------------------------------------------------

describe('目标收集:只取比对口径的差异集合,并把「无统代」单列', () => {
  it('三家 miit 侧企业是 extra_in_miit,无统代的 jxj 侧企业是 missing_in_miit 且不可直查', () => {
    const collected = collectReconcileTargets(db, { titles: ['specialized_sme'] })
    expect(collected.targets.map((target) => target.enterpriseId).sort()).toEqual([canonical, third].sort())
    expect(collected.targets.every((target) => target.direction === 'extra_in_miit')).toBe(true)
    expect(collected.unqueryable).toHaveLength(1)
    expect(collected.unqueryable[0]!.enterpriseId).toBe(legacy)
    expect(collected.unqueryable[0]!.uscc).toBeNull()
    expect(collected.byUscc.get(USCC)!).toHaveLength(1)
  })

  it('limit/offset 配成分页:逐片取完 → 不重、不漏(全量长跑靠它分片)', () => {
    // 分页口径:在**全部差异目标**上滑窗(含无统代那些 —— 它们也是差异,也要在某一篇里落行)。
    const signature = (target: { enterpriseId: number; titleCode: string; direction: string }) =>
      `${target.enterpriseId}|${target.titleCode}|${target.direction}`
    const idsIn = (collected: ReturnType<typeof collectReconcileTargets>) =>
      [...collected.targets, ...collected.unqueryable].map(signature)

    const all = collectReconcileTargets(db, { titles: ['specialized_sme'] })
    const full = idsIn(all)
    expect(full.length).toBeGreaterThan(2)

    const first = collectReconcileTargets(db, { titles: ['specialized_sme'], limit: 1 })
    const second = collectReconcileTargets(db, { titles: ['specialized_sme'], limit: 1, offset: 1 })
    expect(idsIn(first)).not.toEqual(idsIn(second))

    // 一片一片取完:总数与全集一致,且没有重复(片之间不重叠、也不漏)。
    const paged: string[] = []
    for (let offset = 0; ; offset += 1) {
      const slice = collectReconcileTargets(db, { titles: ['specialized_sme'], limit: 1, offset })
      const ids = idsIn(slice)
      if (!ids.length) break
      paged.push(...ids)
      if (paged.length > full.length + 1) throw new Error('分页没有终止')
    }
    // 顺序按比对口径(无统代那类可能排在中间),所以比**集合**:数量一致、无重复、无遗漏。
    expect([...paged].sort()).toEqual([...full].sort())
    expect(new Set(paged).size).toBe(full.length)
  })

  it('usccs 点名 ⇒ 只留点到的那个统代(小样本实查;无统代的自然一个都不命中)', () => {
    const collected = collectReconcileTargets(db, { titles: ['specialized_sme'], usccs: [USCC] })
    expect(collected.targets.map((target) => target.uscc)).toEqual([USCC])
    expect(collected.unqueryable).toHaveLength(0)
    expect([...collected.byUscc.keys()]).toEqual([USCC])
  })
})

// ---------------------------------------------------------------------------
// 端到端:实查 → 落证据 → 判定 → 写回 → 读回
// ---------------------------------------------------------------------------

describe('端到端:一次运行经统一 API 保存证据和未确认处理状态', () => {
  let report: ReconcileReport

  beforeAll(async () => {
    clearEvidence()
    fake = platformReplay(defaultReply)
    report = await runPlatformReconcile({
      ...baseOptions(),
      fetchImpl: fake.fetchImpl,
      titles: ['specialized_sme'],
    })
  })

  it('实查两次 USCC、每次 4 个请求(rdjb=1/2/3 全查 + 申报接口)', () => {
    expect(report.usccCount).toBe(2)
    expect(report.queries.network).toBe(8)
    expect(report.queries.byInterface.business_list).toBe(6)
    expect(report.queries.byInterface.apply_list).toBe(2)
    // 每个 USCC 一定把 rdjb 1/2/3 都问了 —— 只问本地称号映射出来的那一个会漏掉证据。
    for (const uscc of [USCC, THIRD_USCC]) {
      const asked = fake.calls.filter((call) => call.uscc === uscc && call.interface === 'business_list').map((call) => call.rdjb).sort()
      expect(asked).toEqual(['1', '2', '3'])
    }
  })

  it('platform_query:每个槽位各占一行,四态按实际(no_record ≠ failed)', () => {
    const rows = platformQueries()
    expect(rows).toHaveLength(8)
    const forUscc = (uscc: string) =>
      rows
        .filter((row) => row.queryKey === uscc)
        .map((row) => `${row.interface}|${row.rdjb}|${row.status}`)
        .sort()
    expect(forUscc(USCC)).toEqual([
      'apply_list||success',
      'business_list|1|no_record',
      'business_list|2|no_record',
      'business_list|3|success',
    ])
    expect(forUscc(THIRD_USCC)).toEqual([
      'apply_list||no_record',
      'business_list|1|no_record',
      'business_list|2|no_record',
      'business_list|3|no_record',
    ])
    // 原始响应留证(解析口径变了以后还能回看引擎收到了什么)。
    const business3 = rows.find((row) => row.queryKey === USCC && row.rdjb === '3')!
    expect(business3.rawResponse).toContain('SQ332022062212391')
    // 查询时点用**真实查询时点**,不是重放时的常量。
    expect(business3.queriedAt).toBe('2026-10-16T02:00:00.000Z')
  })

  it('platform_relation:rdjb=3 的 6 条逐条保留,申报接口的 2 条不按 id 去重', () => {
    const business3 = platformQueries().find((row) => row.queryKey === USCC && row.rdjb === '3')!
    const relations = platformRelations()
      .filter((row) => row.queryId === business3.id)
      .sort((a, b) => a.sequenceNo - b.sequenceNo)
    expect(relations.map((row) => row.sequenceNo)).toEqual([1, 2, 3, 4, 5, 6])
    expect(relations.filter((row) => row.nameRaw === OLD_NAME)).toHaveLength(2)
    // 同一份记录在两个接口各出一次 ⇒ 8 条全在,不按 relation_key 去重。
    expect(platformRelations()).toHaveLength(8)
    expect(platformRelations().filter((row) => row.relationKey === 'SQ332022062212391')).toHaveLength(2)
    // 守护 C1:平台没有独立「曾用名」列,绝不拿 qymc 充数。
    for (const relation of platformRelations()) expect(relation.aliasNameRaw).toBeNull()
    // 关系按统代归到规范行。
    expect(relations.every((row) => row.enterpriseId === canonical)).toBe(true)
    expect(relations.every((row) => row.matchBasis === 'uscc')).toBe(true)
  })

  it('difference_reason:每个差异一条,原因与措施成对;无统代那条明确写「为什么查不了」', () => {
    const rows = differences()
    expect(rows).toHaveLength(3)

    const renamed = rows.find((row) => row.enterpriseId === canonical)!
    expect(renamed.titleCode).toBe('specialized_sme')
    expect(renamed.direction).toBe('extra_in_miit')
    expect(renamed.status).toBe('needs_review')
    expect(renamed.reasonCode).toBeNull()
    expect(renamed.measureCode).toBe('manual_review')
    expect(renamed.measureNote).toContain('代理')
    expect(renamed.verificationStatus).toBe('pending')

    const unresolvable = rows.find((row) => row.enterpriseId === legacy)!
    expect(unresolvable.status).toBe('not_queried')
    expect(unresolvable.measureCode).toBe('manual_review')
    expect(unresolvable.reasonNote).toContain('tyshxydm')
    expect(unresolvable.verificationStatus).toBe('pending')

    const thirdRow = rows.find((row) => row.enterpriseId === third)!
    expect(thirdRow.status).toBe('no_record')
    expect(thirdRow.measureCode).toBe('manual_review')
  })

  it('multiple qymc values remain raw relationships and do not write aliases', () => {
    expect(aliases()).toHaveLength(0)
    expect(platformRelations().filter(row => row.nameRaw === OLD_NAME).length).toBeGreaterThan(0)
  })

  it('pending case points to a real collected query, without inventing a decisive relation', () => {
    const pending = differences().find(row => row.enterpriseId === canonical)!
    expect(platformQueries().some(q => q.id === pending.evidenceQueryId)).toBe(true)
    expect(pending.evidenceRelationId).toBeNull()
  })

  it('查询与待核状态通过同一批次写入', async () => {
    const batches = db.select().from(schema.importBatch).all()
    expect(batches).toHaveLength(1)
    expect(batches[0]!.sourceKind).toBe('alias_evidence')
    expect(batches[0]!.status).toBe('committed')
    expect(batches[0]!.idempotencyKey).toMatch(/^platform_reconcile:[0-9a-f]{32}$/)
  })

  it('报告分项:不产出已确认原因；待核、无记录、未查询分别计数', () => {
    expect(report.counts.total).toBe(3)
    expect(report.counts.confirmed).toBe(0)
    expect(report.counts.byReason).toEqual({})
    expect(report.counts.noRecord).toBe(1)
    expect(report.counts.needsReview).toBe(1)
    expect(report.counts.queryFailed).toBe(0)
    expect(report.counts.notQueried).toBe(1)
    expect(report.relations).toBe(8)
    expect(report.aliases).toBe(0)
    expect(report.write).toEqual({ batchId: expect.any(Number), status: 'committed', written: expect.any(Number), skipped: expect.any(Number) })
  })

  it('采集不生成归并决策，原始名称留在关系中', () => {
    expect(report.mergeCandidates).toEqual([])
    // **没有**做归并:两家企业都还在。
    const names = db.select().from(schema.enterprise).all().filter((row) => row.name === OLD_NAME || row.name === NEW_NAME)
    expect(names).toHaveLength(2)
  })

  it('读回:GET /api/platform/queries 能查到全部查询与关系(§7.6),含旧名那条', async () => {
    const response = await fetch(`${server.baseUrl}/api/platform/queries?queryKey=${USCC}&pageSize=50`)
    expect(response.status).toBe(200)
    const result = (await response.json()) as PlatformQueriesResult
    expect(result.total).toBe(4)
    expect(result.counts).toEqual({ success: 2, no_record: 2 })
    const business3 = result.rows.find((row) => row.query.rdjb === '3')!
    expect(business3.relations).toHaveLength(6)
    const old = business3.relations.filter((row: PlatformRelationRow) => row.nameRaw === OLD_NAME)
    expect(old).toHaveLength(2)
    expect(old[0]!.matchedName).toBe(NEW_NAME)
  })
})

// ---------------------------------------------------------------------------
// 可续跑 / 幂等
// ---------------------------------------------------------------------------

describe('可续跑:重跑复用新鲜证据,不重复打平台、不重复堆行', () => {
  it('同一目标集第二次运行:0 次网络请求、0 处新写入', async () => {
    const before = {
      queries: platformQueries().length,
      relations: platformRelations().length,
      differences: differences().length,
      aliases: aliases().length,
      batches: db.select().from(schema.importBatch).all().length,
    }
    const replay = platformReplay(defaultReply)
    const second = await runPlatformReconcile({
      ...baseOptions(),
      fetchImpl: replay.fetchImpl,
      titles: ['specialized_sme'],
    })

    expect(replay.calls).toHaveLength(0)
    expect(second.queries.network).toBe(0)
    expect(second.queries.reused).toBe(8)
    // 三个目标(含无统代那个)都命中「新鲜」⇒ 一个都不重写。
    expect(second.counts.reusedFresh).toBe(3)
    expect(second.write).toBeNull()
    expect({
      queries: platformQueries().length,
      relations: platformRelations().length,
      differences: differences().length,
      aliases: aliases().length,
      batches: db.select().from(schema.importBatch).all().length,
    }).toEqual(before)
  })

  it('失败后的成功重试:最新失败压过更旧成功结论,保留两次审计记录', async () => {
    clearEvidence()
    const failedReplay = platformReplay(() => ({ status: 400, text: 'temporary platform failure' }))
    const failed = await runPlatformReconcile({
      ...baseOptions(),
      fetchImpl: failedReplay.fetchImpl,
      titles: ['specialized_sme'],
      usccs: [USCC],
    })

    expect(failedReplay.calls).toHaveLength(4)
    expect(failed.counts.queryFailed).toBe(1)
    expect(differences()).toHaveLength(1)
    expect(differences()[0]!.status).toBe('query_failed')

    // 模拟同一目标已有更早的成功解释；较新的 query_failed 必须优先于它。
    db.insert(schema.differenceReason)
      .values({
        enterpriseId: canonical,
        titleCode: 'specialized_sme',
        direction: 'extra_in_miit',
        status: 'confirmed_reason',
        reasonCode: 'renamed',
        reasonNote: 'older successful explanation',
        measureCode: 'update_current_name',
        measureNote: 'older successful explanation',
        verificationStatus: 'confirmed',
        recordedAt: '2026-10-16T01:59:00.000Z',
      })
      .run()

    const successReplay = platformReplay(defaultReply)
    const retried = await runPlatformReconcile({
      ...baseOptions(),
      fetchImpl: successReplay.fetchImpl,
      titles: ['specialized_sme'],
      usccs: [USCC],
      now: () => new Date('2026-10-16T02:01:00.000Z'),
    })

    expect(successReplay.calls).toHaveLength(4)
    expect(retried.queries.network).toBe(4)
    expect(retried.counts.reusedFresh).toBe(0)
    expect(retried.counts.queryFailed).toBe(0)
    expect(retried.counts.confirmed).toBe(0)
    expect(retried.write?.status).toBe('committed')

    const history = differences().sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    expect(history.map((row) => [row.recordedAt, row.status])).toEqual([
      ['2026-10-16T01:59:00.000Z', 'confirmed_reason'],
      ['2026-10-16T02:00:00.000Z', 'query_failed'],
      ['2026-10-16T02:01:00.000Z', 'needs_review'],
    ])
    const queries = platformQueries()
    expect(queries).toHaveLength(8)
    const failedQueries = queries.filter((row) => row.queriedAt === '2026-10-16T02:00:00.000Z')
    const retriedQueries = queries.filter((row) => row.queriedAt === '2026-10-16T02:01:00.000Z')
    expect(failedQueries).toHaveLength(4)
    expect(failedQueries.every((row) => row.status === 'failed')).toBe(true)
    expect(retriedQueries).toHaveLength(4)
    expect(retriedQueries.every((row) => row.status !== 'failed')).toBe(true)
  })

  it('幂等键由证据内容派生:同一目标集 + 同一证据 ⇒ 同一个键', async () => {
    const { reconcileIdempotencyKey } = await import('../server/utils/platform-reconcile')
    const sample = {
      queries: [
        { interface: 'business_list' as const, rdjb: '3', queriedAt: '2026-10-16T02:00:00.000Z', status: 'success' as const, relations: [{ sequenceNo: 1, relationKey: 'SQ1', nameRaw: OLD_NAME }] as never[] },
      ],
      differences: [{ enterpriseId: 1, titleCode: 'specialized_sme', direction: 'extra_in_miit', status: 'confirmed_reason', reasonCode: 'renamed' }],
      aliases: [{ enterpriseId: 1, name: OLD_NAME }],
    }
    expect(reconcileIdempotencyKey(sample)).toBe(reconcileIdempotencyKey(sample))
    // 证据变了(新时点的新查询)⇒ 另一个键 ⇒ 新解释形成新行(旧解释不丢)。
    const changed = {
      ...sample,
      queries: [{ ...sample.queries[0]!, queriedAt: '2026-10-17T02:00:00.000Z' }],
    }
    expect(reconcileIdempotencyKey(changed)).not.toBe(reconcileIdempotencyKey(sample))
  })
})

// ---------------------------------------------------------------------------
// 试跑 / 取消
// ---------------------------------------------------------------------------

describe('试跑与取消', () => {
  it('write:false ⇒ 只判定不回写(库里一行不加)', async () => {
    clearEvidence()
    const dry = platformReplay(defaultReply)
    const report = await runPlatformReconcile({
      ...baseOptions(),
      fetchImpl: dry.fetchImpl,
      titles: ['specialized_sme'],
      write: false,
    })
    expect(report.counts.confirmed).toBe(0)
    expect(report.write).toBeNull()
    expect(platformQueries()).toHaveLength(0)
    expect(differences()).toHaveLength(0)
    expect(aliases()).toHaveLength(0)
  })

  it('取消 ⇒ 报告如实标 cancelled、不写回,且进度分步可见', async () => {
    clearEvidence()
    const cancelling = platformReplay(defaultReply)
    let calls = 0
    const progress: [number, number][] = []
    const report = await runPlatformReconcile({
      ...baseOptions(),
      fetchImpl: cancelling.fetchImpl,
      titles: ['specialized_sme'],
      // 第一个 USCC 查完就取消 ⇒ 第二个不再打平台。
      shouldCancel: () => calls++ > 0,
      onProgress: (done, total) => progress.push([done, total]),
    })
    expect(report.cancelled).toBe(true)
    expect(report.write).toBeNull()
    expect(differences()).toHaveLength(0)
    expect(progress[0]).toEqual([0, 2])
    expect(cancelling.calls.length).toBeLessThanOrEqual(4)
  })
})


describe('agent-confirmed conclusions are separate from collection', () => {
  it('preserves an old confirmed decision while persisting newly collected evidence', async () => {
    clearEvidence()
    db.insert(schema.differenceReason).values({
      enterpriseId: canonical, titleCode: 'specialized_sme', direction: 'extra_in_miit',
      status: 'confirmed_reason', reasonCode: 'renamed', reasonNote: 'explicit agent decision',
      measureCode: 'update_current_name', measureNote: 'explicit agent measure',
      verificationStatus: 'confirmed', recordedAt: '2026-09-01T00:00:00.000Z',
    }).run()
    const before = differences()
    const replay = platformReplay(defaultReply)
    const first = await runPlatformReconcile({ ...baseOptions(), fetchImpl: replay.fetchImpl, titles: ['specialized_sme'], usccs: [USCC] })
    expect(replay.calls).toHaveLength(4)
    expect(platformQueries()).toHaveLength(4)
    expect(platformRelations()).toHaveLength(8)
    expect(differences()).toEqual(before)
    expect(aliases()).toEqual([])
    expect(first.write?.status).toBe('committed')
    expect(first.counts.confirmed).toBe(0)
    const again = platformReplay(defaultReply)
    const second = await runPlatformReconcile({ ...baseOptions(), fetchImpl: again.fetchImpl, titles: ['specialized_sme'], usccs: [USCC] })
    expect(again.calls).toHaveLength(0)
    expect(second.write).toBeNull()
    expect(differences()).toEqual(before)
  })
})
