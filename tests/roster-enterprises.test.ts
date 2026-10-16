import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema, useDb } from '../db'
import { createRosterImportClient } from '../lib/roster-import-client'
import {
  getRosterEnterpriseDetail,
  listRosterDifferences,
  listRosterEnterprises,
} from '../lib/roster/enterprise-roster'
import type { PlatformInterface } from '../lib/labels'
import { startRosterApi, type RosterApiServer } from './helpers/roster-http-server'

/**
 * RL-04 —— 跨称号去重企业总表 / 企业详情 / 差异与解释(契约 §7.1 / §7.2 / §7.3)。
 *
 * 测的是**用户能观察到的行、状态、原因、证据**(brief §4):一企一行、称号与事件不折叠、
 * 别名搜索口径、`rosterState` 派生、生命周期数字、差异四态与原因/措施/迁入承载。
 *
 * 夹具分两类:
 *  - **输入**用 drizzle 直插(企业/记录/事件/出处、平台查询与关系、导出快照);
 *  - **回归案例的归并**走**真实 HTTP API**(RL-11 的 `/api/roster/import/commit`)——
 *    「归并后总表一行」这个状态必须是**经公开 API 产生**的,不能靠测试自己改库凑出来。
 */

const dir = mkdtempSync(join(tmpdir(), 'spztx-roster-read-'))
const db = useDb({ dbPath: join(dir, 'roster.db') })
const TOKEN = 'roster-read-test-token'

/** 企业 id 按 key 记下来,断言用 key 而不是裸数字。 */
const ids: Record<string, number> = {}
const REGRESSION_USCC = '91330211255994457P'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function enterprise(key: string, name: string, uscc: string | null, district: string | null = null) {
  const id = db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc, district })
    .returning({ id: schema.enterprise.id })
    .get().id
  ids[key] = id
  return id
}

interface EventSpec {
  eventType: 'award' | 'review' | 'maintain' | 'nurture'
  year?: number | null
  batchSeq?: number | null
  decidedYear?: number | null
  reviewOutcome?: 'passed' | 'failed' | null
  evidence?: { sourceFile: string; attachment?: string | null; listNo?: number | null; page?: number | null }[]
}

function record(
  enterpriseId: number,
  titleCode: string,
  source: 'jxj' | 'miit',
  events: EventSpec[],
  district: string | null = null,
) {
  const recordId = db
    .insert(schema.record)
    .values({ enterpriseId, titleCode, source, district })
    .returning({ id: schema.record.id })
    .get().id
  for (const e of events) {
    const eventId = db
      .insert(schema.recordEvent)
      .values({
        recordId,
        eventType: e.eventType,
        year: e.year ?? null,
        batchSeq: e.batchSeq ?? null,
        decidedYear: e.decidedYear === undefined ? (e.year ?? null) : e.decidedYear,
        reviewOutcome: e.reviewOutcome ?? null,
      })
      .returning({ id: schema.recordEvent.id })
      .get().id
    for (const v of e.evidence ?? []) {
      db.insert(schema.recordEvidence)
        .values({
          recordEventId: eventId,
          sourceFile: v.sourceFile,
          attachment: v.attachment ?? null,
          listNo: v.listNo ?? null,
          page: v.page ?? null,
        })
        .run()
    }
  }
  return recordId
}

function alias(
  enterpriseId: number,
  name: string,
  verificationStatus: 'confirmed' | 'pending',
  sourceKind: 'platform_business' | 'platform_apply' | 'announcement' | 'manual' = 'manual',
  sourceRefId = 0,
) {
  db.insert(schema.enterpriseAlias)
    .values({ enterpriseId, name, nameNorm: name, sourceKind, sourceRefId, verificationStatus })
    .run()
}

function difference(
  enterpriseId: number,
  titleCode: string,
  direction: 'missing_in_miit' | 'extra_in_miit',
  values: Partial<{
    status: string
    reasonCode: string | null
    reasonNote: string | null
    measureCode: string | null
    measureNote: string | null
    evidenceQueryId: number | null
    evidenceRelationId: number | null
    movedInCity: string | null
    movedInTitleCode: string | null
    movedInYear: number | null
    movedInBatch: number | null
    verificationStatus: 'confirmed' | 'pending'
    recordedAt: string
  }> & { recordedAt: string },
) {
  return db
    .insert(schema.differenceReason)
    .values({
      enterpriseId,
      titleCode,
      direction,
      status: (values.status ?? 'not_queried') as never,
      reasonCode: (values.reasonCode ?? null) as never,
      reasonNote: values.reasonNote ?? null,
      measureCode: (values.measureCode ?? null) as never,
      measureNote: values.measureNote ?? null,
      evidenceQueryId: values.evidenceQueryId ?? null,
      evidenceRelationId: values.evidenceRelationId ?? null,
      movedInCity: values.movedInCity ?? null,
      movedInTitleCode: (values.movedInTitleCode ?? null) as never,
      movedInYear: values.movedInYear ?? null,
      movedInBatch: values.movedInBatch ?? null,
      verificationStatus: values.verificationStatus ?? 'pending',
      recordedAt: values.recordedAt,
    })
    .returning({ id: schema.differenceReason.id })
    .get().id
}

function query(
  interfaceName: PlatformInterface,
  queryKey: string,
  rdjb: string,
  status: 'success' | 'failed' | 'no_record' | 'not_queried',
  queriedAt: string,
  failureReason: string | null = null,
) {
  return db
    .insert(schema.platformQuery)
    .values({ interface: interfaceName, queryKey, rdjb, status, queriedAt, failureReason })
    .returning({ id: schema.platformQuery.id })
    .get().id
}

function relation(
  queryId: number,
  sequenceNo: number,
  values: Partial<{
    relationKey: string
    enterpriseId: number | null
    usccRaw: string
    nameRaw: string
    declareKind: string | null
    awardBatchLabel: string | null
    batch: string
    appliedAt: string
    status: string
    year: number
    matchBasis: 'uscc' | 'alias' | 'manual' | 'none'
    verificationStatus: 'confirmed' | 'pending'
  }>,
) {
  return db
    .insert(schema.platformRelation)
    .values({
      queryId,
      sequenceNo,
      relationKey: values.relationKey ?? null,
      enterpriseId: values.enterpriseId ?? null,
      usccRaw: values.usccRaw ?? null,
      nameRaw: values.nameRaw ?? null,
      declareKind: (values.declareKind ?? null) as never,
      awardBatchLabel: values.awardBatchLabel ?? null,
      batch: values.batch ?? null,
      appliedAt: values.appliedAt ?? null,
      status: values.status ?? null,
      matchBasis: values.matchBasis ?? 'none',
      verificationStatus: values.verificationStatus ?? 'pending',
    })
    .returning({ id: schema.platformRelation.id })
    .get().id
}

function snapshotBatch(titleCode: string, year: number, sha256: string, collectedOn: string) {
  return db
    .insert(schema.platformExportBatch)
    .values({
      titleCode,
      year,
      sha256,
      collectedOn,
      originalFilename: `${titleCode}-${year}.xlsx`,
      rowCount: 1,
      importStatus: 'imported',
    })
    .returning({ id: schema.platformExportBatch.id })
    .get().id
}

function snapshotRow(batchId: number, sourceRowNo: number, usccRaw: string, nameRaw: string) {
  db.insert(schema.platformExportRow)
    .values({ batchId, sourceRowNo, usccRaw, nameRaw })
    .run()
}

/** 同一 USCC 下 6 条真实关联(取自 `04-EVIDENCE-91330211255994457P.md` 的裁剪摘录)。 */
const REGRESSION_RELATIONS = [
  { relationKey: 'SQ332022062212391', name: '宁波上航测绘有限公司', declareKind: 'apply', batch: '2022-1', appliedAt: '2022-06-22 17:17:52', status: '终审通过' },
  { relationKey: 'SQ332023041984270', name: '宁波上航测绘有限公司', declareKind: 'update', batch: '2022-1', appliedAt: '2023-04-19 16:46:01', status: '待审核' },
  { relationKey: 'SQ332024052128274', name: '宁波上航测绘股份有限公司', declareKind: 'update', batch: '2022-1', appliedAt: '2024-05-21 14:10:06', status: '待审核' },
  { relationKey: 'SQ332025060392166', name: '宁波上航测绘股份有限公司', declareKind: 'review', batch: '2025-1', appliedAt: '2025-06-21 09:50:48', status: '省已审' },
  { relationKey: 'SQ332025062064737', name: '宁波上航测绘股份有限公司', declareKind: 'update', batch: '2025-1', appliedAt: '2025-06-20 10:43:42', status: '待审核' },
  { relationKey: 'SQ332026052238796', name: '宁波上航测绘股份有限公司', declareKind: 'update', batch: '2025-1', appliedAt: '2026-05-22 16:49:44', status: '待审核' },
]

let api: RosterApiServer
/** 归并后规范行的 id(被并的 375 已删除,故由 API 写入后现取)。 */
let canonicalId = 0
/** 四态证据用的查询 id。 */
let fourStateQuery = 0

beforeAll(async () => {
  // —— 企业 A:多称号 + 别名 + 两条时态化的差异解释 ——
  const a = enterprise('a', '宁波双称号股份有限公司', '91330211AAAAAAA001X')
  record(a, 'specialized_sme', 'jxj', [{ eventType: 'award', year: 2021 }], '鄞州区')
  record(a, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  record(a, 'little_giant', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])

  // 旧解释(待核实)与新解释(已确认外迁 + 配对措施):当前解释必须是新的那条。
  difference(a, 'little_giant', 'extra_in_miit', {
    status: 'needs_review',
    recordedAt: '2026-10-01T00:00:00.000Z',
  })
  difference(a, 'little_giant', 'extra_in_miit', {
    status: 'confirmed_reason',
    reasonCode: 'moved_out',
    reasonNote: '营业执照已迁至嘉兴',
    measureCode: 'mark_moved_out',
    measureNote: '保留公布历史,标明迁出状态',
    verificationStatus: 'confirmed',
    recordedAt: '2026-10-14T00:00:00.000Z',
  })

  // —— 别名搜索:一 confirmed 一 pending ——
  const aliasEnt = enterprise('aliasEnt', '宁波别名测试有限公司', '91330211AAAAAAA002X', '海曙区')
  record(aliasEnt, 'innovative_sme', 'jxj', [{ eventType: 'award', year: 2023 }])
  alias(aliasEnt, '宁波别名测试厂', 'confirmed', 'announcement')
  alias(aliasEnt, '宁波别名测试旧名', 'pending')

  // —— rosterState:仅平台、且已从最新快照消失 ⇒ removed_platform_only ——
  const onlyPlatform = enterprise('onlyPlatform', '宁波仅平台企业', '91330211AAAAAAA003X')
  record(onlyPlatform, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  // —— 仍在最新快照 ⇒ current ——
  const stillLatest = enterprise('stillLatest', '宁波仍在新快照企业', '91330211AAAAAAA004X')
  record(stillLatest, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  // —— 一张快照都没有 ⇒ 无从证明「已移除」⇒ 保留为 current ——
  const noSnapshot = enterprise('noSnapshot', '宁波无快照平台企业', '91330211AAAAAAA005X')
  record(noSnapshot, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  // —— 只在公布名单里出现过(入库培育)⇒ 官方历史,必须留在总表 ——
  const nurtureOnly = enterprise('nurtureOnly', '宁波仅培育企业', '91330211AAAAAAA006X')
  record(nurtureOnly, 'specialized_sme', 'jxj', [{ eventType: 'nurture', year: 2023 }])

  const oldBatch = snapshotBatch('specialized_sme', 2025, 'sha-old', '2025-06-30')
  snapshotRow(oldBatch, 1, '91330211AAAAAAA003X', '宁波仅平台企业')
  snapshotRow(oldBatch, 2, '91330211AAAAAAA004X', '宁波仍在新快照企业')
  const latestBatch = snapshotBatch('specialized_sme', 2026, 'sha-new', '2026-06-30')
  snapshotRow(latestBatch, 1, '91330211AAAAAAA004X', '宁波仍在新快照企业')

  // —— 迁入:证据齐全 / 缺项待补 ——
  const movedInOk = enterprise('movedInOk', '宁波迁入企业', '91330211AAAAAAA007X')
  record(movedInOk, 'innovative_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  difference(movedInOk, 'innovative_sme', 'extra_in_miit', {
    status: 'confirmed_reason',
    reasonCode: 'moved_in',
    measureCode: 'record_moved_in',
    movedInCity: '杭州市',
    movedInTitleCode: 'specialized_sme',
    movedInYear: 2020,
    movedInBatch: 2,
    verificationStatus: 'confirmed',
    recordedAt: '2026-10-14T00:00:00.000Z',
  })
  const movedInPending = enterprise('movedInPending', '宁波迁入待补企业', '91330211AAAAAAA008X')
  record(movedInPending, 'innovative_sme', 'jxj', [{ eventType: 'award', year: 2022 }])
  difference(movedInPending, 'innovative_sme', 'missing_in_miit', {
    status: 'needs_review',
    reasonCode: 'moved_in',
    measureCode: 'manual_review',
    movedInCity: '绍兴市',
    verificationStatus: 'pending',
    recordedAt: '2026-10-14T00:00:00.000Z',
  })

  // —— 差异四态互不冒充(未查询 / 查询失败 / 无记录 / 已确认无差异)——
  fourStateQuery = query('business_list', '91330211AAAAAAA010X', '2', 'failed', '2026-10-15T01:00:00.000Z', '登录超时,请重新登录')
  relation(fourStateQuery, 1, { relationKey: 'SQ-BAD', usccRaw: '91330211AAAAAAA010X', nameRaw: '宁波查失败企业' })

  const stateNotQueried = enterprise('stateNotQueried', '宁波未查企业', '91330211AAAAAAA009X')
  record(stateNotQueried, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  difference(stateNotQueried, 'specialized_sme', 'extra_in_miit', { status: 'not_queried', recordedAt: '2026-10-14T00:00:00.000Z' })

  const stateFailed = enterprise('stateFailed', '宁波查失败企业', '91330211AAAAAAA010X')
  record(stateFailed, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  difference(stateFailed, 'specialized_sme', 'extra_in_miit', {
    status: 'query_failed',
    reasonNote: '会话过期,查询没成功执行',
    evidenceQueryId: fourStateQuery,
    recordedAt: '2026-10-15T01:00:00.000Z',
  })

  const stateNoRecord = enterprise('stateNoRecord', '宁波无记录企业', '91330211AAAAAAA011X')
  record(stateNoRecord, 'specialized_sme', 'jxj', [{ eventType: 'award', year: 2022 }])
  difference(stateNoRecord, 'specialized_sme', 'missing_in_miit', {
    status: 'no_record',
    reasonNote: '查询成功执行,平台返回空',
    recordedAt: '2026-10-15T00:00:00.000Z',
  })

  const stateNoDiff = enterprise('stateNoDiff', '宁波已确认无差异企业', '91330211AAAAAAA012X')
  record(stateNoDiff, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  difference(stateNoDiff, 'specialized_sme', 'extra_in_miit', {
    status: 'confirmed_no_diff',
    measureCode: 'none',
    verificationStatus: 'confirmed',
    recordedAt: '2026-10-15T00:00:00.000Z',
  })

  // —— 生命周期:复核通过 ⇒ 锚点取结论年份;缺结论年份 ⇒ 标待核 ——
  const reviewed = enterprise('reviewed', '宁波复核通过企业', '91330211AAAAAAA020X')
  record(reviewed, 'specialized_sme', 'jxj', [
    { eventType: 'award', year: 2021 },
    { eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'passed' },
  ])
  const noDecided = enterprise('noDecided', '宁波缺结论年份企业', '91330211AAAAAAA021X')
  record(noDecided, 'specialized_sme', 'jxj', [{ eventType: 'award', year: 2020, decidedYear: null }])
  const failedReview = enterprise('failedReview', '宁波复核未通过企业', '91330211AAAAAAA022X')
  record(failedReview, 'specialized_sme', 'jxj', [
    { eventType: 'award', year: 2021 },
    { eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'failed' },
  ])

  // —— 缺统代企业:公布名单条目必须保留,并按名称可搜到 ——
  const noUsccInRoster = enterprise('noUsccInRoster', '宁波无统代企业', null, '北仑区')
  record(noUsccInRoster, 'specialized_sme', 'jxj', [{ eventType: 'award', year: 2024 }])

  // —— 回归案例:375(无统代,jxj 2022 认定)与 7289(统代,两条 miit 记录) ——
  const e375 = enterprise('e375', '宁波上航测绘有限公司', null)
  record(e375, 'specialized_sme', 'jxj', [
    {
      eventType: 'award',
      year: 2022,
      evidence: [
        {
          sourceFile: 'jxj/announcement/2022/甬经信中小〔2022〕145号关于公布宁波市“专精特新”中小企业名单的通知.pdf',
          attachment: '附件',
          listNo: 74,
          page: 74,
        },
      ],
    },
  ])
  const e7289 = enterprise('e7289', '宁波上航测绘股份有限公司', REGRESSION_USCC)
  record(e7289, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  record(e7289, 'little_giant', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])

  const q3 = query('business_list', REGRESSION_USCC, '3', 'success', '2026-10-15T17:11:21.514Z')
  for (const [index, r] of REGRESSION_RELATIONS.entries()) {
    relation(q3, index + 1, {
      relationKey: r.relationKey,
      enterpriseId: e7289,
      usccRaw: REGRESSION_USCC,
      nameRaw: r.name,
      declareKind: r.declareKind,
      batch: r.batch,
      appliedAt: r.appliedAt,
      status: r.status,
      // 曾用名那条按 `qymc` 差异人工确认为 `alias`;其余按统代匹配。
      matchBasis: index < 2 ? 'alias' : 'uscc',
      verificationStatus: index < 2 ? 'confirmed' : 'pending',
    })
  }
  // `rdjb=1` / `rdjb=2` 返回 0 行:请求成功、会话有效 ⇒ **无记录**,不是失败。
  query('business_list', REGRESSION_USCC, '1', 'no_record', '2026-10-15T17:11:21.514Z')
  query('business_list', REGRESSION_USCC, '2', 'no_record', '2026-10-15T17:11:21.514Z')
  const qApply = query('apply_list', REGRESSION_USCC, '', 'success', '2026-10-15T17:11:21.514Z')
  relation(qApply, 1, { relationKey: 'SQ332025060392166', enterpriseId: e7289, usccRaw: REGRESSION_USCC, nameRaw: '宁波上航测绘股份有限公司', year: 2025 })
  relation(qApply, 2, { relationKey: 'SQ332022062212391', enterpriseId: e7289, usccRaw: REGRESSION_USCC, nameRaw: '宁波上航测绘有限公司', year: 2022 })

  // —— 归并走**真实 HTTP API**(不是测试自己改库) ——
  api = await startRosterApi({ db, apiToken: TOKEN })
  const client = createRosterImportClient({ baseUrl: api.baseUrl, token: TOKEN })
  const oldNameRelation = db
    .select()
    .from(schema.platformRelation)
    .all()
    .find((r) => r.queryId === q3 && r.nameRaw === '宁波上航测绘有限公司')!
  const result = await client.commit({
    idempotencyKey: 'rl04/regression/merge#1',
    sourceKind: 'alias_evidence',
    sourceIdentity: 'platform-capture/91330211255994457P',
    payload: {
      merges: [
        {
          fromEnterpriseId: ids.e375,
          intoUscc: REGRESSION_USCC,
          aliasName: '宁波上航测绘有限公司',
          sourceKind: 'platform_business',
          sourceRefId: oldNameRelation.id,
          evidenceQueryId: q3,
          note: 'businessList rdjb=3 的 qymc 差异行',
        },
      ],
    },
  })
  expect(result.status).toBe('committed')
  canonicalId = db.select().from(schema.enterprise).all().find((e) => e.usccNorm === REGRESSION_USCC)!.id
})

afterAll(async () => {
  await api?.close()
  rmSync(dir, { recursive: true, force: true })
})

const rowsByName = (names: string[]) =>
  listRosterEnterprises(db, { pageSize: 200 }).rows.filter((r) => names.includes(r.name))
const rowOf = (key: string) =>
  listRosterEnterprises(db, { pageSize: 200 }).rows.find((r) => r.enterpriseId === ids[key])!

// ---------------------------------------------------------------------------
// §7.1 企业总表
// ---------------------------------------------------------------------------

describe('§7.1 企业总表 —— 一企一行,称号与事件不折叠', () => {
  it('跨称号去重:同一企业只出现一行,titles 列出它拿过的全部称号', () => {
    const row = rowOf('a')
    expect(row.titles).toEqual(['little_giant', 'specialized_sme'])
    // 三条 record(称号×来源)没有把它拆成三行。
    expect(listRosterEnterprises(db, { pageSize: 200 }).rows.filter((r) => r.name === '宁波双称号股份有限公司')).toHaveLength(1)
  })

  /**
   * RL-08 增量:`firstRecognition` 的一项除了 `titleCode` / `year` / `needsReview`,
   * 还带首次认定**自己的**状态与出处(`status` / `pendingReason` / `evidence` / `source` /
   * `firstEventId` / `undatedAwardIds`)。所以这里用 `toMatchObject` 只钉 RL-04 拥有的那三项
   * —— 多出来的字段由 RL-08 的用例(`tests/roster-recognitions.test.ts`)负责,
   * 不在这张票的文件里重复一遍。
   *
   * 这个夹具的 award 事件**没有出处行** ⇒ 下面的 `status` 是 `pending`(`no_evidence`),
   * 那是如实:依据回不到出处的首次认定本来就不算确立(RL-08 口径)。
   */
  it('首次认定取最早的 award;没有 award 的称号不出现在 firstRecognition 里', () => {
    const row = rowOf('a')
    // 专精特新 2021 认定 ⇒ 2021;同年 + 3 = 下一次到期 2024。
    expect(row.firstRecognition).toMatchObject([{ titleCode: 'specialized_sme', year: 2021, needsReview: false }])
    expect(row.nextReviewYear).toBe(2024)
    // 小巨人只有 miit 维护记录(**没有** award)⇒ 不产生首次认定,也不产生锚点。
    expect(row.firstRecognition.some((f) => f.titleCode === 'little_giant')).toBe(false)
    // 新字段在这里的行为:没有存下来的出处 ⇒ 待确认,原因点明是缺出处(不是「年份未知」)。
    expect(row.firstRecognition[0]).toMatchObject({
      status: 'pending',
      pendingReason: 'no_evidence',
      source: 'jxj',
      evidence: [],
      undatedAwardIds: [],
    })
  })

  it('复核通过的称号锚点 = 结论年份,下一次到期 = 锚点 + 3', () => {
    const row = rowOf('reviewed')
    expect(row.firstRecognition).toMatchObject([{ titleCode: 'specialized_sme', year: 2021, needsReview: false }])
    expect(row.nextReviewYear).toBe(2027)
  })

  it('结论年份缺失 ⇒ 退回年份并标待核(不猜)', () => {
    const row = rowOf('noDecided')
    expect(row.firstRecognition).toMatchObject([{ titleCode: 'specialized_sme', year: 2020, needsReview: true }])
    expect(row.anchorNeedsReview).toBe(true)
    expect(row.nextReviewYear).toBe(2023)
    // ⚠️ 两个「待」是两件事:`needsReview` 说的是**锚点**缺结论年份(上面这条),
    // 而首次认定自己的状态是 `no_evidence`(这个夹具没有出处行)。
    expect(row.firstRecognition[0]!.needsReview).toBe(true)
    expect(row.firstRecognition[0]!.pendingReason).toBe('no_evidence')
  })
})

describe('§7.1 别名搜索口径(契约 §1.2)', () => {
  it('按现名命中', () => {
    const hits = listRosterEnterprises(db, { q: '宁波别名测试有限公司', pageSize: 200 }).rows
    expect(hits.map((r) => r.enterpriseId)).toEqual([ids.aliasEnt])
  })

  it('按**已确认**曾用名命中同一企业', () => {
    const hits = listRosterEnterprises(db, { q: '宁波别名测试厂', pageSize: 200 }).rows
    expect(hits.map((r) => r.enterpriseId)).toEqual([ids.aliasEnt])
    // 曾用名原值也随行返回(仅 confirmed)。
    expect(hits[0]!.aliasNames).toEqual(['宁波别名测试厂'])
  })

  it('`pending` 别名**不参与搜索**,也不出现在 aliasNames 里', () => {
    expect(listRosterEnterprises(db, { q: '宁波别名测试旧名', pageSize: 200 }).rows).toEqual([])
    expect(rowOf('aliasEnt').aliasNames).toEqual(['宁波别名测试厂'])
  })
})

describe('§7.1 rosterState 派生(契约 §5,不落列)', () => {
  it('有 jxj 认定事件 ⇒ current', () => {
    expect(rowOf('a').rosterState).toBe('current')
    expect(rowOf('aliasEnt').rosterState).toBe('current')
  })

  it('只在公布名单里出现过(入库培育)⇒ 仍在当前总表(公布历史不因平台缺失被删)', () => {
    expect(rowOf('nurtureOnly').rosterState).toBe('current')
  })

  it('仅由历史平台导出引入、且不在最新快照 ⇒ removed_platform_only', () => {
    expect(rowOf('onlyPlatform').rosterState).toBe('removed_platform_only')
  })

  it('仍在最新快照 ⇒ current', () => {
    expect(rowOf('stillLatest').rosterState).toBe('current')
  })

  it('一张快照都没有 ⇒ 无从证明「已移除」,保留为 current(证据不足不误删)', () => {
    expect(rowOf('noSnapshot').rosterState).toBe('current')
  })

  it('rosterState 可按 current / removed_platform_only 双向筛', () => {
    const removed = listRosterEnterprises(db, { rosterState: 'removed_platform_only', pageSize: 200 }).rows
    expect(removed.map((r) => r.name)).toEqual(['宁波仅平台企业'])
    const current = listRosterEnterprises(db, { rosterState: 'current', pageSize: 200 }).rows
    expect(current.some((r) => r.name === '宁波仅平台企业')).toBe(false)
    expect(current.length).toBeGreaterThan(removed.length)
  })
})

describe('§7.1 计数口径、筛选与分页', () => {
  it('counts 同时给企业数与「企业 × 称号」数,且两者口径一致', () => {
    const all = listRosterEnterprises(db, { pageSize: 1 })
    // total 是**企业数**(与分页无关,是筛选后的全量)。
    expect(all.counts.total).toBe(listRosterEnterprises(db, { pageSize: 200 }).rows.length)
    // titles 是每称号的**企业数**;titlePairs 是「企业 × 称号」总数 = 各称号之和。
    expect(all.counts.titlePairs).toBe(Object.values(all.counts.titles).reduce((a, b) => a + b, 0))
    // 多称号企业只算一家企业,但在每个称号桶里各计一次。
    const titles = listRosterEnterprises(db, { pageSize: 200 }).rows.reduce<Record<string, number>>((acc, row) => {
      for (const t of row.titles) acc[t] = (acc[t] ?? 0) + 1
      return acc
    }, {})
    expect(all.counts.titles).toEqual(titles)
  })

  it('筛选后 counts 与筛选后的行同口径(不是全库口径)', () => {
    const { rows, counts } = listRosterEnterprises(db, { title: ['innovative_sme'], pageSize: 200 })
    expect(rows.every((r) => r.titles.includes('innovative_sme'))).toBe(true)
    expect(counts.total).toBe(rows.length)
    // 桶恒在(缺省 0),UI 不必自己补空桶;值确实随筛选收窄。
    expect(counts.titles.little_giant).toBe(0)
    expect(counts.titles.innovative_sme).toBe(rows.length)
    expect(counts.titlePairs).toBe(rows.length)
  })

  it('district 筛选按企业有效属地(企业自身属地优先,其次记录属地)', () => {
    const byEnterprise = listRosterEnterprises(db, { district: '海曙区', pageSize: 200 }).rows
    expect(byEnterprise.map((r) => r.name)).toEqual(['宁波别名测试有限公司'])
    // 企业自身属地为空,属地来自它那条 jxj 记录。
    const byRecord = listRosterEnterprises(db, { district: '鄞州区', pageSize: 200 }).rows
    expect(byRecord.map((r) => r.name)).toEqual(['宁波双称号股份有限公司'])
  })

  it('分页只截返回行,不动 counts', () => {
    const first = listRosterEnterprises(db, { pageSize: 2, page: 1 })
    const second = listRosterEnterprises(db, { pageSize: 2, page: 2 })
    expect(first.rows).toHaveLength(2)
    expect(second.rows).toHaveLength(2)
    expect(first.rows[0]!.enterpriseId).not.toBe(second.rows[0]!.enterpriseId)
    expect(first.counts).toEqual(second.counts)
    expect(first.page).toBe(1)
    expect(second.pageSize).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// §7.2 企业详情
// ---------------------------------------------------------------------------

describe('§7.2 企业详情 —— 别名 / 记录 / 事件 / 出处 / 差异 / 平台关系', () => {
  it('不存在的企业返回 null', () => {
    expect(getRosterEnterpriseDetail(db, 999_999)).toBeNull()
  })

  it('记录按称号 × 来源列出,事件带复核结论与结论年份,出处带页码', () => {
    const detail = getRosterEnterpriseDetail(db, ids.a!)!
    expect(detail.enterprise.name).toBe('宁波双称号股份有限公司')
    expect(detail.records.map((r) => `${r.titleCode}/${r.source}`)).toEqual([
      'little_giant/miit',
      'specialized_sme/jxj',
      'specialized_sme/miit',
    ])
    const award = detail.events.find((e) => e.eventType === 'award')!
    expect(award).toMatchObject({ year: 2021, decidedYear: 2021, reviewOutcome: null })
    expect(detail.records.find((r) => r.titleCode === 'specialized_sme' && r.source === 'jxj')!.lifecycle)
      .toMatchObject({ firstRecognitionYear: 2021, dueYear: 2024, state: 'active' })
  })

  it('复核事件带 reviewOutcome 与 decidedYear(2021 认定 → 2024 未通过)', () => {
    const detail = getRosterEnterpriseDetail(db, ids.failedReview!)!
    const review = detail.events.find((e) => e.eventType === 'review')!
    expect(review).toMatchObject({ year: 2021, decidedYear: 2024, reviewOutcome: 'failed' })
    expect(detail.records[0]!.lifecycle).toMatchObject({ firstRecognitionYear: 2021, state: 'terminated', dueYear: null })
  })

  it('出处逐条带 eventId / 文件 / 附件 / 序号 / 页码(RL-10 的落点)', () => {
    const detail = getRosterEnterpriseDetail(db, canonicalId)!
    const award = detail.events.find((e) => e.eventType === 'award')!
    expect(detail.evidence.filter((v) => v.eventId === award.id)).toEqual([
      {
        eventId: award.id,
        sourceFile: 'jxj/announcement/2022/甬经信中小〔2022〕145号关于公布宁波市“专精特新”中小企业名单的通知.pdf',
        attachment: '附件',
        listNo: 74,
        page: 74,
      },
    ])
  })

  it('差异只取当前解释(recordedAt 最新那条),旧解释不冒充当前', () => {
    const detail = getRosterEnterpriseDetail(db, ids.a!)!
    const diffs = detail.differences.filter((d) => d.titleCode === 'little_giant')
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({
      direction: 'extra_in_miit',
      status: 'confirmed_reason',
      reasonCode: 'moved_out',
      measureCode: 'mark_moved_out',
      verificationStatus: 'confirmed',
      recordedAt: '2026-10-14T00:00:00.000Z',
    })
  })

  it('别名按核验状态逐条返回(pending 也在详情里,只是不参与搜索)', () => {
    const detail = getRosterEnterpriseDetail(db, ids.aliasEnt!)!
    expect(detail.aliases.map((x) => [x.name, x.verificationStatus])).toEqual([
      ['宁波别名测试厂', 'confirmed'],
      ['宁波别名测试旧名', 'pending'],
    ])
  })

  it('无法归属的平台关系**不会**被按名称推断挂到某家企业上(不建模糊推断引擎)', () => {
    // 关系行写得很像「a」那家(名称一字不差),但写入侧没有把它归属给它(enterprise_id 为空)。
    const q = query('business_list', 'UNATTRIBUTED-KEY', '2', 'success', '2026-10-16T00:00:00.000Z')
    relation(q, 1, {
      relationKey: 'SQ-UNATTRIBUTED',
      enterpriseId: null,
      usccRaw: '91330211AAAAAAA001X',
      nameRaw: '宁波双称号股份有限公司',
      matchBasis: 'none',
      verificationStatus: 'pending',
    })
    const detail = getRosterEnterpriseDetail(db, ids.a!)!
    // 归属由**存下来的** enterprise_id 决定;读侧不按名称相似度补挂。
    expect(detail.platform.relations.some((r) => r.relationKey === 'SQ-UNATTRIBUTED')).toBe(false)
    expect(detail.platform.queries.some((x) => x.queryKey === 'UNATTRIBUTED-KEY')).toBe(false)
  })

  it('缺统一社会信用代码的企业**仍然**在总表里,并能按名称搜到', () => {
    const rows = listRosterEnterprises(db, { q: '宁波无统代企业', pageSize: 200 }).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      enterpriseId: ids.noUsccInRoster,
      uscc: null,
      district: '北仑区',
      rosterState: 'current',
    })
  })
})

// ---------------------------------------------------------------------------
// §7.3 差异与解释
// ---------------------------------------------------------------------------

describe('§7.3 差异与解释', () => {
  it('每 (企业 × 称号 × 方向) 只出一条**当前**解释', () => {
    const rows = listRosterDifferences(db, { pageSize: 500 }).rows
    const a = rows.filter((r) => r.enterpriseId === ids.a && r.titleCode === 'little_giant')
    expect(a).toHaveLength(1)
    expect(a[0]!.status).toBe('confirmed_reason')
  })

  it('两个方向的差异都能筛:公布有而平台无 / 平台有而公布无', () => {
    const missing = listRosterDifferences(db, { direction: ['missing_in_miit'], pageSize: 500 }).rows
    const extra = listRosterDifferences(db, { direction: ['extra_in_miit'], pageSize: 500 }).rows
    expect(missing.length).toBeGreaterThan(0)
    expect(extra.length).toBeGreaterThan(0)
    expect(missing.every((r) => r.direction === 'missing_in_miit')).toBe(true)
    expect(extra.every((r) => r.direction === 'extra_in_miit')).toBe(true)
    // 两方向的集合不交叉。
    const extraKeys = new Set(extra.map((r) => `${r.enterpriseId}|${r.titleCode}`))
    expect(missing.some((r) => extraKeys.has(`${r.enterpriseId}|${r.titleCode}`))).toBe(false)
  })

  it('四态互不冒充:未查询 / 查询失败 / 无记录 / 已确认无差异各是各的', () => {
    const rows = listRosterDifferences(db, { pageSize: 500 }).rows
    const statusOf = (key: string) =>
      rows.find((r) => r.enterpriseId === ids[key] && r.titleCode === 'specialized_sme')!.status
    expect(statusOf('stateNotQueried')).toBe('not_queried')
    expect(statusOf('stateFailed')).toBe('query_failed')
    expect(statusOf('stateNoRecord')).toBe('no_record')
    expect(statusOf('stateNoDiff')).toBe('confirmed_no_diff')
    // 四值互不相等,不做二次推导。
    expect(new Set([statusOf('stateNotQueried'), statusOf('stateFailed'), statusOf('stateNoRecord'), statusOf('stateNoDiff')]).size).toBe(4)
    // 按状态筛得到且只得到该状态。
    const failed = listRosterDifferences(db, { status: ['query_failed'], pageSize: 500 }).rows
    expect(failed.map((r) => r.enterpriseId)).toEqual([ids.stateFailed!])
  })

  it('已确认原因带证据与配对措施;查询失败带接口证据', () => {
    const rows = listRosterDifferences(db, { pageSize: 500 }).rows
    const a = rows.find((r) => r.enterpriseId === ids.a && r.titleCode === 'little_giant')!
    expect(a).toMatchObject({
      status: 'confirmed_reason',
      reasonCode: 'moved_out',
      reasonNote: '营业执照已迁至嘉兴',
      measureCode: 'mark_moved_out',
      measureNote: '保留公布历史,标明迁出状态',
      verificationStatus: 'confirmed',
    })
    const failed = rows.find((r) => r.enterpriseId === ids.stateFailed)!
    expect(failed.evidence).toMatchObject({
      queryId: fourStateQuery,
      interface: 'business_list',
      status: 'failed',
      queriedAt: '2026-10-15T01:00:00.000Z',
      relationIds: [expect.any(Number)],
    })
  })

  it('迁入企业给原称号 / 年份 / 批次;缺项则标 incomplete(页面显示待补证)', () => {
    const rows = listRosterDifferences(db, { pageSize: 500 }).rows
    const ok = rows.find((r) => r.enterpriseId === ids.movedInOk)!
    expect(ok.reasonCode).toBe('moved_in')
    expect(ok.movedIn).toEqual({ city: '杭州市', titleCode: 'specialized_sme', year: 2020, batch: 2, complete: true })
    const pending = rows.find((r) => r.enterpriseId === ids.movedInPending)!
    expect(pending.status).toBe('needs_review')
    expect(pending.movedIn).toEqual({ city: '绍兴市', titleCode: null, year: null, batch: null, complete: false })
  })

  it('可按 title / direction / status / reason 组合筛', () => {
    expect(listRosterDifferences(db, { title: ['little_giant'], pageSize: 500 }).rows.every((r) => r.titleCode === 'little_giant')).toBe(true)
    expect(listRosterDifferences(db, { reason: ['moved_out'], pageSize: 500 }).rows.map((r) => r.enterpriseId)).toEqual([ids.a])
    expect(listRosterDifferences(db, { reason: ['moved_in'], pageSize: 500 }).rows.map((r) => r.enterpriseId).sort()).toEqual([ids.movedInOk, ids.movedInPending].sort())
  })

  it('counts 按称号 × 方向给出当前筛选下的条数', () => {
    const { rows, counts } = listRosterDifferences(db, { pageSize: 500 })
    for (const title of Object.keys(counts)) {
      for (const direction of ['missing_in_miit', 'extra_in_miit'] as const) {
        expect(counts[title]![direction] ?? 0).toBe(rows.filter((r) => r.titleCode === title && r.direction === direction).length)
      }
    }
    // 筛选后口径同步收窄。
    const filtered = listRosterDifferences(db, { direction: ['extra_in_miit'], pageSize: 500 })
    expect(Object.values(filtered.counts).every((d) => d.missing_in_miit === 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 回归案例(brief 硬要求 F)
// ---------------------------------------------------------------------------

describe('回归案例:91330211255994457P 归并后总表一行', () => {
  it('375 与 7289 归并后**只出现一行**,被并企业行已删除', () => {
    const all = listRosterEnterprises(db, { pageSize: 200 }).rows
    expect(all.filter((r) => r.name.includes('上航测绘'))).toHaveLength(1)
    expect(all.some((r) => r.enterpriseId === ids.e375!)).toBe(false)
  })

  it('收起后仍保留三个称号(小巨人 miit + 专精特新 jxj 2022 认定 + 专精特新 miit)', () => {
    const detail = getRosterEnterpriseDetail(db, canonicalId)!
    expect(detail.records.map((r) => `${r.titleCode}/${r.source}`)).toEqual([
      'little_giant/miit',
      'specialized_sme/jxj',
      'specialized_sme/miit',
    ])
    // 出处一条不丢(第 74 页).
    expect(detail.evidence.map((v) => v.page)).toContain(74)
    // 首次认定仍是 2022(jxj 那条 award)。RL-08 起这一项还带状态与出处,
    // 所以只钉 RL-04 拥有的三项;新字段在这里由 §7.2 的 `recognitions` 段负责。
    expect(detail.enterprise.firstRecognition).toMatchObject([
      { titleCode: 'specialized_sme', year: 2022, needsReview: false },
    ])
    // §7.2 新增段:每个有认定的称号一条首次认定,与总表/§7.5 同一处计算。
    // 这条 award 的出处里带着第 74 页 ⇒ 依据回得到出处,状态是已确立。
    expect(detail.recognitions).toMatchObject([
      { titleCode: 'specialized_sme', firstYear: 2022, status: 'confirmed', pendingReason: null },
    ])
    expect(detail.recognitions[0]!.evidence.map((v) => v.page)).toEqual([74])
  })

  it('按现名或曾用名搜索都命中同一企业', () => {
    const byNew = listRosterEnterprises(db, { q: '宁波上航测绘股份有限公司', pageSize: 200 }).rows
    const byOld = listRosterEnterprises(db, { q: '宁波上航测绘有限公司', pageSize: 200 }).rows
    const byPart = listRosterEnterprises(db, { q: '上航测绘', pageSize: 200 }).rows
    expect(byNew.map((r) => r.enterpriseId)).toEqual([canonicalId])
    expect(byOld.map((r) => r.enterpriseId)).toEqual([canonicalId])
    expect(byPart.map((r) => r.enterpriseId)).toEqual([canonicalId])
    // 曾用名是归并写进来的那条(matchBasis=alias 的 qymc 差异行)。
    expect(byNew[0]!.aliasNames).toEqual(['宁波上航测绘有限公司'])
  })

  it('可查看该 USCC 的**全部 6 条**平台关联(不是 1 条)', () => {
    const detail = getRosterEnterpriseDetail(db, canonicalId)!
    const rdjb3 = detail.platform.queries.find((q) => q.interface === 'business_list' && q.rdjb === '3')!
    const relations = detail.platform.relations.filter((r) => r.queryId === rdjb3.id)
    expect(relations).toHaveLength(6)
    expect(rdjb3.relationCount).toBe(6)
    const oldNameOnes = relations.filter((r) => r.nameRaw === '宁波上航测绘有限公司')
    expect(oldNameOnes).toHaveLength(2)
    // 四级查询四态可区分:成功 / 无记录 ×2。
    expect(detail.platform.queries.map((q) => `${q.interface}:${q.rdjb}:${q.status}`)).toEqual([
      'business_list:3:success',
      'business_list:1:no_record',
      'business_list:2:no_record',
      'apply_list::success',
    ])
  })
})
