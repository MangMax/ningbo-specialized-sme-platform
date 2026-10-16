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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { schema, useDb } from '../db'
import { APPLY_LIST_PATH, BUSINESS_LIST_PATH, type PlatformFetch } from '../lib/platform'
import type { PlatformRelationRow, PlatformQueriesResult } from '../lib/platform/read'
import {
  collectReconcileTargets,
  runPlatformReconcile,
  type ReconcileReport,
} from '../server/utils/platform-reconcile'
import { startEvidenceServer, type EvidenceServer } from './helpers/platform-evidence-server'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures/platform', name), 'utf8')

const USCC = '91330211255994457P'
const OTHER_USCC = '91330211316904639T'
const OLD_NAME = '宁波上航测绘有限公司'
const NEW_NAME = '宁波上航测绘股份有限公司'
const THIRD = '宁波第三甲科技有限公司'
const THIRD_USCC = '91330211000000009Z'

const dir = mkdtempSync(join(tmpdir(), 'spztx-platform-reconcile-'))
const db = useDb({ dbPath: join(dir, 'run.db') })

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
// 可注入的假 fetch:按「接口 + rdjb + USCC」回夹具,并记录每次调用
// ---------------------------------------------------------------------------

interface Call {
  uscc: string
  interface: 'business_list' | 'apply_list'
  rdjb: string
}

const EMPTY_HTML = readFileSync(join(import.meta.dirname, 'fixtures/platform/business-list-rdjb1-empty.html'), 'utf8')

/** 默认回复:USCC 走真实夹具(rdjb=3 有 6 条含旧名);其余 USCC 一律 0 行。 */
function defaultReply(call: Call): { text: string } {
  if (call.uscc !== USCC) {
    return {
      text:
        call.interface === 'business_list'
          ? EMPTY_HTML
          : '{"zrarData":{"grid":{"applyGrid":{"maxCount":0,"page":1,"pageSize":50,"pageSet":[]}}}}',
    }
  }
  if (call.interface === 'business_list') {
    return {
      text: call.rdjb === '3' ? fixture('business-list-rdjb3.html') : fixture(`business-list-rdjb${call.rdjb}-empty.html`),
    }
  }
  return { text: fixture('apply-list.json') }
}

interface FakePlatform {
  fetchImpl: PlatformFetch
  calls: Call[]
  maxInFlight(): number
  reset(): void
}

function fakePlatform(
  reply: (call: Call, attempt: number) => { status?: number; text: string } | Promise<{ status?: number; text: string }>,
  options: { delayMs?: number } = {},
): FakePlatform {
  const calls: Call[] = []
  const attempts = new Map<string, number>()
  let inFlight = 0
  let peak = 0
  const fetchImpl: PlatformFetch = async (url, init) => {
    const body = new URLSearchParams(init.body)
    const isBusiness = url.includes(BUSINESS_LIST_PATH)
    const call: Call = {
      uscc: body.get('tyshxydm') ?? '',
      interface: isBusiness ? 'business_list' : 'apply_list',
      rdjb: body.get('rdjb') ?? '',
    }
    calls.push(call)
    const key = `${call.uscc}|${call.interface}|${call.rdjb}`
    const attempt = (attempts.get(key) ?? 0) + 1
    attempts.set(key, attempt)
    inFlight += 1
    peak = Math.max(peak, inFlight)
    try {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      const result = await reply(call, attempt)
      const status = result.status ?? 200
      return { ok: status >= 200 && status < 300, status, text: async () => result.text }
    } finally {
      inFlight -= 1
    }
  }
  return {
    fetchImpl,
    calls,
    maxInFlight: () => peak,
    reset: () => {
      calls.length = 0
      attempts.clear()
      peak = 0
    },
  }
}

const platformQueries = () => db.select().from(schema.platformQuery).all()
const platformRelations = () => db.select().from(schema.platformRelation).all()
const differences = () => db.select().from(schema.differenceReason).all()
const aliases = () => db.select().from(schema.enterpriseAlias).all()

/** 每个用例都在**干净的库**上跑:清掉前一个用例写下的证据行。 */
function clearEvidence() {
  for (const table of [schema.enterpriseAlias, schema.differenceReason, schema.platformRelation, schema.platformQuery, schema.importBatch]) {
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

let fake = fakePlatform(defaultReply)
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

afterAll(async () => {
  await server?.close()
  vi.unstubAllGlobals()
  vi.doUnmock('@db')
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

describe('端到端:一次运行把证据、原因与措施经统一 API 写回', () => {
  let report: ReconcileReport

  beforeAll(async () => {
    clearEvidence()
    fake = fakePlatform(defaultReply)
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
    expect(renamed.status).toBe('confirmed_reason')
    expect(renamed.reasonCode).toBe('renamed')
    expect(renamed.measureCode).toBe('update_current_name')
    expect(renamed.measureNote).toContain('曾用名')
    expect(renamed.verificationStatus).toBe('confirmed')

    const unresolvable = rows.find((row) => row.enterpriseId === legacy)!
    expect(unresolvable.status).toBe('not_queried')
    expect(unresolvable.measureCode).toBe('manual_review')
    expect(unresolvable.reasonNote).toContain('tyshxydm')
    expect(unresolvable.verificationStatus).toBe('pending')

    const thirdRow = rows.find((row) => row.enterpriseId === third)!
    expect(thirdRow.status).toBe('no_record')
    expect(thirdRow.measureCode).toBe('manual_review')
  })

  it('曾用名写成 confirmed 别名,来源指向**本批新建**的关系行(§8.7 自然键解析到真 id)', () => {
    const rows = aliases()
    expect(rows).toHaveLength(1)
    const alias = rows[0]!
    expect(alias.enterpriseId).toBe(canonical)
    expect(alias.name).toBe(OLD_NAME)
    expect(alias.nameNorm).toBe(OLD_NAME)
    expect(alias.sourceKind).toBe('platform_business')
    expect(alias.verificationStatus).toBe('confirmed')
    expect(alias.validFrom).toBe('2022-06-22 17:17:52')
    // **不是 0 哨兵**:整批写完就指到了真实的 platform_relation 行。
    expect(alias.sourceRefId).not.toBe(0)
    const relation = platformRelations().find((row) => row.id === alias.sourceRefId)!
    expect(relation.sequenceNo).toBe(1)
    expect(relation.nameRaw).toBe(OLD_NAME)
  })

  it('差异证据指针在**同一批内**解析:evidence_query_id / evidence_relation_id 指向真实行', () => {
    const renamed = differences().find((row) => row.enterpriseId === canonical)!
    const business3 = platformQueries().find((row) => row.queryKey === USCC && row.rdjb === '3')!
    expect(renamed.evidenceQueryId).toBe(business3.id)
    const relation = platformRelations().find((row) => row.id === renamed.evidenceRelationId)!
    expect(relation.queryId).toBe(business3.id)
    expect(relation.nameRaw).toBe(OLD_NAME)
  })

  it('只发一个批次(preflight + commit 同键),不是「先写查询、再写别名」两批', async () => {
    const batches = db.select().from(schema.importBatch).all()
    expect(batches).toHaveLength(1)
    expect(batches[0]!.sourceKind).toBe('alias_evidence')
    expect(batches[0]!.status).toBe('committed')
    expect(batches[0]!.idempotencyKey).toMatch(/^platform_reconcile:[0-9a-f]{32}$/)
  })

  it('报告分项:已确认按原因分类、无记录、待人工、无法直查各归各桶', () => {
    expect(report.counts.total).toBe(3)
    expect(report.counts.confirmed).toBe(1)
    expect(report.counts.byReason).toEqual({ renamed: 1 })
    expect(report.counts.noRecord).toBe(1)
    expect(report.counts.needsReview).toBe(0)
    expect(report.counts.queryFailed).toBe(0)
    expect(report.counts.notQueried).toBe(1)
    expect(report.relations).toBe(8)
    expect(report.aliases).toBe(1)
    expect(report.write).toEqual({ batchId: expect.any(Number), status: 'committed', written: expect.any(Number), skipped: expect.any(Number) })
  })

  it('提示但不自动归并:旧名 = 库里另一家无统代企业的现名', () => {
    expect(report.mergeCandidates).toEqual([
      {
        fromEnterpriseId: legacy,
        fromName: OLD_NAME,
        intoEnterpriseId: canonical,
        intoName: NEW_NAME,
        uscc: USCC,
        aliasName: OLD_NAME,
      },
    ])
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
    const replay = fakePlatform(defaultReply)
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
    const dry = fakePlatform(defaultReply)
    const report = await runPlatformReconcile({
      ...baseOptions(),
      fetchImpl: dry.fetchImpl,
      titles: ['specialized_sme'],
      write: false,
    })
    expect(report.counts.confirmed).toBe(1)
    expect(report.write).toBeNull()
    expect(platformQueries()).toHaveLength(0)
    expect(differences()).toHaveLength(0)
    expect(aliases()).toHaveLength(0)
  })

  it('取消 ⇒ 报告如实标 cancelled、不写回,且进度分步可见', async () => {
    clearEvidence()
    const cancelling = fakePlatform(defaultReply)
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
