/**
 * 名录生命周期**冻结契约**的验收样例(RL-01)。
 *
 * 本文件是交付物 D:用 SQLite 场景数据证明 `docs/roster-lifecycle-contract.md`
 * 与 `db/schema.ts` 里那批新表**真的**按契约行事 —— 尤其是唯一键/幂等键在
 * **库层面**生效(违反时确实抛错),而不是只在文档里写着。
 *
 * 测试缝 = drizzle schema + SQLite 约束本身:后续票(RL-02..RL-11)照着契约写代码,
 * 这些断言就是它们共用的验收样例。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { schema, useDb } from '../db'

const dir = mkdtempSync(join(tmpdir(), 'spztx-lifecycle-contract-'))
const db = useDb({ dbPath: join(dir, 'contract.db') })

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function enterprise(name: string, uscc: string | null = null) {
  return db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc })
    .returning({ id: schema.enterprise.id })
    .get().id
}

function record(
  enterpriseId: number,
  titleCode: 'little_giant' | 'specialized_sme' | 'innovative_sme',
  source: 'jxj' | 'miit' = 'jxj',
) {
  return db
    .insert(schema.record)
    .values({ enterpriseId, titleCode, source, district: '鄞州区' })
    .returning({ id: schema.record.id })
    .get().id
}

function event(
  recordId: number,
  eventType: 'award' | 'review' | 'maintain' | 'nurture',
  year: number,
  extra: Partial<typeof schema.recordEvent.$inferInsert> = {},
) {
  return db
    .insert(schema.recordEvent)
    .values({ recordId, eventType, year, sortKey: year, ...extra })
    .returning({ id: schema.recordEvent.id })
    .get().id
}

/**
 * 通用样例企业(别名场景与多关联场景共用)。真实回归案例 `91330211255994457P`
 * 另有自己的企业行,见文件末尾「回归案例」。
 */
const caseId = enterprise('宁波示范企业', '91330211000000009W')

/** 真实回归案例企业(场景八 / 九共用):统代 `91330211255994457P`。 */
const shanghangId = enterprise('宁波上航测绘股份有限公司', '91330211255994457P')

// ---------------------------------------------------------------------------
// 场景一:一家企业多称号 + 同信用代码多批次保留多条事件
// ---------------------------------------------------------------------------

describe('一企多称号、同信用代码多批次', () => {
  const id = enterprise('宁波博登智能科技有限公司', '91330211316904639T')
  const specialized = record(id, 'specialized_sme')
  const innovative = record(id, 'innovative_sme')
  const giant = record(id, 'little_giant')

  it('同一企业在总表只出现一行,称号各自成记录', () => {
    // 企业去重:身份只有一行。
    expect(db.select().from(schema.enterprise).all().filter((e) => e.id === id)).toHaveLength(1)
    // 称号不去重:同企业可有专精特新、创新型、小巨人多条记录。
    expect(new Set([specialized, innovative, giant]).size).toBe(3)
    expect(
      db.select().from(schema.record).all().filter((r) => r.enterpriseId === id).map((r) => r.titleCode).sort(),
    ).toEqual(['innovative_sme', 'little_giant', 'specialized_sme'])
  })

  it('同一信用代码在第 2 批与第 6 批各出现一次 → 保留两条认定事件,不折叠', () => {
    // 小巨人工作簿批次年份约定:年份 = 2018 + 批次序号(见 RL-02)。
    event(giant, 'award', 2020, { batchSeq: 2 })
    event(giant, 'award', 2024, { batchSeq: 6 })
    const awards = db
      .select()
      .from(schema.recordEvent)
      .all()
      .filter((e) => e.recordId === giant)
    expect(awards).toHaveLength(2)
    expect(awards.map((e) => e.batchSeq).sort()).toEqual([2, 6])
    expect(awards.map((e) => e.year).sort()).toEqual([2020, 2024])
  })
})

// ---------------------------------------------------------------------------
// 场景二:复核未通过必须能被表达(现有 record_event 的能力缺口)
// ---------------------------------------------------------------------------

describe('复核结果字段', () => {
  const id = enterprise('复核案例企业', '91330211000000001X')
  const rec = record(id, 'specialized_sme')
  const firstAward = event(rec, 'award', 2021, { batchSeq: 1 })

  it('record_event 能区分「复核通过」与「复核未通过」', () => {
    const failedReview = event(rec, 'review', 2021, {
      batchSeq: 1,
      reviewOutcome: 'failed',
      decidedYear: 2024,
    })
    const failed = db
      .select()
      .from(schema.recordEvent)
      .all()
      .find((e) => e.id === failedReview)!
    expect(failed.reviewOutcome).toBe('failed')
    // 复核的 `year` 是被复核的原认定年份;结论年份单列,不与被复核年份混为一谈。
    expect(failed.year).toBe(2021)
    expect(failed.decidedYear).toBe(2024)
  })

  it('复核未通过后再次获批:首次认定仍是 2021,再获批不重置首次认定', () => {
    const reApproved = event(rec, 'award', 2025, { batchSeq: 1, decidedYear: 2025 })
    const events = db
      .select()
      .from(schema.recordEvent)
      .all()
      .filter((e) => e.recordId === rec)
    const awards = events.filter((e) => e.eventType === 'award')
    expect(Math.min(...awards.map((e) => e.year!))).toBe(2021)
    expect(awards.map((e) => e.year).sort()).toEqual([2021, 2025])
    // 首次认定锚点未被 2025 覆盖:最早认定事件仍是 2021。
    expect(db.select().from(schema.recordEvent).all().find((e) => e.id === firstAward)!.year).toBe(2021)
    // 复核锚点从重新获批年份刷新:下一次到期 = 2025 + 3。
    const anchor = Math.max(
      ...events
        .filter((e) => e.eventType === 'award' || (e.eventType === 'review' && e.reviewOutcome === 'passed'))
        .map((e) => (e.decidedYear ?? e.year)!),
    )
    expect(anchor).toBe(2025)
    expect(anchor + 3).toBe(2028)
    expect(reApproved).toBeTypeOf('number')
  })
})

// ---------------------------------------------------------------------------
// 场景三:企业曾用名 / 别名 —— 按现名或任一已确认曾用名搜索命中同一企业
// ---------------------------------------------------------------------------

/** 契约里的名称搜索口径:现名归一化命中,或**任一已确认**曾用名归一化命中。 */
function searchEnterpriseId(term: string): number[] {
  const norm = term
  const byName = db
    .select({ id: schema.enterprise.id, nameNorm: schema.enterprise.nameNorm })
    .from(schema.enterprise)
    .all()
    .filter((e) => e.nameNorm === norm)
  const byAlias = db
    .select({
      id: schema.enterpriseAlias.enterpriseId,
      nameNorm: schema.enterpriseAlias.nameNorm,
      verificationStatus: schema.enterpriseAlias.verificationStatus,
    })
    .from(schema.enterpriseAlias)
    .all()
    .filter((a) => a.nameNorm === norm && a.verificationStatus === 'confirmed')
  return [...new Set([...byName.map((r) => r.id), ...byAlias.map((r) => r.id)])].sort((a, b) => a - b)
}

describe('企业曾用名 / 别名', () => {
  const id = caseId
  const query = db.insert(schema.platformQuery).values({
    interface: 'business_list',
    queryKey: '91330211255994457P',
    queriedAt: '2026-10-14T03:00:00.000Z',
    status: 'success',
  }).returning({ id: schema.platformQuery.id }).get().id

  it('一个企业可有多条别名记录,保留原值、来源关系与核验状态', () => {
    db.insert(schema.enterpriseAlias).values([
      {
        enterpriseId: id,
        name: '宁波旧名科技有限公司',
        nameNorm: '宁波旧名科技有限公司',
        sourceKind: 'platform_business',
        sourceRefId: query,
        verificationStatus: 'confirmed',
      },
      {
        enterpriseId: id,
        name: '宁波更早名科技有限公司',
        nameNorm: '宁波更早名科技有限公司',
        sourceKind: 'announcement',
        verificationStatus: 'confirmed',
      },
      {
        enterpriseId: id,
        name: '宁波疑似同名科技有限公司',
        nameNorm: '宁波疑似同名科技有限公司',
        sourceKind: 'platform_apply',
        verificationStatus: 'pending',
      },
    ]).run()
    const aliases = db
      .select()
      .from(schema.enterpriseAlias)
      .all()
      .filter((a) => a.enterpriseId === id)
    expect(aliases).toHaveLength(3)
    // 来源未给出的生效时间**留空**,不推测。
    expect(aliases.every((a) => a.validFrom === null)).toBe(true)
    // 来源关系证据与核验状态逐条保留。
    expect(aliases.find((a) => a.sourceKind === 'platform_business')?.sourceRefId).toBe(query)
    expect(aliases.filter((a) => a.verificationStatus === 'pending')).toHaveLength(1)
  })

  it('按现名与任一已确认曾用名搜索,都命中同一企业', () => {
    expect(searchEnterpriseId('宁波示范企业')).toEqual([id])
    expect(searchEnterpriseId('宁波旧名科技有限公司')).toEqual([id])
    expect(searchEnterpriseId('宁波更早名科技有限公司')).toEqual([id])
    // 未确认(pending)的别名不参与搜索 —— 证据不足不自动归并。
    expect(searchEnterpriseId('宁波疑似同名科技有限公司')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 场景四:平台双接口关系记录 —— 同一信用代码的多条关联逐条保留
// ---------------------------------------------------------------------------

describe('平台接口关系记录', () => {
  const id = caseId

  it('同一信用代码返回的多条关联逐条保留,不覆盖成一条', () => {
    const q = db.insert(schema.platformQuery).values({
      interface: 'business_list',
      queryKey: '91330211255994457P',
      titleCode: 'specialized_sme',
      queriedAt: '2026-10-14T04:00:00.000Z',
      status: 'success',
      rawResponse: '<table>…</table>',
    }).returning({ id: schema.platformQuery.id }).get().id

    db.insert(schema.platformRelation).values([
      {
        queryId: q,
        sequenceNo: 1,
        enterpriseId: id,
        rawFields: { 企业名称: '多关联案例企业', 统一社会信用代码: '91330211255994457P' },
        nameRaw: '多关联案例企业',
        usccRaw: '91330211255994457P',
        matchBasis: 'uscc',
        verificationStatus: 'confirmed',
      },
      {
        queryId: q,
        sequenceNo: 2,
        enterpriseId: id,
        rawFields: { 企业名称: '经信局侧旧名企业', 曾用名: '经信局侧旧名企业' },
        nameRaw: '经信局侧旧名企业',
        sourceText: '曾用名:经信局侧旧名企业',
        aliasNameRaw: '经信局侧旧名企业',
        matchBasis: 'alias',
        verificationStatus: 'confirmed',
      },
      {
        queryId: q,
        sequenceNo: 3,
        enterpriseId: null,
        rawFields: { 企业名称: '同名他企' },
        nameRaw: '同名他企',
        matchBasis: 'none',
        verificationStatus: 'pending',
      },
    ]).run()

    const relations = db
      .select()
      .from(schema.platformRelation)
      .all()
      .filter((r) => r.queryId === q)
    expect(relations).toHaveLength(3)
    expect(relations.map((r) => r.sequenceNo).sort()).toEqual([1, 2, 3])
    expect(relations.find((r) => r.sequenceNo === 2)?.sourceText).toContain('经信局侧旧名企业')
    expect(relations.find((r) => r.sequenceNo === 2)?.matchBasis).toBe('alias')
    // 无法判定的关联不自动归并:enterprise_id 留空、核验状态待核实。
    const unbound = relations.find((r) => r.sequenceNo === 3)!
    expect(unbound.enterpriseId).toBeNull()
    expect(unbound.verificationStatus).toBe('pending')
  })

  it('查询失败 ≠ 无记录:两种状态彼此可区分', () => {
    db.insert(schema.platformQuery).values([
      {
        interface: 'apply_list',
        queryKey: 'name:某企业',
        queriedAt: '2026-10-14T05:00:00.000Z',
        status: 'failed',
        failureReason: '会话过期',
      },
      {
        interface: 'apply_list',
        queryKey: 'name:另一企业',
        queriedAt: '2026-10-14T05:01:00.000Z',
        status: 'no_record',
      },
    ]).run()
    const rows = db.select().from(schema.platformQuery).all()
    const failed = rows.find((r) => r.queryKey === 'name:某企业')!
    const empty = rows.find((r) => r.queryKey === 'name:另一企业')!
    expect(failed.status).toBe('failed')
    expect(empty.status).toBe('no_record')
    expect(failed.status).not.toBe(empty.status)
  })
})

// ---------------------------------------------------------------------------
// 场景五:差异原因与后续措施(成对)+ 状态机
// ---------------------------------------------------------------------------

describe('差异原因与后续措施', () => {
  const id = enterprise('迁入企业', '91330211000000002Y')

  it('未查询 / 查询失败 / 无记录 / 已确认无差异 四态彼此可区分', () => {
    const statuses = ['not_queried', 'query_failed', 'no_record', 'confirmed_no_diff'] as const
    statuses.forEach((status, i) => {
      db.insert(schema.differenceReason).values({
        enterpriseId: id,
        titleCode: 'specialized_sme',
        direction: 'missing_in_miit',
        status,
        recordedAt: `2026-10-14T06:0${i}:00.000Z`,
      }).run()
    })
    const rows = db
      .select()
      .from(schema.differenceReason)
      .all()
      .filter((r) => r.enterpriseId === id)
    const got = new Set(rows.map((r) => r.status))
    statuses.forEach((s) => expect(got.has(s)).toBe(true))
    expect(got.size).toBe(4)
    // 未查询 ≠ 失败 ≠ 无记录:三者的区分是这票的硬要求。
    expect(got.has('not_queried') && got.has('query_failed') && got.has('no_record')).toBe(true)
  })

  it('原因与后续措施成对保存,迁入承载原城市/称号/年份/批次', () => {
    const q = db.insert(schema.platformQuery).values({
      interface: 'apply_list',
      queryKey: '91330211000000002Y',
      queriedAt: '2026-10-14T07:00:00.000Z',
      status: 'success',
    }).returning({ id: schema.platformQuery.id }).get().id
    db.insert(schema.differenceReason).values({
      enterpriseId: id,
      titleCode: 'specialized_sme',
      direction: 'extra_in_miit',
      status: 'confirmed_reason',
      reasonCode: 'moved_in',
      reasonNote: '平台申报记录显示外地迁入',
      measureCode: 'record_moved_in',
      measureNote: '登记原称号与批次',
      evidenceQueryId: q,
      movedInCity: '杭州市',
      movedInTitleCode: 'innovative_sme',
      movedInYear: 2021,
      movedInBatch: 2,
      verificationStatus: 'confirmed',
      recordedAt: '2026-10-14T08:00:00.000Z',
    }).run()
    const row = db
      .select()
      .from(schema.differenceReason)
      .all()
      .find((r) => r.status === 'confirmed_reason')!
    expect(row.reasonCode).toBe('moved_in')
    expect(row.measureCode).toBe('record_moved_in')
    expect(row.movedInCity).toBe('杭州市')
    expect(row.movedInTitleCode).toBe('innovative_sme')
    expect(row.movedInYear).toBe(2021)
    expect(row.movedInBatch).toBe(2)
    expect(row.evidenceQueryId).toBe(q)
  })

  it('证据不足的迁入缺项留空并待核,不猜填', () => {
    db.insert(schema.differenceReason).values({
      enterpriseId: id,
      titleCode: 'innovative_sme',
      direction: 'extra_in_miit',
      status: 'needs_review',
      reasonCode: 'moved_in',
      measureCode: 'manual_review',
      verificationStatus: 'pending',
      recordedAt: '2026-10-14T09:00:00.000Z',
    }).run()
    const row = db
      .select()
      .from(schema.differenceReason)
      .all()
      .find((r) => r.status === 'needs_review')!
    expect(row.movedInCity).toBeNull()
    expect(row.movedInYear).toBeNull()
    expect(row.movedInBatch).toBeNull()
    expect(row.verificationStatus).toBe('pending')
  })

  it('时态化:同一差异的旧解释不丢,新解释形成新记录', () => {
    const same = (r: typeof schema.differenceReason.$inferSelect) =>
      r.enterpriseId === id && r.titleCode === 'specialized_sme' && r.direction === 'missing_in_miit'
    const before = db.select().from(schema.differenceReason).all().filter(same).length
    db.insert(schema.differenceReason).values({
      enterpriseId: id,
      titleCode: 'specialized_sme',
      direction: 'missing_in_miit',
      status: 'confirmed_reason',
      reasonCode: 'platform_stale',
      measureCode: 'mark_platform_snapshot',
      verificationStatus: 'confirmed',
      recordedAt: '2026-10-15T09:00:00.000Z',
    }).run()
    const rows = db
      .select()
      .from(schema.differenceReason)
      .all()
      .filter(same)
    expect(rows.length).toBe(before + 1)
    // 时点不同 → 两条并存;当前解释 = recordedAt 最新那条。
    expect(new Set(rows.map((r) => r.recordedAt)).size).toBe(rows.length)
    const current = rows.reduce((a, b) => (a.recordedAt > b.recordedAt ? a : b))
    expect(current.reasonCode).toBe('platform_stale')
  })
})

// ---------------------------------------------------------------------------
// 场景六:平台导出快照 —— 同文件重放幂等、替换文件形成新版本
// ---------------------------------------------------------------------------

describe('平台导出快照', () => {
  it('同一文件重放幂等:同(称号, 年份, SHA-256)只有一批', () => {
    const values = {
      titleCode: 'specialized_sme' as const,
      year: 2026,
      collectedOn: '2026-10-14',
      originalFilename: '专精特新中小企业导出Excel.xlsx',
      sha256: 'a'.repeat(64),
      rowCount: 3268,
      importStatus: 'imported' as const,
    }
    const first = db
      .insert(schema.platformExportBatch)
      .values(values)
      .returning({ id: schema.platformExportBatch.id })
      .get().id
    expect(() => db.insert(schema.platformExportBatch).values(values).run()).toThrow()
    expect(
      db.select().from(schema.platformExportBatch).all().filter((b) => b.sha256 === values.sha256),
    ).toHaveLength(1)
    expect(first).toBeTypeOf('number')
  })

  it('替换文件产生可区分的新版本并记录替换关系', () => {
    const replacement = db
      .insert(schema.platformExportBatch)
      .values({
        titleCode: 'specialized_sme',
        year: 2026,
        collectedOn: '2026-10-15',
        originalFilename: '专精特新中小企业导出Excel.xlsx',
        sha256: 'b'.repeat(64),
        rowCount: 3300,
        importStatus: 'imported',
      })
      .returning({ id: schema.platformExportBatch.id })
      .get().id
    const old = db
      .select()
      .from(schema.platformExportBatch)
      .all()
      .find((b) => b.sha256 === 'a'.repeat(64))!
    db.update(schema.platformExportBatch)
      .set({ replacedBatchId: replacement })
      .run()
    const reloaded = db
      .select()
      .from(schema.platformExportBatch)
      .all()
      .find((b) => b.id === old.id)!
    expect(reloaded.replacedBatchId).toBe(replacement)
    // 两版并存,旧快照不因替换而消失。
    const versions = db
      .select()
      .from(schema.platformExportBatch)
      .all()
      .filter((b) => b.titleCode === 'specialized_sme' && b.year === 2026)
    expect(versions).toHaveLength(2)
  })

  it('快照行保留源行身份与来源文件行号,同行号唯一', () => {
    const batchId = db
      .select()
      .from(schema.platformExportBatch)
      .all()
      .find((b) => b.sha256 === 'a'.repeat(64))!.id
    db.insert(schema.platformExportRow).values({
      batchId,
      sourceRowNo: 1,
      nameRaw: '某企业',
      usccRaw: '91330211000000003Z',
      district: '鄞州区',
      rawFields: { 企业名称: '某企业' },
    }).run()
    expect(() =>
      db.insert(schema.platformExportRow).values({ batchId, sourceRowNo: 1, nameRaw: '重复行' }).run(),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// 场景七:统一导入批次 —— 幂等键在库层面生效
// ---------------------------------------------------------------------------

describe('统一导入批次', () => {
  it('幂等键在库层面唯一:同一批次键不会重复写入', () => {
    const values = {
      idempotencyKey: 'jxj/省专/2024/192号#sha256:abc',
      sourceKind: 'announcement' as const,
      sourceIdentity: 'jxj/announcement/2024/2/甬经信中小〔2024〕192号.docx',
    }
    db.insert(schema.importBatch).values(values).run()
    expect(() => db.insert(schema.importBatch).values(values).run()).toThrow()
    expect(
      db.select().from(schema.importBatch).all().filter((b) => b.idempotencyKey === values.idempotencyKey),
    ).toHaveLength(1)
  })

  it('预检与提交是不同状态,逐项结果可留档', () => {
    const b = db
      .insert(schema.importBatch)
      .values({
        idempotencyKey: 'miit/2026/specialized#sha256:def',
        sourceKind: 'platform_export',
        sourceIdentity: 'miit/export/2026/specialized.xlsx',
        status: 'preflight',
        preflightResult: { add: 12, update: 3, remove: 1, review: 2 },
      })
      .returning({ id: schema.importBatch.id })
      .get().id
    db.update(schema.importBatch)
      .set({
        status: 'committed',
        itemResults: [{ ok: true, ref: 'enterprise:1' }],
        summary: { written: 15, skipped: 0 },
        committedAt: '2026-10-16T01:00:00.000Z',
      })
      .run()
    const row = db.select().from(schema.importBatch).all().find((r) => r.id === b)!
    expect(row.status).toBe('committed')
    expect(row.preflightResult).toEqual({ add: 12, update: 3, remove: 1, review: 2 })
    expect(row.summary).toEqual({ written: 15, skipped: 0 })
  })
})

// ---------------------------------------------------------------------------
// 场景八:回归案例 91330211255994457P —— 真实平台响应(裁剪后的字段摘录)
//
// 原响应全文与凭证**不入库、不进仓库**(依据 orchestration-notes/
// 04-EVIDENCE-91330211255994457P.md)。这里只保留与契约有关的字段。
// ---------------------------------------------------------------------------

describe('回归案例:91330211255994457P(真实响应摘录)', () => {
  const id = shanghangId

  // businessList(rdjb=3) 的 6 条关联:2 条旧名、4 条现名,唯一与名称有关的差异字段是 qymc。
  const trimmed = [
    { id: 'SQ332022062212391', qymc: '宁波上航测绘有限公司', sblx: '申请', whpc: '2022-1', sqsj: '2022-06-22 17:17:52', personuuid: null },
    { id: 'SQ332023041984270', qymc: '宁波上航测绘有限公司', sblx: '更新', whpc: '2022-1', sqsj: '2023-04-19 16:46:01', personuuid: null },
    { id: 'SQ332024052128274', qymc: '宁波上航测绘股份有限公司', sblx: '更新', whpc: '2022-1', sqsj: '2024-05-21 14:10:06', personuuid: null },
    { id: 'SQ332025060392166', qymc: '宁波上航测绘股份有限公司', sblx: '复核', whpc: '2025-1', sqsj: '2025-06-21 09:50:48', personuuid: '第四批' },
    { id: 'SQ332025062064737', qymc: '宁波上航测绘股份有限公司', sblx: '更新', whpc: '2025-1', sqsj: '2025-06-20 10:43:42', personuuid: null },
    { id: 'SQ332026052238796', qymc: '宁波上航测绘股份有限公司', sblx: '更新', whpc: '2025-1', sqsj: '2026-05-22 16:49:44', personuuid: null },
  ] as const
  const declareKinds = { 申请: 'apply', 更新: 'update', 复核: 'review' } as const

  it('rdjb=3 的 6 条关联逐条保留;rdjb=1/2 是「无记录」,会话过期是「失败」', () => {
    const query = (rdjb: string, status: 'success' | 'no_record' | 'failed', at: string, failureReason?: string) =>
      db.insert(schema.platformQuery).values({
        interface: 'business_list',
        queryKey: '91330211255994457P',
        rdjb,
        queriedAt: at,
        status,
        failureReason: failureReason ?? null,
      }).returning({ id: schema.platformQuery.id }).get().id

    const hit = query('3', 'success', '2026-10-15T17:11:21.514Z')
    const none1 = query('1', 'no_record', '2026-10-15T17:11:21.600Z')
    const none2 = query('2', 'no_record', '2026-10-15T17:11:21.700Z')
    const expired = query('3', 'failed', '2026-10-15T17:20:00.000Z', '登录超时,请重新登录')

    db.insert(schema.platformRelation).values(
      trimmed.map((r, i) => ({
        queryId: hit,
        sequenceNo: i + 1,
        relationKey: r.id,
        enterpriseId: id,
        nameRaw: r.qymc,
        usccRaw: '91330211255994457P',
        province: '宁波市',
        batch: r.whpc,
        declareKind: declareKinds[r.sblx],
        appliedAt: r.sqsj,
        awardBatchLabel: r.personuuid,
        matchBasis: 'uscc' as const,
        verificationStatus: 'confirmed' as const,
      })),
    ).run()

    const relations = db.select().from(schema.platformRelation).all().filter((r) => r.queryId === hit)
    expect(relations).toHaveLength(6) // 不是 1 条
    expect(relations.map((r) => r.sequenceNo).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
    expect(relations.every((r) => r.usccRaw === '91330211255994457P')).toBe(true)

    const queries = db.select().from(schema.platformQuery).all()
    expect(queries.find((q) => q.id === none1)!.status).toBe('no_record')
    expect(queries.find((q) => q.id === none2)!.status).toBe('no_record')
    expect(queries.find((q) => q.id === expired)!.status).toBe('failed')
    // 四态彼此可区分:同 USCC 下 no_record(1/2)与 failed(会话过期)不是一回事。
    expect(new Set([queries.find((q) => q.id === hit)!.status, 'no_record', 'failed']).size).toBe(3)
  })

  it('曾用名由「同 USCC 下 qymc 不同的历史关联行」派生,没有独立别名字段', () => {
    const oldNameRows = db
      .select()
      .from(schema.platformRelation)
      .all()
      .filter((r) => r.nameRaw === '宁波上航测绘有限公司')
    expect(oldNameRows).toHaveLength(2)
    // 同一 USCC、不同 qymc ⇒ 曾用名证据;确认后落 enterprise_alias。
    db.insert(schema.enterpriseAlias).values({
      enterpriseId: id,
      name: '宁波上航测绘有限公司',
      nameNorm: '宁波上航测绘有限公司',
      sourceKind: 'platform_business',
      sourceRefId: oldNameRows[0]!.id,
      verificationStatus: 'confirmed',
    }).run()
    expect(searchEnterpriseId('宁波上航测绘股份有限公司')).toEqual([id])
    // 曾用名把搜索引到同一企业身份(此刻库里还有一个同名无统代主体,即场景九待归并的那条)。
    expect(searchEnterpriseId('宁波上航测绘有限公司')).toContain(id)
    const alias = db
      .select()
      .from(schema.enterpriseAlias)
      .all()
      .find((a) => a.enterpriseId === id && a.name === '宁波上航测绘有限公司')!
    expect(alias.sourceKind).toBe('platform_business')
    expect(alias.sourceRefId).toBe(oldNameRows[0]!.id)
  })

  it('复核关联行佐证「2022 认定 → 2025 复核」,但不推断复核结论', () => {
    const review = db
      .select()
      .from(schema.platformRelation)
      .all()
      .find((r) => r.relationKey === 'SQ332025060392166')!
    expect(review.declareKind).toBe('review')
    expect(review.batch).toBe('2025-1') // whpc:结论年份 2025
    expect(review.awardBatchLabel).toBe('第四批') // → 被复核年份 = 2018 + 4 = 2022
    // 平台只说「发生过复核」,没说结论 ⇒ review_outcome 必须为 NULL(待核),不猜成通过。
    const reviewCase = enterprise('复核口径样例企业', '91330211000000006B')
    const rec = record(reviewCase, 'specialized_sme', 'jxj')
    const reviewEvent = event(rec, 'review', 2022, { decidedYear: 2025 })
    const stored = db.select().from(schema.recordEvent).all().find((e) => e.id === reviewEvent)!
    expect(stored.year).toBe(2022)
    expect(stored.decidedYear).toBe(2025)
    expect(stored.reviewOutcome).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 场景九:确认主体后的归并(375 → 7289)—— 不丢任何称号/事件/出处
// ---------------------------------------------------------------------------

/** 契约 §5.2 的归并:回填 USCC 时不是 UPDATE,而是迁子行 + 解决唯一键冲突的 MERGE。 */
function mergeEnterprises(canonicalId: number, duplicateId: number) {
  const dup = db.select().from(schema.enterprise).all().find((e) => e.id === duplicateId)!
  // 迁移还指着被并企业的子行。
  for (const table of [schema.enterpriseAlias, schema.differenceReason, schema.platformRelation] as const) {
    db.update(table).set({ enterpriseId: canonicalId }).where(eq(table.enterpriseId, duplicateId)).run()
  }
  // 旧名写成已确认别名(旧名不丢)。
  db.insert(schema.enterpriseAlias)
    .values({
      enterpriseId: canonicalId,
      name: dup.name,
      nameNorm: dup.nameNorm,
      sourceKind: 'manual',
      verificationStatus: 'confirmed',
    })
    .onConflictDoNothing()
    .run()
  // 记录:同 (称号, 来源) 冲突时把**事件**并到规范行的那条记录上(事件一条不丢)。
  for (const r of db.select().from(schema.record).all().filter((x) => x.enterpriseId === duplicateId)) {
    const existing = db
      .select()
      .from(schema.record)
      .all()
      .find((x) => x.enterpriseId === canonicalId && x.titleCode === r.titleCode && x.source === r.source)
    if (existing) {
      db.update(schema.recordEvent).set({ recordId: existing.id }).where(eq(schema.recordEvent.recordId, r.id)).run()
      db.delete(schema.record).where(eq(schema.record.id, r.id)).run()
    } else {
      db.update(schema.record).set({ enterpriseId: canonicalId }).where(eq(schema.record.id, r.id)).run()
    }
  }
  db.delete(schema.enterprise).where(eq(schema.enterprise.id, duplicateId)).run()
}

describe('确认主体后归并为总表一行', () => {
  const canonical = shanghangId
  const duplicate = enterprise('宁波上航测绘有限公司', null) // uscc_missing
  const dupRecord = record(duplicate, 'specialized_sme', 'jxj')
  const dupEvent = event(dupRecord, 'award', 2022, { batchSeq: 2 })
  db.insert(schema.recordEvidence).values({
    recordEventId: dupEvent,
    sourceFile: 'jxj/announcement/2022/甬经信中小〔2022〕145号.pdf',
    attachment: '附件',
    listNo: 74,
    page: 74,
  }).run()
  record(canonical, 'specialized_sme', 'miit')
  record(canonical, 'little_giant', 'miit')

  it('回填 USCC 触发 enterprise_uscc_norm_uq 冲突 ⇒ 归并而非 UPDATE,且一行收齐全部称号与出处', () => {
    // 直接 UPDATE 会撞唯一键 —— 这正是必须 MERGE 的原因。
    expect(() =>
      db.update(schema.enterprise).set({ usccNorm: '91330211255994457P' }).where(eq(schema.enterprise.id, duplicate)).run(),
    ).toThrow()

    mergeEnterprises(canonical, duplicate)

    // 总表只有一行带该 USCC。
    expect(db.select().from(schema.enterprise).all().filter((e) => e.usccNorm === '91330211255994457P')).toHaveLength(1)
    // 被并企业行已删除;其称号、事件、出处**一条不丢**。
    expect(db.select().from(schema.enterprise).all().find((e) => e.id === duplicate)).toBeUndefined()
    const titles = db.select().from(schema.record).all().filter((r) => r.enterpriseId === canonical).map((r) => `${r.titleCode}/${r.source}`).sort()
    expect(titles).toEqual(['little_giant/miit', 'specialized_sme/jxj', 'specialized_sme/miit'])
    const kept = db.select().from(schema.recordEvent).all().find((e) => e.id === dupEvent)!
    expect(kept.recordId).toBe(dupRecord) // 无同坐标冲突,记录本身直接改指规范行
    expect(kept.year).toBe(2022)
    const evidence = db.select().from(schema.recordEvidence).all().find((e) => e.recordEventId === dupEvent)!
    expect(evidence.page).toBe(74)
    // 按现名与曾用名搜索都命中同一企业。
    expect(searchEnterpriseId('宁波上航测绘股份有限公司').includes(canonical)).toBe(true)
    expect(searchEnterpriseId('宁波上航测绘有限公司')).toEqual([canonical])
  })

  it('同 (企业, 称号, 来源) 冲突时:事件并到同一条记录,数量不减', () => {
    const a = enterprise('同名冲突甲', null)
    const b = enterprise('同名冲突乙', '91330211000000007C')
    const aRec = record(a, 'innovative_sme', 'jxj')
    event(aRec, 'award', 2021, { batchSeq: 1 })
    const bRec = record(b, 'innovative_sme', 'jxj')
    event(bRec, 'award', 2019, { batchSeq: 2 })

    mergeEnterprises(b, a)

    const merged = db.select().from(schema.record).all().filter((r) => r.enterpriseId === b && r.titleCode === 'innovative_sme')
    expect(merged).toHaveLength(1) // 记录去重
    const events = db.select().from(schema.recordEvent).all().filter((e) => e.recordId === merged[0]!.id)
    expect(events.map((e) => e.year).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([2019, 2021]) // 事件不丢
  })
})
