/**
 * RL-11 —— 名录统一写入 API 的验收（契约 §8 写接口 / §9 MCP tool）。
 *
 * 分四层：
 *  1. **核心逻辑**（`server/utils/roster-import.ts`）：预检不写业务数据、单批事务、
 *     逐项错误、幂等重放、七张新表覆盖、归并血缘可查回；
 *  2. **真实 HTTP 契约**（`tests/helpers/roster-http-server.ts` 起真端口 + `lib/roster-import-client.ts`
 *     发真请求）：鉴权四态、预检 → 提交 → 重放 → 失败恢复 → 完整性；
 *  3. **MCP 面**：写入 tool 名单（`MCP_WRITE_TOOLS`）与四个 tool 的注册/参数面；
 *  4. **读面**：`list_enterprises` / `list_differences` 的落点（`server/utils/mcp-roster.ts`）。
 *
 * 验收要求「不以直接数据库写入代替 API 验收」—— 所以端到端一律走 HTTP，只有
 * 夹具造数（企业/记录/事件）用 drizzle 直插（那是**输入**，不是被测行为）。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { schema, useDb } from '../db'
import { normalizeName } from '../lib/domain'
import { getRosterEnterpriseDetail } from '../lib/roster/enterprise-roster'
import {
  RosterImportApiError,
  createRosterImportClient,
  type RosterImportRequest,
} from '../lib/roster-import-client'
import {
  commitRosterImport,
  enterpriseExists,
  preflightRosterImport,
  readImportBatchOutcome,
  readMergeLineage,
  rosterRowCounts,
  searchEnterpriseIdsByName,
  validateImportRequest,
} from '../server/utils/roster-import'
import { MCP_WRITE_TOOLS } from '../server/utils/mcp-auth'
import { listDifferences, listEnterprises } from '../server/utils/mcp-roster'
import { startRosterApi } from './helpers/roster-http-server'

const TOKEN = 'test-api-token-value'
const dirs: string[] = []

/** 每个用例一个**全新临时库**（互不干扰；`useDb` 按路径缓存）。 */
function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'spztx-roster-'))
  dirs.push(dir)
  return useDb({ dbPath: join(dir, 'roster.db') })
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 一份「公布文件」批次的载荷：一个企业 × 一个称号 × 一条复核事件 + 一条出处。 */
function announcementRequest(over: Partial<RosterImportRequest> = {}): RosterImportRequest {
  return {
    idempotencyKey: over.idempotencyKey ?? 'jxj/省专/2024/192号#sha256:abc',
    sourceKind: 'announcement',
    sourceIdentity: 'jxj/announcement/2024/2/甬经信中小〔2024〕192号.pdf',
    sourceSha256: 'abc',
    payload: {
      announcement: {
        sourceDocument: { source: 'jxj', title: '关于公布专精特新中小企业名单的通知', docNumber: '甬经信中小〔2024〕192号' },
        records: [
          {
            enterprise: { name: '宁波上航测绘股份有限公司', uscc: '91330211255994457P' },
            titleCode: 'specialized_sme',
            events: [
              {
                eventType: 'review',
                year: 2021,
                batchSeq: 2,
                decidedYear: 2024,
                reviewOutcome: 'failed',
                evidence: [
                  { sourceFile: 'jxj/announcement/2024/2/甬经信中小〔2024〕192号.pdf', attachment: '附件2', listNo: 3, page: 7 },
                ],
              },
            ],
          },
        ],
      },
    },
    ...over,
  }
}

function seedEnterprise(
  db: ReturnType<typeof makeDb>,
  input: { name: string; uscc?: string | null; district?: string | null },
) {
  return db
    .insert(schema.enterprise)
    .values({
      name: input.name,
      nameNorm: normalizeName(input.name),
      usccNorm: input.uscc ?? null,
      district: input.district ?? null,
      qualityFlags: input.uscc ? [] : ['uscc_missing'],
    })
    .returning({ id: schema.enterprise.id })
    .get().id
}

function seedRecord(
  db: ReturnType<typeof makeDb>,
  enterpriseId: number,
  titleCode: string,
  source: 'jxj' | 'miit',
) {
  return db
    .insert(schema.record)
    .values({ enterpriseId, titleCode, source })
    .returning({ id: schema.record.id })
    .get().id
}

function seedEvent(
  db: ReturnType<typeof makeDb>,
  recordId: number,
  eventType: 'award' | 'review' | 'maintain' | 'nurture',
  year: number,
  batchSeq?: number,
) {
  return db
    .insert(schema.recordEvent)
    .values({ recordId, eventType, year, batchSeq, sortKey: year })
    .returning({ id: schema.recordEvent.id })
    .get().id
}

// ---------------------------------------------------------------------------
// 1. 请求校验 + 预检不写业务数据
// ---------------------------------------------------------------------------

describe('请求校验', () => {
  it('缺幂等键 / 来源类别 / 来源身份 / payload 分别报错', () => {
    const base = { idempotencyKey: 'k', sourceKind: 'announcement', sourceIdentity: 'p', payload: {} }
    expect(validateImportRequest(null).ok).toBe(false)
    expect(validateImportRequest({ ...base, idempotencyKey: '' })).toMatchObject({ ok: false, status: 400 })
    expect(validateImportRequest({ ...base, sourceKind: 'nope' }).ok).toBe(false)
    expect(validateImportRequest({ ...base, sourceIdentity: '  ' }).ok).toBe(false)
    expect(validateImportRequest({ ...base, payload: undefined }).ok).toBe(false)
    expect(validateImportRequest(base).ok).toBe(true)
  })
})

describe('预检：只算影响，不写业务数据', () => {
  it('落一条 status=preflight 的批次，行数一行不变', () => {
    const db = makeDb()
    const before = rosterRowCounts(db)
    const result = preflightRosterImport(db, announcementRequest())

    expect(result.status).toBe('preflight')
    expect(result.preflight.add).toBeGreaterThan(0)
    // 业务数据一行未写。
    expect(rosterRowCounts(db)).toEqual(before)
    // 批次行落了，且状态是 preflight。
    const batch = db.select().from(schema.importBatch).all().find((b) => b.id === result.batchId)!
    expect(batch.status).toBe('preflight')
    expect(batch.preflightResult).toMatchObject({ add: result.preflight.add })
  })

  it('同一幂等键重复预检：同一批次，不新增批次行', () => {
    const db = makeDb()
    const a = preflightRosterImport(db, announcementRequest())
    const b = preflightRosterImport(db, announcementRequest())
    expect(b.batchId).toBe(a.batchId)
    expect(db.select().from(schema.importBatch).all()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 2. 提交：覆盖七张新表 + 完整性
// ---------------------------------------------------------------------------

describe('提交：一次写入企业/事件/出处/别名/平台证据/快照/差异', () => {
  const request: RosterImportRequest = {
    idempotencyKey: 'all-in-one#sha256:def',
    sourceKind: 'announcement',
    sourceIdentity: 'jxj/announcement/2026/1/全量.pdf',
    payload: {
      announcement: {
        sourceDocument: { source: 'jxj', title: '全量表', docNumber: '甬经信中小〔2026〕1号' },
        records: [
          {
            enterprise: { name: '甲企业有限公司', uscc: '913302110000000001' },
            titleCode: 'specialized_sme',
            events: [
              {
                eventType: 'award',
                year: 2021,
                batchSeq: 1,
                evidence: [{ sourceFile: 'jxj/announcement/2021/1/145号.pdf', attachment: '附件', listNo: 74, page: 74 }],
              },
              { eventType: 'review', year: 2021, batchSeq: 2, decidedYear: 2024, reviewOutcome: 'failed' },
            ],
          },
          // ★ 未匹配任何平台导出的公布名单条目 —— 仍必须入库（完整性）。
          { enterprise: { name: '仅公布未匹配企业' }, titleCode: 'innovative_sme', events: [{ eventType: 'award', year: 2026, batchSeq: 1 }] },
        ],
      },
      aliases: [
        { enterpriseName: '甲企业有限公司', name: '甲企业旧名有限公司', sourceKind: 'platform_business', sourceRefId: 7, verificationStatus: 'confirmed' },
        { enterpriseName: '甲企业有限公司', name: '疑似同名待核有限公司', sourceKind: 'platform_apply', verificationStatus: 'pending' },
      ],
      platformQueries: [
        {
          interface: 'business_list',
          queryKey: '913302110000000001',
          rdjb: '3',
          queriedAt: '2026-10-16T03:00:00.000Z',
          status: 'success',
          relations: [
            { sequenceNo: 1, relationKey: 'SQ1', usccRaw: '913302110000000001', nameRaw: '甲企业有限公司', matchBasis: 'uscc', verificationStatus: 'confirmed' },
            { sequenceNo: 2, relationKey: 'SQ2', usccRaw: '913302110000000001', nameRaw: '甲企业旧名有限公司', aliasNameRaw: '甲企业旧名有限公司', matchBasis: 'alias', verificationStatus: 'confirmed' },
            // 未知 sblx 取值：原样入库 + 标待核（不因未知取值崩溃）。
            { sequenceNo: 3, relationKey: 'SQ3', usccRaw: '913302110000000001', nameRaw: '甲企业有限公司', declareKind: '复核确认' },
          ],
        },
        { interface: 'business_list', queryKey: '913302110000000001', rdjb: '1', queriedAt: '2026-10-16T03:01:00.000Z', status: 'no_record' },
      ],
      exportSnapshot: {
        titleCode: 'specialized_sme',
        year: 2026,
        collectedOn: '2026-10-16',
        originalFilename: '专精特新中小企业导出Excel.xlsx',
        sha256: 'f'.repeat(64),
        rows: [
          { sourceRowNo: 1, usccRaw: '913302110000000001', nameRaw: '甲企业有限公司' },
          { sourceRowNo: 2, usccRaw: '91330211000000000X', nameRaw: '平台有的企业' },
        ],
      },
      differences: [
        {
          enterpriseName: '甲企业有限公司',
          titleCode: 'specialized_sme',
          direction: 'missing_in_miit',
          status: 'confirmed_reason',
          reasonCode: 'moved_out',
          measureCode: 'mark_moved_out',
          verificationStatus: 'confirmed',
          recordedAt: '2026-10-16T04:00:00.000Z',
        },
      ],
    },
  }

  it('整批 committed，七张表都落到，且逐项结果带真实 id', () => {
    const db = makeDb()
    const result = commitRosterImport(db, request)

    expect(result.status).toBe('committed')
    expect(result.error).toBeNull()
    expect(result.summary.written).toBeGreaterThan(0)
    expect(result.summary.failed).toBe(0)

    const counts = rosterRowCounts(db)
    expect(counts.source_document).toBe(1)
    expect(counts.enterprise).toBe(2) // 甲企业 + 仅公布未匹配企业
    expect(counts.record).toBe(2) // 两条 record（未匹配平台导出的那条**也在**）
    expect(counts.record_event).toBe(3) // award + review + 仅公布那条的 award
    expect(counts.record_evidence).toBe(1) // 附件 序号74 第74页
    expect(counts.enterprise_alias).toBe(2)
    expect(counts.platform_query).toBe(2)
    expect(counts.platform_relation).toBe(3) // 三条关联逐条保留，不按企业去重
    expect(counts.platform_export_batch).toBe(1)
    expect(counts.platform_export_row).toBe(2)
    expect(counts.difference_reason).toBe(1)

    // 完整性：未匹配平台导出的公布条目入库（不是被导出对照过滤掉）。
    const unmatched = db.select().from(schema.enterprise).all().find((e) => e.name === '仅公布未匹配企业')!
    expect(db.select().from(schema.record).all().filter((r) => r.enterpriseId === unmatched.id)).toHaveLength(1)

    // 出处保留页码（RL-10 的跳转依据）。
    expect(db.select().from(schema.recordEvidence).all()[0]!.page).toBe(74)

    // 未知 sblx 取值：原样入库 + 标待核。
    const unknown = db.select().from(schema.platformRelation).all().find((r) => r.relationKey === 'SQ3')!
    expect(unknown.declareKind).toBe('复核确认')
    expect(unknown.verificationStatus).toBe('pending')
    // 四态可区分：rdjb=1 那次是 no_record，不是 failed。
    const empty = db.select().from(schema.platformQuery).all().find((q) => q.rdjb === '1')!
    expect(empty.status).toBe('no_record')

    // 错误 → `failed` 的区分在别的用例里（本批没有不合法项）。
    expect(result.items.every((item) => item.ok)).toBe(true)
    expect(result.items.some((item) => item.kind === 'record_event' && item.ref.startsWith('record:'))).toBe(true)
  })

  it('往返一致性：用 import_batch.item_results / summary 查回写入结果', () => {
    const db = makeDb()
    commitRosterImport(db, request)
    const outcome = readImportBatchOutcome(db, request.idempotencyKey)!
    expect(outcome.status).toBe('committed')
    expect(outcome.summary!.written).toBeGreaterThan(0)
    expect(outcome.items!.some((i) => i.kind === 'platform_relation' || i.kind === 'alias')).toBe(true)
    expect(outcome.preflight!.add).toBeGreaterThan(0)
  })

  it('★ 幂等重放：同一键再提交，不再写企业/事件，返回既有摘要', () => {
    const db = makeDb()
    const first = commitRosterImport(db, request)
    const afterFirst = rosterRowCounts(db)

    const replay = commitRosterImport(db, request)
    expect(replay.batchId).toBe(first.batchId)
    expect(replay.status).toBe('committed')
    expect(replay.summary).toEqual(first.summary)
    // 一行都没多出来。
    expect(rosterRowCounts(db)).toEqual(afterFirst)
    expect(db.select().from(schema.importBatch).all()).toHaveLength(1)
  })

  it('★ 同内容换幂等键重放：`written` 反映**真实新增行数**(0)，不是「计划项数」', () => {
    const db = makeDb()
    const first = commitRosterImport(db, request)
    // 首跑确实写了东西（否则这条用例证明不了什么）。
    expect(first.summary.written).toBeGreaterThan(0)
    const afterFirst = rosterRowCounts(db)

    // 换一个幂等键 ⇒ 走的是**真正执行**的那条路（不是命中 `committed` 批次直接返回既有摘要），
    // 内容一模一样 ⇒ 每个计划项都只命中既有行，**一行都没写**。
    // RL-11 验收：「应用后可查询**已写入数量**」——此刻真实新增就是 0。
    const replay = commitRosterImport(db, { ...request, idempotencyKey: 'replay/same-content#sha256:abc' })
    expect(replay.batchId).not.toBe(first.batchId)
    expect(replay.status).toBe('committed')
    expect(replay.error).toBeNull()
    expect(replay.summary.written).toBe(0)
    // 业务数据与行数一行都没动。
    expect(rosterRowCounts(db)).toEqual(afterFirst)
    // 逐项明细同样如实：快照项不再把「批次里已有的行」算成本次新增。
    const snapshotItem = replay.items.find((i) => i.kind === 'export_batch')!
    expect(snapshotItem.detail!.rows).toEqual([])
    expect(snapshotItem.detail!.rowsWritten).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. 逐项错误 + 单批事务（绝不部分提交）
// ---------------------------------------------------------------------------

describe('逐项错误与单批事务', () => {
  const brokenRequest: RosterImportRequest = {
    idempotencyKey: 'broken#sha256:xyz',
    sourceKind: 'announcement',
    sourceIdentity: 'jxj/announcement/2026/1/坏行.pdf',
    payload: {
      announcement: {
        sourceDocument: { source: 'jxj', title: '坏行表' },
        records: [
          { enterprise: { name: '好企业', uscc: '913302110000000002' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2026 }] },
          // ★ 称号不在字典内 —— 逐项报错，不静默丢行；整批不落库。
          { enterprise: { name: '坏企业' }, titleCode: 'not_a_title', events: [{ eventType: 'award', year: 2026 }] },
        ],
      },
      differences: [
        // ★ `recordedAt` 是必填（时态化排序键）—— 这里故意给空串，触发 `recorded_at_required`。
        { enterpriseName: '好企业', titleCode: 'specialized_sme', direction: 'missing_in_miit', recordedAt: '' },
      ],
    },
  }

  it('任一项不合法 ⇒ 整批 failed，业务数据一行不落，错误逐项可读', () => {
    const db = makeDb()
    const before = rosterRowCounts(db)
    const result = commitRosterImport(db, brokenRequest)

    expect(result.status).toBe('failed')
    expect(result.error).toContain('未写入任何数据')
    expect(rosterRowCounts(db)).toEqual(before)

    const bad = result.items.find((i) => !i.ok)!
    expect(bad).toMatchObject({ ok: false, kind: 'record' })
    expect(bad.error!.code).toBe('title_unknown')
    expect(bad.error!.field).toBe('titleCode')
    expect(bad.error!.message).toContain('not_a_title')
    expect(result.items.some((i) => i.error?.code === 'recorded_at_required')).toBe(true)
    expect(result.summary).toMatchObject({ written: 0, failed: 2 })

    const batch = db.select().from(schema.importBatch).all().find((b) => b.id === result.batchId)!
    expect(batch.status).toBe('failed')
    expect(batch.error).toBeTruthy()
  })

  it('★ 失败恢复：修好载荷后以同一键重试，本批转为 committed', () => {
    const db = makeDb()
    const first = commitRosterImport(db, brokenRequest)
    expect(first.status).toBe('failed')

    const fixed: RosterImportRequest = {
      ...brokenRequest,
      payload: {
        announcement: {
          sourceDocument: { source: 'jxj', title: '坏行表' },
          records: [
            { enterprise: { name: '好企业', uscc: '913302110000000002' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2026 }] },
          ],
        },
        differences: [
          { enterpriseName: '好企业', titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'no_record', recordedAt: '2026-10-16T05:00:00.000Z' },
        ],
      },
    }
    const retry = commitRosterImport(db, fixed)
    expect(retry.batchId).toBe(first.batchId)
    expect(retry.status).toBe('committed')
    expect(retry.summary.written).toBeGreaterThan(0)
    expect(rosterRowCounts(db).record).toBe(1)
    expect(rosterRowCounts(db).difference_reason).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. 归并与回填（契约 §5.2 / 父代理裁决 #4：血缘可查回）
// ---------------------------------------------------------------------------

describe('归并与回填：血缘在 item_results 中可查询', () => {
  /** 造「回归案例」的合并前状态：375（无统代）vs 7289（统代 91330211255994457P）。 */
  function seedMergeCase(db: ReturnType<typeof makeDb>) {
    const canonical = seedEnterprise(db, { name: '宁波上航测绘股份有限公司', uscc: '91330211255994457P' })
    const duplicate = seedEnterprise(db, { name: '宁波上航测绘有限公司' })
    const dupRecord = seedRecord(db, duplicate, 'specialized_sme', 'jxj')
    const dupEvent = seedEvent(db, dupRecord, 'award', 2022, 2)
    const evidenceId = db
      .insert(schema.recordEvidence)
      .values({
        recordEventId: dupEvent,
        sourceFile: 'jxj/announcement/2022/甬经信中小〔2022〕145号.pdf',
        attachment: '附件',
        listNo: 74,
        page: 74,
      })
      .returning({ id: schema.recordEvidence.id })
      .get().id
    seedRecord(db, canonical, 'specialized_sme', 'miit')
    seedRecord(db, canonical, 'little_giant', 'miit')
    return { canonical, duplicate, dupRecord, dupEvent, evidenceId }
  }

  const mergeRequest = (
    fromEnterpriseId: number,
    key = 'merge/375->7289#sha256:m1',
    intoUscc = '91330211255994457P',
  ): RosterImportRequest => ({
    idempotencyKey: key,
    sourceKind: 'alias_evidence',
    sourceIdentity: `miit/relations/${intoUscc}`,
    payload: {
      merges: [
        {
          fromEnterpriseId,
          intoUscc,
          aliasName: '宁波上航测绘有限公司',
          sourceKind: 'platform_business',
          sourceRefId: 6,
          evidenceQueryId: null,
          note: 'businessList rdjb=3 的 qymc 差异行',
        },
      ],
    },
  })

  it('直接 UPDATE uscc_norm 会撞唯一键 —— 所以归并走 MERGE', () => {
    const db = makeDb()
    const { duplicate } = seedMergeCase(db)
    expect(() =>
      db
        .update(schema.enterprise)
        .set({ usccNorm: '91330211255994457P' })
        .where(eq(schema.enterprise.id, duplicate))
        .run(),
    ).toThrow()
  })

  it('★ 归并后：一行收齐全部称号/事件/出处；按现名与曾用名搜索命中同一企业', () => {
    const db = makeDb()
    const { canonical, duplicate, dupRecord, dupEvent, evidenceId } = seedMergeCase(db)

    const result = commitRosterImport(db, mergeRequest(duplicate))
    expect(result.status).toBe('committed')

    // 被并企业行已删除；称号、事件、出处**一条不丢**。
    expect(enterpriseExists(db, duplicate)).toBe(false)
    const titles = db.select().from(schema.record).all().filter((r) => r.enterpriseId === canonical).map((r) => `${r.titleCode}/${r.source}`).sort()
    expect(titles).toEqual(['little_giant/miit', 'specialized_sme/jxj', 'specialized_sme/miit'])
    const kept = db.select().from(schema.recordEvent).all().find((e) => e.id === dupEvent)!
    expect(kept.recordId).toBe(dupRecord) // 无同坐标冲突 ⇒ 记录本身改指规范行
    expect(kept.year).toBe(2022)
    expect(db.select().from(schema.recordEvidence).all().find((e) => e.id === evidenceId)!.page).toBe(74)

    // 按现名与曾用名搜索都命中同一企业；旧名不丢。
    expect(searchEnterpriseIdsByName(db, '宁波上航测绘股份有限公司')).toEqual([canonical])
    expect(searchEnterpriseIdsByName(db, '宁波上航测绘有限公司')).toEqual([canonical])
    const alias = db.select().from(schema.enterpriseAlias).all().find((a) => a.enterpriseId === canonical && a.name === '宁波上航测绘有限公司')!
    expect(alias.verificationStatus).toBe('confirmed')

    // ★ 父代理裁决 #4：血缘在 import_batch.item_results 中可查回。
    const lineage = readMergeLineage(db, mergeRequest(duplicate).idempotencyKey, duplicate)!
    expect(lineage.fromEnterpriseId).toBe(duplicate)
    expect(lineage.fromEnterpriseName).toBe('宁波上航测绘有限公司')
    expect(lineage.intoEnterpriseId).toBe(canonical)
    expect(lineage.intoUscc).toBe('91330211255994457P')
    expect(lineage.aliasId).toBe(alias.id)
    expect(lineage.recordsMoved).toContain(dupRecord)
    expect(lineage.eventsMoved).toContain(dupEvent)
    expect(lineage.evidenceMoved).toContain(evidenceId)
    expect(lineage.recordsFolded).toEqual([])

    // 同一份血缘也在提交响应的 item.detail 里（供调用方就地取）。
    const item = result.items.find((i) => i.kind === 'merge')!
    expect(item.ok).toBe(true)
    expect((item.detail!.lineage as { fromEnterpriseId: number }).fromEnterpriseId).toBe(duplicate)
  })

  it('★ 同 (企业,称号,来源) 冲突时：事件折到规范行那条记录，数量不减、一条不折叠', () => {
    const db = makeDb()
    const canonical = seedEnterprise(db, { name: '同名冲突甲', uscc: '913302110000000007' })
    const canonicalRecord = seedRecord(db, canonical, 'innovative_sme', 'jxj')
    seedEvent(db, canonicalRecord, 'award', 2019, 2)
    const duplicate = seedEnterprise(db, { name: '同名冲突乙' })
    const dupRecord = seedRecord(db, duplicate, 'innovative_sme', 'jxj')
    seedEvent(db, dupRecord, 'award', 2021, 1)

    const result = commitRosterImport(db, mergeRequest(duplicate, 'merge/conflict#sha256:m2', '913302110000000007'))
    expect(result.status).toBe('committed')

    const merged = db.select().from(schema.record).all().filter((r) => r.enterpriseId === canonical && r.titleCode === 'innovative_sme')
    expect(merged).toHaveLength(1)
    const events = db.select().from(schema.recordEvent).all().filter((e) => e.recordId === merged[0]!.id)
    expect(events.map((e) => e.year).sort()).toEqual([2019, 2021])

    const lineage = readMergeLineage(db, 'merge/conflict#sha256:m2', duplicate)!
    expect(lineage.recordsFolded).toEqual([{ fromRecordId: dupRecord, intoRecordId: canonicalRecord }])
    expect(lineage.eventsMoved).toHaveLength(1)
  })

  it('目标 / 来源缺失逐项报错，且整批不落库', () => {
    const db = makeDb()
    const before = rosterRowCounts(db)
    const result = commitRosterImport(db, mergeRequest(999999, 'merge/missing#sha256:m3'))
    expect(result.status).toBe('failed')
    expect(result.items[0]!.error!.code).toBe('merge_source_not_found')
    expect(rosterRowCounts(db)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// 5. 真实 HTTP 契约（真端口 + 真客户端）
// ---------------------------------------------------------------------------

describe('真实 HTTP：鉴权', () => {
  it('未配 token ⇒ 写入整体关闭（401），即便带了 token', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: '' })
    try {
      const response = await fetch(`${server.baseUrl}/api/roster/import/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(announcementRequest()),
      })
      expect(response.status).toBe(401)
      expect((await response.json()) as { reason: string }).toMatchObject({ reason: 'no-token-configured' })
    } finally {
      await server.close()
    }
  })

  it('未带 token / token 错误 ⇒ 401，且**不写任何数据**', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    try {
      const missing = await fetch(`${server.baseUrl}/api/roster/import/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(announcementRequest()),
      })
      expect(missing.status).toBe(401)
      expect(missing.headers.get('www-authenticate')).toContain('Bearer')

      const wrong = await fetch(`${server.baseUrl}/api/roster/import/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-token': 'nope' },
        body: JSON.stringify(announcementRequest()),
      })
      expect(wrong.status).toBe(401)
      expect(rosterRowCounts(db).enterprise).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('请求体不合法 ⇒ 400；路径不对 ⇒ 404', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    try {
      const bad = await fetch(`${server.baseUrl}/api/roster/import/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ idempotencyKey: 'k' }),
      })
      expect(bad.status).toBe(400)
      const notFound = await fetch(`${server.baseUrl}/api/other`)
      expect(notFound.status).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('★ 方法不对 ⇒ 405 由**核心自己**给出(夹具不替它拦成 404)', async () => {
    // 夹具按**路径**分发、不看方法,方法守卫留给 `handleRosterImportRequest`
    // (`tests/helpers/http-fixture.ts` 的路由规则)。若夹具改成按方法分发,这条会变 404
    // —— 那等于把核心的方法守卫从真 HTTP 面上悄悄摘掉。
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    try {
      const got = await fetch(`${server.baseUrl}/api/roster/import/commit`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(got.status).toBe(405)
      expect(rosterRowCounts(db).enterprise).toBe(0)
    } finally {
      await server.close()
    }
  })
})

describe('真实 HTTP：预检 → 提交 → 重放 → 失败恢复 → 完整性', () => {
  it('客户端走完整个回放序列，结果与直接调核心逻辑一致', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const request = announcementRequest({ idempotencyKey: 'http/replay#sha256:abc' })

    try {
      // 1. 预检：只算影响，不写业务数据。
      const preflight = await client.preflight(request)
      expect(preflight.status).toBe('preflight')
      expect(preflight.preflight.add).toBeGreaterThan(0)
      expect(rosterRowCounts(db).enterprise).toBe(0)

      // 2. 提交。
      const committed = await client.commit(request)
      expect(committed.status).toBe('committed')
      expect(committed.summary.failed).toBe(0)
      const after = rosterRowCounts(db)
      expect(after.enterprise).toBe(1)
      expect(after.record).toBe(1)
      expect(after.record_event).toBe(1)
      expect(after.record_evidence).toBe(1)

      // 3. 重放同一来源：同一批次、同一摘要、零新增。
      const replay = await client.commit(request)
      expect(replay.batchId).toBe(committed.batchId)
      expect(replay.summary).toEqual(committed.summary)
      expect(rosterRowCounts(db)).toEqual(after)

      // 4. 失败恢复：坏载荷 → failed（一行不写）；修好后以同一键重试 → committed。
      const broken = announcementRequest({ idempotencyKey: 'http/recover#sha256:abc' })
      ;(broken.payload.announcement!.records[0] as { titleCode: string }).titleCode = 'nope'
      const failed = await client.commit(broken)
      expect(failed.status).toBe('failed')
      expect(failed.items.some((i) => i.error?.code === 'title_unknown')).toBe(true)
      expect(rosterRowCounts(db)).toEqual(after)

      const fixed = announcementRequest({ idempotencyKey: 'http/recover#sha256:abc' })
      fixed.payload.announcement!.records[0]!.events = [{ eventType: 'award', year: 2026, batchSeq: 1 }]
      const recovered = await client.commit(fixed)
      expect(recovered.status).toBe('committed')
      expect(recovered.batchId).toBe(failed.batchId)
      // 同一 record 上：复核(replay 批) + 认定(recover 批)—— 事件一条不丢。
      expect(rosterRowCounts(db).record_event).toBe(2)

      // 5. 完整性：未匹配平台导出的公布条目也在（走同一批的第二条记录）。
      const complete = announcementRequest({ idempotencyKey: 'http/complete#sha256:abc' })
      complete.payload.announcement!.records.push({
        enterprise: { name: '未匹配平台导出的企业' },
        titleCode: 'innovative_sme',
        events: [{ eventType: 'award', year: 2026, batchSeq: 1 }],
      })
      complete.payload.platformQueries = [
        {
          interface: 'business_list',
          queryKey: '9133021100000000ZZ',
          rdjb: '3',
          queriedAt: '2026-10-16T06:00:00.000Z',
          status: 'success',
          relations: [{ sequenceNo: 1, usccRaw: '9133021100000000ZZ', nameRaw: '平台有的另一家', matchBasis: 'none' }],
        },
      ]
      const done = await client.commit(complete)
      expect(done.status).toBe('committed')
      const names = db.select().from(schema.enterprise).all().map((e) => e.name)
      expect(names).toContain('未匹配平台导出的企业')
      // 平台关系归属不到企业时留空待核（不模糊推断）。
      const unbound = db.select().from(schema.platformRelation).all().find((r) => r.usccRaw === '9133021100000000ZZ')!
      expect(unbound.enterpriseId).toBeNull()
      expect(unbound.verificationStatus).toBe('pending')
    } finally {
      await server.close()
    }
  })

  it('统一导入 API 对 DOCX / Excel 出处忽略 page，PDF 页码仍持久化', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    const request = announcementRequest({ idempotencyKey: 'http/stable-evidence-pages#sha256:abc' })
    request.payload.announcement!.records[0]!.events![0]!.evidence = [
      { sourceFile: 'synthetic/notice.pdf', attachment: '附件', listNo: 1, page: 7 },
      { sourceFile: 'synthetic/notice.docx', attachment: '正文', listNo: 2, page: 12 },
      { sourceFile: 'synthetic/export.xlsx', attachment: 'Sheet1', listNo: 3, page: 13 },
    ]

    try {
      const committed = await client.commit(request)
      expect(committed.status).toBe('committed')

      const enterprise = db
        .select()
        .from(schema.enterprise)
        .where(eq(schema.enterprise.name, '宁波上航测绘股份有限公司'))
        .get()!
      const evidence = getRosterEnterpriseDetail(db, enterprise.id)!.evidence
      const pageBySource = Object.fromEntries(evidence.map((entry) => [entry.sourceFile, entry.page]))
      expect(pageBySource).toEqual({
        'synthetic/notice.pdf': 7,
        'synthetic/notice.docx': null,
        'synthetic/export.xlsx': null,
      })
    } finally {
      await server.close()
    }
  })

  it('客户端把非 2xx 翻成 RosterImportApiError（带状态码与文案）', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    try {
      const client = createRosterImportClient({ baseUrl: server.baseUrl, token: 'wrong' })
      await expect(client.commit(announcementRequest())).rejects.toBeInstanceOf(RosterImportApiError)
      await expect(client.commit(announcementRequest())).rejects.toMatchObject({ status: 401 })
    } finally {
      await server.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. MCP 面
// ---------------------------------------------------------------------------

describe('MCP 面：tool 注册与写入名单', () => {
  it('save_roster_batch 在写入名单里；所有名录只读 tool 都不在', () => {
    expect([...MCP_WRITE_TOOLS]).toContain('save_roster_batch')
    for (const name of [
      'preflight_roster_batch',
      'list_enterprises',
      'list_differences',
      'query_records',
      'get_enterprise_detail',
    ]) {
      expect([...MCP_WRITE_TOOLS]).not.toContain(name)
    }
  })

  it('统一写入与名录查询 tool 文件都声明了对应的 tool 名', () => {
    const base = join(process.cwd(), 'server/mcp/tools')
    const expected: Array<[string, string]> = [
      ['save_roster_batch.ts', 'save_roster_batch'],
      ['preflight_roster_batch.ts', 'preflight_roster_batch'],
      ['list_enterprises.ts', 'list_enterprises'],
      ['list_differences.ts', 'list_differences'],
      ['query_records.ts', 'query_records'],
      ['get_enterprise_detail.ts', 'get_enterprise_detail'],
    ]
    for (const [file, name] of expected) {
      const source = readFileSync(join(base, file), 'utf8')
      expect(source, file).toContain(`name: '${name}'`)
      expect(source, file).toContain('defineMcpTool({')
    }
    expect(readFileSync(join(base, 'save_roster_batch.ts'), 'utf8')).toContain('enabled: writeGuard')
  })
})

// ---------------------------------------------------------------------------
// 6b. HTTP 路由面（OpenAPI 可发现 + token 绑定）
// ---------------------------------------------------------------------------

describe('HTTP 路由面', () => {
  it('三个写路由（preflight / commit / replay）都带顶层 defineRouteMeta（OpenAPI 可发现）并绑定 NUXT_API_TOKEN', () => {
    const base = join(process.cwd(), 'server/api/roster/import')
    for (const file of ['preflight.post.ts', 'commit.post.ts', 'replay.post.ts']) {
      const source = readFileSync(join(base, file), 'utf8')
      expect(source, file).toContain('defineRouteMeta({')
      // 宏必须在**顶层**（nitro 的 handlers-meta 插件只认顶层 ExpressionStatement）。
      expect(/^defineRouteMeta\(/m.test(source), file).toBe(true)
      // 鉴权判据从运行时读（token 值不进源码），且声明了 bearerAuth 安全方案。
      expect(source, file).toContain('security: [{ bearerAuth: [] }]')
      // 路由只是胶水：逻辑在 transport 无关的 handler 里（真实 HTTP 测试打的是它），
      // 而且三条路由共用**同一份**胶水工厂（RL-19 收拢，免得各抄一份、抄漏一处）。
      expect(source, file).toContain('createRosterImportHandler(')
      expect(source, file).toMatch(/^export default createRosterImportHandler\('(\w+)'\)$/m)
    }
    // 工厂里才读运行时 token（`useRuntimeConfig().apiToken`）—— 每条路由各自再读一遍
    // 就是三份会各自漂的实现。
    const factory = readFileSync(join(process.cwd(), 'server/utils/roster-import-route.ts'), 'utf8')
    expect(factory).toContain('useRuntimeConfig().apiToken')
    for (const action of ['preflight', 'commit', 'replay'] as const) {
      expect(readFileSync(join(base, `${action}.post.ts`), 'utf8'), action).toContain(
        `createRosterImportHandler('${action}')`,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// 7. 平台导出快照写入（对齐 RL-05 的读侧与版本口径）
// ---------------------------------------------------------------------------

describe('导出快照写入', () => {
  function snapshotRequest(over: {
    key: string
    sha: string
    year?: number
    collectedOn?: string
    rows?: Array<{ sourceRowNo: number; nameRaw: string }>
  }): RosterImportRequest {
    return {
      idempotencyKey: over.key,
      sourceKind: 'platform_export',
      sourceIdentity: 'miit/export/专精特新中小企业导出Excel.xlsx',
      payload: {
        exportSnapshot: {
          titleCode: 'specialized_sme',
          // ★ 年度与采集日**由调用方给出**；解析器/写入口都不从文件名或内容推断。
          year: over.year ?? 2026,
          collectedOn: over.collectedOn ?? '2026-10-16',
          originalFilename: '专精特新中小企业导出Excel.xlsx',
          sha256: over.sha,
          rows: (over.rows ?? [
            { sourceRowNo: 3, nameRaw: '甲企业' },
            { sourceRowNo: 4, nameRaw: '乙企业' },
          ]).map((row) => ({
            sourceRowNo: row.sourceRowNo,
            usccRaw: null,
            nameRaw: row.nameRaw,
            rawFields: { '1': row.nameRaw, '18': '' },
          })),
        },
      },
    }
  }

  it('年度 / 采集日原样落库（不推断），行与 importBatchId 指回本批', () => {
    const db = makeDb()
    const result = commitRosterImport(db, snapshotRequest({ key: 'exp/first#sha:1', sha: '1'.repeat(64), year: 2019, collectedOn: '2019-06-30' }))
    expect(result.status).toBe('committed')
    const batch = db.select().from(schema.platformExportBatch).all()[0]!
    expect(batch.year).toBe(2019)
    expect(batch.collectedOn).toBe('2019-06-30')
    expect(batch.rowCount).toBe(2)
    expect(batch.replacedBatchId).toBeNull() // 首版
    expect(batch.importBatchId).toBe(result.batchId)
    expect(db.select().from(schema.platformExportRow).all().filter((r) => r.batchId === batch.id)).toHaveLength(2)
  })

  it('★ 版本替换：新批的 replacedBatchId 指向上一个版本的 id；同 sha 重放不新建批', () => {
    const db = makeDb()
    const v1 = commitRosterImport(db, snapshotRequest({ key: 'exp/v1#sha:1', sha: '1'.repeat(64) }))
    const first = db.select().from(schema.platformExportBatch).all().find((b) => b.importBatchId === v1.batchId)!

    // 同内容重放：命中唯一键 (title, year, sha256) ⇒ 不新建批、不重落行。
    const replay = commitRosterImport(db, snapshotRequest({ key: 'exp/v1#sha:1', sha: '1'.repeat(64) }))
    expect(replay.batchId).toBe(v1.batchId)
    expect(db.select().from(schema.platformExportBatch).all()).toHaveLength(1)

    // 换内容 ⇒ 新版本；新批记下「它替换了 v1」。
    const v2 = commitRosterImport(db, snapshotRequest({ key: 'exp/v2#sha:2', sha: '2'.repeat(64) }))
    const second = db.select().from(schema.platformExportBatch).all().find((b) => b.importBatchId === v2.batchId)!
    expect(second.id).not.toBe(first.id)
    expect(second.replacedBatchId).toBe(first.id)
    // 两版并存：旧快照不因替换而消失。
    expect(db.select().from(schema.platformExportBatch).all()).toHaveLength(2)
    expect(db.select().from(schema.platformExportRow).all().filter((r) => r.batchId === first.id)).toHaveLength(2)
  })

  it('同批内源行号唯一：重复行号逐项报错，整批不落库', () => {
    const db = makeDb()
    const result = commitRosterImport(
      db,
      snapshotRequest({ key: 'exp/dup#sha:3', sha: '3'.repeat(64), rows: [{ sourceRowNo: 3, nameRaw: '甲' }, { sourceRowNo: 3, nameRaw: '乙' }] }),
    )
    expect(result.status).toBe('failed')
    expect(result.items[0]!.error!.code).toBe('source_row_no_duplicate')
    expect(db.select().from(schema.platformExportBatch).all()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 8. 大载荷（MB 级导出快照）真实 HTTP 提交
// ---------------------------------------------------------------------------

describe('大载荷：MB 级导出快照经真实 HTTP 提交', () => {
  it('6273 行 × 数十列的载荷能完整收到并落库（实测字节数）', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    try {
      // 实测最大一张导出表 6273 行；rawFields 键 = 1-based 列号字符串、只留非空值。
      const rows = Array.from({ length: 6273 }, (_, i) => {
        const rawFields: Record<string, string> = {}
        for (let col = 1; col <= 30; col += 1) rawFields[String(col)] = `第${i + 1}行的第${col}列取值`
        return {
          sourceRowNo: i + 3,
          usccRaw: `91330211${String(i).padStart(10, '0')}`,
          nameRaw: `第${i + 1}家企业有限公司`,
          province: '浙江省',
          city: '宁波市',
          district: '鄞州区',
          regStatus: '推荐',
          rawFields,
        }
      })
      const body = {
        idempotencyKey: 'exp/large#sha:big',
        sourceKind: 'platform_export' as const,
        sourceIdentity: 'miit/export/专精特新中小企业导出Excel.xlsx',
        payload: {
          exportSnapshot: {
            titleCode: 'specialized_sme',
            year: 2026,
            collectedOn: '2026-10-16',
            originalFilename: '专精特新中小企业导出Excel.xlsx',
            sha256: 'a'.repeat(64),
            rows,
          },
        },
      }
      const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8')
      // 实测体量：这份载荷是本仓测试里最大的一类（真件 6273 行）。
      expect(bytes).toBeGreaterThan(3_000_000)

      const result = await client.commit(body)
      expect(result.status).toBe('committed')
      expect(result.items[0]!.ok).toBe(true)

      const batch = db.select().from(schema.platformExportBatch).all()[0]!
      expect(batch.rowCount).toBe(6273)
      const stored = db.select().from(schema.platformExportRow).all()
      expect(stored).toHaveLength(6273)
      // 整行原始字段完整保留（30 个非空列）。
      expect(Object.keys(stored[0]!.rawFields as Record<string, string>)).toHaveLength(30)
      // 行号从 3 起（两行表头之后），与解析器口径一致。
      expect(Math.min(...stored.map((r) => r.sourceRowNo))).toBe(3)
    } finally {
      await server.close()
    }
  }, 120_000)
})


// ---------------------------------------------------------------------------
// 9b. 批内自然键引用（别名 / 差异 / 归并的证据指针指向本批新建的查询 / 关系）
// ---------------------------------------------------------------------------

describe('批内自然键引用：一批写完「查询 → 关系 → 别名 / 差异 / 归并」', () => {
  /**
   * 一个 payload 同时含 `platformQueries`（含多条 relations）、`aliases`（自然键指本批关系）、
   * `differences`（自然键指本批查询与关系）、`announcement`（企业 + 事件）与 `merges`。
   * 关键：关系/查询的 id 由本批事务内生成，客户端**事前不可能知道** —— 自然键必须在**同一批内**解析。
   */
  const oneBatch = (): RosterImportRequest => ({
    idempotencyKey: 'one-batch/evidence#sha256:x1',
    sourceKind: 'announcement',
    sourceIdentity: 'jxj/announcement/2026/1/一批到底.pdf',
    payload: {
      platformQueries: [
        {
          interface: 'business_list',
          queryKey: '91330211255994457P',
          rdjb: '3',
          queriedAt: '2026-10-16T03:00:00.000Z',
          status: 'success',
          relations: [
            { sequenceNo: 1, relationKey: 'SQ-1', usccRaw: '91330211255994457P', nameRaw: '宁波上航测绘股份有限公司', matchBasis: 'uscc', verificationStatus: 'confirmed' },
            { sequenceNo: 2, relationKey: 'SQ-2', usccRaw: '91330211255994457P', nameRaw: '宁波上航测绘有限公司', matchBasis: 'alias', verificationStatus: 'confirmed' },
          ],
        },
        { interface: 'apply_list', queryKey: '91330211255994457P', queriedAt: '2026-10-16T03:01:00.000Z', status: 'no_record' },
      ],
      announcement: {
        sourceDocument: { source: 'jxj', title: '一批到底' },
        records: [
          {
            enterprise: { name: '宁波上航测绘股份有限公司', uscc: '91330211255994457P' },
            titleCode: 'specialized_sme',
            events: [{ eventType: 'award', year: 2022, batchSeq: 2, evidence: [{ sourceFile: 'jxj/announcement/2022/145号.pdf', listNo: 74, page: 74 }] }],
          },
          // 无统代主体，待本批归并。
          { enterprise: { name: '宁波上航测绘有限公司' }, titleCode: 'innovative_sme', events: [{ eventType: 'award', year: 2021, batchSeq: 1 }] },
        ],
      },
      aliases: [
        {
          uscc: '91330211255994457P',
          name: '宁波上航测绘有限公司',
          sourceKind: 'platform_business',
          verificationStatus: 'confirmed',
          // ★ 指向**本批新建**的关系行（第 2 条）；带 queriedAt 精确匹配。
          sourceRelationRef: { interface: 'business_list', queryKey: '91330211255994457P', rdjb: '3', queriedAt: '2026-10-16T03:00:00.000Z', sequenceNo: 2 },
        },
      ],
      differences: [
        {
          uscc: '91330211255994457P',
          titleCode: 'specialized_sme',
          direction: 'missing_in_miit',
          status: 'confirmed_reason',
          reasonCode: 'platform_stale',
          measureCode: 'mark_platform_snapshot',
          verificationStatus: 'confirmed',
          recordedAt: '2026-10-16T04:00:00.000Z',
          // ★ 省略 queriedAt ⇒ 靠 (interface, queryKey, rdjb) 唯一命中本批那次查询。
          evidenceQueryRef: { interface: 'business_list', queryKey: '91330211255994457P', rdjb: '3' },
          evidenceRelationRef: { interface: 'business_list', queryKey: '91330211255994457P', rdjb: '3', sequenceNo: 1 },
        },
      ],
      merges: [
        {
          fromEnterpriseName: '宁波上航测绘有限公司',
          intoUscc: '91330211255994457P',
          aliasName: '宁波上航测绘有限公司',
          sourceKind: 'platform_business',
          sourceRelationRef: { interface: 'business_list', queryKey: '91330211255994457P', rdjb: '3', sequenceNo: 2 },
          evidenceQueryRef: { interface: 'business_list', queryKey: '91330211255994457P', rdjb: '3' },
        },
      ],
    },
  })

  it('★ 一次 commit 完成；证据指针落的是**本批新建行**的真实 id（不是 0 哨兵、不是猜的）', () => {
    const db = makeDb()
    const result = commitRosterImport(db, oneBatch())

    expect(result.status).toBe('committed')
    expect(result.error).toBeNull()
    expect(result.summary.failed).toBe(0)
    expect(result.items.every((item) => item.ok)).toBe(true)
    // **只有一个批次** —— 不需要「先写查询、读回 id、再写别名」的两批绕行。
    expect(db.select().from(schema.importBatch).all()).toHaveLength(1)

    const relations = db.select().from(schema.platformRelation).all()
    const rel1 = relations.find((r) => r.relationKey === 'SQ-1')!
    const rel2 = relations.find((r) => r.relationKey === 'SQ-2')!
    const query = db.select().from(schema.platformQuery).all().find((q) => q.interface === 'business_list' && q.rdjb === '3')!

    // 别名：source_ref_id = 本批新建的第 2 条关系的真实 id。
    const canonical = db.select().from(schema.enterprise).all().find((e) => e.usccNorm === '91330211255994457P')!
    const aliases = db.select().from(schema.enterpriseAlias).all().filter((a) => a.enterpriseId === canonical.id && a.name === '宁波上航测绘有限公司')
    expect(aliases).toHaveLength(1)
    expect(aliases[0]!.sourceRefId).toBe(rel2.id)
    expect(aliases[0]!.sourceRefId).not.toBe(0)
    expect(aliases[0]!.verificationStatus).toBe('confirmed')

    // 差异：evidence_query_id / evidence_relation_id 都指向本批新建的行。
    const difference = db.select().from(schema.differenceReason).all()[0]!
    expect(difference.evidenceQueryId).toBe(query.id)
    expect(difference.evidenceRelationId).toBe(rel1.id)

    // 归并：曾用名的来源关系解析成同一条真实关系；血缘里的查询证据也是真实 id。
    const mergeItem = result.items.find((item) => item.kind === 'merge')!
    const lineage = mergeItem.detail!.lineage as { aliasId: number; evidenceQueryId: number | null; fromEnterpriseId: number }
    expect(lineage.aliasId).toBe(aliases[0]!.id)
    expect(lineage.evidenceQueryId).toBe(query.id)

    // 归并仍按 §5.2 生效：被并企业行删除，称号/事件/出处一条不丢。
    expect(enterpriseExists(db, lineage.fromEnterpriseId)).toBe(false)
    expect(db.select().from(schema.record).all().filter((r) => r.enterpriseId === canonical.id).map((r) => r.titleCode).sort()).toEqual(['innovative_sme', 'specialized_sme'])
    expect(db.select().from(schema.recordEvidence).all()[0]!.page).toBe(74)

    // 血缘可从批次行查回（父代理裁决 #4）。
    const replayedLineage = readMergeLineage(db, 'one-batch/evidence#sha256:x1', lineage.fromEnterpriseId)!
    expect(replayedLineage.evidenceQueryId).toBe(query.id)
  })

  it('★ 自然键解析不到 ⇒ 整批 failed，业务数据一行不落，逐项报错', () => {
    const db = makeDb()
    const before = rosterRowCounts(db)

    // (a) 关系序号不存在
    const missingSeq = oneBatch()
    missingSeq.idempotencyKey = 'one-batch/missing-seq#sha256:x2'
    ;(missingSeq.payload.aliases![0] as { sourceRelationRef: { sequenceNo: number } }).sourceRelationRef.sequenceNo = 99
    const a = commitRosterImport(db, missingSeq)
    expect(a.status).toBe('failed')
    expect(a.items.find((item) => !item.ok)!.error!.code).toBe('relation_ref_not_found')
    expect(rosterRowCounts(db)).toEqual(before)

    // (b) 查询键根本不存在
    const missingQuery = oneBatch()
    missingQuery.idempotencyKey = 'one-batch/missing-query#sha256:x3'
    ;(missingQuery.payload.differences![0] as { evidenceQueryRef: { queryKey: string } }).evidenceQueryRef.queryKey = '91330211000000000Z'
    const b = commitRosterImport(db, missingQuery)
    expect(b.status).toBe('failed')
    expect(b.items.some((item) => item.error?.code === 'query_ref_not_found')).toBe(true)
    expect(rosterRowCounts(db)).toEqual(before)

    // (c) 关系引用缺 sequenceNo
    const noSeq = oneBatch()
    noSeq.idempotencyKey = 'one-batch/no-seq#sha256:x4'
    delete (noSeq.payload.differences![0] as { evidenceRelationRef?: unknown }).evidenceRelationRef
    ;(noSeq.payload.differences![0] as unknown as { evidenceRelationRef: Record<string, unknown> }).evidenceRelationRef = { interface: 'business_list', queryKey: '91330211255994457P', rdjb: '3' }
    const c = commitRosterImport(db, noSeq)
    expect(c.status).toBe('failed')
    expect(c.items.some((item) => item.error?.code === 'ref_sequence_no_required')).toBe(true)
    expect(rosterRowCounts(db)).toEqual(before)
  })

  it('裸 id 与自然键同时给 ⇒ 逐项报错（不静默取一个）', () => {
    const db = makeDb()
    const request = oneBatch()
    request.idempotencyKey = 'one-batch/conflict#sha256:x5'
    ;(request.payload.aliases![0] as { sourceRefId?: number }).sourceRefId = 7
    const result = commitRosterImport(db, request)
    expect(result.status).toBe('failed')
    expect(result.items.find((i) => !i.ok)!.error!.code).toBe('source_ref_conflict')
    expect(rosterRowCounts(db).enterprise).toBe(0)

    const request2 = oneBatch()
    request2.idempotencyKey = 'one-batch/conflict2#sha256:x6'
    ;(request2.payload.differences![0] as { evidenceRelationId?: number }).evidenceRelationId = 3
    const result2 = commitRosterImport(db, request2)
    expect(result2.status).toBe('failed')
    expect(result2.items.some((i) => i.error?.code === 'evidence_ref_conflict')).toBe(true)
  })

  it('★ 自然键不含时点时要求唯一：同 (interface, queryKey, rdjb) 两次查询 ⇒ 逐项报错', () => {
    const db = makeDb()
    const before = rosterRowCounts(db)
    const request = oneBatch()
    request.idempotencyKey = 'one-batch/ambiguous#sha256:x7'
    // 再插一次同 (interface, queryKey, rdjb) 但不同 queriedAt 的查询（含同样的序号 2）。
    request.payload.platformQueries!.push({
      interface: 'business_list',
      queryKey: '91330211255994457P',
      rdjb: '3',
      queriedAt: '2026-10-17T03:00:00.000Z',
      status: 'success',
      relations: [{ sequenceNo: 2, relationKey: 'SQ-2b', usccRaw: '91330211255994457P', nameRaw: '宁波上航测绘有限公司' }],
    })
    const result = commitRosterImport(db, request)
    expect(result.status).toBe('failed')
    // 别名那次引用带了 queriedAt ⇒ 不歧义；差异/归并省略了 queriedAt ⇒ 歧义。
    expect(result.items.some((i) => i.error?.code === 'relation_ref_ambiguous' || i.error?.code === 'query_ref_ambiguous')).toBe(true)
    expect(rosterRowCounts(db)).toEqual(before)
  })

  it('兼容：显式裸 id 继续可用（指向**已存在**的行），不被自然键逻辑覆盖', () => {
    const db = makeDb()
    const canonical = seedEnterprise(db, { name: '宁波显式企业有限公司', uscc: '9133021100000000E1' })
    const result = commitRosterImport(db, {
      idempotencyKey: 'literal-id#sha256:x8',
      sourceKind: 'alias_evidence',
      sourceIdentity: 'miit/relations/literal',
      payload: {
        aliases: [
          {
            uscc: '9133021100000000E1',
            name: '宁波显式旧名有限公司',
            sourceKind: 'platform_business',
            sourceRefId: 12345,
            verificationStatus: 'confirmed',
          },
          // 不给来源 ⇒ 契约 §1.2 的 0 哨兵（「无具体来源行引用」）。
          { uscc: '9133021100000000E1', name: '宁波无来源旧名', sourceKind: 'manual', verificationStatus: 'confirmed' },
        ],
      },
    })
    expect(result.status).toBe('committed')
    const rows = db.select().from(schema.enterpriseAlias).all().filter((a) => a.enterpriseId === canonical)
    expect(rows.find((a) => a.name === '宁波显式旧名有限公司')!.sourceRefId).toBe(12345)
    expect(rows.find((a) => a.name === '宁波无来源旧名')!.sourceRefId).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 10. 读面（list_enterprises / list_differences）
// ---------------------------------------------------------------------------

describe('读面：list_enterprises / list_differences', () => {
  it('企业总表去重、按现名与已确认曾用名都能搜到、未确认别名不命中', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    try {
      await client.commit({
        idempotencyKey: 'read/enterprises#sha256:r1',
        sourceKind: 'announcement',
        sourceIdentity: 'jxj/announcement/2026/1/读面.pdf',
        payload: {
          announcement: {
            sourceDocument: { source: 'jxj', title: '读面' },
            records: [
              { enterprise: { name: '宁波读面企业有限公司', uscc: '9133021100000000R1', district: '鄞州区' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2021, batchSeq: 1 }] },
              { enterprise: { name: '宁波仅平台企业' }, titleCode: 'innovative_sme', events: [] },
            ],
          },
          aliases: [
            { enterpriseName: '宁波读面企业有限公司', name: '宁波读面旧名', sourceKind: 'platform_business', verificationStatus: 'confirmed' },
            { enterpriseName: '宁波读面企业有限公司', name: '宁波读面未核别名', sourceKind: 'platform_apply', verificationStatus: 'pending' },
          ],
        },
      })

      const all = listEnterprises(db, {})
      expect(all.counts.total).toBe(2)
      const target = all.rows.find((r) => r.name === '宁波读面企业有限公司')!
      expect(target.uscc).toBe('9133021100000000R1')
      expect(target.district).toBe('鄞州区')
      expect(target.rosterState).toBe('current')
      expect(target.titles).toEqual(['specialized_sme'])
      expect(target.aliasNames).toEqual(['宁波读面旧名'])

      // 只由平台引入、无 jxj 事件 ⇒ removed_platform_only。
      expect(all.rows.find((r) => r.name === '宁波仅平台企业')!.rosterState).toBe('removed_platform_only')

      expect(listEnterprises(db, { q: '宁波读面旧名' }).rows.map((r) => r.name)).toEqual(['宁波读面企业有限公司'])
      expect(listEnterprises(db, { q: '宁波读面未核别名' }).rows).toEqual([])
      expect(listEnterprises(db, { district: '鄞州区' }).counts.total).toBe(1)
      expect(listEnterprises(db, { title: 'innovative_sme' }).rows.map((r) => r.name)).toEqual(['宁波仅平台企业'])
    } finally {
      await server.close()
    }
  })

  it('差异取「当前解释」（recordedAt 最新），原因与措施成对', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    const client = createRosterImportClient({ baseUrl: server.baseUrl, token: TOKEN })
    try {
      await client.commit({
        idempotencyKey: 'read/differences#sha256:r2',
        sourceKind: 'alias_evidence',
        sourceIdentity: 'miit/relations/r2',
        payload: {
          platformQueries: [
            { interface: 'apply_list', queryKey: '9133021100000000R2', queriedAt: '2026-10-16T07:00:00.000Z', status: 'success' },
          ],
          announcement: {
            sourceDocument: { source: 'jxj', title: '读面差异' },
            records: [{ enterprise: { name: '宁波差异企业', uscc: '9133021100000000R2' }, titleCode: 'specialized_sme', events: [] }],
          },
          differences: [
            { enterpriseName: '宁波差异企业', titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'no_record', recordedAt: '2026-10-15T08:00:00.000Z' },
            { enterpriseName: '宁波差异企业', titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'confirmed_reason', reasonCode: 'moved_out', measureCode: 'mark_moved_out', verificationStatus: 'confirmed', recordedAt: '2026-10-16T08:00:00.000Z' },
          ],
        },
      })

      const differences = listDifferences(db, { title: 'specialized_sme' })
      expect(differences.rows).toHaveLength(1)
      const row = differences.rows[0]!
      expect(row.status).toBe('confirmed_reason')
      expect(row.reasonCode).toBe('moved_out')
      expect(row.measureCode).toBe('mark_moved_out')
      expect(row.recordedAt).toBe('2026-10-16T08:00:00.000Z')
      expect(differences.counts.specialized_sme!.missing_in_miit).toBe(1)
      // 旧解释仍在库里（时态化不丢）。
      expect(db.select().from(schema.differenceReason).all()).toHaveLength(2)
    } finally {
      await server.close()
    }
  })
})
