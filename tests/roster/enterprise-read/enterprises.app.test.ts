import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { platformExportBatch, platformExportRow } from '../../../db/postgresql/platform-tables'
import { readPostgresPlatformQueries } from '../../../layers/sme-roster/lib/platform/postgres-query-read'
import type { RosterImportRelation } from '../../../layers/sme-roster/lib/roster-import-client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from '../fixtures/postgres-tables'
import { createRosterImportClient } from '../../../layers/sme-roster/lib/roster-import-client'
import { listPostgresRosterEnterprises as listRosterEnterprises } from '../../../layers/sme-roster/lib/roster/enterprise-list-postgres'
import { readPostgresRosterEnterpriseDetail as getRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-detail-postgres'
import { listPostgresRosterDifferences as listRosterDifferences } from '../../../layers/sme-roster/lib/roster/difference-list-postgres'
import type { PlatformInterface } from '../../../layers/sme-roster/lib/labels'
import { startPostgresImportHttp } from './fixtures/postgres-import-http'

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
let db: ReturnType<typeof usePostgresDirectoryDb>
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
const TOKEN = 'roster-read-test-token'

/** 企业 id 按 key 记下来,断言用 key 而不是裸数字。 */
const ids: Record<string, number> = {}
const REGRESSION_USCC = '91330211255994457P'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

async function enterprise(key: string, name: string, uscc: string | null, district: string | null = null) {
  const id = (await db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc, district })
    .returning({ id: schema.enterprise.id }))[0]!.id
  ids[key] = id
  await db.insert(schema.rosterLegacyMember).values({ enterpriseId: id })
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

async function record(
  enterpriseId: number,
  titleCode: string,
  source: 'jxj' | 'miit',
  events: EventSpec[],
  district: string | null = null,
) {
  const recordId = (await db
    .insert(schema.record)
    .values({ enterpriseId, titleCode, source, district })
    .returning({ id: schema.record.id }))[0]!.id
  for (const e of events) {
    const eventId = (await db
      .insert(schema.recordEvent)
      .values({
        recordId,
        eventType: e.eventType,
        year: e.year ?? null,
        batchSeq: e.batchSeq ?? null,
        decidedYear: e.decidedYear === undefined ? (e.year ?? null) : e.decidedYear,
        reviewOutcome: e.reviewOutcome ?? null,
      })
      .returning({ id: schema.recordEvent.id }))[0]!.id
    for (const v of e.evidence ?? []) {
      await db.insert(schema.recordEvidence)
        .values({
          recordEventId: eventId,
          sourceFile: v.sourceFile,
          attachment: v.attachment ?? null,
          listNo: v.listNo ?? null,
          page: v.page ?? null,
        })
    }
  }
  return recordId
}

async function alias(
  enterpriseId: number,
  name: string,
  verificationStatus: 'confirmed' | 'pending',
  sourceKind: 'platform_business' | 'platform_apply' | 'announcement' | 'manual' = 'manual',
  sourceRefId = 0,
) {
  await db.insert(schema.enterpriseAlias)
    .values({ enterpriseId, name, nameNorm: name, sourceKind, sourceRefId, verificationStatus, createdAt: '2026-10-14' })
}

async function difference(
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
  return (await db
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
      createdAt: values.recordedAt,
    })
    .returning({ id: schema.differenceReason.id }))[0]!.id
}

async function query(
  interfaceName: PlatformInterface,
  queryKey: string,
  rdjb: string,
  status: 'success' | 'failed' | 'no_record' | 'not_queried',
  queriedAt: string,
  failureReason: string | null = null,
  relations: RosterImportRelation[] = [],
) {
  return (await seedPostgresPlatformQuery(db, { interface: interfaceName, queryKey, rdjb, status, queriedAt, failureReason, rawResponse: 'Explicit synthetic roster source', relations })).queryId
}

async function snapshotBatch(titleCode: string, year: number, sha256: string, collectedOn: string) {
  return (await db
    .insert(platformExportBatch)
    .values({
      titleCode,
      year,
      sha256,
      collectedOn,
      originalFilename: `${titleCode}-${year}.xlsx`,
      rowCount: 1,
      importStatus: 'imported',
      createdAt: collectedOn,
    })
    .returning({ id: platformExportBatch.id }))[0]!.id
}

async function snapshotRow(batchId: number, sourceRowNo: number, usccRaw: string, nameRaw: string) {
  await db.insert(platformExportRow)
    .values({ batchId, sourceRowNo, usccRaw, nameRaw, createdAt: '2026-10-14' })
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

let api: Awaited<ReturnType<typeof startPostgresImportHttp>>
/** 归并后规范行的 id(被并的 375 已删除,故由 API 写入后现取)。 */
let canonicalId = 0
/** 四态证据用的查询 id。 */
let fourStateQuery = 0

beforeAll(async () => {
  postgres = await postgresRuntimeFixture({ dir })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  db = usePostgresDirectoryDb()
  // —— 企业 A:多称号 + 别名 + 两条时态化的差异解释 ——
  const a = (await enterprise('a', '宁波双称号股份有限公司', '91330211AAAAAAA001X'))
  await record(a, 'specialized_sme', 'jxj', [{ eventType: 'award', year: 2021 }], '鄞州区')
  await record(a, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  await record(a, 'little_giant', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])

  // 旧解释(待核实)与新解释(已确认外迁 + 配对措施):当前解释必须是新的那条。
  await difference(a, 'little_giant', 'extra_in_miit', {
    status: 'needs_review',
    recordedAt: '2026-10-01T00:00:00.000Z',
  })
  await difference(a, 'little_giant', 'extra_in_miit', {
    status: 'confirmed_reason',
    reasonCode: 'moved_out',
    reasonNote: '营业执照已迁至嘉兴',
    measureCode: 'mark_moved_out',
    measureNote: '保留公布历史,标明迁出状态',
    verificationStatus: 'confirmed',
    recordedAt: '2026-10-14T00:00:00.000Z',
  })

  // —— 别名搜索:一 confirmed 一 pending ——
  const aliasEnt = (await enterprise('aliasEnt', '宁波别名测试有限公司', '91330211AAAAAAA002X', '海曙区'))
  await record(aliasEnt, 'innovative_sme', 'jxj', [{ eventType: 'award', year: 2023 }])
  await alias(aliasEnt, '宁波别名测试厂', 'confirmed', 'announcement')
  await alias(aliasEnt, '宁波别名测试旧名', 'pending')

  // —— rosterState:仅平台、且已从最新快照消失 ⇒ removed_platform_only ——
  const onlyPlatform = (await enterprise('onlyPlatform', '宁波仅平台企业', '91330211AAAAAAA003X'))
  await record(onlyPlatform, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  // —— 仍在最新快照 ⇒ current ——
  const stillLatest = (await enterprise('stillLatest', '宁波仍在新快照企业', '91330211AAAAAAA004X'))
  await record(stillLatest, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  // —— 一张快照都没有 ⇒ 无从证明「已移除」⇒ 保留为 current ——
  const noSnapshot = (await enterprise('noSnapshot', '宁波无快照平台企业', '91330211AAAAAAA005X'))
  await record(noSnapshot, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  // —— 只在公布名单里出现过(入库培育)⇒ 官方历史,必须留在总表 ——
  const nurtureOnly = (await enterprise('nurtureOnly', '宁波仅培育企业', '91330211AAAAAAA006X'))
  await record(nurtureOnly, 'specialized_sme', 'jxj', [{ eventType: 'nurture', year: 2023 }])

  const oldBatch = (await snapshotBatch('specialized_sme', 2025, 'sha-old', '2025-06-30'))
  await snapshotRow(oldBatch, 1, '91330211AAAAAAA003X', '宁波仅平台企业')
  await snapshotRow(oldBatch, 2, '91330211AAAAAAA004X', '宁波仍在新快照企业')
  const latestBatch = (await snapshotBatch('specialized_sme', 2026, 'sha-new', '2026-06-30'))
  await snapshotRow(latestBatch, 1, '91330211AAAAAAA004X', '宁波仍在新快照企业')

  // —— 迁入:证据齐全 / 缺项待补 ——
  const movedInOk = (await enterprise('movedInOk', '宁波迁入企业', '91330211AAAAAAA007X'))
  await record(movedInOk, 'innovative_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  await difference(movedInOk, 'innovative_sme', 'extra_in_miit', {
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
  const movedInPending = (await enterprise('movedInPending', '宁波迁入待补企业', '91330211AAAAAAA008X'))
  await record(movedInPending, 'innovative_sme', 'jxj', [{ eventType: 'award', year: 2022 }])
  await difference(movedInPending, 'innovative_sme', 'missing_in_miit', {
    status: 'needs_review',
    reasonCode: 'moved_in',
    measureCode: 'manual_review',
    movedInCity: '绍兴市',
    verificationStatus: 'pending',
    recordedAt: '2026-10-14T00:00:00.000Z',
  })

  // —— 差异四态互不冒充(未查询 / 查询失败 / 无记录 / 已确认无差异)——
  fourStateQuery = await query('business_list', '91330211AAAAAAA010X', '2', 'failed', '2026-10-15T01:00:00.000Z', '登录超时,请重新登录', [{ sequenceNo: 1, relationKey: 'SQ-BAD', usccRaw: '91330211AAAAAAA010X', nameRaw: '宁波查失败企业' }])

  const stateNotQueried = (await enterprise('stateNotQueried', '宁波未查企业', '91330211AAAAAAA009X'))
  await record(stateNotQueried, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  await difference(stateNotQueried, 'specialized_sme', 'extra_in_miit', { status: 'not_queried', recordedAt: '2026-10-14T00:00:00.000Z' })

  const stateFailed = (await enterprise('stateFailed', '宁波查失败企业', '91330211AAAAAAA010X'))
  await record(stateFailed, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  await difference(stateFailed, 'specialized_sme', 'extra_in_miit', {
    status: 'query_failed',
    reasonNote: '会话过期,查询没成功执行',
    evidenceQueryId: fourStateQuery,
    recordedAt: '2026-10-15T01:00:00.000Z',
  })

  const stateNoRecord = (await enterprise('stateNoRecord', '宁波无记录企业', '91330211AAAAAAA011X'))
  await record(stateNoRecord, 'specialized_sme', 'jxj', [{ eventType: 'award', year: 2022 }])
  await difference(stateNoRecord, 'specialized_sme', 'missing_in_miit', {
    status: 'no_record',
    reasonNote: '查询成功执行,平台返回空',
    recordedAt: '2026-10-15T00:00:00.000Z',
  })

  const stateNoDiff = (await enterprise('stateNoDiff', '宁波已确认无差异企业', '91330211AAAAAAA012X'))
  await record(stateNoDiff, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  await difference(stateNoDiff, 'specialized_sme', 'extra_in_miit', {
    status: 'confirmed_no_diff',
    measureCode: 'none',
    verificationStatus: 'confirmed',
    recordedAt: '2026-10-15T00:00:00.000Z',
  })

  // 总表差异筛选必须命中任一差异坐标,不能只看摘要优先挑出的状态。
  const multiDiffStatus = (await enterprise('multiDiffStatus', '宁波多状态差异企业', '91330211AAAAAAA013X'))
  await record(multiDiffStatus, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025 }])
  await record(multiDiffStatus, 'little_giant', 'miit', [{ eventType: 'maintain', year: 2025 }])
  await difference(multiDiffStatus, 'specialized_sme', 'extra_in_miit', {
    status: 'not_queried',
    recordedAt: '2026-10-15T00:00:00.000Z',
  })
  await difference(multiDiffStatus, 'little_giant', 'extra_in_miit', {
    status: 'confirmed_reason',
    verificationStatus: 'confirmed',
    recordedAt: '2026-10-16T00:00:00.000Z',
  })

  // —— 生命周期:复核通过 ⇒ 锚点取结论年份;缺结论年份 ⇒ 标待核 ——
  const reviewed = (await enterprise('reviewed', '宁波复核通过企业', '91330211AAAAAAA020X'))
  await record(reviewed, 'specialized_sme', 'jxj', [
    { eventType: 'award', year: 2021, batchSeq: 1 },
    { eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'passed', batchSeq: 1 },
  ])
  const noDecided = (await enterprise('noDecided', '宁波缺结论年份企业', '91330211AAAAAAA021X'))
  await record(noDecided, 'specialized_sme', 'jxj', [{ eventType: 'award', year: 2020, decidedYear: null }])
  const failedReview = (await enterprise('failedReview', '宁波复核未通过企业', '91330211AAAAAAA022X'))
  await record(failedReview, 'specialized_sme', 'jxj', [
    { eventType: 'award', year: 2021, batchSeq: 1 },
    { eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'failed', batchSeq: 1 },
  ])

  // —— 缺统代企业:公布名单条目必须保留,并按名称可搜到 ——
  const noUsccInRoster = (await enterprise('noUsccInRoster', '宁波无统代企业', null, '北仑区'))
  await record(noUsccInRoster, 'specialized_sme', 'jxj', [{ eventType: 'award', year: 2024 }])

  // —— 回归案例:375(无统代,jxj 2022 认定)与 7289(统代,两条 miit 记录) ——
  const e375 = (await enterprise('e375', '宁波上航测绘有限公司', null))
  await record(e375, 'specialized_sme', 'jxj', [
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
  const e7289 = (await enterprise('e7289', '宁波上航测绘股份有限公司', REGRESSION_USCC))
  await record(e7289, 'specialized_sme', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])
  await record(e7289, 'little_giant', 'miit', [{ eventType: 'maintain', year: 2025, batchSeq: 1 }])

  const q3 = (await query('business_list', REGRESSION_USCC, '3', 'success', '2026-10-15T17:11:21.514Z', null, REGRESSION_RELATIONS.map((r, index) => ({ sequenceNo: index + 1,
      relationKey: r.relationKey,
      rawFields: { id: r.relationKey, qymc: r.name, tyshxydm: REGRESSION_USCC },
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
  }))))
  // `rdjb=1` / `rdjb=2` 返回 0 行:请求成功、会话有效 ⇒ **无记录**,不是失败。
  await query('business_list', REGRESSION_USCC, '1', 'no_record', '2026-10-15T17:11:21.514Z')
  await query('business_list', REGRESSION_USCC, '2', 'no_record', '2026-10-15T17:11:21.514Z')
  const qApply = await query('apply_list', REGRESSION_USCC, '', 'success', '2026-10-15T17:11:21.514Z', null, [{ sequenceNo: 1, ...{ relationKey: 'SQ332025060392166', enterpriseId: e7289, usccRaw: REGRESSION_USCC, nameRaw: '宁波上航测绘股份有限公司', rawFields: { id: 'SQ332025060392166', qymc: '宁波上航测绘股份有限公司', tyshxydm: REGRESSION_USCC }, year: 2025 } }, { sequenceNo: 2, ...{ relationKey: 'SQ332022062212391', enterpriseId: e7289, usccRaw: REGRESSION_USCC, nameRaw: '宁波上航测绘有限公司', rawFields: { id: 'SQ332022062212391', qymc: '宁波上航测绘有限公司', tyshxydm: REGRESSION_USCC }, year: 2022 } }])

  // —— 归并走**真实 HTTP API**(不是测试自己改库) ——
  api = await startPostgresImportHttp(dir, TOKEN)
  const client = createRosterImportClient({ baseUrl: api.baseUrl, token: TOKEN })
  const oldNameRelation = (await readPostgresPlatformQueries(db, { pageSize: 200 })).rows.flatMap(item => item.relations.map(row => ({ ...row, queryId: item.query.id })))
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
  canonicalId = (await db.select().from(schema.enterprise)).find((e) => e.usccNorm === REGRESSION_USCC)!.id
}, 60_000)

afterAll(async () => {
  await api?.close()
  await closePostgresDirectoryDb()
  postgres?.close()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

const rowsByName = async (names: string[]) =>
  (await listRosterEnterprises(db, { pageSize: 200 })).rows.filter((r) => names.includes(r.name))
const rowOf = async (key: string) =>
  (await listRosterEnterprises(db, { pageSize: 200 })).rows.find((r) => r.enterpriseId === ids[key])!

// ---------------------------------------------------------------------------
// §7.1 企业总表
// ---------------------------------------------------------------------------

describe('§7.1 企业总表 —— 一企一行,称号与事件不折叠', () => {
  it('跨称号去重:同一企业只出现一行,titles 列出它拿过的全部称号', async () => {
    const row = await rowOf('a')
    expect(row.titles).toEqual(['little_giant', 'specialized_sme'])
    // 三条 record(称号×来源)没有把它拆成三行。
    expect((await listRosterEnterprises(db, { pageSize: 200 })).rows.filter((r) => r.name === '宁波双称号股份有限公司')).toHaveLength(1)
  })

  /**
   * RL-08 增量:`firstRecognition` 的一项除了 `titleCode` / `year` / `needsReview`,
   * 还带首次认定**自己的**状态与出处(`status` / `pendingReason` / `evidence` / `source` /
   * `firstEventId` / `undatedAwardIds`)。
   *
   * 这里仍然用 `toEqual`(**不是** `toMatchObject`)—— 逐字段全等才有力量:
   * 多出一个少写一个都会红,数组长度也被钉住。唯一给不出常量的是 `firstEventId`(运行期 id),
   * 用 `expect.any(Number)` 明说「只要是条数就行」,而不是把整个对象放宽成「包含」。
   *
   * 这个夹具的 award 事件**没有出处行** ⇒ `status` 是 `pending`(`no_evidence`),
   * 那是如实:依据回不到出处的首次认定本来就不算确立(RL-08 口径)。
   */
  it('首次认定取最早的 award;没有 award 的称号不出现在 firstRecognition 里', async () => {
    const row = await rowOf('a')
    // 专精特新 2021 认定 ⇒ 2021;同年 + 3 = 下一次到期 2024。
    expect(row.firstRecognition).toEqual([
      {
        titleCode: 'specialized_sme',
        year: 2021,
        firstEventId: expect.any(Number),
        source: 'jxj',
        status: 'pending',
        pendingReason: 'no_evidence',
        evidence: [],
        undatedAwardIds: [],
        needsReview: false,
      },
    ])
    expect(row.nextReviewYear).toBe(2024)
    // 小巨人只有 miit 维护记录(**没有** award)⇒ 不产生首次认定,也不产生锚点。
    expect(row.firstRecognition.some((f) => f.titleCode === 'little_giant')).toBe(false)
  })

  it('复核通过的称号锚点 = 结论年份,下一次到期 = 锚点 + 3', async () => {
    const row = await rowOf('reviewed')
    expect(row.firstRecognition).toEqual([
      {
        titleCode: 'specialized_sme',
        year: 2021,
        firstEventId: expect.any(Number),
        source: 'jxj',
        status: 'pending',
        pendingReason: 'no_evidence',
        evidence: [],
        undatedAwardIds: [],
        needsReview: false,
      },
    ])
    expect(row.nextReviewYear).toBe(2027)
  })

  it('结论年份缺失 ⇒ 退回年份并标待核(不猜)', async () => {
    const row = await rowOf('noDecided')
    // ⚠️ 两个「待」是两件事,这里同时出现:`needsReview` 说的是**锚点**缺结论年份,
    // 而首次认定自己的状态是 `no_evidence`(这个夹具没有出处行)。
    expect(row.firstRecognition).toEqual([
      {
        titleCode: 'specialized_sme',
        year: 2020,
        firstEventId: expect.any(Number),
        source: 'jxj',
        status: 'pending',
        pendingReason: 'no_evidence',
        evidence: [],
        undatedAwardIds: [],
        needsReview: true,
      },
    ])
    expect(row.anchorNeedsReview).toBe(true)
    expect(row.nextReviewYear).toBe(2023)
  })
})

describe('§7.1 别名搜索口径(契约 §1.2)', () => {
  it('按现名命中', async () => {
    const hits = (await listRosterEnterprises(db, { q: '宁波别名测试有限公司', pageSize: 200 })).rows
    expect(hits.map((r) => r.enterpriseId)).toEqual([ids.aliasEnt])
  })

  it('按**已确认**曾用名命中同一企业', async () => {
    const hits = (await listRosterEnterprises(db, { q: '宁波别名测试厂', pageSize: 200 })).rows
    expect(hits.map((r) => r.enterpriseId)).toEqual([ids.aliasEnt])
    // 曾用名原值也随行返回(仅 confirmed)。
    expect(hits[0]!.aliasNames).toEqual(['宁波别名测试厂'])
  })

  it('`pending` 别名**不参与搜索**,也不出现在 aliasNames 里', async () => {
    expect((await listRosterEnterprises(db, { q: '宁波别名测试旧名', pageSize: 200 })).rows).toEqual([])
    expect((await rowOf('aliasEnt')).aliasNames).toEqual(['宁波别名测试厂'])
  })
})

describe('§7.1 rosterState 派生(契约 §5,不落列)', () => {
  it('有 jxj 认定事件 ⇒ current', async () => {
    expect((await rowOf('a')).rosterState).toBe('current')
    expect((await rowOf('aliasEnt')).rosterState).toBe('current')
  })

  it('只在公布名单里出现过(入库培育)⇒ 仍在当前总表(公布历史不因平台缺失被删)', async () => {
    expect((await rowOf('nurtureOnly')).rosterState).toBe('current')
  })

  it('仅由历史平台导出引入、且不在最新快照 ⇒ removed_platform_only', async () => {
    expect((await rowOf('onlyPlatform')).rosterState).toBe('removed_platform_only')
  })

  it('仍在最新快照 ⇒ current', async () => {
    expect((await rowOf('stillLatest')).rosterState).toBe('current')
  })

  it('一张快照都没有 ⇒ 无从证明「已移除」,保留为 current(证据不足不误删)', async () => {
    expect((await rowOf('noSnapshot')).rosterState).toBe('current')
  })

  it('rosterState 可按 current / removed_platform_only 双向筛', async () => {
    const removed = (await listRosterEnterprises(db, { rosterState: 'removed_platform_only', pageSize: 200 })).rows
    expect(removed.map((r) => r.name)).toEqual(['宁波仅平台企业'])
    const current = (await listRosterEnterprises(db, { rosterState: 'current', pageSize: 200 })).rows
    expect(current.some((r) => r.name === '宁波仅平台企业')).toBe(false)
    expect(current.length).toBeGreaterThan(removed.length)
  })
})

describe('§7.1 差异状态筛选', () => {
  it('按企业任一差异记录命中,摘要优先级只决定展示状态', async () => {
    const summary = await rowOf('multiDiffStatus')
    expect(summary.difference).toMatchObject({ count: 2, status: 'confirmed_reason' })

    const notQueried = (await listRosterEnterprises(db, { diffStatus: ['not_queried'] })).rows
    expect(notQueried.map((row) => row.enterpriseId)).toContain(ids.multiDiffStatus)

    const confirmed = (await listRosterEnterprises(db, { diffStatus: ['confirmed_reason'] })).rows
    expect(confirmed.map((row) => row.enterpriseId)).toContain(ids.multiDiffStatus)

    const noDifference = (await listRosterEnterprises(db, { diffStatus: ['none'] })).rows
    expect(noDifference.map((row) => row.enterpriseId)).not.toContain(ids.multiDiffStatus)
  })
})

describe('§7.1 计数口径、筛选与分页', () => {
  it('counts 同时给企业数与「企业 × 称号」数,且两者口径一致', async () => {
    const all = await listRosterEnterprises(db, { pageSize: 1 })
    // total 是**企业数**(与分页无关,是筛选后的全量)。
    expect(all.counts.total).toBe((await listRosterEnterprises(db, { pageSize: 200 })).rows.length)
    // titles 是每称号的**企业数**;titlePairs 是「企业 × 称号」总数 = 各称号之和。
    expect(all.counts.titlePairs).toBe(Object.values(all.counts.titles).reduce((a, b) => a + b, 0))
    // 多称号企业只算一家企业,但在每个称号桶里各计一次。
    const titles = (await listRosterEnterprises(db, { pageSize: 200 })).rows.reduce<Record<string, number>>((acc, row) => {
      for (const t of row.titles) acc[t] = (acc[t] ?? 0) + 1
      return acc
    }, {})
    expect(all.counts.titles).toEqual(titles)
  })

  it('筛选后 counts 与筛选后的行同口径(不是全库口径)', async () => {
    const { rows, counts } = await listRosterEnterprises(db, { title: ['innovative_sme'], pageSize: 200 })
    expect(rows.every((r) => r.titles.includes('innovative_sme'))).toBe(true)
    expect(counts.total).toBe(rows.length)
    // 桶恒在(缺省 0),UI 不必自己补空桶;值确实随筛选收窄。
    expect(counts.titles.little_giant).toBe(0)
    expect(counts.titles.innovative_sme).toBe(rows.length)
    expect(counts.titlePairs).toBe(rows.length)
  })

  it('district 筛选按企业有效属地(企业自身属地优先,其次记录属地)', async () => {
    const byEnterprise = (await listRosterEnterprises(db, { district: '海曙区', pageSize: 200 })).rows
    expect(byEnterprise.map((r) => r.name)).toEqual(['宁波别名测试有限公司'])
    // 企业自身属地为空,属地来自它那条 jxj 记录。
    const byRecord = (await listRosterEnterprises(db, { district: '鄞州区', pageSize: 200 })).rows
    expect(byRecord.map((r) => r.name)).toEqual(['宁波双称号股份有限公司'])
  })

  it('分页只截返回行,不动 counts', async () => {
    const first = await listRosterEnterprises(db, { pageSize: 2, page: 1 })
    const second = await listRosterEnterprises(db, { pageSize: 2, page: 2 })
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
  it('不存在的企业返回 null', async () => {
    expect((await getRosterEnterpriseDetail(db, 999_999))).toBeNull()
  })

  it('记录按称号 × 来源列出,事件带复核结论与结论年份,出处带页码', async () => {
    const detail = (await getRosterEnterpriseDetail(db, ids.a!))!
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

  it('复核事件带 reviewOutcome 与 decidedYear(2021 认定 → 2024 未通过)', async () => {
    const detail = (await getRosterEnterpriseDetail(db, ids.failedReview!))!
    const review = detail.events.find((e) => e.eventType === 'review')!
    expect(review).toMatchObject({ year: 2021, decidedYear: 2024, reviewOutcome: 'failed' })
    expect(detail.records[0]!.lifecycle).toMatchObject({ firstRecognitionYear: 2021, state: 'terminated', dueYear: null })
  })

  it('出处逐条带 eventId / 文件 / 附件 / 序号 / 页码(RL-10 的落点)', async () => {
    const detail = (await getRosterEnterpriseDetail(db, canonicalId))!
    const award = detail.events.find((e) => e.eventType === 'award')!
    expect(detail.evidence.filter((v) => v.eventId === award.id)).toEqual([
      {
        id: 1, // Original persisted evidence ID; #356 adds it without changing the locator.
        eventId: award.id,
        sourceFile: 'jxj/announcement/2022/甬经信中小〔2022〕145号关于公布宁波市“专精特新”中小企业名单的通知.pdf',
        attachment: '附件',
        listNo: 74,
        page: 74,
      },
    ])
  })

  it('差异只取当前解释(recordedAt 最新那条),旧解释不冒充当前', async () => {
    const detail = (await getRosterEnterpriseDetail(db, ids.a!))!
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

  it('别名按核验状态逐条返回(pending 也在详情里,只是不参与搜索)', async () => {
    const detail = (await getRosterEnterpriseDetail(db, ids.aliasEnt!))!
    expect(detail.aliases.map((x) => [x.name, x.verificationStatus])).toEqual([
      ['宁波别名测试厂', 'confirmed'],
      ['宁波别名测试旧名', 'pending'],
    ])
  })

  it('无法归属的平台关系**不会**被按名称推断挂到某家企业上(不建模糊推断引擎)', async () => {
    // 关系行写得很像「a」那家(名称一字不差),但写入侧没有把它归属给它(enterprise_id 为空)。
    await query('business_list', 'UNATTRIBUTED-KEY', '2', 'success', '2026-10-16T00:00:00.000Z', null, [{ sequenceNo: 1,
      relationKey: 'SQ-UNATTRIBUTED',
      enterpriseId: null,
      usccRaw: '91330211AAAAAAA001X',
      nameRaw: '宁波双称号股份有限公司',
      matchBasis: 'none',
      verificationStatus: 'pending',
    }])
    const detail = (await getRosterEnterpriseDetail(db, ids.a!))!
    // 归属由**存下来的** enterprise_id 决定;读侧不按名称相似度补挂。
    expect(detail.platform.relations.some((r) => r.relationKey === 'SQ-UNATTRIBUTED')).toBe(false)
    expect(detail.platform.queries.some((x) => x.queryKey === 'UNATTRIBUTED-KEY')).toBe(false)
  })

  it('缺统一社会信用代码的企业**仍然**在总表里,并能按名称搜到', async () => {
    const rows = (await listRosterEnterprises(db, { q: '宁波无统代企业', pageSize: 200 })).rows
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
  it('每 (企业 × 称号 × 方向) 只出一条**当前**解释', async () => {
    const rows = (await listRosterDifferences(db, { pageSize: 500 })).rows
    const a = rows.filter((r) => r.enterpriseId === ids.a && r.titleCode === 'little_giant')
    expect(a).toHaveLength(1)
    expect(a[0]!.status).toBe('confirmed_reason')
  })

  it('两个方向的差异都能筛:公布有而平台无 / 平台有而公布无', async () => {
    const missing = (await listRosterDifferences(db, { direction: ['missing_in_miit'], pageSize: 500 })).rows
    const extra = (await listRosterDifferences(db, { direction: ['extra_in_miit'], pageSize: 500 })).rows
    expect(missing.length).toBeGreaterThan(0)
    expect(extra.length).toBeGreaterThan(0)
    expect(missing.every((r) => r.direction === 'missing_in_miit')).toBe(true)
    expect(extra.every((r) => r.direction === 'extra_in_miit')).toBe(true)
    // 两方向的集合不交叉。
    const extraKeys = new Set(extra.map((r) => `${r.enterpriseId}|${r.titleCode}`))
    expect(missing.some((r) => extraKeys.has(`${r.enterpriseId}|${r.titleCode}`))).toBe(false)
  })

  it('四态互不冒充:未查询 / 查询失败 / 无记录 / 已确认无差异各是各的', async () => {
    const rows = (await listRosterDifferences(db, { pageSize: 500 })).rows
    const statusOf = (key: string) =>
      rows.find((r) => r.enterpriseId === ids[key] && r.titleCode === 'specialized_sme')!.status
    expect(statusOf('stateNotQueried')).toBe('not_queried')
    expect(statusOf('stateFailed')).toBe('query_failed')
    expect(statusOf('stateNoRecord')).toBe('no_record')
    expect(statusOf('stateNoDiff')).toBe('confirmed_no_diff')
    // 四值互不相等,不做二次推导。
    expect(new Set([statusOf('stateNotQueried'), statusOf('stateFailed'), statusOf('stateNoRecord'), statusOf('stateNoDiff')]).size).toBe(4)
    // 按状态筛得到且只得到该状态。
    const failed = (await listRosterDifferences(db, { status: ['query_failed'], pageSize: 500 })).rows
    expect(failed.map((r) => r.enterpriseId)).toEqual([ids.stateFailed!])
  })

  it('已确认原因带证据与配对措施;查询失败带接口证据', async () => {
    const rows = (await listRosterDifferences(db, { pageSize: 500 })).rows
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

  it('迁入企业给原称号 / 年份 / 批次;缺项则标 incomplete(页面显示待补证)', async () => {
    const rows = (await listRosterDifferences(db, { pageSize: 500 })).rows
    const ok = rows.find((r) => r.enterpriseId === ids.movedInOk)!
    expect(ok.reasonCode).toBe('moved_in')
    expect(ok.movedIn).toEqual({ city: '杭州市', titleCode: 'specialized_sme', year: 2020, batch: 2, complete: true })
    const pending = rows.find((r) => r.enterpriseId === ids.movedInPending)!
    expect(pending.status).toBe('needs_review')
    expect(pending.movedIn).toEqual({ city: '绍兴市', titleCode: null, year: null, batch: null, complete: false })
  })

  it('可按 title / direction / status / reason 组合筛', async () => {
    expect((await listRosterDifferences(db, { title: ['little_giant'], pageSize: 500 })).rows.every((r) => r.titleCode === 'little_giant')).toBe(true)
    expect((await listRosterDifferences(db, { reason: ['moved_out'], pageSize: 500 })).rows.map((r) => r.enterpriseId)).toEqual([ids.a])
    expect((await listRosterDifferences(db, { reason: ['moved_in'], pageSize: 500 })).rows.map((r) => r.enterpriseId).sort()).toEqual([ids.movedInOk, ids.movedInPending].sort())
  })

  it('counts 按称号 × 方向给出当前筛选下的条数', async () => {
    const { rows, counts } = await listRosterDifferences(db, { pageSize: 500 })
    for (const title of Object.keys(counts)) {
      for (const direction of ['missing_in_miit', 'extra_in_miit'] as const) {
        expect(counts[title]![direction] ?? 0).toBe(rows.filter((r) => r.titleCode === title && r.direction === direction).length)
      }
    }
    // 筛选后口径同步收窄。
    const filtered = await listRosterDifferences(db, { direction: ['extra_in_miit'], pageSize: 500 })
    expect(Object.values(filtered.counts).every((d) => d.missing_in_miit === 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 回归案例(brief 硬要求 F)
// ---------------------------------------------------------------------------

describe('回归案例:91330211255994457P 归并后总表一行', () => {
  it('375 与 7289 归并后**只出现一行**,被并企业行已删除', async () => {
    const all = (await listRosterEnterprises(db, { pageSize: 200 })).rows
    expect(all.filter((r) => r.name.includes('上航测绘'))).toHaveLength(1)
    expect(all.some((r) => r.enterpriseId === ids.e375!)).toBe(false)
  })

  it('收起后仍保留三个称号(小巨人 miit + 专精特新 jxj 2022 认定 + 专精特新 miit)', async () => {
    const detail = (await getRosterEnterpriseDetail(db, canonicalId))!
    expect(detail.records.map((r) => `${r.titleCode}/${r.source}`)).toEqual([
      'little_giant/miit',
      'specialized_sme/jxj',
      'specialized_sme/miit',
    ])
    // 出处一条不丢(第 74 页).
    expect(detail.evidence.map((v) => v.page)).toContain(74)
    // 首次认定仍是 2022(jxj 那条 award)。RL-08 起这一项还带状态与出处 —— 逐字段全等。
    expect(detail.enterprise.firstRecognition).toEqual([
      {
        titleCode: 'specialized_sme',
        year: 2022,
        firstEventId: expect.any(Number),
        source: 'jxj',
        status: 'confirmed',
        pendingReason: null,
        evidence: [{ sourceFile: expect.stringContaining('145号'), attachment: expect.anything(), listNo: 74, page: 74 }],
        undatedAwardIds: [],
        needsReview: false,
      },
    ])
    // §7.2 新增段:每个有认定的称号一条首次认定,与总表/§7.5 同一处计算。
    // 这条 award 的出处里带着第 74 页 ⇒ 依据回得到出处,状态是已确立。
    expect(detail.recognitions).toMatchObject([
      { titleCode: 'specialized_sme', firstYear: 2022, status: 'confirmed', pendingReason: null },
    ])
    expect(detail.recognitions[0]!.evidence.map((v) => v.page)).toEqual([74])
  })

  it('按现名或曾用名搜索都命中同一企业', async () => {
    const byNew = (await listRosterEnterprises(db, { q: '宁波上航测绘股份有限公司', pageSize: 200 })).rows
    const byOld = (await listRosterEnterprises(db, { q: '宁波上航测绘有限公司', pageSize: 200 })).rows
    const byPart = (await listRosterEnterprises(db, { q: '上航测绘', pageSize: 200 })).rows
    expect(byNew.map((r) => r.enterpriseId)).toEqual([canonicalId])
    expect(byOld.map((r) => r.enterpriseId)).toEqual([canonicalId])
    expect(byPart.map((r) => r.enterpriseId)).toEqual([canonicalId])
    // 曾用名是归并写进来的那条(matchBasis=alias 的 qymc 差异行)。
    expect(byNew[0]!.aliasNames).toEqual(['宁波上航测绘有限公司'])
  })

  it('可查看该 USCC 的**全部 6 条**平台关联(不是 1 条)', async () => {
    const detail = (await getRosterEnterpriseDetail(db, canonicalId))!
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

describe('企业列表正式认定批次摘要', () => {
  it('合并来源重复批次，保留原始年份批次，不混入复核或维持', async () => {
    const id = (await enterprise('awardSummary', '认定批次摘要测试企业', null))
    await record(id, 'specialized_sme', 'jxj', [
      { eventType: 'award', year: 2020, decidedYear: 2021, batchSeq: 2 },
      { eventType: 'review', year: 2024, batchSeq: 1 },
    ])
    await record(id, 'specialized_sme', 'miit', [
      { eventType: 'award', year: 2020, batchSeq: 2 },
      { eventType: 'award', year: 2022, batchSeq: 1 },
      { eventType: 'maintain', year: 2025 },
    ])
    expect((await listRosterEnterprises(db, { q: '认定批次摘要测试企业' })).rows[0]!.awards).toEqual([
      { titleCode: 'specialized_sme', year: 2020, batchSeq: 2 },
      { titleCode: 'specialized_sme', year: 2022, batchSeq: 1 },
    ])
  })
})
