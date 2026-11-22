import { closeApplicationLogging } from '../../../layers/core/lib/logging'
import { eq } from 'drizzle-orm'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createError, createRouter, defineEventHandler, getHeader, getQuery, readBody, setHeader, setResponseStatus, toNodeListener } from 'h3'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { enterprise, enterpriseAlias, enterpriseMerge } from '../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { differenceReason, rosterLegacyMember } from '../../../db/postgresql/roster-selection-tables'
import { importBatch } from '../../../db/postgresql/import-tables'
import { platformCollection } from '../../../db/postgresql/platform-tables'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { readPostgresFingerprintQueries, readPostgresFingerprintRelations } from '../../../layers/sme-roster/server/utils/postgres-platform-fingerprint'
import { createRosterImportHandler } from '../../../layers/sme-roster/server/utils/roster-import-route'
/**
 * RL-03 的**真实端到端**(写入 → 读回):
 *
 *   裁剪的真实平台响应(夹具)→ §8.3 载荷 → **真实 HTTP** preflight + commit
 *   → 落库断言 → 再用**只读接口**(`/api/platform/queries`、`/api/comparison`)读回来。
 *
 * 为什么要分两批(而不是一个 payload 一把梭):`enterprise_alias.source_ref_id` 与
 * `difference_reason.evidence_query_id` / `evidence_relation_id` 是**整数行 id**,而
 * `platform_query` / `platform_relation` 的 id 由写入侧在**本批事务内**生成 —— 客户端构造
 * 载荷时不可能预知(契约 §8.3 只给了 `sourceRefId: 7` 这种形状,没有自然键解析)。
 * 所以:① 先提 `platformQueries`;② 从只读接口读回真 id;③ 再提 `aliases` / `differences` /
 * `merges`,把自然键换成**已落库**的 id。两批走的是**同一个统一 API**,不是第二条写路径。
 *
 * Node HTTP 挂载实际路由，PostgreSQL 夹具独立于其他用例。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRosterImportClient } from '../../../layers/sme-roster/lib/roster-import-client'
import { classifyRawQuery } from '../../../layers/sme-roster/lib/platform'
import {
  buildPlatformWritePayload,
  type KnownEnterprise,
  type PlatformQueryInput,
  type QueryRef,
  type RelationRef,
} from '../../../layers/sme-roster/lib/platform/payload'
import type { PlatformQueriesResult } from '../../../layers/sme-roster/lib/platform/read'
import type { MergeLineage } from '../../../layers/sme-roster/server/utils/roster-import'

const dir = mkdtempSync(join(tmpdir(), 'spztx-platform-e2e-'))
let db: ReturnType<typeof usePostgresDirectoryDb>
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined

const TOKEN = 'e2e-platform-token'
const USCC = '91330211255994457P'
const OLD_NAME = '宁波上航测绘有限公司'
const NEW_NAME = '宁波上航测绘股份有限公司'
const QUERIED_AT = '2026-10-15T17:11:21.514Z'
const FAILED_AT = '2026-10-15T18:30:00.000Z'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '../../fixtures/platform', name), 'utf8')

// ---------------------------------------------------------------------------
// 场景数据:企业 7289(规范行,带统代)与 375(被并方,无统代),故意未合并
// ---------------------------------------------------------------------------

let canonical: number
let duplicate: number
let duplicateRecord: number
let duplicateEvent: number
let enterprises: KnownEnterprise[]

async function nativeQueryRows() {
  const ids = await db.select({ id: platformCollection.publicId }).from(platformCollection).orderBy(platformCollection.publicId)
  return [...(await readPostgresFingerprintQueries(db, ids.map(row => row.id))).values()].map(row => row.query)
}

async function nativeRelationRows() {
  const ids = await db.select({ id: platformCollection.publicId }).from(platformCollection).orderBy(platformCollection.publicId)
  return (await Promise.all(ids.map(row => readPostgresFingerprintRelations(db, row.id)))).flat()
}

/** 五个查询,含 rdjb=1/2 的 `no_record` 与一次会话过期的 `failed`。 */
const queries: PlatformQueryInput[] = [
  { interface: 'business_list', queryKey: USCC, rdjb: '1', queriedAt: QUERIED_AT, outcome: classifyRawQuery(fixture('business-list-rdjb1-empty.html'), { interface: 'business_list', rdjb: '1', queryKey: USCC }) },
  { interface: 'business_list', queryKey: USCC, rdjb: '2', queriedAt: QUERIED_AT, outcome: classifyRawQuery(fixture('business-list-rdjb2-empty.html'), { interface: 'business_list', rdjb: '2', queryKey: USCC }) },
  { interface: 'business_list', queryKey: USCC, rdjb: '3', queriedAt: QUERIED_AT, outcome: classifyRawQuery(fixture('business-list-rdjb3.html'), { interface: 'business_list', rdjb: '3', queryKey: USCC }) },
  { interface: 'apply_list', queryKey: USCC, rdjb: '', queriedAt: QUERIED_AT, outcome: classifyRawQuery(fixture('apply-list.json'), { interface: 'apply_list', queryKey: USCC }) },
  // 同一 (interface, queryKey, rdjb) 的**另一次**查询(时点不同)⇒ 独立一行,不覆盖上面那次。
  { interface: 'business_list', queryKey: USCC, rdjb: '3', queriedAt: FAILED_AT, outcome: classifyRawQuery(fixture('session-expired.json'), { interface: 'business_list', rdjb: '3', queryKey: USCC }) },
]

// ---------------------------------------------------------------------------
// 进程内真实 HTTP 服务:写路由 = RL-11 的 http 面;读路由 = 本票的两块路由模块
// ---------------------------------------------------------------------------

let server: ReturnType<typeof createServer>
let baseUrl: string
const json = async (path: string) => {
  const response = await fetch(baseUrl + path)
  expect(response.status, path + ' 应返回 200').toBe(200)
  return response.json()
}

beforeAll(async () => {
  postgres = await postgresRuntimeFixture({ dir })
  for (const [key, value] of Object.entries(postgres.env)) vi.stubEnv(key, value)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  for (const [key, value] of Object.entries({ defineEventHandler, getQuery, createError, getHeader, readBody, setHeader, setResponseStatus })) vi.stubGlobal(key, value)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: TOKEN, filesDir: dir, curatedPath: join(dir, 'no-curation.json') }))
  db = usePostgresDirectoryDb()

  const owners = await db.insert(enterprise).values([
    { name: NEW_NAME, nameNorm: NEW_NAME, usccNorm: USCC, district: '镇海区' },
    { name: OLD_NAME, nameNorm: OLD_NAME, district: '镇海区' },
  ]).returning({ id: enterprise.id })
  canonical = owners[0]!.id
  duplicate = owners[1]!.id
  await db.insert(rosterLegacyMember).values([{ enterpriseId: canonical }, { enterpriseId: duplicate }])
  const records = await db.insert(record).values([
    { enterpriseId: canonical, source: 'miit', titleCode: 'specialized_sme', district: '镇海区' },
    { enterpriseId: canonical, source: 'miit', titleCode: 'innovative_sme', district: '镇海区' },
    { enterpriseId: duplicate, source: 'jxj', titleCode: 'specialized_sme', district: '镇海区' },
  ]).returning({ id: record.id })
  duplicateRecord = records[2]!.id
  const [event] = await db.insert(recordEvent).values({ recordId: duplicateRecord, eventType: 'award', year: 2022, sortKey: 2022, batchSeq: 1 }).returning({ id: recordEvent.id })
  duplicateEvent = event!.id
  await db.insert(recordEvidence).values({
    recordEventId: duplicateEvent, sourceFile: 'jxj/announcement/2022/甬经信中小〔2022〕145号.pdf',
    attachment: '附件', listNo: 74, page: 74,
  })
  enterprises = [
    { id: duplicate, name: OLD_NAME, nameNorm: OLD_NAME, uscc: null },
    { id: canonical, name: NEW_NAME, nameNorm: NEW_NAME, uscc: USCC },
  ]

  const queriesRoute = (await import('../../../layers/sme-roster/server/api/platform/queries.get')).default
  const comparisonRoute = (await import('../../../layers/sme-roster/server/api/comparison.get')).default
  const enterprisesRoute = (await import('../../../layers/sme-roster/server/api/roster/enterprises.get')).default
  const router = createRouter()
    .get('/api/platform/queries', queriesRoute)
    .get('/api/comparison', comparisonRoute)
    .get('/api/roster/enterprises', enterprisesRoute)
    .post('/api/roster/import/preflight', createRosterImportHandler('preflight'))
    .post('/api/roster/import/commit', createRosterImportHandler('commit'))
  server = createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
}, 30_000)

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await closeApplicationLogging()
  await closePostgresDirectoryDb()
  postgres?.close()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const client = () => createRosterImportClient({ baseUrl, token: TOKEN })

// ---------------------------------------------------------------------------
// 第一批:平台查询与逐条关系
// ---------------------------------------------------------------------------

describe('第一批 · 平台查询与关系经统一 API 落库', () => {
  let commitResult: { status: string; summary: { written: number } }

  it('preflight 只算影响、不落业务数据', async () => {
    const request = buildPlatformWritePayload({ sourceIdentity: 'platform/91330211255994457P.json', queries, enterprises })
    const pre = await client().preflight(request)
    expect(pre.status).toBe('preflight')
    expect(pre.preflight.add).toBeGreaterThan(0)
    expect(await nativeQueryRows()).toHaveLength(0)
  })

  it('commit 落 5 次查询与 8 条关系', async () => {
    const request = buildPlatformWritePayload({ sourceIdentity: 'platform/91330211255994457P.json', queries, enterprises })
    commitResult = (await client().commitCommand(request)) as unknown as typeof commitResult
    expect(commitResult.status).toBe('committed')
    expect(commitResult.summary.written).toBeGreaterThan(0)
  })

  it('platform_query:五次查询各自成行,四态按实际(含 rdjb=1/2 的 no_record 与一次 failed)', async () => {
    const rows = (await nativeQueryRows()).filter((q) => q.queryKey === USCC)
    expect(rows).toHaveLength(5)
    const byQueryStatus = rows.map((q) => `${q.interface}|${q.rdjb}|${q.status}`).sort()
    expect(byQueryStatus).toEqual([
      'apply_list||success',
      'business_list|1|no_record',
      'business_list|2|no_record',
      'business_list|3|failed',
      'business_list|3|success',
    ])
    const failed = rows.find((q) => q.status === 'failed')!
    expect(failed.failureReason).toContain('登录超时')
    // 失败那次没有关系行 —— 失败 ≠ 无记录,但也不冒充有记录。
    expect((await nativeRelationRows()).filter((r) => r.queryId === failed.id)).toEqual([])
  })

  it('platform_relation:rdjb=3 的 6 条逐条保留(序号 1–6、原序、不按 id 去重)', async () => {
    const rows = (await nativeQueryRows())
    const success3 = rows.find((q) => q.rdjb === '3' && q.status === 'success')!
    const relations = (await nativeRelationRows())
      .filter((r) => r.queryId === success3.id)
      .sort((a, b) => a.sequenceNo - b.sequenceNo)
    expect(relations.map((r) => r.sequenceNo)).toEqual([1, 2, 3, 4, 5, 6])
    expect(relations.map((r) => r.relationKey)).toEqual([
      'SQ332022062212391',
      'SQ332023041984270',
      'SQ332024052128274',
      'SQ332025060392166',
      'SQ332025062064737',
      'SQ332026052238796',
    ])
    // 前两条写的是**经信局公布名**(曾用名证据),后四条是现名。
    expect(relations.slice(0, 2).every((r) => r.nameRaw === OLD_NAME)).toBe(true)
    expect(relations.slice(2).every((r) => r.nameRaw === NEW_NAME)).toBe(true)
    // 同 USCC 的 8 条关系全在:两个接口各有 SQ332025060392166 / SQ332022062212391,
    // **不按 relation_key 去重**(同一份记录在两个接口各出一次)。
    const allRelations = (await nativeRelationRows())
      .filter((r) => rows.some((q) => q.id === r.queryId && q.queryKey === USCC))
    expect(allRelations).toHaveLength(8)
    expect(allRelations.filter((r) => r.relationKey === 'SQ332022062212391')).toHaveLength(2)
  })

  it('守护 C1:alias_name_raw 全为 null,平台关系不伪造曾用名列', async () => {
    for (const relation of (await nativeRelationRows())) {
      expect(relation.aliasNameRaw).toBeNull()
    }
  })

  it('匹配依据是统代:关系归到规范行(统代命中),verification_status=confirmed', async () => {
    const success3 = (await nativeQueryRows()).find((q) => q.rdjb === '3' && q.status === 'success')!
    const relations = (await nativeRelationRows()).filter((r) => r.queryId === success3.id)
    for (const relation of relations) {
      expect(relation.enterpriseId).toBe(canonical)
      expect(relation.matchBasis).toBe('uscc')
      expect(relation.verificationStatus).toBe('confirmed')
    }
  })

  it('读回:GET /api/platform/queries 能查到这五次查询与全部关系(§7.6)', async () => {
    const result = (await json(`/api/platform/queries?queryKey=${USCC}&pageSize=50`)) as unknown as PlatformQueriesResult
    expect(result.total).toBe(5)
    expect(result.counts.success).toBe(2)
    expect(result.counts.no_record).toBe(2)
    expect(result.counts.failed).toBe(1)
    const success3 = result.rows.find((row) => row.query.rdjb === '3' && row.query.status === 'success')!
    expect(success3.relations).toHaveLength(6)
    expect(success3.relations.map((r) => r.sequenceNo)).toEqual([1, 2, 3, 4, 5, 6])
    // 只读接口把「旧名那条关系」原样带出,并标出它匹配到的企业(现名)。
    const oldName = success3.relations.filter((r) => r.nameRaw === OLD_NAME)
    expect(oldName).toHaveLength(2)
    expect(oldName[0]!.matchedName).toBe(NEW_NAME)
  })
})

// ---------------------------------------------------------------------------
// 第二批:曾用名 + 差异处置 + 归并(用读回的**真 id** 指认证据)
// ---------------------------------------------------------------------------

describe('第二批 · 曾用名、已核验处置与归并', () => {
  /** 自然键 → 已落库行 id(从只读接口读回,不是猜的)。 */
  let relationIds: Map<string, number>
  let queryIds: Map<string, number>

  const relationKeyOf = (ref: RelationRef) => `${ref.interface}|${ref.queryKey}|${ref.rdjb}|${ref.sequenceNo}`

  beforeAll(async () => {
    const result = (await json(`/api/platform/queries?queryKey=${USCC}&pageSize=50`)) as unknown as PlatformQueriesResult
    relationIds = new Map()
    queryIds = new Map()
    for (const row of result.rows) {
      queryIds.set(`${row.query.interface}|${row.query.queryKey}|${row.query.rdjb}`, row.query.id)
      for (const relation of row.relations) {
        relationIds.set(
          `${row.query.interface}|${row.query.queryKey}|${row.query.rdjb}|${relation.sequenceNo}`,
          relation.id,
        )
      }
    }
    expect(relationIds.size).toBe(8)
  })

  const refs = {
    relationIdOf: (ref: RelationRef) => relationIds.get(relationKeyOf(ref)) ?? null,
    queryIdOf: (ref: QueryRef) =>
      queryIds.get(`${ref.interface}|${ref.queryKey}|${ref.rdjb}`) ?? null,
  }

  /**
   * 第二批请求**只构造一次**,提交与重放共用 —— 幂等键由**载荷内容**派生,
   * 重新构造时只要载荷一致,键就一致(这正是「重放不重复写」的前提)。
   */
  let request: ReturnType<typeof buildPlatformWritePayload>

  beforeAll(() => {
    request = buildPlatformWritePayload({
      sourceIdentity: 'platform/91330211255994457P.json',
      // 同来源、不同内容 ⇒ 另一个幂等键(不会与第一批互相顶掉)。
      queries: [],
      enterprises,
      aliases: [
        {
          enterpriseId: canonical,
          name: OLD_NAME,
          sourceKind: 'platform_business',
          sourceRelation: { queryKey: USCC, interface: 'business_list', rdjb: '3', sequenceNo: 1 },
          validFrom: '2022-06-22 17:17:52',
          note: '平台关系 SQ332022062212391 / SQ332023041984270 明确写出',
        },
      ],
      differences: [
        {
          enterpriseId: canonical,
          titleCode: 'specialized_sme',
          direction: 'extra_in_miit',
          status: 'confirmed_reason',
          reasonCode: 'renamed',
          reasonNote: '平台关系写出的历史名称与经信局公布名不一致,确认系更名',
          measureCode: 'update_current_name',
          measureNote: '旧名保留为曾用名,现名与曾用名都可查',
          evidenceQuery: { interface: 'business_list', queryKey: USCC, rdjb: '3' },
          evidenceRelation: { queryKey: USCC, interface: 'business_list', rdjb: '3', sequenceNo: 1 },
          verificationStatus: 'confirmed',
          recordedAt: '2026-10-16T00:00:00.000Z',
        },
        {
          enterpriseId: canonical,
          titleCode: 'innovative_sme',
          direction: 'extra_in_miit',
          status: 'confirmed_reason',
          reasonCode: 'platform_stale',
          measureCode: 'mark_platform_snapshot',
          evidenceQuery: { interface: 'business_list', queryKey: USCC, rdjb: '1' },
          verificationStatus: 'confirmed',
          recordedAt: '2026-10-16T00:00:00.000Z',
        },
      ],
      merges: [
        {
          fromEnterpriseId: duplicate,
          intoUscc: USCC,
          aliasName: OLD_NAME,
          sourceKind: 'platform_business',
          sourceRelation: { queryKey: USCC, interface: 'business_list', rdjb: '3', sequenceNo: 1 },
          evidenceQuery: { interface: 'business_list', queryKey: USCC, rdjb: '3' },
          note: 'businessList rdjb=3 的 qymc 差异行',
        },
      ],
      refs,
    })
  })

  it('commit 第二批:代理确认的曾用名 + 差异原因/措施 + 归并', async () => {
    const pre = await client().preflight(request)
    expect(pre.preflight.conflicts).toEqual([])
    const committed = await client().commitCommand(request)
    expect(committed.status).toBe('committed')
    expect(committed.summary.failed).toBe(0)
  })

  it('enterprise_alias:旧名写成 confirmed,来源指向真实的 platform_relation 行', async () => {
    const alias = (await db.select().from(enterpriseAlias)).find((a) => a.enterpriseId === canonical && a.name === OLD_NAME)!
    expect(alias.verificationStatus).toBe('confirmed')
    expect(alias.sourceKind).toBe('platform_business')
    expect(alias.validFrom).toBe('2022-06-22 17:17:52')
    // 来源证据 = rdjb=3 的第 1 条关系(读回的真 id),不是 0 哨兵、不是猜的。
    const relation = (await nativeRelationRows()).find((r) => r.id === alias.sourceRefId)!
    expect(relation.sequenceNo).toBe(1)
    expect(relation.nameRaw).toBe(OLD_NAME)
    expect(alias.sourceRefId).toBe(relationIds.get(`business_list|${USCC}|3|1`))
  })

  it('difference_reason:原因与措施成对,并带查询/关系证据', async () => {
    const reasons = (await db.select().from(differenceReason)).filter((d) => d.enterpriseId === canonical)
    const renamed = reasons.find((d) => d.reasonCode === 'renamed')!
    expect(renamed.measureCode).toBe('update_current_name')
    expect(renamed.measureNote).toContain('曾用名')
    expect(renamed.status).toBe('confirmed_reason')
    expect(renamed.verificationStatus).toBe('confirmed')
    expect(renamed.evidenceQueryId).toBe(queryIds.get(`business_list|${USCC}|3`))
    expect(renamed.evidenceRelationId).toBe(relationIds.get(`business_list|${USCC}|3|1`))
    const stale = reasons.find((d) => d.reasonCode === 'platform_stale')!
    expect(stale.measureCode).toBe('mark_platform_snapshot')
    expect(stale.recordedAt).toBe('2026-10-16T00:00:00.000Z')
  })

  it('merges:375 与 7289 归并为一行,公布历史(事件 + 出处含页码)一条不丢', async () => {
    const names = (await db.select().from(enterprise)).filter((e) => e.name === OLD_NAME || e.name === NEW_NAME)
    expect(names).toHaveLength(2)
    expect((await db.select().from(enterpriseMerge))).toEqual(expect.arrayContaining([expect.objectContaining({intoEnterpriseId:canonical})]))
    expect(names.find(e=>e.usccNorm===USCC)!.id).toBe(canonical)
    expect(names.find(e=>e.id===canonical)!.usccNorm).toBe(USCC)
    // 被并企业的记录已改指规范行;事件与出处随之归入,页 74 还在。
    const moved = (await db.select().from(record)).find((r) => r.id === duplicateRecord)!
    expect(moved.enterpriseId).toBe(canonical)
    const movedEvent = (await db.select().from(recordEvent)).find((e) => e.id === duplicateEvent)!
    expect(movedEvent.recordId).toBe(duplicateRecord)
    const evidence = (await db.select().from(recordEvidence)).find((v) => v.recordEventId === duplicateEvent)!
    expect(evidence.page).toBe(74)
    expect(evidence.listNo).toBe(74)
  })

  it('按现名或曾用名搜索都命中同一家企业', async () => {
    for (const name of [NEW_NAME, OLD_NAME]) {
      const result = await json('/api/roster/enterprises?q=' + encodeURIComponent(name))
      expect(result.rows.map((row: { enterpriseId: number }) => row.enterpriseId)).toEqual([canonical])
    }
  })

  it('归并血缘可在 import_batch.item_results 里查回(父代理裁决 #4)', async () => {
    const [batch] = await db.select({ items: importBatch.itemResults }).from(importBatch)
      .where(eq(importBatch.idempotencyKey, request.idempotencyKey))
    const items = JSON.parse(batch!.items!) as { kind: string; detail?: { lineage?: MergeLineage } }[]
    const lineage = items.find(item => item.kind === 'merge')?.detail?.lineage!
    expect(lineage).toBeTruthy()
    expect(lineage.fromEnterpriseName).toBe(OLD_NAME)
    expect(lineage.intoEnterpriseId).toBe(canonical)
    expect(lineage.intoUscc).toBe(USCC)
    // 事件与出处**一条都没删**,随记录归入规范行(契约 §5.2 第 3–4 步)。
    expect(lineage.recordsMoved).toContain(duplicateRecord)
    expect(lineage.eventsMoved).toContain(duplicateEvent)
    expect(lineage.childRowsMoved.records).toBe(1)
    // 归并血缘也确实落在批次行里(可查询,不只在内存)。
    const text = batch!.items!
    expect(text).toContain(`merge:${duplicate}->${canonical}`)
    expect(text).toContain('"eventsMoved"')
  })

  it('读回:GET /api/comparison 带出曾用名与已核验处置(§7.6 / 交付物 3)', async () => {
    const result = (await json('/api/comparison?title=innovative_sme&direction=extra_in_miit&pageSize=50')) as unknown as {
      rows: { enterpriseId: number; platform: { aliases: { name: string; verificationStatus: string }[]; disposition: { reasonCode: string; measureCode: string } | null; relationCount: number } | null }[]
      platform: { withEvidence: number }
    }
    const row = result.rows.find((r) => r.enterpriseId === canonical)!
    expect(row).toBeTruthy()
    expect(row.platform!.aliases.map((a) => `${a.name}:${a.verificationStatus}`)).toContain(`${OLD_NAME}:confirmed`)
    expect(row.platform!.disposition).toMatchObject({ reasonCode: 'platform_stale', measureCode: 'mark_platform_snapshot' })
    expect(row.platform!.relationCount).toBe(8)
  })

  it('读回:GET /api/platform/queries?enterpriseId= 能列出该企业的全部关系', async () => {
    const result = (await json(`/api/platform/queries?enterpriseId=${canonical}&pageSize=50`)) as unknown as PlatformQueriesResult
    expect(result.pageSize).toBe(50)
    const relations = result.rows.flatMap((row) => row.relations)
    expect(relations).toHaveLength(8)
    expect(relations.filter((r) => r.nameRaw === OLD_NAME)).toHaveLength(3)
  })

  it('重放第二批(同幂等键)不重复写:别名、差异、归并都不再新增', async () => {
    const before = {
      aliases: (await db.select().from(enterpriseAlias)).length,
      differences: (await db.select().from(differenceReason)).length,
      batches: (await db.select().from(importBatch)).length,
    }
    const replay = await client().commitCommand(request)
    expect(replay.status).toBe('committed')
    expect((await db.select().from(enterpriseAlias)).length).toBe(before.aliases)
    expect((await db.select().from(differenceReason)).length).toBe(before.differences)
    expect((await db.select().from(importBatch)).length).toBe(before.batches)
    // 企业也没因为重放又冒出来。
    expect((await db.select().from(enterprise)).filter((e) => e.name === OLD_NAME)).toHaveLength(1)
  })
})
