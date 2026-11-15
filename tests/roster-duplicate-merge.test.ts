import { nativeQueryRows, nativeRelationRows } from './helpers/native-platform-evidence'
import { initializeDb } from '../db/client'
/**
 * RL-14 端到端：**重名候选显式化 + 有证据的归并**。
 *
 * ── 覆盖什么 ────────────────────────────────────────────────────────────
 *  - **A**：导入**新建企业**时，库里已有同名（`name_norm` 相同）的行 ⇒ 报告里**显式**出现
 *    该重名候选（预检 + 提交 + 批次结果三处都能查回）；**匹配规则不变**（不按名自动合并 ——
 *    新建那行照样建出来，候选只是把它说清楚）。
 *  - **B**：归并后规范行保留**导出表侧**的名字；被并的公布名落 `enterprise_alias`
 *    （**逐字相同则不造别名**，只并身份）。
 *  - **C**：一条**端到端** —— 真实 HTTP 写入平台查询/关系（夹具是 `tests/fixtures/platform/`
 *    里裁剪的**真实响应摘录**），再执行 `payload.merges`：两行合一、各称号/事件/出处一条不丢、
 *    血缘可在 `import_batch.item_results` 取回、同键重放不增行。
 *  - **反面**：证据不足（`qymc` 与公布名不符 / 该统代一次都没查过 / 同一既有行被多条候选认领）
 *    ⇒ **不归并**，逐条列待核。
 *
 * ── 走的是哪条链路 ──────────────────────────────────────────────────────
 * `tests/helpers/platform-evidence-server.ts` 在**真端口**上起 node:http，挂的是 Nitro 路由
 * 也在调的**同一份** `handleRosterImportRequest`（写）与**真的**路由模块（读）；
 * 客户端用 `lib/roster-import-client.ts`。测的不是替身实现，契约只有一份。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { schema, useDb } from '../db'
import type { DuplicateMergeReport } from '../lib/roster/duplicate-merge'
import { createRosterImportClient, type RosterImportRequest } from '../lib/roster-import-client'
import { classifyRawQuery } from '../lib/platform'
import { buildPlatformWritePayload, type KnownEnterprise, type PlatformQueryInput } from '../lib/platform/payload'
import {
  enterpriseExists,
  planRosterImport,
  readImportBatchOutcome,
  readMergeLineage,
  rosterRowCounts,
  searchEnterpriseIdsByName,
} from '../server/utils/roster-import'
import { startEvidenceServer, type EvidenceServer } from './helpers/platform-evidence-server'

const dir = mkdtempSync(join(tmpdir(), 'spztx-duplicate-merge-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'dup-merge.db') })

const TOKEN = 'rl14-token-value'
const QUERIED_AT = '2026-10-15T17:11:21.514Z'

/** 真实夹具对应的回归案例：统代 `91330211255994457P`，公布名（历史名）与平台现名不同。 */
const USCC = '91330211255994457P'
const OLD_NAME = '宁波上航测绘有限公司'
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures/platform', name), 'utf8')

// ---------------------------------------------------------------------------
// 夹具：既有企业（公布侧，无统代）与它的记录 / 事件 / 出处
// ---------------------------------------------------------------------------

function seedEnterprise(name: string, uscc: string | null) {
  return db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc, district: '镇海区' })
    .returning({ id: schema.enterprise.id })
    .get().id
}
function seedRecord(enterpriseId: number, source: 'jxj' | 'miit', titleCode: 'specialized_sme' | 'little_giant') {
  return db
    .insert(schema.record)
    .values({ enterpriseId, source, titleCode, district: '镇海区' })
    .returning({ id: schema.record.id })
    .get().id
}
function seedEvent(recordId: number, eventType: 'award' | 'review', year: number, batchSeq: number) {
  return db
    .insert(schema.recordEvent)
    .values({ recordId, eventType, year, sortKey: year, batchSeq, decidedYear: year })
    .returning({ id: schema.recordEvent.id })
    .get().id
}
function seedEvidence(recordEventId: number, page: number | null) {
  return db
    .insert(schema.recordEvidence)
    .values({
      recordEventId,
      sourceFile: 'jxj/announcement/2022/甬经信中小〔2022〕145号.pdf',
      attachment: '附件',
      listNo: 74,
      page,
    })
    .returning({ id: schema.recordEvidence.id })
    .get().id
}

/** 公布侧那一行（事故里的 375：**无统代**，只有 jxj 公布记录）。 */
const existing = seedEnterprise(OLD_NAME, null)
const existingRecord = seedRecord(existing, 'jxj', 'specialized_sme')
const existingEvent = seedEvent(existingRecord, 'award', 2022, 1)
const existingEvidence = seedEvidence(existingEvent, 74)

/**
 * 一次「带统代再进来一遍」的导入（事故的触发动作）：名字与既有行**逐字相同**，
 * 只是这次带了统一社会信用代码 —— 于是写入侧按统代另起一行，既有行原封不动。
 */
const importRequest: RosterImportRequest = {
  idempotencyKey: 'rl14/import#sha256:a1',
  sourceKind: 'announcement',
  sourceIdentity: 'jxj/workbook/little-giant.xlsx',
  payload: {
    announcement: {
      sourceDocument: { source: 'jxj', title: '历年小巨人工作簿', docNumber: null },
      records: [
        {
          enterprise: { name: OLD_NAME, uscc: USCC, district: '镇海区' },
          titleCode: 'specialized_sme',
          events: [
            {
              eventType: 'award',
              year: 2023,
              batchSeq: 2,
              decidedYear: 2023,
              evidence: [{ sourceFile: 'jxj/workbook/little-giant.xlsx', attachment: 'Sheet1', listNo: 5, page: null }],
            },
          ],
        },
      ],
    },
  },
}

// ---------------------------------------------------------------------------
// 真实 HTTP 服务：写 = RL-11 的 http 面；读 = 本票新增的候选报告路由（真模块）
// ---------------------------------------------------------------------------

let server: EvidenceServer
let currentQuery: Record<string, unknown> = {}
const client = () => createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
const json = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${server.baseUrl}${path}`)
  expect(response.status, `${path} 应返回 200`).toBe(200)
  return (await response.json()) as T
}
const candidatesReport = (batchKey: string) =>
  json<DuplicateMergeReport>(`/api/roster/import/duplicate-candidates?batchKey=${encodeURIComponent(batchKey)}`)

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getQuery', () => currentQuery)
  vi.stubGlobal('createError', (opts: { statusCode?: number; statusMessage?: string }) =>
    Object.assign(new Error(opts.statusMessage ?? 'Bad request'), opts),
  )
  vi.stubGlobal('useRuntimeConfig', () => ({ curatedPath: join(dir, 'none.json'), reconcilePath: join(dir, 'none.json') }))
  vi.doMock('@db', () => ({ useDb: () => db }))

  const route = (await import('../server/api/roster/import/duplicate-candidates.get')).default as unknown as (
    event: unknown,
  ) => unknown

  server = await startEvidenceServer({
    db,
    apiToken: TOKEN,
    getRoutes: {
      '/api/roster/import/duplicate-candidates': (url) => {
        currentQuery = Object.fromEntries(url.searchParams.entries())
        return route({})
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
// A：重名候选是**显式**的
// ---------------------------------------------------------------------------

describe('A · 新建企业时同名 ⇒ 报告里显式列出重名候选', () => {
  let committed: { status: string; items: Array<{ kind: string; ok: boolean; detail?: Record<string, unknown> }> }
  let newEnterpriseId = 0

  it('预检就报出候选（那时新建行还没有 id）', async () => {
    const pre = await client().preflight(importRequest)
    expect(pre.status).toBe('preflight')
    const candidates = (pre.preflight as { duplicateCandidates?: Array<Record<string, unknown>> }).duplicateCandidates ?? []
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      basis: 'same_name_norm',
      name: OLD_NAME,
      existingEnterpriseId: existing,
      existingEnterpriseName: OLD_NAME,
      existingUscc: null,
      newEnterpriseId: null,
      newUscc: USCC,
      sourceRef: 'record:0',
    })
    // 预检不写业务数据。
    expect(db.select().from(schema.enterprise).all().filter((e) => e.usccNorm === USCC)).toHaveLength(0)
  })

  it('★ 提交：候选进 item_results（补齐新建行 id），且**匹配规则不变**——新行照样建出来', async () => {
    committed = (await client().commit(importRequest)) as unknown as typeof committed
    expect(committed.status).toBe('committed')

    const item = committed.items.find((i) => i.kind === 'duplicate_candidate')!
    expect(item.ok).toBe(true)
    const candidate = item.detail!.candidate as Record<string, unknown>
    newEnterpriseId = candidate.newEnterpriseId as number
    expect(candidate).toMatchObject({
      basis: 'same_name_norm',
      nameNorm: OLD_NAME,
      existingEnterpriseId: existing,
      existingEnterpriseName: OLD_NAME,
      existingUscc: null,
      newUscc: USCC,
      sourceRef: 'record:0',
    })
    expect(newEnterpriseId).not.toBe(existing)

    // 规则没被放宽：同名两行**都在**（候选只报事实，不合并）。
    const sameName = db.select().from(schema.enterprise).all().filter((e) => e.nameNorm === OLD_NAME)
    expect(sameName.map((e) => e.id).sort((a, b) => a - b)).toEqual([existing, newEnterpriseId].sort((a, b) => a - b))
    expect(sameName.find((e) => e.id === newEnterpriseId)!.usccNorm).toBe(USCC)
  })

  it('批次结果里能查回候选（计数 + 明细）', () => {
    const outcome = readImportBatchOutcome(db, importRequest.idempotencyKey)!
    expect(outcome.duplicateCandidates).toHaveLength(1)
    expect(outcome.duplicateCandidates[0]).toMatchObject({
      existingEnterpriseId: existing,
      newEnterpriseId,
      newUscc: USCC,
      basis: 'same_name_norm',
    })
    // 读接口给的就是同一份（报告不是另存的一份）。
    expect(outcome.duplicateCandidates).toEqual(readImportBatchOutcome(db, importRequest.idempotencyKey)!.duplicateCandidates)
  })

  it('证据还没写 ⇒ 报告里是「待核」，没有任何可并项', async () => {
    const report = await candidatesReport(importRequest.idempotencyKey)
    expect(report.counts).toEqual({ candidates: 1, ready: 0, pending: 1 })
    expect(report.pending[0]!.reason).toBe('no_platform_query')
    expect(report.request).toBeNull()
    expect(enterpriseExists(db, existing)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// C：证据到位后，端到端归并（真实 HTTP + 真实平台响应摘录）
// ---------------------------------------------------------------------------

describe('C · 端到端：真实平台证据 ⇒ 两行合一，一条不丢', () => {
  let relationId = 0
  let queryId = 0
  /** 报告给出的那份可提交请求体（执行过之后报告就不再给可并项了，所以必须当场留住）。 */
  let mergeRequest: RosterImportRequest | null = null

  it('第一批：平台查询与关系经统一 API 落库（夹具是裁剪的真实响应）', async () => {
    const queries: PlatformQueryInput[] = [
      { interface: 'business_list', queryKey: USCC, rdjb: '1', queriedAt: QUERIED_AT, outcome: classifyRawQuery(fixture('business-list-rdjb1-empty.html'), { interface: 'business_list', rdjb: '1', queryKey: USCC }) },
      { interface: 'business_list', queryKey: USCC, rdjb: '2', queriedAt: QUERIED_AT, outcome: classifyRawQuery(fixture('business-list-rdjb2-empty.html'), { interface: 'business_list', rdjb: '2', queryKey: USCC }) },
      { interface: 'business_list', queryKey: USCC, rdjb: '3', queriedAt: QUERIED_AT, outcome: classifyRawQuery(fixture('business-list-rdjb3.html'), { interface: 'business_list', rdjb: '3', queryKey: USCC }) },
      { interface: 'apply_list', queryKey: USCC, rdjb: '', queriedAt: QUERIED_AT, outcome: classifyRawQuery(fixture('apply-list.json'), { interface: 'apply_list', queryKey: USCC }) },
    ]
    const enterprises: KnownEnterprise[] = [
      { id: existing, name: OLD_NAME, nameNorm: OLD_NAME, uscc: null },
      { id: db.select().from(schema.enterprise).all().find((e) => e.usccNorm === USCC)!.id, name: OLD_NAME, nameNorm: OLD_NAME, uscc: USCC },
    ]
    const request = buildPlatformWritePayload({ sourceIdentity: `platform/${USCC}.json`, queries, enterprises })
    const result = await client().commit(request)
    expect(result.status).toBe('committed')

    // 平台自己记录了「这个统代就叫这个名字」：`qymc` 逐字等于公布名（rdjb=3 与 applyList 各有一条）。
    const matching = nativeRelationRows(db)
      .filter(
        (r) =>
          r.nameRaw === OLD_NAME &&
          nativeQueryRows(db).some((q) => q.id === r.queryId && q.queryKey === USCC),
      )
    expect(matching.length, '夹具里应有 qymc 等于公布名的关系').toBeGreaterThan(0)
  })

  it('★ 报告：证据成立 ⇒ 可并，并给出可直接提交的 merges', async () => {
    const report = await candidatesReport(importRequest.idempotencyKey)
    expect(report.counts).toEqual({ candidates: 1, ready: 1, pending: 0 })
    expect(report.previous).toBeNull()

    const ready = report.ready[0]!
    const evidence = ready.evidence
    expect(evidence.nameRaw).toBe(OLD_NAME)
    expect(evidence.queryKey).toBe(USCC)
    // 取证据的规则是**确定性的**：用户实测过的那一类形状（business_list + rdjb=3）优先，
    // 其余接口按查询时点新→旧（并列按行 id 大→小）；查询内按序号小→大取第一条 `qymc` 逐字相等的。
    // 同一个库 ⇒ 同一条证据 ⇒ 可重放。
    const authorized = nativeQueryRows(db)
      .find((q) => q.queryKey === USCC && q.interface === 'business_list' && q.rdjb === '3')!
    expect(evidence.queryId).toBe(authorized.id)
    expect(evidence.interface).toBe('business_list')
    expect(evidence.rdjb).toBe('3')
    // 夹具 rdjb=3 的前两条关系 `qymc` 就是公布名（历史名）⇒ 取序号最小的那条。
    expect(evidence.sequenceNo).toBe(1)
    expect(evidence.relationKey).toBe('SQ332022062212391')
    expect(evidence.sourceKind).toBe('platform_business')
    const relation = nativeRelationRows(db).find((r) => r.id === evidence.relationId)!
    expect(relation.queryId).toBe(authorized.id)
    expect(relation.nameRaw).toBe(OLD_NAME)
    expect(relation.usccRaw).toBe(USCC)
    relationId = evidence.relationId
    queryId = evidence.queryId

    expect(report.request).not.toBeNull()
    mergeRequest = report.request
    expect(report.request!.sourceKind).toBe('alias_evidence')
    // ① 的**缺导出名**一侧：这次没写过任何导出快照 ⇒ `exportName` 为 null、`canonicalName` 不给
    // ⇒ 规范行**不改名**（不猜）。有导出名的一侧见下面的 describe ①。
    expect(ready.exportName).toBeNull()
    expect(report.request!.payload.merges![0]!.canonicalName).toBeUndefined()
    expect(report.request!.payload.merges).toEqual([
      {
        fromEnterpriseId: existing,
        intoUscc: USCC,
        // 两侧**逐字同名** ⇒ 不造别名（§5.3）。
        sourceKind: evidence.sourceKind,
        sourceRefId: relationId,
        evidenceQueryId: queryId,
        note: expect.stringContaining(`qymc 逐字等于「${OLD_NAME}」`),
      },
    ])
  })

  it('★ 执行 merges：两行合一，称号/事件/出处一条不丢', async () => {
    expect(mergeRequest).not.toBeNull()
    const result = await client().commit(mergeRequest!)
    expect(result.status).toBe('committed')
    expect(result.summary.failed).toBe(0)

    // 原身份保留归并映射；规范企业为持有统代的企业。
    expect(db.select().from(schema.enterpriseMerge).all()).toEqual(expect.arrayContaining([expect.objectContaining({fromEnterpriseId:existing})]))
    const canonical = db.select().from(schema.enterprise).all().find((e) => e.usccNorm === USCC)!
    // B：规范行 = 带统代那行 = **导出/平台侧**，归并**不改**它的名字。
    // 重名候选的判据是 `name_norm` 相同，所以这一路两侧的名字按定义同名（本 4 例即如此）：
    // 「规范行的 name 取导出表侧的名字」在这里退化为「保留规范行原样」，没有名字被写坏。
    // 两侧**逐字不同名**时（公布名是短名、导出表是全名）的形态由下面 describe B 覆盖。
    expect(canonical.name).toBe(OLD_NAME)
    // B：两侧逐字同名 ⇒ 不造别名（只并身份）。
    expect(db.select().from(schema.enterpriseAlias).all()).toHaveLength(0)

    // 同 (称号, 来源) 冲突 ⇒ 事件**改指**规范行那条记录：两条认定事件都在。
    const records = db.select().from(schema.record).all().filter((r) => r.enterpriseId === canonical.id)
    expect(records.map((r) => `${r.titleCode}/${r.source}`)).toEqual(['specialized_sme/jxj'])
    const events = db.select().from(schema.recordEvent).all().filter((e) => e.recordId === records[0]!.id)
    expect(events.map((e) => e.year).sort()).toEqual([2022, 2023])
    // 出处随事件归入（含页码）。
    const evidence = db
      .select()
      .from(schema.recordEvidence)
      .all()
      .filter((v) => events.some((e) => e.id === v.recordEventId))
    expect(evidence).toHaveLength(2)
    expect(evidence.some((v) => v.page === 74)).toBe(true)
    // 被并行树下无孤儿。
    expect(db.select().from(schema.record).all().some((r) => r.enterpriseId === existing)).toBe(false)

    // 血缘在 import_batch.item_results 里可查回。
    const lineage = readMergeLineage(db, mergeRequest!.idempotencyKey, existing)!
    expect(lineage).toMatchObject({
      fromEnterpriseId: existing,
      intoEnterpriseId: canonical.id,
      intoUscc: USCC,
      aliasId: null,
      // ① 缺导出名 ⇒ 没改名。
      canonicalName: OLD_NAME,
      rename: null,
    })
    expect(lineage.recordsFolded).toEqual([{
      fromRecordId: existingRecord,
      intoRecordId: records[0]!.id,
      // 原公布侧 seed；不从 merge 后的规范记录或私有结果反推历史快照。
      fromRecordSnapshot: {
        id: existingRecord,
        enterpriseId: existing,
        titleCode: 'specialized_sme',
        source: 'jxj',
        nameRaw: null,
        usccRaw: null,
        district: '镇海区',
        qualityFlags: [],
      },
      eventIds: [existingEvent],
    }])
    expect(lineage.eventsMoved).toEqual([existingEvent])
    expect(lineage.evidenceMoved).toEqual([existingEvidence])
  })

  it('★ 同键重放：不再写一行，返回既有摘要', async () => {
    const before = rosterRowCounts(db)
    const replay = await client().commit(mergeRequest!)
    expect(replay.status).toBe('committed')
    expect(rosterRowCounts(db)).toEqual(before)
    expect(replay.summary).toEqual((await client().commit(mergeRequest!)).summary)
  })

  it('已执行过的候选再读报告：`previous` 指出那一次归并，候选不再重复可并', async () => {
    const report = await candidatesReport(importRequest.idempotencyKey)
    expect(report.previous).not.toBeNull()
    expect(report.previous!.idempotencyKey).toBe(mergeRequest!.idempotencyKey)
    // 被并行已不在库里 ⇒ 这条候选现在读作 `source_gone`（不是「证据不够」）；
    // 已经做过的那次由 `previous` 说明，所以不会有人再并一遍，也不会重复增行。
    expect(report.ready).toHaveLength(0)
    expect(report.pending[0]!.reason).toBe('source_has_uscc')
    expect(report.request).toBeNull()
  })

  it('缺 batchKey / 批次不存在：400 / 404', async () => {
    const missing = await fetch(`${server.baseUrl}/api/roster/import/duplicate-candidates`)
    expect(missing.status).toBe(400)
    const unknown = await fetch(`${server.baseUrl}/api/roster/import/duplicate-candidates?batchKey=nope%23sha256:zz`)
    expect(unknown.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// C · 反面：证据不足一律不并
// ---------------------------------------------------------------------------

describe('C · 反面：证据不足 ⇒ 不归并，逐条待核', () => {
  const NOT_EVIDENCED_USCC = '91330205084796244Y'
  const NEVER_QUERIED_USCC = '913302126102116572'
  const NO_QUERY_NAME = '宁波哲能精密塑料有限公司'
  const NEVER_QUERIED_NAME = '宁波巨神制泵实业有限公司'
  const batchKey = 'rl14/import-negatives#sha256:n1'

  const existingNotEvidenced = seedEnterprise(NO_QUERY_NAME, null)
  const existingNeverQueried = seedEnterprise(NEVER_QUERIED_NAME, null)

  it('导入两行同名企业 ⇒ 两条候选', async () => {
    const request: RosterImportRequest = {
      idempotencyKey: batchKey,
      sourceKind: 'announcement',
      sourceIdentity: 'jxj/workbook/little-giant-negatives.xlsx',
      payload: {
        announcement: {
          sourceDocument: { source: 'jxj', title: '历年小巨人工作簿（反面）', docNumber: null },
          records: [
            { enterprise: { name: NO_QUERY_NAME, uscc: NOT_EVIDENCED_USCC }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2023, batchSeq: 2, decidedYear: 2023, evidence: [{ sourceFile: 'x.xlsx' }] }] },
            { enterprise: { name: NEVER_QUERIED_NAME, uscc: NEVER_QUERIED_USCC }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2023, batchSeq: 2, decidedYear: 2023, evidence: [{ sourceFile: 'x.xlsx' }] }] },
          ],
        },
      },
    }
    const result = await client().commit(request)
    expect(result.status).toBe('committed')
    expect(result.items.filter((i) => i.kind === 'duplicate_candidate')).toHaveLength(2)
  })

  it('查过但 qymc 与公布名不符 / 一次都没查过 ⇒ 逐条待核，一条都不并', async () => {
    // 只给第一个统代写一次查询，且关系里的 `qymc` 与公布名**不符**
    //（这里是**合成**载荷：反面用例要的正是「查过了，但平台没说过这个名字」）。
    const write = await client().commit({
      idempotencyKey: 'rl14/evidence-not-matching#sha256:n2',
      sourceKind: 'alias_evidence',
      sourceIdentity: 'platform/negative.json',
      payload: {
        platformQueries: [
          { rawResponse: 'Explicit synthetic original response',
            interface: 'business_list',
            queryKey: NOT_EVIDENCED_USCC,
            rdjb: '3',
            queriedAt: QUERIED_AT,
            status: 'success',
            relations: [
              {
                sequenceNo: 1,
                relationKey: 'SQ-negative-1',
                usccRaw: NOT_EVIDENCED_USCC,
                nameRaw: '宁波某家别的公司',
                matchBasis: 'uscc',
                verificationStatus: 'confirmed',
              },
            ],
          },
        ],
      },
    })
    expect(write.status).toBe('committed')

    const report = await candidatesReport(batchKey)
    expect(report.counts).toEqual({ candidates: 2, ready: 0, pending: 2 })
    expect(report.request).toBeNull()
    const byName = Object.fromEntries(report.pending.map((p) => [p.candidate.existingEnterpriseName, p.reason]))
    expect(byName[NO_QUERY_NAME]).toBe('name_not_evidenced')
    expect(byName[NEVER_QUERIED_NAME]).toBe('no_platform_query')

    // 一条都没并：四行（两条既有 + 两条新建）都在。
    expect(enterpriseExists(db, existingNotEvidenced)).toBe(true)
    expect(enterpriseExists(db, existingNeverQueried)).toBe(true)
    expect(db.select().from(schema.enterprise).all().filter((e) => e.usccNorm === NOT_EVIDENCED_USCC)).toHaveLength(1)
    expect(db.select().from(schema.enterprise).all().filter((e) => e.usccNorm === NEVER_QUERIED_USCC)).toHaveLength(1)
  })

  it('同一既有行被两条候选认领（同名多主体）⇒ 只并第一条，其余待核', async () => {
    const claimedName = '宁波昌隆机电有限公司'
    const claimed = seedEnterprise(claimedName, null)
    const result = await client().commit({
      idempotencyKey: 'rl14/import-claimed#sha256:c1',
      sourceKind: 'announcement',
      sourceIdentity: 'jxj/workbook/claimed.xlsx',
      payload: {
        announcement: {
          sourceDocument: { source: 'jxj', title: '同名多主体', docNumber: null },
          records: [
            { enterprise: { name: claimedName, uscc: '91330211000000001F' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2023, batchSeq: 1, decidedYear: 2023, evidence: [{ sourceFile: 'x.xlsx' }] }] },
            { enterprise: { name: claimedName, uscc: '91330211000000002J' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2023, batchSeq: 1, decidedYear: 2023, evidence: [{ sourceFile: 'x.xlsx' }] }] },
          ],
        },
      },
    })
    expect(result.status).toBe('committed')

    // 两个统代**都有**逐字同名的关系证据 —— 但同一条既有行不能被并两次。
    const write = await client().commit({
      idempotencyKey: 'rl14/evidence-claimed#sha256:c2',
      sourceKind: 'alias_evidence',
      sourceIdentity: 'platform/claimed.json',
      payload: {
        platformQueries: ['91330211000000001F', '91330211000000002J'].map((uscc, index) => ({ rawResponse: 'Explicit synthetic original response',
          interface: 'business_list' as const,
          queryKey: uscc,
          rdjb: '3',
          queriedAt: QUERIED_AT,
          status: 'success' as const,
          relations: [
            {
              sequenceNo: 1,
              relationKey: `SQ-claimed-${index + 1}`,
              usccRaw: uscc,
              nameRaw: claimedName,
              matchBasis: 'uscc' as const,
              verificationStatus: 'confirmed' as const,
            },
          ],
        })),
      },
    })
    expect(write.status).toBe('committed')

    const report = await candidatesReport('rl14/import-claimed#sha256:c1')
    // 三条候选：既有行 ↔ 两个新统代各一条，外加「两个新行彼此同名」那条。
    expect(report.counts).toEqual({ candidates: 3, ready: 1, pending: 2 })
    const byName = report.pending.map((p) => `${p.candidate.existingEnterpriseName}#${p.candidate.newUscc}:${p.reason}`).sort()
    expect(byName).toEqual([
      // 同一条既有（无统代）行被两条候选认领 ⇒ 只并第一认领者，另一条待核。
      `宁波昌隆机电有限公司#91330211000000002J:source_claimed`,
      // 两条带统代的新行彼此同名 ⇒ 是**两个已识别的不同主体**，不并。
      `宁波昌隆机电有限公司#91330211000000002J:source_has_uscc`,
    ])
    expect(report.ready[0]!.merge.fromEnterpriseId).toBe(claimed)
  })
})

// ---------------------------------------------------------------------------
// B：规范行的 name 与别名
// ---------------------------------------------------------------------------

describe('B · 归并后规范行保名、被并名落别名（仅当两侧逐字不同）', () => {
  const CANON_USCC = '91330211316904639T'
  const CANON_NAME = '宁波奔野重工股份有限公司'
  const OLD_ANNOUNCED = '宁波奔野重工有限公司'

  it('两侧名称逐字不同 ⇒ 被并名写成 enterprise_alias（confirmed），规范行 name 不变', async () => {
    const canonical = seedEnterprise(CANON_NAME, CANON_USCC)
    const duplicated = seedEnterprise(OLD_ANNOUNCED, null)
    const duplicatedRecord = seedRecord(duplicated, 'jxj', 'specialized_sme')
    const duplicatedEvent = seedEvent(duplicatedRecord, 'award', 2021, 3)
    const duplicatedEvidence = seedEvidence(duplicatedEvent, 12)

    // 证据也走统一 API：平台自己记录了「这个统代就叫公布名」。
    const evidenceWrite = await client().commit({
      idempotencyKey: 'rl14/alias-rule#sha256:b0',
      sourceKind: 'alias_evidence',
      sourceIdentity: `platform/${CANON_USCC}.json`,
      payload: {
        platformQueries: [
          { rawResponse: 'Explicit synthetic original response',
            interface: 'business_list',
            queryKey: CANON_USCC,
            rdjb: '3',
            queriedAt: QUERIED_AT,
            status: 'success',
            relations: [
              { sequenceNo: 1, relationKey: 'SQ-alias-1', usccRaw: CANON_USCC, nameRaw: CANON_NAME, matchBasis: 'uscc', verificationStatus: 'confirmed' },
              { sequenceNo: 2, relationKey: 'SQ-alias-2', usccRaw: CANON_USCC, nameRaw: OLD_ANNOUNCED, matchBasis: 'uscc', verificationStatus: 'confirmed' },
            ],
          },
        ],
      },
    })
    expect(evidenceWrite.status).toBe('committed')
    const evidenceRelation = nativeRelationRows(db)
      .find((r) => r.nameRaw === OLD_ANNOUNCED && r.usccRaw === CANON_USCC)!

    const request: RosterImportRequest = {
      idempotencyKey: 'rl14/alias#sha256:b1',
      sourceKind: 'alias_evidence',
      sourceIdentity: `miit/relations/${CANON_USCC}`,
      payload: {
        merges: [
          {
            fromEnterpriseId: duplicated,
            intoUscc: CANON_USCC,
            aliasName: OLD_ANNOUNCED,
            sourceKind: 'platform_business',
            sourceRefId: evidenceRelation.id,
            note: '公布名（历史名）→ 平台现名',
          },
        ],
      },
    }
    const result = await client().commit(request)
    expect(result.status).toBe('committed')

    const kept = db.select().from(schema.enterprise).all().find((e) => e.id === canonical)!
    // B 的正面：规范行取**导出/平台侧**（最新）的名字 —— 归并**不**让历史名顶掉它。
    expect(kept.name).toBe(CANON_NAME)
    // B：被并的公布名落成 `confirmed` 别名，来源就是那条平台关系。
    const alias = db.select().from(schema.enterpriseAlias).all().find((a) => a.enterpriseId === canonical)!
    expect(alias).toMatchObject({
      name: OLD_ANNOUNCED,
      sourceKind: 'platform_business',
      sourceRefId: evidenceRelation.id,
      verificationStatus: 'confirmed',
    })
    const lineage = readMergeLineage(db, request.idempotencyKey, duplicated)!
    expect(lineage.aliasId).toBe(alias.id)
    // 没给 `canonicalName` ⇒ 不改名（缺省行为，向后兼容）。
    expect(lineage.canonicalName).toBe(CANON_NAME)
    expect(lineage.rename).toBeNull()
    expect(lineage.eventsMoved).toContain(duplicatedEvent)
    expect(lineage.evidenceMoved).toContain(duplicatedEvidence)
    // 按现名或历史名搜索都命中同一企业。
    expect(db.select().from(schema.enterprise).all().map((e) => e.id)).toContain(canonical)
  })

  it('两侧名称逐字相同 ⇒ 不造别名（只并身份）', async () => {
    const sameName = '宁波同名样例有限公司'
    const uscc = '91330211000000000C'
    const canonical = seedEnterprise(sameName, uscc)
    const duplicated = seedEnterprise(sameName, null)

    const request: RosterImportRequest = {
      idempotencyKey: 'rl14/same-name#sha256:b2',
      sourceKind: 'alias_evidence',
      sourceIdentity: `miit/relations/${uscc}`,
      payload: { merges: [{ fromEnterpriseId: duplicated, intoUscc: uscc, sourceKind: 'platform_business', sourceRefId: 0 }] },
    }
    const result = await client().commit(request)
    expect(result.status).toBe('committed')

    expect(db.select().from(schema.enterpriseMerge).all()).toEqual(expect.arrayContaining([expect.objectContaining({fromEnterpriseId:duplicated,intoEnterpriseId:canonical})]))
    expect(db.select().from(schema.enterpriseAlias).all().filter((a) => a.enterpriseId === canonical)).toHaveLength(0)
    const lineage = readMergeLineage(db, request.idempotencyKey, duplicated)!
    expect(lineage.aliasId).toBeNull()
    // 净新增 0 行。
    expect(result.items.find((i) => i.kind === 'merge')!.detail!.rowsWritten).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ⑤：预检与写入侧用**同一套**企业定位规则
// ---------------------------------------------------------------------------

describe('⑤ · 预检按写入侧的身份规则判 add/skip（不再用带按名回退的那套猜）', () => {
  const NAME = '宁波重名判定样例有限公司'
  const USCC5 = '91330211000000003M'
  /** 既有那一行：**无统代**，且已经有同坐标（jxj × 专精特新）的记录 —— 事故里正是这样。 */
  const seeded = seedEnterprise(NAME, null)
  const seededRecord = seedRecord(seeded, 'jxj', 'specialized_sme')
  seedEvent(seededRecord, 'award', 2022, 1)

  const request: RosterImportRequest = {
    idempotencyKey: 'rl14/preflight-identity#sha256:p1',
    sourceKind: 'announcement',
    sourceIdentity: 'jxj/workbook/preflight-identity.xlsx',
    payload: {
      announcement: {
        sourceDocument: { source: 'jxj', title: '预检口径样例', docNumber: null },
        records: [
          {
            enterprise: { name: NAME, uscc: USCC5 },
            titleCode: 'specialized_sme',
            events: [{ eventType: 'award', year: 2023, batchSeq: 1, decidedYear: 2023, evidence: [{ sourceFile: 'x.xlsx' }] }],
          },
        ],
      },
    },
  }

  it('这条记录会被**新建** ⇒ 计 add；计划期还没有那一行，`enterpriseId` 如实为 null', () => {
    const plan = planRosterImport(db, request)
    const kinds = plan.items.map((i) => `${i.item.kind}:${i.action}`)
    // 旧行为：`locateEnterprise` 按名回退到既有行、又看到它有同坐标记录 ⇒ 误判 `record:skip`，
    // 而写入侧（只按统代）实际**新建**一行 —— 预检与提交自相矛盾。
    expect(kinds).toEqual(['record:add', 'duplicate_candidate:note'])
    const record = plan.items.find((i) => i.item.kind === 'record')!
    expect(record.item.detail!.enterpriseId).toBeNull()
    expect(record.item.ref).toBe('record:0')
  })

  it('同一批里两条**同身份同坐标**的记录：后一条计 skip（写入侧会复用前一条建的行）', () => {
    // 只看库状态的判据会把第二条也报成 `add`（库里此刻还没有那一行），而提交时
    // `upsertEnterprise` / `upsertRecord` 会复用前一条建的企业与记录 ⇒ 又回到
    // 「预检说 2 条新增、提交只写 1 条」。两处判据已在计划里合并（`reusedInBatch`）。
    const twin: RosterImportRequest = {
      ...request,
      idempotencyKey: 'rl14/preflight-identity-twin#sha256:p2',
      payload: {
        announcement: {
          ...request.payload.announcement!,
          records: [request.payload.announcement!.records[0]!, request.payload.announcement!.records[0]!],
        },
      },
    }
    const plan = planRosterImport(db, twin)
    expect(plan.items.map((i) => `${i.item.kind}:${i.action}`)).toEqual([
      'record:add',
      // 第一条记录**新建**企业时，库里那条同名行（本 describe 的种子）⇒ 一条候选（不写行）。
      'duplicate_candidate:note',
      // 第二条记录同身份同坐标 ⇒ 复用第一条建的企业与记录。
      'record:skip',
    ])
  })

  it('提交后：written 与 skipped 不再自相矛盾，记录项指向**新建**那行', async () => {
    const pre = await client().preflight(request)
    expect(pre.preflight.add).toBe(1)
    expect(pre.preflight.conflicts).toEqual([])

    const result = await client().commit(request)
    expect(result.status).toBe('committed')
    // 真的建了：来源文件 + 企业 + 记录 + 事件 + 出处 = 5 行 ⇒ 就不该同时报「跳过 1 项」。
    expect(result.summary.written).toBe(5)
    expect(result.summary.skipped).toBe(0)
    const recordItem = result.items.find((i) => i.kind === 'record_event')!
    expect(recordItem.detail!.enterpriseId).not.toBe(seeded)
    // 确实新生成了第二行（身份规则没被放宽）；候选把这件事说明白了。
    expect(db.select().from(schema.enterprise).all().filter((e) => e.nameNorm === NAME)).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// ①：主名称以导出表为准（`merges[].canonicalName`）
// ---------------------------------------------------------------------------

describe('① · 主名称以导出表为准：归并把规范行改成导出名，被顶掉的原名落别名', () => {
  // 真实领域例子：公布名（历史名）与平台/导出表现名不同。
  const ANNOUNCED = '宁波一力减震器有限公司'
  const EXPORT_NAME = '宁波一力实业有限公司'
  const USCC1 = '91330206793007818K'

  const announcedRow = seedEnterprise(ANNOUNCED, null)
  const announcedRecord = seedRecord(announcedRow, 'jxj', 'specialized_sme')
  const announcedEvent = seedEvent(announcedRecord, 'award', 2022, 1)
  const announcedEvidence = seedEvidence(announcedEvent, 33)

  const importKey = 'rl14/canonical-name#sha256:n1'
  let canonicalId = 0
  let evidenceRelationId = 0

  it('规范行由导入建出（公告名）', async () => {
    const result = await client().commit({
      idempotencyKey: importKey,
      sourceKind: 'announcement',
      sourceIdentity: 'jxj/workbook/canonical-name.xlsx',
      payload: {
        announcement: {
          sourceDocument: { source: 'jxj', title: '主名称口径样例', docNumber: null },
          records: [
            {
              enterprise: { name: ANNOUNCED, uscc: USCC1 },
              titleCode: 'specialized_sme',
              events: [{ eventType: 'award', year: 2023, batchSeq: 1, decidedYear: 2023, evidence: [{ sourceFile: 'x.xlsx' }] }],
            },
          ],
        },
      },
    })
    expect(result.status).toBe('committed')
    const rows = db.select().from(schema.enterprise).all().filter((e) => e.usccNorm === USCC1)
    expect(rows).toHaveLength(1)
    canonicalId = rows[0]!.id
    // 规范行现在挂的是**公告名**（历史名）—— 正是需要被导出名顶掉的那个。
    expect(rows[0]!.name).toBe(ANNOUNCED)
  })

  it('写导出快照（导出名 ≠ 公告名）与平台证据（qymc 逐字等于公布名）', async () => {
    const snapshot = await client().commit({
      idempotencyKey: 'rl14/canonical-export#sha256:n2',
      sourceKind: 'platform_export',
      sourceIdentity: 'miit/export/specialized-sme-2026.xlsx',
      payload: {
        exportSnapshot: {
          titleCode: 'specialized_sme',
          year: 2026,
          collectedOn: '2026-10-16',
          originalFilename: '专精特新中小企业导出Excel.xlsx',
          sha256: 'c'.repeat(64),
          rows: [{ sourceRowNo: 1, usccRaw: USCC1, nameRaw: EXPORT_NAME, district: '鄞州区' }],
        },
      },
    })
    expect(snapshot.status).toBe('committed')

    const evidence = await client().commit({
      idempotencyKey: 'rl14/canonical-evidence#sha256:n3',
      sourceKind: 'alias_evidence',
      sourceIdentity: `platform/${USCC1}.json`,
      payload: {
        platformQueries: [
          { rawResponse: 'Explicit synthetic original response',
            interface: 'business_list',
            queryKey: USCC1,
            rdjb: '3',
            queriedAt: QUERIED_AT,
            status: 'success',
            relations: [
              { sequenceNo: 1, relationKey: 'SQ-yili-1', usccRaw: USCC1, nameRaw: ANNOUNCED, matchBasis: 'uscc', verificationStatus: 'confirmed' },
            ],
          },
        ],
      },
    })
    expect(evidence.status).toBe('committed')
    evidenceRelationId = nativeRelationRows(db).find((r) => r.relationKey === 'SQ-yili-1')!.id
  })

  it('★ 报告：把导出名作为 `canonicalName` 交给归并（不是猜的，是导出表记的）', async () => {
    const report = await candidatesReport(importKey)
    expect(report.counts).toEqual({ candidates: 1, ready: 1, pending: 0 })
    expect(report.ready[0]!.exportName).toBe(EXPORT_NAME)
    expect(report.request!.payload.merges![0]).toMatchObject({
      fromEnterpriseId: announcedRow,
      intoUscc: USCC1,
      canonicalName: EXPORT_NAME,
      sourceRefId: evidenceRelationId,
    })
    // 预检的 merge 项只说**请求**里给了什么（`requestedCanonicalName`）—— 真会不会改名在执行时定，
    // 权威答案在血缘 `rename`。名字如实，不承诺做不到的事。
    const plan = planRosterImport(db, report.request!)
    const mergeItem = plan.items.find((i) => i.item.kind === 'merge')!
    expect(mergeItem.action).toBe('update')
    expect(mergeItem.item.detail!.requestedCanonicalName).toBe(EXPORT_NAME)
  })

  it('★ 执行：规范行 name = **导出名**，被顶掉的原名是 confirmed 别名（来源 = 落库关系）', async () => {
    const report = await candidatesReport(importKey)
    const result = await client().commit(report.request!)
    expect(result.status).toBe('committed')

    const canonical = db.select().from(schema.enterprise).all().find((e) => e.id === canonicalId)!
    expect(canonical.name).toBe(EXPORT_NAME)
    expect(canonical.nameNorm).toBe(EXPORT_NAME)
    expect(db.select().from(schema.enterpriseMerge).all()).toEqual(expect.arrayContaining([expect.objectContaining({fromEnterpriseId:announcedRow,intoEnterpriseId:canonicalId})]))

    // 被顶掉的原名（公告名）落 confirmed 别名，来源就是那条落库的平台关系。
    const aliases = db.select().from(schema.enterpriseAlias).all().filter((a) => a.enterpriseId === canonicalId)
    // 「被并方的名字」与「被顶掉的规范行原名」在这里是同一个名字 ⇒ 同一唯一键 ⇒ **只有一条**别名。
    expect(aliases).toHaveLength(1)
    expect(aliases[0]).toMatchObject({
      name: ANNOUNCED,
      nameNorm: ANNOUNCED,
      sourceKind: 'platform_business',
      sourceRefId: evidenceRelationId,
      verificationStatus: 'confirmed',
    })

    // 血缘：改名 `from → to` + 那条别名；一条不丢。
    const lineage = readMergeLineage(db, report.request!.idempotencyKey, announcedRow)!
    expect(lineage.canonicalName).toBe(EXPORT_NAME)
    expect(lineage.rename).toEqual({ from: ANNOUNCED, to: EXPORT_NAME, aliasId: aliases[0]!.id })
    expect(lineage.aliasId).toBe(aliases[0]!.id)
    expect(lineage.eventsMoved).toContain(announcedEvent)
    expect(lineage.evidenceMoved).toContain(announcedEvidence)
    // 净新增只有那一条别名。
    expect(result.items.find((i) => i.kind === 'merge')!.detail!.rowsWritten).toBe(1)
    // 按导出名或历史名搜索都命中同一企业。
    expect(searchEnterpriseIdsByName(db,ANNOUNCED)).toEqual([canonicalId])
    expect(searchEnterpriseIdsByName(db,EXPORT_NAME)).toEqual([canonicalId])
  })

  it('坏 `canonicalName` 逐项报错、整批不落库（不静默忽略）', async () => {
    const before = rosterRowCounts(db)
    const result = await client().commit({
      idempotencyKey: 'rl14/canonical-name-bad#sha256:n4',
      sourceKind: 'alias_evidence',
      sourceIdentity: `miit/relations/${USCC1}`,
      payload: { merges: [{ fromEnterpriseId: 1, intoUscc: USCC1, canonicalName: 123 as unknown as string }] },
    })
    expect(result.status).toBe('failed')
    expect(result.items[0]!.error!.code).toBe('canonical_name_invalid')
    expect(rosterRowCounts(db)).toEqual(before)
  })
})
