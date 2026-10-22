/**
 * RL-06：**缺统一社会信用代码企业的补录**。
 *
 * ── 覆盖什么 ────────────────────────────────────────────────────────────
 *  - **A · 纯函数**：核心词抓取、统一社会信用代码格式/校验位（GB 32100-2015）、
 *    公开来源 claim 的客观判定。这些是「不猜」的全部机器判据。
 *  - **B · 待查清单**：仍缺统代的企业能筛出来，且每行带名称 / 地区 / 称号 /
 *    **来源文件与页码** / **接口匹配追溯**（为什么它还没解决）。
 *  - **C · 库内计划（路径一）**：核心词命中候选 + 平台原始关系 `qymc` 逐字证实 ⇒ 补齐；
 *    有候选但证不出 ⇒ 待人工（**不按名字挑最像的**）；搜不到 ⇒ 未找到；
 *    两个统代都自称这个名字 ⇒ 冲突（同名多主体）。
 *  - **D · 公开来源计划（路径二）**：代码格式/校验位不合法、来源三要素不齐、地区不符、
 *    统代已被别家占用 ⇒ 分别落冲突/待人工，**绝不填猜测值**。
 *  - **E · 写回**：`payload.usccBackfills` 经**真实 HTTP** 的 `POST /api/roster/import/commit`
 *    落库（只补缺失值、不覆盖已有代码、不合并身份），同键重放不增行，血缘可查回。
 *  - **F · 回归**：`91330211255994457P`（上航测绘）整条链路走得通 ——
 *    清单里它就是「缺统代」那一家，计划给出**有证据的**归并，执行后两行合一、
 *    按现名或曾用名搜索都命中同一企业、该统代的 **6 条关联一条不丢**。
 *
 * ── 走的是哪条链路 ──────────────────────────────────────────────────────
 * 写入走 `tests/helpers/platform-evidence-server.ts` 起的**真端口** node:http，挂的是 Nitro
 * 路由也在调的**同一份** `handleRosterImportRequest`；读侧挂**真的**路由模块。平台证据用
 * `tests/fixtures/platform/` 里裁剪的**真实响应摘录**经 `buildPlatformWritePayload` 写入。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { schema, useDb } from '../db'
import {
  coreWordOf,
  isValidUscc,
  judgeUsccClaim,
  nameMatchLevel,
  usccFormatVerdict,
  type UsccResearchClaim,
} from '../lib/roster/uscc-research'
import { normalizeName } from '../lib/domain'
import { createRosterImportClient, type RosterImportRequest } from '../lib/roster-import-client'
import { classifyRawQuery } from '../lib/platform'
import { buildPlatformWritePayload, type KnownEnterprise, type PlatformQueryInput } from '../lib/platform/payload'
import { listUsccChecklist, planUsccResearch, usccResearchIdempotencyKey } from '../server/utils/uscc-research'
import { normalizeUsccVerdicts, type UsccVerdictFile } from '../server/utils/uscc-verdicts'
import { parseUsccChecklistQuery, parseUsccResearchBody } from '../server/utils/uscc-research-query'
import { readImportBatchOutcome } from '../server/utils/roster-import'
import { startEvidenceServer, type EvidenceServer } from './helpers/platform-evidence-server'

const dir = mkdtempSync(join(tmpdir(), 'spztx-uscc-research-'))
const db = useDb({ dbPath: join(dir, 'uscc-research.db') })

const TOKEN = 'rl06-token-value'
const QUERIED_AT = '2026-10-16T03:33:51.280Z'

/** 回归案例（真实证据文件 `platform-capture-91330211255994457P.json`）。 */
const USCC = '91330211255994457P'
const OLD_NAME = '宁波上航测绘有限公司'
const NEW_NAME = '宁波上航测绘股份有限公司'
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures/platform', name), 'utf8')

// ---------------------------------------------------------------------------
// 夹具：企业 / 记录 / 事件 / 出处
// ---------------------------------------------------------------------------

function seedEnterprise(input: {
  name: string
  uscc?: string | null
  district?: string | null
  qualityFlags?: string[]
}) {
  return db
    .insert(schema.enterprise)
    .values({
      name: input.name,
      nameNorm: input.name,
      usccNorm: input.uscc ?? null,
      district: input.district ?? '镇海区',
      qualityFlags: input.qualityFlags ?? (input.uscc ? [] : ['uscc_missing']),
    })
    .returning({ id: schema.enterprise.id })
    .get().id
}

function seedRecord(enterpriseId: number, source: 'jxj' | 'miit', titleCode: string) {
  return db
    .insert(schema.record)
    .values({ enterpriseId, source, titleCode, district: '镇海区' })
    .returning({ id: schema.record.id })
    .get().id
}

function seedEvent(recordId: number, eventType: 'award' | 'review' | 'maintain', year: number, batchSeq = 1) {
  return db
    .insert(schema.recordEvent)
    .values({ recordId, eventType, year, sortKey: year, batchSeq, decidedYear: year })
    .returning({ id: schema.recordEvent.id })
    .get().id
}

function seedEvidence(recordEventId: number, input: { sourceFile: string; listNo: number; page: number | null }) {
  return db
    .insert(schema.recordEvidence)
    .values({ recordEventId, sourceFile: input.sourceFile, attachment: '附件', listNo: input.listNo, page: input.page })
    .returning({ id: schema.recordEvidence.id })
    .get().id
}

/** 回归案例的两行：375（公布侧，**无统代**）与 7289（带统代）。 */
const target = seedEnterprise({ name: OLD_NAME })
const targetRecord = seedRecord(target, 'jxj', 'specialized_sme')
const targetEvent = seedEvent(targetRecord, 'award', 2022)
const targetEvidence = seedEvidence(targetEvent, {
  sourceFile: 'jxj/announcement/2022/甬经信中小〔2022〕145号关于公布宁波市“专精特新”中小企业名单的通知.pdf',
  listNo: 74,
  page: 74,
})
/** 该（企业 × 称号 × 方向）的解释：无统代 ⇒ `not_queried`（RL-03 判定引擎写的）。 */
db.insert(schema.differenceReason)
  .values({
    enterpriseId: target,
    titleCode: 'specialized_sme',
    direction: 'missing_in_miit',
    status: 'not_queried',
    measureCode: 'manual_review',
    reasonNote: '本企业无统一社会信用代码；平台两接口只认 tyshxydm，不支持按名称查询，无法直查。',
    verificationStatus: 'pending',
    recordedAt: '2026-10-16T03:40:00.000Z',
  })
  .run()

const canonical = seedEnterprise({ name: NEW_NAME, uscc: USCC })
seedRecord(canonical, 'miit', 'specialized_sme')
seedRecord(canonical, 'miit', 'little_giant')

/** 一条**没有候选、也没有证据**的目标：库内核心词搜不出任何东西。 */
const lonely = seedEnterprise({ name: '宁波孤帆远影文创有限公司' })
const lonelyRecord = seedRecord(lonely, 'jxj', 'innovative_sme')
const lonelyEvent = seedEvent(lonelyRecord, 'award', 2023)
seedEvidence(lonelyEvent, { sourceFile: 'jxj/announcement/2023/名单.docx', listNo: 3, page: 12 })

/**
 * 判定文件那一组用的目标：库里搜不出任何候选、也没有任何平台查询 —— 正好用来验
 * 「文件说 resolved 但库里对不上 ⇒ 一行不写」与「文件带证据 ⇒ 同批写关系 + 补录」两条路。
 */
const lonelyAlt = seedEnterprise({ name: '宁波判定断言企业有限公司' })
seedRecord(lonelyAlt, 'jxj', 'specialized_sme')

/** 一条**有候选、但平台证不出来**的目标（候选统代查过、却没有逐字相等的 qymc）。 */
const unproven = seedEnterprise({ name: '宁波启明灯饰制造有限公司' })
seedRecord(unproven, 'jxj', 'specialized_sme')
const unprovenTwin = seedEnterprise({ name: '宁波启明灯饰制造股份有限公司', uscc: '91330200MA2AB1CD2U' })

// ---------------------------------------------------------------------------
// 真实 HTTP 服务（写 = RL-11 的 http 面；读 = 本票新增的路由模块）
// ---------------------------------------------------------------------------

let server: EvidenceServer
let currentQuery: Record<string, unknown> = {}
const client = () => createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
const getJson = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${server.baseUrl}${path}`)
  expect(response.status, `${path} 应返回 200`).toBe(200)
  return (await response.json()) as T
}

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getQuery', () => currentQuery)
  vi.stubGlobal('readBody', async () => currentQuery)
  vi.stubGlobal('createError', (opts: { statusCode?: number; statusMessage?: string }) =>
    Object.assign(new Error(opts.statusMessage ?? 'Bad request'), opts),
  )
  vi.stubGlobal('useRuntimeConfig', () => ({
    curatedPath: join(dir, 'none.json'),
    reconcilePath: join(dir, 'none.json'),
  }))
  vi.doMock('@db', () => ({ useDb: () => db }))

  const routes = {
    get: (await import('../server/api/roster/uscc-research.get')).default as unknown as (event: unknown) => unknown,
    post: (await import('../server/api/roster/uscc-research.post')).default as unknown as (event: unknown) => unknown,
  }

  server = await startEvidenceServer({
    db,
    apiToken: TOKEN,
    getRoutes: {},
    // 同一路径上 `GET` 只跑库内路径、`POST` 还要收公开来源/判定文件 —— 按方法分派，
    // 方法守卫留在被测那一层（`http-fixture` 的 `routes` 表对任意方法都生效）。
    routes: {
      // 路由模块的默认导出是 `async`，所以这里要 await 它 —— 否则夹具拿到的响应体是个
      // 未决的 Promise，`JSON.stringify` 出来是 `{}`。
      '/api/roster/uscc-research': async (request) => {
        if (request.method === 'POST') {
          currentQuery = (request.body ?? {}) as Record<string, unknown>
          const out = await routes.post({})
          return { status: 200, body: out }
        }
        currentQuery = request.query
        return { status: 200, body: await routes.get({}) }
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
// A · 纯函数：核心词 / 统代格式 / claim 判定
// ---------------------------------------------------------------------------

describe('A · 核心词与统一社会信用代码格式（纯函数）', () => {
  it('去区划前缀 + 去组织形式后缀', () => {
    expect(coreWordOf('宁波上航测绘有限公司')).toBe('上航测绘')
    expect(coreWordOf('宁波市上航测绘股份有限公司')).toBe('上航测绘')
    expect(coreWordOf('浙江瑞堂塑料科技股份有限公司')).toBe('瑞堂塑料科技')
    expect(coreWordOf('浙江省瑞堂塑料科技有限公司')).toBe('瑞堂塑料科技')
    expect(coreWordOf('华裕电器集团股份有限公司')).toBe('华裕电器集团')
    expect(coreWordOf('宁波仁栋电气有限责任公司')).toBe('仁栋电气')
  })

  it('前缀/后缀各只去一次（「宁波宁波」不会一路剥到底）', () => {
    expect(coreWordOf('宁波宁波机械有限公司')).toBe('宁波机械')
  })

  it('抓不出内容时返回空串 —— 不拿全名去猜', () => {
    expect(coreWordOf('')).toBe('')
    expect(coreWordOf(null)).toBe('')
    expect(coreWordOf('宁波')).toBe('')
    expect(coreWordOf('有限公司')).toBe('')
  })

  it('名称里的空白 / 全角空格 / 零宽字符不影响抓取', () => {
    expect(coreWordOf('  宁波上航​测绘有限公司 ')).toBe('上航测绘')
  })

  it('真实统代通过格式与校验位', () => {
    expect(usccFormatVerdict(USCC)).toBe('ok')
    expect(isValidUscc('913302017133602847')).toBe(true)
    expect(isValidUscc('913302067562827060')).toBe(true)
    expect(isValidUscc('91330205084796244Y')).toBe(true)
    expect(isValidUscc('913302126102116572')).toBe(true)
    // 大小写不敏感（来源里常见小写）。
    expect(isValidUscc('91330211255994457p')).toBe(true)
  })

  it('长度 / 字符集 / 校验位分别报出（不合并成一句「非法」）', () => {
    expect(usccFormatVerdict('91330211255994457')).toBe('length')
    expect(usccFormatVerdict('9133021125599445IP')).toBe('charset') // I 不在 GB 32100 字符集里
    // 校验位抄错：把真实的最后一位换成字符集里的另一个。
    expect(usccFormatVerdict('91330211255994457Q')).toBe('checksum')
    expect(isValidUscc(undefined)).toBe(false)
  })

  it('claim：三要素齐备、地区相符、校验位正确 ⇒ 可行', () => {
    expect(
      judgeUsccClaim({
        enterpriseId: 1,
        uscc: USCC,
        source: {
          url: 'https://example.gov.cn/notice/1',
          checkedOn: '2026-10-16',
          basis: '公开名录里该主体名与公布名一致，注册地宁波镇海',
          name: OLD_NAME,
          region: '宁波市/镇海区',
        },
      }),
    ).toEqual({ ok: true })
  })

  it('claim：代码格式不合法 / 三要素不齐 / 地区不符 ⇒ 逐条给理由', () => {
    const base = {
      enterpriseId: 1,
      uscc: USCC,
      source: { url: 'u', checkedOn: '2026-10-16', basis: 'b', name: 'n', region: '宁波市' },
    }
    expect(judgeUsccClaim({ ...base, uscc: '9133021125599445IP' })).toMatchObject({ code: 'uscc_format_invalid' })
    expect(judgeUsccClaim({ ...base, source: { ...base.source, url: '' } })).toMatchObject({
      code: 'source_evidence_incomplete',
    })
    expect(judgeUsccClaim({ ...base, source: { ...base.source, checkedOn: '2026/10/16' } })).toMatchObject({
      code: 'source_evidence_incomplete',
    })
    expect(judgeUsccClaim({ ...base, source: { ...base.source, basis: '  ' } })).toMatchObject({
      code: 'source_evidence_incomplete',
    })
    expect(judgeUsccClaim({ ...base, source: { ...base.source, region: '杭州市' } })).toMatchObject({
      code: 'region_mismatch',
    })
  })
})

// ---------------------------------------------------------------------------
// B · 待查清单
// ---------------------------------------------------------------------------

describe('B · 待查清单：名称 / 地区 / 称号 / 来源文件与页码 / 接口匹配追溯', () => {
  it('只列**仍缺统代**的企业；有统代的不在清单里', () => {
    const { rows, counts } = listUsccChecklist(db, { pageSize: 500 })
    const ids = rows.map((row) => row.enterpriseId)
    expect(ids).toContain(target)
    expect(ids).toContain(lonely)
    expect(ids).toContain(unproven)
    expect(ids).not.toContain(canonical)
    expect(counts.total).toBe(rows.length)
  })

  it('每行带称号、来源文件与**可用页码**，以及「为什么它还没解决」的追溯', () => {
    const row = listUsccChecklist(db, { pageSize: 500 }).rows.find((item) => item.enterpriseId === target)!
    expect(row.name).toBe(OLD_NAME)
    expect(row.district).toBe('镇海区')
    expect(row.titles).toEqual(['specialized_sme'])
    expect(row.coreWord).toBe('上航测绘')
    const evidence = row.evidence.find((item) => item.page === 74)!
    expect(evidence.attachment).toBe('附件')
    expect(evidence.listNo).toBe(74)
    expect(evidence.sourceFile).toContain('甬经信中小〔2022〕145号')
    expect(row.traces).toEqual([
      expect.objectContaining({
        titleCode: 'specialized_sme',
        direction: 'missing_in_miit',
        status: 'not_queried',
        reasonNote: expect.stringContaining('无统一社会信用代码'),
      }),
    ])
  })

  it('筛选与总表同口径：`q` / `district` 命中，`title` 不在字典内报错', () => {
    expect(listUsccChecklist(db, { q: '上航测绘' }).rows.map((r) => r.enterpriseId)).toEqual([target])
    expect(listUsccChecklist(db, { district: '镇海区', pageSize: 500 }).rows.map((r) => r.enterpriseId)).toContain(target)
    expect(listUsccChecklist(db, { district: '鄞州区', pageSize: 500 }).rows).toEqual([])
    expect(parseUsccChecklistQuery({ title: 'nope' })).toMatchObject({ ok: false })
    expect(parseUsccChecklistQuery({ title: 'specialized_sme,创新型' })).toMatchObject({ ok: false })
    expect(parseUsccChecklistQuery({ title: 'specialized_sme', page: '2' })).toMatchObject({
      ok: true,
      filter: { title: ['specialized_sme'], page: 2 },
    })
  })

  it('GET 路由给出同一份清单与计划（真实 HTTP）', async () => {
    const body = await getJson<{
      checklist: { rows: Array<{ enterpriseId: number; coreWord: string }>; counts: { total: number } }
      plan: { counts: { targets: number; notFound: number } }
    }>('/api/roster/uscc-research?q=%E4%B8%8A%E8%88%AA%E6%B5%8B%E7%BB%98')
    expect(body.checklist.counts.total).toBe(1)
    expect(body.checklist.rows).toHaveLength(1)
    expect(body.checklist.rows[0]!.enterpriseId).toBe(target)
    expect(body.checklist.rows[0]!.coreWord).toBe('上航测绘')
    expect(body.plan.counts.targets).toBe(1)
    expect(body.plan.counts.notFound).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// C · 库内计划（路径一）
// ---------------------------------------------------------------------------

describe('C · 库内核心词 → 候选 → 平台原始关系逐字验证', () => {
  it('① 候选还没有平台证据时：**待人工**，不按名字挑最像的，也不写一行', () => {
    const report = planUsccResearch(db, { enterpriseIds: [unproven] })
    expect(report.counts).toMatchObject({ filled: 0, manual: 1, conflict: 0, notFound: 0 })
    const pending = report.pending[0]!
    expect(pending.code).toBe('candidate_without_platform_evidence')
    expect(pending.candidates.map((c) => c.enterpriseId)).toEqual([unprovenTwin])
    // 候选确实是从「核心词包含」来的，但结论是「证据不足」。
    expect(pending.candidates[0]!.matchedCoreWord).toBe('启明灯饰制造')
    expect(report.request).toBeNull()
  })

  it('② 库内搜不出核心词 ⇒ 未找到（下一步才退到平台 queryList?qymc= 子串反查）', () => {
    const report = planUsccResearch(db, { enterpriseIds: [lonely] })
    expect(report.counts).toMatchObject({ notFound: 1, filled: 0 })
    expect(report.pending[0]!).toMatchObject({ code: 'no_candidate', outcome: 'not_found' })
  })

  it('③ 平台原始关系逐字证实 ⇒ 补齐：给出归并 + 那条关系的 id', async () => {
    // 用**真实响应摘录**经统一 API 写入平台查询与关系（RL-03 的那次实查）。
    const queries: PlatformQueryInput[] = [
      {
        interface: 'business_list',
        queryKey: USCC,
        rdjb: '1',
        queriedAt: QUERIED_AT,
        outcome: classifyRawQuery(fixture('business-list-rdjb1-empty.html'), {
          interface: 'business_list',
          rdjb: '1',
          queryKey: USCC,
        }),
      },
      {
        interface: 'business_list',
        queryKey: USCC,
        rdjb: '2',
        queriedAt: QUERIED_AT,
        outcome: classifyRawQuery(fixture('business-list-rdjb2-empty.html'), {
          interface: 'business_list',
          rdjb: '2',
          queryKey: USCC,
        }),
      },
      {
        interface: 'business_list',
        queryKey: USCC,
        rdjb: '3',
        queriedAt: QUERIED_AT,
        outcome: classifyRawQuery(fixture('business-list-rdjb3.html'), {
          interface: 'business_list',
          rdjb: '3',
          queryKey: USCC,
        }),
      },
      {
        interface: 'apply_list',
        queryKey: USCC,
        rdjb: '',
        queriedAt: '2026-10-16T03:33:52.037Z',
        outcome: classifyRawQuery(fixture('apply-list.json'), { interface: 'apply_list', queryKey: USCC }),
      },
    ]
    const enterprises: KnownEnterprise[] = [
      { id: target, name: OLD_NAME, nameNorm: OLD_NAME, uscc: null },
      { id: canonical, name: NEW_NAME, nameNorm: NEW_NAME, uscc: USCC },
    ]
    const written = await client().commit(
      buildPlatformWritePayload({ sourceIdentity: `platform/${USCC}.json`, queries, enterprises }),
    )
    expect(written.status).toBe('committed')

    const report = planUsccResearch(db, { enterpriseIds: [target] })
    expect(report.counts).toMatchObject({ targets: 1, filled: 1, closed: 1, manual: 0, conflict: 0, notFound: 0 })
    expect(report.counts.byRoute).toEqual({ library: 1, platform_claim: 0, public_source: 0 })

    const ready = report.ready[0]!
    expect(ready.uscc).toBe(USCC)
    expect(ready.chosen!.enterpriseId).toBe(canonical)
    expect(ready.chosen!.matchedCoreWord).toBe('上航测绘')
    // 证据 = **平台原始关系**：qymc 逐字等于公布名，且带着那条关系/查询的真实 id。
    expect(ready.evidence!.nameRaw).toBe(OLD_NAME)
    expect(ready.evidence!.relationKey).toBe('SQ332022062212391')
    expect(ready.evidence!.sourceKind).toBe('platform_business')
    const relation = db.select().from(schema.platformRelation).all().find((r) => r.id === ready.evidence!.relationId)!
    expect(relation.nameRaw).toBe(OLD_NAME)
    expect(relation.relationKey).toBe('SQ332022062212391')
    // 载荷：被并方是公布侧那一行，规范行是该统代，来源=那条关系。
    expect(ready.merge).toMatchObject({
      fromEnterpriseId: target,
      intoUscc: USCC,
      aliasName: OLD_NAME,
      sourceKind: 'platform_business',
      sourceRefId: relation.id,
      evidenceQueryId: ready.evidence!.queryId,
    })
    expect(ready.merge!.note).toContain('qymc 逐字等于')
    // 计划是**只读**的：此刻库里一行都没动。
    expect(db.select().from(schema.enterprise).all().find((e) => e.id === target)!.usccNorm).toBeNull()
    expect(report.request!.payload.merges).toHaveLength(1)
  })

  it('④ 两个不同统代都自称这个名字 ⇒ **冲突**（同名多主体），一个都不并', () => {
    // 复制一条平台关系：另一个统代下也写出同样的 qymc（先落库，再判）。
    const relation = db.select().from(schema.platformRelation).all().find((r) => r.nameRaw === OLD_NAME)!
    const query = db.select().from(schema.platformQuery).all().find((q) => q.id === relation.queryId)!
    const other = seedEnterprise({ name: '宁波上航测绘工程有限公司', uscc: '91330200MA2XY8WX9K' })
    db.insert(schema.platformQuery)
      .values({
        interface: 'business_list',
        queryKey: '91330200MA2XY8WX9K',
        rdjb: '3',
        queriedAt: QUERIED_AT,
        status: 'success',
      })
      .run()
    const otherQuery = db.select().from(schema.platformQuery).all().at(-1)!
    db.insert(schema.platformRelation)
      .values({
        queryId: otherQuery.id,
        sequenceNo: 1,
        relationKey: 'SQ-test-multi',
        usccRaw: '91330200MA2XY8WX9K',
        nameRaw: OLD_NAME,
        matchBasis: 'none',
        verificationStatus: 'pending',
      })
      .run()

    const report = planUsccResearch(db, { enterpriseIds: [target] })
    expect(report.counts).toMatchObject({ conflict: 1, filled: 0 })
    expect(report.pending[0]!).toMatchObject({ code: 'multiple_subjects', outcome: 'conflict' })
    expect(report.request).toBeNull()
    expect(query.queryKey).toBe(USCC)
    expect(other).toBeGreaterThan(0)

    // 清掉这条人为构造的证据，后面的用例回到单候选状态。
    db.delete(schema.platformRelation).where(eq(schema.platformRelation.relationKey, 'SQ-test-multi')).run()
  })

  it('⑤ 同一轮内收敛：先补齐的名字**立刻**进字典，后一个目标当轮就能配上', () => {
    // 一家写法不完整的公布名（现实里就是 OCR 截断：`宁波上航测绘有限`）。它的核心词
    // `上航测绘有限` 与规范行现名 `宁波上航测绘股份有限公司` **不是**子串关系，
    // 所以它命不中任何东西 —— 除非**同一轮**里先补齐的那家把名字写进了字典。
    const truncated = seedEnterprise({ name: '宁波上航测绘有限' })
    seedRecord(truncated, 'jxj', 'innovative_sme')

    // 单独跑它：字典里没有这个名字 ⇒ **未找到**。
    const alone = planUsccResearch(db, { enterpriseIds: [truncated] })
    expect(alone.counts).toMatchObject({ notFound: 1, filled: 0 })
    expect(alone.pending[0]!.candidates).toEqual([])

    // 与「上航测绘」那家**同一轮**跑：上航测绘当轮补齐 ⇒ 它的名字（= 本轮写出的曾用名）
    // 立刻进字典 ⇒ 截断名当轮就命中了同一个候选（不必等下一轮）。
    const together = planUsccResearch(db, { enterpriseIds: [target, truncated] })
    expect(together.counts.filled).toBe(1) // 只有上航测绘那家有逐字证据
    const second = together.outcomes.find((row) => row.enterpriseId === truncated)!
    expect(second.message).not.toContain('搜不到候选')
    expect(second.candidates.map((c) => c.enterpriseId)).toContain(canonical)
    expect(second.candidates[0]!.matchedBy).toBe('alias')
    expect(second.candidates[0]!.matchedName).toBe(OLD_NAME)
    // 名字只用来「找候选」：截断名的 qymc 在平台关系里没有逐字命中 ⇒ 停在待人工，**不并**。
    expect(second.outcome).toBe('manual')
    expect(second.code).toBe('candidate_without_platform_evidence')
  })
})

// ---------------------------------------------------------------------------
// D · 公开来源计划（路径二）
// ---------------------------------------------------------------------------

/** 一条完全合规、指向「孤帆远影」的公开来源查证结果（用真实校验位的代码）。 */
const validClaimUscc = '91330211MA2CL6FP24'
const claimFor = (overrides: Partial<UsccResearchClaim> = {}): UsccResearchClaim => ({
  enterpriseId: lonely,
  uscc: validClaimUscc,
  source: {
    url: 'https://www.creditchina.gov.cn/xinyong/example',
    checkedOn: '2026-10-16',
    basis: '公开信用信息页：主体名「宁波孤帆远影文创有限公司」，注册地宁波市，统一社会信用代码一致',
    name: '宁波孤帆远影文创有限公司',
    region: '宁波市/鄞州区',
  },
  ...overrides,
})

describe('D · 公开来源查证结果 → 补录计划（路径二）', () => {
  it('三要素齐备、代码合法、未被占用 ⇒ 走 `usccBackfills`（不并身份、不写别名）', () => {
    const report = planUsccResearch(db, { enterpriseIds: [lonely], claims: [claimFor()] })
    expect(report.counts).toMatchObject({ filled: 1, closed: 1, byRoute: { library: 0, platform_claim: 0, public_source: 1 } })
    const ready = report.ready[0]!
    expect(ready.merge).toBeNull()
    expect(ready.backfill).toMatchObject({ enterpriseId: lonely, uscc: validClaimUscc })
    expect(ready.backfill!.source.checkedOn).toBe('2026-10-16')
    expect(report.request!.payload.usccBackfills).toHaveLength(1)
    expect(report.request!.payload.merges ?? []).toHaveLength(0)
  })

  it('代码格式不合法 ⇒ **冲突**（不填猜测值）', () => {
    const report = planUsccResearch(db, {
      enterpriseIds: [lonely],
      claims: [claimFor({ uscc: '91330211MA2CL6FP2U' })],
    })
    expect(report.counts).toMatchObject({ conflict: 1, filled: 0 })
    expect(report.pending[0]!.code).toBe('uscc_format_invalid')
    expect(report.request).toBeNull()
  })

  it('来源证据不齐 ⇒ **待人工**', () => {
    const report = planUsccResearch(db, {
      enterpriseIds: [lonely],
      claims: [claimFor({ source: { ...claimFor().source, url: '' } })],
    })
    expect(report.counts).toMatchObject({ manual: 1, filled: 0 })
    expect(report.pending[0]!.code).toBe('source_evidence_incomplete')
  })

  it('地区不符 ⇒ **冲突**', () => {
    const report = planUsccResearch(db, {
      enterpriseIds: [lonely],
      claims: [claimFor({ source: { ...claimFor().source, region: '杭州市余杭区' } })],
    })
    expect(report.counts).toMatchObject({ conflict: 1 })
    expect(report.pending[0]!.code).toBe('region_mismatch')
  })

  it('代码已被别的企业占用 ⇒ **冲突**（不覆盖、不自动合并身份）', () => {
    const report = planUsccResearch(db, { enterpriseIds: [lonely], claims: [claimFor({ uscc: USCC })] })
    expect(report.counts).toMatchObject({ conflict: 1 })
    expect(report.pending[0]!).toMatchObject({ code: 'uscc_taken' })
    expect(report.pending[0]!.message).toContain('不自动合并身份')
  })

  it('claim 找不到归属企业 ⇒ 如实报一条待人工，不静默丢弃', () => {
    const report = planUsccResearch(db, {
      enterpriseIds: [lonely],
      claims: [claimFor({ enterpriseId: undefined, enterpriseName: '宁波不存在的企业有限公司' })],
    })
    expect(report.pending.some((row) => row.code === 'claim_target_not_found')).toBe(true)
  })

  it('★ 同一轮内两个目标认领**同一个**统代 ⇒ 第二个落冲突（不留到写入阶段才炸）', () => {
    // 两条 claim 各自「看起来很干净」（库里此刻没有任何一行持有那个统代），若都进载荷，
    // 执行时第一条补上、第二条撞唯一键 ⇒ 整批回滚。计划里就必须判掉。
    const report = planUsccResearch(db, {
      enterpriseIds: [lonely, unproven],
      claims: [
        claimFor({ enterpriseId: lonely }),
        claimFor({ enterpriseId: unproven, source: { ...claimFor().source, name: '宁波启明灯饰制造有限公司' } }),
      ],
    })
    expect(report.counts).toMatchObject({ filled: 1, conflict: 1 })
    expect(report.counts.byRoute).toEqual({ library: 0, platform_claim: 0, public_source: 1 })
    const conflict = report.pending.find((row) => row.code === 'uscc_taken')!
    expect(conflict.outcome).toBe('conflict')
    expect(conflict.message).toContain('本轮已被')
    // 载荷里只有一条 —— 预检报的就是提交真会改的。
    expect(report.request!.payload.usccBackfills).toHaveLength(1)
    expect(report.request!.payload.usccBackfills![0]!.enterpriseId).toBe(lonely)
  })

  it('POST 体的形状校验（不合法的 claims 直接 400，不进语义判定）', () => {
    expect(parseUsccResearchBody({ claims: [{ uscc: USCC }] })).toMatchObject({ ok: false })
    expect(parseUsccResearchBody({ claims: [{ uscc: USCC, enterpriseId: 1, source: {} }] })).toMatchObject({ ok: true })
    expect(parseUsccResearchBody({ claims: 'nope' })).toMatchObject({ ok: false })
    expect(parseUsccResearchBody([])).toMatchObject({ ok: false })
  })

  it('幂等键只看**载荷内容**：同内容同键、换内容换键', () => {
    const a = planUsccResearch(db, { enterpriseIds: [lonely], claims: [claimFor()] }).request!
    const b = planUsccResearch(db, { enterpriseIds: [lonely], claims: [claimFor()] }).request!
    expect(a.idempotencyKey).toBe(b.idempotencyKey)
    expect(a.idempotencyKey).toBe(
      usccResearchIdempotencyKey({
        platformQueries: a.payload.platformQueries ?? [],
        merges: a.payload.merges ?? [],
        backfills: a.payload.usccBackfills ?? [],
      }),
    )
    const other = planUsccResearch(db, {
      enterpriseIds: [lonely],
      claims: [claimFor({ uscc: '91330212MA2CL6FP2J' })],
    }).request!
    expect(other.idempotencyKey).not.toBe(a.idempotencyKey)
  })
})

// ---------------------------------------------------------------------------
// E · 写回：经统一 API 的 usccBackfills
// ---------------------------------------------------------------------------

describe('E · 补录经统一写入 API 落库（真实 HTTP）', () => {
  let request: RosterImportRequest | null = null

  it('★ 提交：只补缺失值 + 摘掉 uscc_missing 标记，血缘可查回', async () => {
    request = planUsccResearch(db, { enterpriseIds: [lonely], claims: [claimFor()] }).request
    expect(request).not.toBeNull()
    const result = await client().commit(request!)
    expect(result.status).toBe('committed')
    expect(result.summary.written).toBe(1)

    const row = db.select().from(schema.enterprise).all().find((e) => e.id === lonely)!
    expect(row.usccNorm).toBe(validClaimUscc)
    expect(row.qualityFlags).not.toContain('uscc_missing')

    const item = result.items.find((entry) => entry.kind === 'uscc_backfill')!
    expect(item.ok).toBe(true)
    expect(item.detail?.lineage).toMatchObject({
      enterpriseId: lonely,
      uscc: validClaimUscc,
      previousUscc: null,
      source: { checkedOn: '2026-10-16', url: 'https://www.creditchina.gov.cn/xinyong/example' },
    })
    const outcome = readImportBatchOutcome(db, request!.idempotencyKey)!
    expect(outcome.items!.some((entry) => entry.kind === 'uscc_backfill' && entry.ok)).toBe(true)
  })

  it('★ 同键重放：不再写一行，返回既有摘要', async () => {
    const replay = await client().commit(request!)
    expect(replay.status).toBe('committed')
    expect(replay.summary.written).toBe(1)
    expect(replay.items).toEqual((await client().commit(request!)).items)
  })

  it('清单里不再出现这家企业（补齐 ⇒ 自动移出待查清单）', () => {
    expect(listUsccChecklist(db, { pageSize: 500 }).rows.map((r) => r.enterpriseId)).not.toContain(lonely)
  })

  it('★ 已有统代的企业 ⇒ `uscc_already_present`，整批失败、一行不落', async () => {
    const before = db.select().from(schema.enterprise).all().find((e) => e.id === canonical)!
    const result = await client().commit({
      idempotencyKey: 'rl06/backfill/occupied#sha256:b1',
      sourceKind: 'alias_evidence',
      sourceIdentity: 'roster/uscc-research',
      payload: {
        usccBackfills: [
          { enterpriseId: canonical, uscc: '91330212MA2CL6FP2J', source: claimFor().source },
        ],
      },
    })
    expect(result.status).toBe('failed')
    expect(result.summary.written).toBe(0)
    expect(result.items[0]!.error!.code).toBe('uscc_already_present')
    const after = db.select().from(schema.enterprise).all().find((e) => e.id === canonical)!
    expect(after.usccNorm).toBe(before.usccNorm)
  })

  it('★ 统代被别家占用 ⇒ `uscc_taken`（冲突，不并身份）', async () => {
    const free = seedEnterprise({ name: '宁波另一家无统代企业有限公司' })
    const result = await client().commit({
      idempotencyKey: 'rl06/backfill/taken#sha256:b2',
      sourceKind: 'alias_evidence',
      sourceIdentity: 'roster/uscc-research',
      payload: { usccBackfills: [{ enterpriseId: free, uscc: USCC, source: claimFor().source }] },
    })
    expect(result.status).toBe('failed')
    expect(result.items[0]!.error!.code).toBe('uscc_taken')
    expect(db.select().from(schema.enterprise).all().find((e) => e.id === free)!.usccNorm).toBeNull()
  })

  it('★ backfill 的 enterpriseId 与 enterpriseName 冲突时拒绝，不给 ID 主体补错代码', async () => {
    const targetName = '宁波ID指定补码主体有限公司'
    const conflictingName = '宁波名称指定补码主体有限公司'
    const target = seedEnterprise({ name: targetName })
    const other = seedEnterprise({ name: conflictingName })
    const result = await client().commit({
      idempotencyKey: 'rl06/backfill/selector-conflict#sha256:b8',
      sourceKind: 'alias_evidence',
      sourceIdentity: 'roster/uscc-research',
      payload: {
        usccBackfills: [{
          enterpriseId: target,
          enterpriseName: conflictingName,
          uscc: '91330212MA2CL6FP2J',
          source: { ...claimFor().source, name: targetName },
        }],
      },
    })

    expect(result.status).toBe('failed')
    expect(result.summary.written).toBe(0)
    expect(result.items.find((item) => item.kind === 'uscc_backfill')!.error!.code).toBe('enterprise_selector_conflict')
    expect(db.select().from(schema.enterprise).all().find((row) => row.id === target)!.usccNorm).toBeNull()
    expect(db.select().from(schema.enterprise).all().find((row) => row.id === other)!.usccNorm).toBeNull()
  })

  it('★ 代码格式/校验位不合法 ⇒ `uscc_format_invalid`；来源证据不齐 ⇒ `source_evidence_incomplete`', async () => {
    const free = seedEnterprise({ name: '宁波格式待查企业有限公司' })
    const bad = await client().commit({
      idempotencyKey: 'rl06/backfill/badcode#sha256:b3',
      sourceKind: 'alias_evidence',
      sourceIdentity: 'roster/uscc-research',
      payload: { usccBackfills: [{ enterpriseId: free, uscc: '91330212MA2CL6FP2V', source: claimFor().source }] },
    })
    expect(bad.status).toBe('failed')
    expect(bad.items[0]!.error!.code).toBe('uscc_format_invalid')

    const noEvidence = await client().commit({
      idempotencyKey: 'rl06/backfill/noevidence#sha256:b4',
      sourceKind: 'alias_evidence',
      sourceIdentity: 'roster/uscc-research',
      payload: {
        usccBackfills: [
          {
            enterpriseId: free,
            uscc: '91330212MA2CL6FP2J',
            source: { url: '', checkedOn: '', basis: '', name: '' },
          },
        ],
      },
    })
    expect(noEvidence.status).toBe('failed')
    expect(noEvidence.items[0]!.error!.code).toBe('source_evidence_incomplete')
    expect(noEvidence.items[0]!.error!.field).toBe('source')
    expect(db.select().from(schema.enterprise).all().find((e) => e.id === free)!.usccNorm).toBeNull()
  })

  it('★ 归一化档的证据不被丢掉：平台原文（全角括号）也能锚定', () => {
    const ingest = normalizeUsccVerdicts([
      {
        file: 'norm.json',
        value: {
          batch: 7,
          generatedAt: '2026-10-16T16:00:00.000Z',
          items: [
            {
              enterpriseId: 9501,
              name: '航天云网云制造科技(浙江)有限公司',
              candidateUscc: '91330201MA2CJG8W1P',
              platformEvidence: [
                {
                  interface: 'business_list',
                  rdjb: '2',
                  sequenceNo: 1,
                  relationKey: 'SQ-norm-1',
                  // 平台原文：**全角**括号 —— 与公布名只差字形档。
                  qymc: '航天云网云制造科技（浙江）有限公司',
                  tyshxydm: '91330201MA2CJG8W1P',
                },
                {
                  interface: 'business_list',
                  rdjb: '2',
                  sequenceNo: 2,
                  relationKey: 'SQ-norm-2',
                  // 现名行：与公布名不同档，也要留住（进库作背景）。
                  qymc: '航天云网云制造科技股份有限公司',
                  tyshxydm: '91330201MA2CJG8W1P',
                },
              ],
            },
          ],
        } as UsccVerdictFile,
      },
    ])
    expect(ingest.platformClaims).toHaveLength(1)
    expect(ingest.platformClaims[0]!.evidence).toHaveLength(2)
    expect(ingest.platformClaims[0]!.evidence!.map((row) => row.relationKey)).toEqual(['SQ-norm-1', 'SQ-norm-2'])
  })

  it('★ 同一企业同一统代被两份文件给出：**带可用证据的那份胜**（不按先到先得）', () => {
    const bare = {
      enterpriseId: 9401,
      name: '宁波先到无证据企业有限公司',
      verdict: 'resolved',
      candidateUscc: '91330211MA2CL6FP24',
      platformEvidence: [],
    }
    const withEvidence = {
      ...bare,
      platformEvidence: [
        {
          interface: 'business_list',
          rdjb: '2',
          sequenceNo: 3,
          relationKey: 'SQ-late-1',
          qymc: '宁波先到无证据企业有限公司',
          tyshxydm: '91330211MA2CL6FP24',
          cszt: '待审核',
        },
      ],
    }
    const ingest = normalizeUsccVerdicts([
      { file: 'early.json', value: { batch: 1, generatedAt: '2026-10-16T15:00:00.000Z', items: [bare] } as UsccVerdictFile },
      {
        file: 'late.json',
        value: { batch: 2, generatedAt: '2026-10-16T15:30:00.000Z', items: [withEvidence] } as UsccVerdictFile,
      },
    ])
    expect(ingest.platformClaims).toHaveLength(1)
    expect(ingest.platformClaims[0]!.batchRef).toBe('uscc-verdict-batch-2')
    expect(ingest.platformClaims[0]!.evidence).toHaveLength(1)
    expect(ingest.untouched).toEqual([])
    expect(ingest.problems.join('|')).toContain('采用后者作证据')
  })

  it('★ 同一企业在多份文件里重复出现且结论不同 ⇒ 按企业去重、取更强', () => {
    const ingest = normalizeUsccVerdicts([
      {
        file: 'a.json',
        value: {
          batch: 1,
          generatedAt: '2026-10-16T15:00:00.000Z',
          items: [{ enterpriseId: 9301, name: '重复企业', verdict: 'not_found', candidateUscc: null }],
        } as UsccVerdictFile,
      },
      {
        file: 'b.json',
        value: {
          batch: 2,
          generatedAt: '2026-10-16T15:30:00.000Z',
          items: [{ enterpriseId: 9301, name: '重复企业', verdict: 'conflict', candidateUscc: '91330211MA2CL6FP24' }],
        } as UsccVerdictFile,
      },
    ])
    expect(ingest.untouched).toHaveLength(1)
    expect(ingest.untouched[0]!.verdict).toBe('conflict')
    expect(ingest.problems.join('|')).toContain('取更强结论')
  })

  it('★ 同名多主体时按名定位 ⇒ `enterprise_ambiguous`（不猜是哪一家）', async () => {
    seedEnterprise({ name: '宁波同名双胞胎有限公司' })
    seedEnterprise({ name: '宁波同名双胞胎有限公司' })
    const result = await client().commit({
      idempotencyKey: 'rl06/backfill/ambiguous#sha256:b5',
      sourceKind: 'alias_evidence',
      sourceIdentity: 'roster/uscc-research',
      payload: {
        usccBackfills: [
          { enterpriseName: '宁波同名双胞胎有限公司', uscc: '91330212MA2CL6FP2J', source: claimFor().source },
        ],
      },
    })
    expect(result.status).toBe('failed')
    expect(result.items[0]!.error!.code).toBe('enterprise_ambiguous')
  })

  it('企业不存在 / 两个归属键都不给 ⇒ 逐项报错', async () => {
    const missing = await client().commit({
      idempotencyKey: 'rl06/backfill/missing#sha256:b6',
      sourceKind: 'alias_evidence',
      sourceIdentity: 'roster/uscc-research',
      payload: { usccBackfills: [{ enterpriseId: 999999, uscc: '91330212MA2CL6FP2J', source: claimFor().source }] },
    })
    expect(missing.items[0]!.error!.code).toBe('enterprise_not_found')

    const noTarget = await client().commit({
      idempotencyKey: 'rl06/backfill/notarget#sha256:b7',
      sourceKind: 'alias_evidence',
      sourceIdentity: 'roster/uscc-research',
      payload: { usccBackfills: [{ uscc: '91330212MA2CL6FP2J', source: claimFor().source }] },
    })
    expect(noTarget.items[0]!.error!.code).toBe('enterprise_required')
  })
})

// ---------------------------------------------------------------------------
// G · 批次判断代理的判定文件 → 中央写回（⚠️ 文件是线索，库才是判官）
// ---------------------------------------------------------------------------

describe('G · 判定文件归一化 + 平台证据认领', () => {
  /** 别名去重用例在执行前后要比对的别名行数，以及那份要提交的请求体。 */
  let aliasRowCount = 0
  let aliasMergeRequest: RosterImportRequest | null = null

  const batchFile = (items: unknown[], generatedAt = '2026-10-16T16:00:00.000Z') => ({
    file: 'uscc-verdict-batch-9.json',
    value: { batch: 9, generatedAt, items } as UsccVerdictFile,
  })

  it('只采纳 resolved + 逐字相等 + 有候选统代；其余**原样列出**不动库', () => {
    const outOfScope = lonelyAlt
    const ingest = normalizeUsccVerdicts([
      batchFile([
        {
          enterpriseId: outOfScope,
          name: '宁波孤帆远影文创有限公司',
          candidateUscc: '91330212MA2CL6FP2J',
          qymcEqualsAnnouncedName: true,
          verdict: 'resolved',
          platformEvidence: [
            { interface: 'queryl_typo', rdjb: '3', sequenceNo: 1, qymc: '宁波孤帆远影文创有限公司' },
          ],
          reason: '库内命中 + 平台 qymc 逐字相等',
        },
        { enterpriseId: 9001, name: '甲', candidateUscc: null, verdict: 'not_found', reason: '库内与平台都查不到' },
        { enterpriseId: 9002, name: '乙', candidateUscc: '91330211MA2CL6FP24', verdict: 'conflict', reason: '两个候选都自称' },
        { enterpriseId: 9003, name: '丙', candidateUscc: '91330211MA2CL6FP24', verdict: 'needs_human', reason: '会话失败' },
        {
          enterpriseId: 9004,
          name: '丁',
          candidateUscc: '91330211MA2CL6FP24',
          qymcEqualsAnnouncedName: false,
          verdict: 'resolved',
          reason: '名字对不上',
        },
      ]),
    ])
    expect(ingest.batches).toEqual([
      { batch: 9, file: 'uscc-verdict-batch-9.json', generatedAt: '2026-10-16T16:00:00.000Z', items: 5 },
    ])
    // 两条 `resolved` 都进认领（**`qymcEqualsAnnouncedName` 不是判据**，采纳与否只看库里对不对得上；
    // 那三态如实记进 `flagState`）；`interface` 写错的那条证据条目被过滤掉了。
    // 另外三条（not_found / conflict / needs_human）原样列出、不动库。
    expect(ingest.platformClaims).toHaveLength(2)
    expect(ingest.platformClaims[0]).toMatchObject({
      enterpriseId: outOfScope,
      enterpriseName: '宁波孤帆远影文创有限公司',
      uscc: '91330212MA2CL6FP2J',
      batchRef: 'uscc-verdict-batch-9',
      observedAt: '2026-10-16T16:00:00.000Z',
      flagState: 'true',
      evidence: [],
    })
    expect(ingest.platformClaims[1]).toMatchObject({ enterpriseId: 9004, flagState: 'false' })
    // 证据**只做结构过滤、不按名称筛**：平台原文常与公布名只在归一化口径下相等
    //（逐字筛会把整批证据丢光），且同一次返回里的现名行也要留住。
    expect(ingest.platformClaims[1]!.evidence).toEqual([])
    expect(ingest.untouched.map((row) => row.verdict).sort()).toEqual(['conflict', 'needs_human', 'not_found'])
    expect(ingest.untouched.every((row) => 'blocked' in row)).toBe(true)
    expect(ingest.problems).toEqual([])
  })

  it('缺 generatedAt / 缺 candidateUscc / verdict 取值未知 ⇒ 记 problem 并跳过（不猜）', () => {
    const noTime = normalizeUsccVerdicts([
      { file: 'f.json', value: { batch: 1, items: [{ enterpriseId: 1, name: '甲', verdict: 'resolved', candidateUscc: '91330211MA2CL6FP24' }] } as UsccVerdictFile },
    ])
    expect(noTime.platformClaims).toEqual([])
    expect(noTime.problems[0]).toContain('缺 generatedAt')

    const bad = normalizeUsccVerdicts([
      batchFile([
        { enterpriseId: 9101, name: '甲', verdict: 'resolved', candidateUscc: '', qymcEqualsAnnouncedName: true },
        { enterpriseId: 9102, name: '乙', verdict: 'maybe', candidateUscc: '91330211MA2CL6FP24' },
        { name: '丙', verdict: 'resolved', candidateUscc: '91330211MA2CL6FP24' },
      ]),
    ])
    expect(bad.platformClaims).toEqual([])
    expect(bad.problems.join('|')).toContain('缺 candidateUscc')
    expect(bad.problems.join('|')).toContain('verdict 取值未知')
    expect(bad.problems.join('|')).toContain('缺 enterpriseId / name')
    expect(bad.untouched).toEqual([
      { enterpriseId: 9101, name: '甲', verdict: 'needs_human', reason: 'resolved 但没给候选统代', blocked: null },
    ])
  })

  it('★ 判定文件说 resolved，但库里对不上 ⇒ `no_platform_evidence`，**一行不写**', () => {
    const report = planUsccResearch(db, {
      enterpriseIds: [lonelyAlt],
      platformClaims: [
        {
          enterpriseId: lonelyAlt,
          enterpriseName: '宁波判定断言企业有限公司',
          uscc: '91330213MA2CL6FP21',
          evidence: [],
          batchRef: 'uscc-verdict-batch-9',
          observedAt: '2026-10-16T16:00:00.000Z',
        },
      ],
    })
    expect(report.counts).toMatchObject({ filled: 0, manual: 1 })
    expect(report.pending[0]!.code).toBe('no_platform_evidence')
    expect(report.pending[0]!.message).toContain('平台原始证据对不上')
    expect(report.request).toBeNull()
  })

  it('★ 判定文件带着逐字相等的关系摘要 ⇒ 同一批写下查询/关系 + 补录，证据指针走批内自然键', () => {
    const report = planUsccResearch(db, {
      enterpriseIds: [lonelyAlt],
      platformClaims: [
        {
          enterpriseId: lonelyAlt,
          enterpriseName: '宁波判定断言企业有限公司',
          uscc: '91330213MA2CL6FP21',
          evidence: [
            {
              interface: 'business_list',
              rdjb: '3',
              sequenceNo: 1,
              relationKey: 'SQ-verdict-1',
              nameRaw: '宁波判定断言企业有限公司',
              status: '终审通过',
            },
          ],
          reason: '库内候选 + 平台 qymc 逐字相等',
          batchRef: 'uscc-verdict-batch-9',
          observedAt: '2026-10-16T16:00:00.000Z',
        },
      ],
    })
    expect(report.counts).toMatchObject({ filled: 1, closed: 1, byRoute: { library: 0, platform_claim: 1, public_source: 0 } })
    const ready = report.ready[0]!
    // 库里还没有那条关系 ⇒ 证据是**批内自然键**（§8.7），不是 0 哨兵、也不是编造的行 id。
    expect(ready.evidence).toBeNull()
    expect(ready.evidenceRef).toEqual({
      interface: 'business_list',
      queryKey: '91330213MA2CL6FP21',
      rdjb: '3',
      queriedAt: '2026-10-16T16:00:00.000Z',
      sequenceNo: 1,
      // 权威锚点：`sequenceNo` 只作参考，`relationKey` 说话（父代理 2026-10-16）。
      relationKey: 'SQ-verdict-1',
    })
    expect(ready.platformQuery).toMatchObject({
      interface: 'business_list',
      queryKey: '91330213MA2CL6FP21',
      rdjb: '3',
      status: 'success',
      rawResponse: null,
      relations: [
        expect.objectContaining({
          sequenceNo: 1,
          relationKey: 'SQ-verdict-1',
          nameRaw: '宁波判定断言企业有限公司',
          usccRaw: '91330213MA2CL6FP21',
          // 这一行**就是**「曾用名证据」本身（`qymc` 与公布名同档）⇒ `alias` + `confirmed`；
          // 同一次返回里的现名行会是 `uscc` + `pending`（见 groupSuppliedEvidence 的注释）。
          matchBasis: 'alias',
          verificationStatus: 'confirmed',
          rawFields: null,
        }),
      ],
    })
    // 只补缺失值：走 usccBackfills（库里没有任何一行持有该统代），且**不造自指别名**。
    expect(ready.merge).toBeNull()
    expect(ready.backfill).toMatchObject({ enterpriseId: lonelyAlt, uscc: '91330213MA2CL6FP21' })
    expect(report.request!.payload.platformQueries).toHaveLength(1)
    expect(report.request!.payload.usccBackfills).toHaveLength(1)
  })

  it('★ 该统代已挂在另一家企业行上 ⇒ §5.2 的**归并**（不是 UPDATE），证据仍是那条关系', () => {
    const held = seedEnterprise({ name: '宁波持有代码的规范行有限公司', uscc: '91330214MA2CL6FP2F' })
    const orphan = seedEnterprise({ name: '宁波待并入企业有限公司' })
    const report = planUsccResearch(db, {
      enterpriseIds: [orphan],
      platformClaims: [
        {
          enterpriseId: orphan,
          enterpriseName: '宁波待并入企业有限公司',
          uscc: '91330214MA2CL6FP2F',
          evidence: [
            {
              interface: 'business_list',
              rdjb: '3',
              sequenceNo: 2,
              relationKey: 'SQ-verdict-2',
              nameRaw: '宁波待并入企业有限公司',
              status: '终审通过',
            },
          ],
          batchRef: 'uscc-verdict-batch-9',
          observedAt: '2026-10-16T16:00:00.000Z',
        },
      ],
    })
    expect(report.counts).toMatchObject({ filled: 1, byRoute: { platform_claim: 1 } })
    const ready = report.ready[0]!
    expect(ready.backfill).toBeNull()
    expect(ready.merge).toMatchObject({
      fromEnterpriseId: orphan,
      intoUscc: '91330214MA2CL6FP2F',
      aliasName: '宁波待并入企业有限公司',
      sourceKind: 'platform_business',
      sourceRelationRef: {
        interface: 'business_list',
        queryKey: '91330214MA2CL6FP2F',
        rdjb: '3',
        sequenceNo: 2,
        relationKey: 'SQ-verdict-2',
      },
    })
    // 审计文案以 **relationKey** 为锚（序号只作参考；一条摘要单看也不知道自己排第几）。
    expect(ready.merge!.note).toContain('relationKey=SQ-verdict-2')
    expect(held).toBeGreaterThan(0)
  })

  it('★ 跨批次按企业去重：同一企业在两批各出现一次（两个称号）⇒ 只采纳一次', () => {
    const item = {
      enterpriseId: lonelyAlt,
      name: '宁波判定断言企业有限公司',
      candidateUscc: '91330213MA2CL6FP21',
      qymcEqualsAnnouncedName: true,
      verdict: 'resolved',
      platformEvidence: [
        { interface: 'business_list', rdjb: '3', sequenceNo: 1, qymc: '宁波判定断言企业有限公司' },
      ],
      reason: 'qymc 逐字相等',
    }
    const ingest = normalizeUsccVerdicts([
      { file: 'uscc-verdict-batch-1.json', value: { batch: 1, generatedAt: '2026-10-16T15:00:00.000Z', items: [item] } as UsccVerdictFile },
      { file: 'uscc-verdict-batch-4.json', value: { batch: 4, generatedAt: '2026-10-16T15:30:00.000Z', items: [item] } as UsccVerdictFile },
    ])
    expect(ingest.platformClaims).toHaveLength(1)
    expect(ingest.platformClaims[0]!.batchRef).toBe('uscc-verdict-batch-1')
    // 「取更强结论」的收尾：这家企业已经可采纳 ⇒ 同一企业的另一条（哪怕标 conflict）
    // **不再**进「不动库」清单，只在 problems 里说明 —— 否则同一条既算补齐又算冲突。
    expect(ingest.untouched).toEqual([])
    expect(ingest.problems.join('|')).toContain('取更强结论')

    // 同企业两个**不同**候选统代 ⇒ 保留先出现的，后一条转冲突待核（不猜哪个对）。
    const clash = normalizeUsccVerdicts([
      { file: 'a.json', value: { batch: 1, generatedAt: '2026-10-16T15:00:00.000Z', items: [item] } as UsccVerdictFile },
      {
        file: 'b.json',
        value: {
          batch: 2,
          generatedAt: '2026-10-16T15:30:00.000Z',
          items: [{ ...item, candidateUscc: '91330212MA2CL6FP2J' }],
        } as UsccVerdictFile,
      },
    ])
    // 两边都自称有证据、候选统代却不同 ⇒ **该企业整体不写**（先出现的那条也撤回）。
    expect(clash.platformClaims).toHaveLength(0)
    expect(clash.untouched[0]!.verdict).toBe('conflict')
    expect(clash.problems.join('|')).toContain('撤回先前采纳')
  })

  it('★ 只交判定文件时**只判这些目标** —— 不顺手把库内路径能解决的也一起归并', () => {
    // 库内路径本来能把 `target`（375）与 `unproven` 等一并处理；给了认领之后不该碰它们。
    const before = db.select().from(schema.enterprise).all().filter((e) => e.usccNorm == null).length
    const report = planUsccResearch(db, {
      platformClaims: [
        {
          enterpriseId: lonelyAlt,
          enterpriseName: '宁波判定断言企业有限公司',
          uscc: '91330215MA2CL6FP21',
          evidence: [],
          batchRef: 'uscc-verdict-batch-9',
          observedAt: '2026-10-16T16:00:00.000Z',
        },
      ],
    })
    // 认领没带可用证据 ⇒ 独立结论是待人工，但**范围**里只有它一家。
    expect(report.counts.targets).toBe(1)
    expect(report.outcomes.map((row) => row.enterpriseId)).toEqual([lonelyAlt])
    expect(report.request).toBeNull()
    expect(db.select().from(schema.enterprise).all().filter((e) => e.usccNorm == null).length).toBe(before)
  })

  it('★ 别名去重：规范行已有同名 confirmed 曾用名 ⇒ 只并身份，不再写第二条别名', () => {
    const canonicalRow = seedEnterprise({ name: '宁波别名去重规范行有限公司', uscc: '91330216MA2CL6FP2C' })
    const duplicate = seedEnterprise({ name: '宁波别名去重旧名有限公司' })
    // 规范行上**已经**有这个名字的 confirmed 曾用名（批次 5 实测 335/783/1448 就是这种）。
    db.insert(schema.enterpriseAlias)
      .values({
        enterpriseId: canonicalRow,
        name: '宁波别名去重旧名有限公司',
        nameNorm: '宁波别名去重旧名有限公司',
        sourceKind: 'platform_business',
        sourceRefId: 0,
        verificationStatus: 'confirmed',
      })
      .run()
    const report = planUsccResearch(db, {
      platformClaims: [
        {
          enterpriseId: duplicate,
          enterpriseName: '宁波别名去重旧名有限公司',
          uscc: '91330216MA2CL6FP2C',
          evidence: [
            {
              interface: 'apply_list',
              rdjb: '',
              sequenceNo: 1,
              relationKey: 'SQ-dup-1',
              nameRaw: '宁波别名去重旧名有限公司',
            },
          ],
          batchRef: 'uscc-verdict-batch-9',
          observedAt: '2026-10-16T16:00:00.000Z',
        },
      ],
    })
    expect(report.counts).toMatchObject({ filled: 1, aliasAlreadyPresent: 1 })
    expect(report.ready[0]!.aliasAlreadyPresent).toBe(true)
    // 归并照做（身份要并），但**不带 `aliasName`** ⇒ 不产生第二条同名别名行。
    expect(report.ready[0]!.merge).toMatchObject({ fromEnterpriseId: duplicate, intoUscc: '91330216MA2CL6FP2C' })
    expect(report.ready[0]!.merge!.aliasName).toBeUndefined()
    // 光看载荷不够：**执行侧**也得按 `(enterprise_id, name_norm)` 去重 ——
    // 归并执行时 `aliasName` 缺省会退回**被并方的现名**，若执行侧只按含 `source_ref_id`
    // 的唯一键判，这里照样会多出一行（这正是本轮实测到的那条真缺陷）。
    aliasRowCount = db.select().from(schema.enterpriseAlias).all().length
    aliasMergeRequest = report.request
  })

  it('★ 执行该归并：同名曾用名被**复用**，别名表不增行', async () => {
    const result = await client().commit(aliasMergeRequest!)
    expect(result.status).toBe('committed')
    const lineage = result.items.find((item) => item.kind === 'merge')!.detail!.lineage as { aliasId: number | null }
    expect(lineage.aliasId).toBeGreaterThan(0)
    expect(db.select().from(schema.enterpriseAlias).all().length).toBe(aliasRowCount)
    expect(db.select().from(schema.enterpriseAlias).all().filter((a) => a.nameNorm === '宁波别名去重旧名有限公司')).toHaveLength(1)
  })

  it('★ 认领只给企业名也给得到结论：四桶之和恒等于 counts.targets', () => {
    const named = seedEnterprise({ name: '宁波按名认领企业有限公司' })
    const report = planUsccResearch(db, {
      claims: [
        {
          enterpriseName: '宁波按名认领企业有限公司',
          uscc: '91330217MA2CL6FP2T',
          source: { url: 'https://example.test/n', checkedOn: '2026-10-16', basis: '按名指企业', name: '宁波按名认领企业有限公司' },
        },
      ],
    })
    // 按名解析到的企业必须在 `targets` 里 ⇒ 进 `outcomes`；否则报告会自相矛盾。
    expect(report.counts.targets).toBe(1)
    expect(report.counts.ready).toBe(report.counts.filled)
    expect(report.outcomes).toHaveLength(1)
    expect(report.outcomes[0]!.enterpriseId).toBe(named)
    const sum = report.counts.filled + report.counts.conflict + report.counts.notFound + report.counts.manual
    expect(sum).toBe(report.counts.targets)
  })

  it('★ 显式 enterpriseIds 之外的认领 ⇒ 报 `out_of_scope`，不进载荷', () => {
    const outside = seedEnterprise({ name: '宁波范围外企业有限公司' })
    const inside = seedEnterprise({ name: '宁波范围内企业有限公司' })
    const report = planUsccResearch(db, {
      enterpriseIds: [inside],
      claims: [
        {
          enterpriseId: outside,
          uscc: '91330218MA2CL6FP29',
          source: { url: 'https://example.test/o', checkedOn: '2026-10-16', basis: '范围外', name: '宁波范围外企业有限公司' },
        },
      ],
    })
    expect(report.counts.filled).toBe(0)
    expect(report.request).toBeNull()
    expect(report.pending.some((row) => row.code === 'out_of_scope')).toBe(true)
  })

  it('★ 用字纠错（ocr_correction）：显式给才认，记档不写成任何一档「名称相等」', () => {
    // 用户 2026-10-16 裁定：公布件「宁波荔群…」是 OCR 误读，平台记录「宁波加群…」为准。
    const wrong = seedEnterprise({ name: '宁波荔群精密模具有限公司' })
    const right = seedEnterprise({ name: '宁波劦群精密模具有限公司', uscc: '91330226MA282TE4X1' })
    const correction = {
      basisKind: 'ocr_correction' as const,
      confirmedBy: '用户',
      announcedName: '宁波荔群精密模具有限公司',
      platformName: '宁波劦群精密模具有限公司',
      note: '荔群属于 OCR 错误,正确的就是平台',
    }
    const evidence = [
      {
        interface: 'business_list' as const,
        rdjb: '2',
        sequenceNo: 1,
        relationKey: 'SQ-ocr-1',
        nameRaw: '宁波劦群精密模具有限公司',
        status: '终审通过',
        usccRaw: '91330226MA282TE4X1',
      },
    ]
    // (1) **不给** correction ⇒ 三档判据一条都不成立（归一化不会把「荔」变成「劦」）⇒ 待人工。
    const without = planUsccResearch(db, {
      enterpriseIds: [wrong],
      platformClaims: [
        {
          enterpriseId: wrong,
          enterpriseName: '宁波荔群精密模具有限公司',
          uscc: '91330226MA282TE4X1',
          evidence,
          batchRef: 'b',
          observedAt: '2026-10-16T16:00:00.000Z',
        },
      ],
    })
    expect(without.counts).toMatchObject({ filled: 0, manual: 1 })
    expect(without.pending[0]!.code).toBe('no_platform_evidence')
    expect(without.request).toBeNull()

    // (2) 给了 correction ⇒ 按「平台原文逐字」锚定，走归并；记档为 ocr_correction。
    const with_ = planUsccResearch(db, {
      enterpriseIds: [wrong],
      platformClaims: [
        {
          enterpriseId: wrong,
          enterpriseName: '宁波荔群精密模具有限公司',
          uscc: '91330226MA282TE4X1',
          evidence,
          correction,
          batchRef: 'uscc-recheck-extra-3',
          observedAt: '2026-10-16T16:00:00.000Z',
        },
      ],
    })
    expect(with_.counts).toMatchObject({ filled: 1, closed: 1 })
    expect(with_.counts.byBasisKind).toEqual({ ocr_correction: 1 })
    const ready = with_.ready[0]!
    expect(ready.basisKind).toBe('ocr_correction')
    expect(ready.merge).toMatchObject({ fromEnterpriseId: wrong, intoUscc: '91330226MA282TE4X1' })
    expect(ready.merge!.sourceRelationRef).toMatchObject({ relationKey: 'SQ-ocr-1' })
    // 记档措辞：写清「用户确认为 OCR 误读 + 平台记录为准」，且**不**出现「名称相等」字样。
    expect(ready.merge!.note).toContain('OCR 误读')
    expect(ready.merge!.note).toContain('宁波劦群精密模具有限公司」为准')
    expect(ready.merge!.note).toContain('人工确认')
    expect(ready.merge!.note).not.toContain('逐字等于')
    expect(ready.merge!.note).not.toContain('归一化后相等')
    expect(right).toBeGreaterThan(0)
  })

  it('★ 用字纠错必须**指名确认人**：空白 confirmedBy ⇒ 拒收，不写', () => {
    const wrong = seedEnterprise({ name: '宁波荔一误读企业有限公司' })
    const report = planUsccResearch(db, {
      enterpriseIds: [wrong],
      platformClaims: [
        {
          enterpriseId: wrong,
          enterpriseName: '宁波荔一误读企业有限公司',
          uscc: '91330219MA2CL6FP2P',
          evidence: [
            {
              interface: 'business_list',
              rdjb: '2',
              sequenceNo: 1,
              relationKey: 'SQ-ocr-2',
              nameRaw: '宁波劦一正写企业有限公司',
            },
          ],
          correction: {
            basisKind: 'ocr_correction',
            confirmedBy: '   ',
            announcedName: '宁波荔一误读企业有限公司',
            platformName: '宁波劦一正写企业有限公司',
            note: '无主纠错',
          },
          batchRef: 'b',
          observedAt: '2026-10-16T16:00:00.000Z',
        },
      ],
    })
    expect(report.counts.filled).toBe(0)
    expect(report.pending[0]!.code).toBe('correction_unattributed')
    expect(report.request).toBeNull()
  })

  it('★ 归一化与逐字都**推不出** ocr_correction：荔/加 不是可套用的模式', () => {
    // 这一条钉住红线：软件不判定字形相近。荔/劦 两字的任何「相等」判据都推不出来。
    expect(nameMatchLevel('宁波荔群精密模具有限公司', '宁波劦群精密模具有限公司')).toBeNull()
    expect(nameMatchLevel('宁波荔群精密模具有限公司', '宁波荔群精密模具有限公司')).toBe('byte')
    // 归一化也不会把它们变成一样（归一化只去空白/零宽/括号/尾随符号、补「宁波」前缀）。
    expect(normalizeName('宁波荔群精密模具有限公司')).not.toBe(normalizeName('宁波劦群精密模具有限公司'))
  })

  it('★ 联网核实 found ⇒ 公开主体来源认领（URL + 抓取日期 + 对应依据），三要素缺一不采纳', () => {
    const ingest = normalizeUsccVerdicts([
      {
        file: 'uscc-webverify-verdict.json',
        value: {
          generatedAt: '2026-10-16T17:32:00+08:00',
          items: [
            {
              enterpriseId: 244,
              name: '宁波洒哇地咔电器有限公司',
              verdict: 'found',
              candidateUscc: '91330281074914761W',
              sources: [
                {
                  url: 'https://www.chinapp.com/company/12056',
                  fetchedAt: '2026-10-16T17:12:00+08:00',
                  basis: '单企业页:标题与正文均含「宁波洒哇地咔电器有限公司」,表「统一社会信用代码 91330281074914761W」',
                },
              ],
              notes: '名称与代码同页配对且区县(余姚市)一致。',
            },
            {
              // 三要素不齐 ⇒ 不采纳、如实列进「不动库」（不猜）。
              enterpriseId: 261,
              name: '慈溪市振鹏管件有限公司',
              verdict: 'found',
              candidateUscc: '91330282724068481X',
              sources: [{ url: '', fetchedAt: '', basis: '' }],
            },
          ],
        } as UsccVerdictFile,
      },
    ])
    expect(ingest.claims).toHaveLength(1)
    expect(ingest.claims[0]).toMatchObject({
      enterpriseId: 244,
      uscc: '91330281074914761W',
      source: {
        url: 'https://www.chinapp.com/company/12056',
        checkedOn: '2026-10-16',
        name: '宁波洒哇地咔电器有限公司',
      },
    })
    expect(ingest.claims[0]!.source.basis).toContain('统一社会信用代码')
    expect(ingest.claims[0]!.note).toContain('余姚市')
    expect(ingest.platformClaims).toEqual([])
    expect(ingest.untouched.map((row) => row.verdict)).toEqual(['needs_human'])
    expect(ingest.problems.join('|')).toContain('公开来源三要素不齐')
  })

  it('★ found 走公开来源那一档：补录载荷带上来源 URL 与查证日期（不写成名称相等）', () => {
    const targetRow = seedEnterprise({ name: '宁波联网补录企业有限公司' })
    const report = planUsccResearch(db, {
      enterpriseIds: [targetRow],
      claims: [
        {
          enterpriseId: targetRow,
          uscc: '91330220MA2CL6FP25',
          source: {
            url: 'https://example.test/credit/2',
            checkedOn: '2026-10-16',
            basis: '公开信用信息页:名称/区划/代码同页配对',
            name: '宁波联网补录企业有限公司',
          },
        },
      ],
    })
    expect(report.counts).toMatchObject({ filled: 1, closed: 1 })
    expect(report.counts.byBasisKind).toEqual({ public_source: 1 })
    const ready = report.ready[0]!
    expect(ready.basisKind).toBe('public_source')
    expect(ready.backfill).toMatchObject({
      enterpriseId: targetRow,
      uscc: '91330220MA2CL6FP25',
      source: { url: 'https://example.test/credit/2', checkedOn: '2026-10-16' },
    })
    expect(ready.merge).toBeNull()
  })

  it('★ 两段来源拼成的归并：note 必须写实「平台现名与公布名不同」与「平台不索引旧名」两句', () => {
    const published = seedEnterprise({ name: '宁波开诚生态技术有限公司' })
    const holder = seedEnterprise({ name: '宁波开诚生态技术股份有限公司', uscc: '9133021274738281XA' })
    const report = planUsccResearch(db, {
      enterpriseIds: [published],
      platformClaims: [
        {
          enterpriseId: published,
          enterpriseName: '宁波开诚生态技术有限公司',
          uscc: '9133021274738281XA',
          crossSource: {
            publicSource: {
              url: 'https://zhidao.baidu.com/question/1309317620586833819.html',
              fetchedAt: '2026-10-16T17:12:00+08:00',
              basis: '页面正文同片出现「…的统一社会信用代码/注册号是9133021274738281XA」，并给出注册地 海曙区古林镇戴家村',
              site: '百度知道',
            },
            platformByCode: { interface: 'business_list', rdjb: '3', rowCount: 4, qymc: '宁波开诚生态技术股份有限公司' },
            nameQueryRowCount: 0,
            renameNote: null,
            controlNote: null,
          },
          batchRef: 'platform-verify-aclass',
          observedAt: '2026-10-16T17:47:18+08:00',
        },
      ],
    })
    expect(report.counts).toMatchObject({ filled: 1, closed: 1 })
    expect(report.counts.byBasisKind).toEqual({ public_source: 1 })
    const ready = report.ready[0]!
    expect(ready.basisKind).toBe('public_source')
    expect(ready.merge).toMatchObject({
      fromEnterpriseId: published,
      intoUscc: '9133021274738281XA',
      aliasName: '宁波开诚生态技术有限公司',
      // 曾用名的来源是**公开来源页** ⇒ manual + 0（不是某条平台关系）。
      sourceKind: 'manual',
      sourceRefId: 0,
    })
    // 第二段（平台按码）落成真的平台查询行，并作为归并的查询证据进血缘。
    expect(ready.platformQueries).toHaveLength(1)
    expect(ready.platformQueries[0]).toMatchObject({ interface: 'business_list', queryKey: '9133021274738281XA', rdjb: '3' })
    const rows = ready.platformQueries[0]!.relations ?? []
    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({
      nameRaw: '宁波开诚生态技术股份有限公司',
      usccRaw: '9133021274738281XA',
      // 名称与公布名不同 ⇒ 这一行不是曾用名证据，标 pending 不冒充 confirmed。
      verificationStatus: 'pending',
    })
    const note = ready.merge!.note
    // 两句必须写实：
    expect(note).toContain('**平台在该码下持有的现名为「宁波开诚生态技术股份有限公司」，与公布名不同**')
    expect(note).toContain('**按公布名查平台 qymc 返回 0 行 —— 平台不索引旧名**')
    expect(note).toContain('宁波劦群')
    expect(note).toContain('不是**由平台名称匹配触发')
    // 绝不出现「名称相等 / 归一化后相等 / 名称相似」这类措辞。
    for (const banned of ['名称相等', '归一化后相等', '名称相似', '名称相近', '逐字等于', '仅字形等价']) {
      expect(note, `note 不得出现「${banned}」`).not.toContain(banned)
    }
    // 第一段的公开来源原样保留（url + 站点 + basis）。
    expect(note).toContain('https://zhidao.baidu.com/question/1309317620586833819.html')
    expect(note).toContain('百度知道')
    expect(note).toContain('海曙区古林镇戴家村')
    expect(holder).toBeGreaterThan(0)
  })

  it('★ 两段缺一即不写；且「平台那个码在库里没行」不算可并（如实落冲突/待人工）', () => {
    const published = seedEnterprise({ name: '宁波缺段企业有限公司' })
    const base = {
      enterpriseId: published,
      enterpriseName: '宁波缺段企业有限公司',
      uscc: '91330221MA2CL6FP2K',
      batchRef: 'b',
      observedAt: '2026-10-16T17:47:18+08:00',
    }
    // (1) 缺第一段（没有公开来源页）
    const noPublic = planUsccResearch(db, {
      enterpriseIds: [published],
      platformClaims: [
        {
          ...base,
          crossSource: {
            publicSource: { url: '', fetchedAt: '', basis: '', site: null },
            platformByCode: { interface: 'business_list', rdjb: '3', rowCount: 2, qymc: '宁波缺段科技股份有限公司' },
            nameQueryRowCount: 0,
          },
        },
      ],
    })
    expect(noPublic.counts.filled).toBe(0)
    expect(noPublic.pending[0]?.code).toBe('cross_source_incomplete')

    // (2) 按公布名查平台回了行 ⇒ 前提不成立（那是平台名称匹配那一路的事）
    const nameMatched = planUsccResearch(db, {
      enterpriseIds: [published],
      platformClaims: [
        {
          ...base,
          crossSource: {
            publicSource: { url: 'https://example.test/x', fetchedAt: '2026-10-16', basis: '配对', site: null },
            platformByCode: { interface: 'business_list', rdjb: '3', rowCount: 2, qymc: '宁波缺段科技股份有限公司' },
            nameQueryRowCount: 3,
          },
        },
      ],
    })
    expect(nameMatched.pending[0]?.code).toBe('cross_source_incomplete')
    expect(nameMatched.pending[0]?.message).toContain('平台不索引旧名')

    // (3) 该码在库里没人持有 ⇒ 没有可并入的规范行
    const noHolder = planUsccResearch(db, {
      enterpriseIds: [published],
      platformClaims: [
        {
          ...base,
          crossSource: {
            publicSource: { url: 'https://example.test/y', fetchedAt: '2026-10-16', basis: '配对', site: null },
            platformByCode: { interface: 'business_list', rdjb: '3', rowCount: 2, qymc: '宁波缺段科技股份有限公司' },
            nameQueryRowCount: 0,
          },
        },
      ],
    })
    expect(noHolder.pending[0]?.code).toBe('uscc_taken')
    expect(noHolder.request).toBeNull()
  })

  it('★ 端到端：判定文件 → 服务端采纳 → 统一 API 落库 → 清单里少一家', async () => {
    const before = listUsccChecklist(db, { pageSize: 500 }).rows.length
    const response = await fetch(`${server.baseUrl}/api/roster/uscc-research`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enterpriseIds: [lonelyAlt],
        verdictFiles: [
          {
            file: 'uscc-verdict-batch-9.json',
            value: {
              batch: 9,
              generatedAt: '2026-10-16T16:00:00.000Z',
              items: [
                {
                  enterpriseId: lonelyAlt,
                  name: '宁波判定断言企业有限公司',
                  district: '鄞州区',
                  keyword: '判定断言',
                  candidateUscc: '91330213MA2CL6FP21',
                  platformEvidence: [
                    {
                      interface: 'business_list',
                      rdjb: '3',
                      sequenceNo: 1,
                      relationKey: 'SQ-verdict-1',
                      qymc: '宁波判定断言企业有限公司',
                      cszt: '终审通过',
                    },
                  ],
                  qymcEqualsAnnouncedName: true,
                  verdict: 'resolved',
                  reason: '依据 qymc 与公布名逐字相等',
                },
              ],
            },
          },
        ],
      }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      plan: { counts: { filled: number }; request: RosterImportRequest | null }
      verdicts: { accepted: number; untouched: unknown[]; problems: string[] }
    }
    expect(body.verdicts.accepted).toBe(1)
    expect(body.verdicts.problems).toEqual([])
    expect(body.plan.request).not.toBeNull()

    const result = await client().commit(body.plan.request!)
    expect(result.status).toBe('committed')
    const row = db.select().from(schema.enterprise).all().find((e) => e.id === lonelyAlt)!
    expect(row.usccNorm).toBe('91330213MA2CL6FP21')
    expect(row.qualityFlags).toEqual([])
    // 证据确实落库了：那条平台关系能按统代查回来，并且关系上写着公布名。
    const query = db
      .select()
      .from(schema.platformQuery)
      .all()
      .find((q) => q.queryKey === '91330213MA2CL6FP21' && q.interface === 'business_list' && q.rdjb === '3')!
    const relation = db.select().from(schema.platformRelation).all().find((r) => r.queryId === query.id)!
    expect(relation.nameRaw).toBe('宁波判定断言企业有限公司')
    expect(relation.relationKey).toBe('SQ-verdict-1')
    expect(relation.sourceText).toContain('uscc-verdict-batch-9')
    expect(relation.sourceText).toContain('未随文件交接')
    expect(listUsccChecklist(db, { pageSize: 500 }).rows.length).toBe(before - 1)

    // 重放：同一批文件再跑一次 ⇒ 清单里已经没有它了 ⇒ 无可执行项，不发空批。
    const replay = (await (
      await fetch(`${server.baseUrl}/api/roster/uscc-research`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enterpriseIds: [lonelyAlt], verdictFiles: [] }),
      })
    ).json()) as { plan: { request: unknown; counts: { filled: number } } }
    expect(replay.plan.counts.filled).toBe(0)
    expect(replay.plan.request).toBeNull()
  })
})

describe('F · 回归 91330211255994457P：计划 → 执行 → 两行合一、一条不丢', () => {
  let request: RosterImportRequest | null = null

  it('★ 计划：证据成立，给出的是**归并**（不是只补一个值），且指向那 6 条关联里的旧名行', () => {
    const report = planUsccResearch(db, { enterpriseIds: [target] })
    expect(report.counts).toMatchObject({ targets: 1, filled: 1, closed: 1 })
    const ready = report.ready[0]!
    expect(ready.route).toBe('library')
    expect(ready.merge).not.toBeNull()
    expect(ready.merge!.fromEnterpriseId).toBe(target)
    expect(ready.merge!.intoUscc).toBe(USCC)
    request = report.request
    expect(request).not.toBeNull()
  })

  it('★ 执行：两行合一 —— 公布历史、称号、出处（含第 74 页）一条不丢，并写出曾用名', async () => {
    const result = await client().commit(request!)
    expect(result.status).toBe('committed')
    const lineage = result.items.find((item) => item.kind === 'merge')!.detail!.lineage as {
      fromEnterpriseId: number
      intoEnterpriseId: number
      intoUscc: string
      aliasId: number | null
      eventsMoved: number[]
      evidenceMoved: number[]
    }
    expect(lineage).toMatchObject({ fromEnterpriseId: target, intoEnterpriseId: canonical, intoUscc: USCC })
    expect(lineage.eventsMoved).toContain(targetEvent)
    expect(lineage.evidenceMoved).toContain(targetEvidence)

    // 被并行没了，规范行还在。
    expect(db.select().from(schema.enterprise).all().some((e) => e.id === target)).toBe(false)
    const merged = db.select().from(schema.enterprise).all().find((e) => e.id === canonical)!
    expect(merged.usccNorm).toBe(USCC)

    // 曾用名（旧名）落在规范行上，且**指回那条平台关系**。
    const alias = db.select().from(schema.enterpriseAlias).all().find((a) => a.enterpriseId === canonical)!
    expect(alias).toMatchObject({ name: OLD_NAME, sourceKind: 'platform_business', verificationStatus: 'confirmed' })
    const relation = db.select().from(schema.platformRelation).all().find((r) => r.id === alias.sourceRefId)!
    expect(relation.nameRaw).toBe(OLD_NAME)

    // 公布侧那条 2022 认定（第 74 页）跟着事件一起归入规范行。
    const event = db.select().from(schema.recordEvent).all().find((e) => e.id === targetEvent)!
    const record = db.select().from(schema.record).all().find((r) => r.id === event.recordId)!
    expect(record.enterpriseId).toBe(canonical)
    const evidence = db.select().from(schema.recordEvidence).all().find((v) => v.id === targetEvidence)!
    expect(evidence.page).toBe(74)
    expect(evidence.recordEventId).toBe(targetEvent)
  })

  it('★ 该统代的**全部 6 条**关联关系一条不丢（不是 1 条）', () => {
    const query = db
      .select()
      .from(schema.platformQuery)
      .all()
      .find((q) => q.queryKey === USCC && q.interface === 'business_list' && q.rdjb === '3')!
    expect(db.select().from(schema.platformRelation).all().filter((r) => r.queryId === query.id)).toHaveLength(6)
  })

  it('★ 按**现名或曾用名**搜索都命中同一家企业（读侧口径）', async () => {
    const byNew = await getJson<{ checklist: { counts: { total: number } } }>(
      '/api/roster/uscc-research?q=%E4%B8%8A%E8%88%AA%E6%B5%8B%E7%BB%98%E8%82%A1%E4%BB%BD',
    )
    // 规范行已有统代 ⇒ 本清单（缺统代）里没有它；用总表读模型验证两个名字都命中同一企业。
    expect(byNew.checklist.counts.total).toBe(0)
    const { allRosterEnterprises } = await import('../lib/roster/enterprise-roster')
    const byAlias = allRosterEnterprises(db, { q: OLD_NAME }).rows
    const byName = allRosterEnterprises(db, { q: NEW_NAME }).rows
    expect(byAlias.map((r) => r.enterpriseId)).toEqual([canonical])
    expect(byName.map((r) => r.enterpriseId)).toEqual([canonical])
    expect(byAlias[0]!.aliasNames).toContain(OLD_NAME)
  })

  it('★ 补齐之后不再进入待查清单（票面第 6 条）', () => {
    const ids = listUsccChecklist(db, { pageSize: 500 }).rows.map((r) => r.enterpriseId)
    expect(ids).not.toContain(target)
    expect(ids).not.toContain(canonical)
    const report = planUsccResearch(db)
    expect(report.counts.filled).toBe(0)
  })
})
