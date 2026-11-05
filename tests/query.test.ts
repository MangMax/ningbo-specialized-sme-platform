import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, count, eq, sql, type SQL } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { allRecords, getEnterpriseDetail, getQuality, getStats, listRecords, type EventType } from '../lib/query'

let dir: string
let db: (typeof import('../db'))['useDb']
let schema: typeof import('../db')['schema']

/**
 * 直接铺一份固定数据集(app 只读台账 —— 测试用 drizzle 插桩,不经过项目外的导入管道)。
 *
 * 粒度 = 企业 × 称号;同一组合可含**多个来源**:
 * - 甲(海曙区):专精特新 · 经信局(award 2024-2 + review 2021-2)+ 专精特新 · 工信部(maintain 2025-1)
 *   —— 同一「企业 × 称号」两个来源,列表应合并为**一行**。
 * - 乙(鄞州区):专精特新 · 经信局 award 2024-2
 * - 丙(北仑区):专精特新 · 经信局 nurture 2021
 * 三家企业均无统代 → `uscc_missing`。
 *
 * 记录 4 条(甲 2 + 乙 1 + 丙 1)、事件 5 条、企业×称号组合 3 个。
 */
function seed() {
  const d = db()

  const ent = (name: string, district: string) =>
    d
      .insert(schema.enterprise)
      .values({ usccNorm: null, name, nameNorm: name, district, qualityFlags: ['uscc_missing'] })
      .returning({ id: schema.enterprise.id })
      .get().id

  const rec = (
    enterpriseId: number,
    source: 'jxj' | 'miit',
    district: string,
    events: { type: string; year: number | null; seq: number | null }[],
  ) => {
    const id = d
      .insert(schema.record)
      .values({ enterpriseId, titleCode: 'specialized_sme', source, district })
      .returning({ id: schema.record.id })
      .get().id
    for (const ev of events) {
      const eventId = d
        .insert(schema.recordEvent)
        .values({ recordId: id, eventType: ev.type as never, year: ev.year, batchSeq: ev.seq, sortKey: ev.year ?? 0 })
        .returning({ id: schema.recordEvent.id })
        .get().id
      d.insert(schema.recordEvidence)
        .values({ recordEventId: eventId, sourceFile: `${source}.docx`, attachment: '附件', listNo: ev.seq })
        .run()
    }
  }

  const jia = ent('宁波甲科技有限公司', '海曙区')
  rec(jia, 'jxj', '海曙区', [
    { type: 'award', year: 2024, seq: 2 },
    { type: 'review', year: 2021, seq: 2 },
  ])
  rec(jia, 'miit', '海曙区', [{ type: 'maintain', year: 2025, seq: 1 }])
  rec(ent('宁波乙机械有限公司', '鄞州区'), 'jxj', '鄞州区', [{ type: 'award', year: 2024, seq: 2 }])
  rec(ent('宁波丙材料有限公司', '北仑区'), 'jxj', '北仑区', [{ type: 'nurture', year: 2021, seq: null }])
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spztx-query-'))
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  ;({ useDb: db } = await import('../db'))
  const { initializeDb } = await import('../db/client')
  initializeDb({ create: true })
  schema = (await import('../db')).schema
  seed()
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** 「企业 × 称号」组合计数(用于校验 getStats —— 统计以组合为单位,与列表/导出一致)。 */
function groupCount(where?: SQL): number {
  return (
    db()
      .select({ n: sql<number>`count(distinct ${schema.record.enterpriseId} || '/' || ${schema.record.titleCode})` })
      .from(schema.record)
      .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
      .where(where)
      .get()?.n ?? 0
  )
}
/** 含某事件的组合数。 */
const groupsWithEventType = (type: string) =>
  db()
    .select({ n: sql<number>`count(distinct ${schema.record.enterpriseId} || '/' || ${schema.record.titleCode})` })
    .from(schema.recordEvent)
    .innerJoin(schema.record, eq(schema.record.id, schema.recordEvent.recordId))
    .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
    .where(eq(schema.recordEvent.eventType, type as 'award' | 'review' | 'maintain' | 'nurture'))
    .get()?.n ?? 0
/** 含某年份事件的组合数。 */
const groupsWithYear = (year: number) =>
  db()
    .select({ n: sql<number>`count(distinct ${schema.record.enterpriseId} || '/' || ${schema.record.titleCode})` })
    .from(schema.recordEvent)
    .innerJoin(schema.record, eq(schema.record.id, schema.recordEvent.recordId))
    .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
    .where(eq(schema.recordEvent.year, year))
    .get()?.n ?? 0

describe('listRecords aggregation grain (企业 × 称号)', () => {
  it('seeds the expected records, events and groups', () => {
    const d = db()
    expect(d.select().from(schema.record).all()).toHaveLength(4)
    expect(d.select().from(schema.recordEvent).all()).toHaveLength(5)
    // 3 个「企业 × 称号」组合(甲的两个来源合并为一行)。
    expect(listRecords(d, {}).total).toBe(3)
  })

  it('merges all sources of one enterprise × title into a single row', () => {
    const d = db()
    const rows = listRecords(d, { pageSize: 200 }).rows
    expect(rows).toHaveLength(3)
    const jia = rows.find((r) => r.name === '宁波甲科技有限公司')!
    expect(jia.sources).toEqual(['jxj', 'miit'])
    // 组合下全部事件,各带来源。
    expect(jia.events.map((e) => e.type).sort()).toEqual(['award', 'maintain', 'review'])
    expect(jia.events.map((e) => e.source).sort()).toEqual(['jxj', 'jxj', 'miit'])
  })

  it('orders sources 经信局 → 工信部 and exposes flags', () => {
    const d = db()
    const jia = listRecords(d, { q: '宁波甲' }).rows[0]!
    expect(jia.sources).toEqual(['jxj', 'miit'])
    expect(jia.flags).toEqual(['uscc_missing'])
    expect(jia.titleCode).toBe('specialized_sme')
  })
})

describe('listRecords multi-value filters (命中任一即匹配)', () => {
  it('filters by eventType (single and multiple)', () => {
    const d = db()
    expect(listRecords(d, { eventType: ['award'] }).total).toBe(2)
    expect(listRecords(d, { eventType: ['review'] }).total).toBe(1)
    expect(listRecords(d, { eventType: ['maintain'] }).total).toBe(1)
    expect(listRecords(d, { eventType: ['nurture'] }).total).toBe(1)
    expect(listRecords(d, { eventType: ['award', 'nurture'] }).total).toBe(3)
    expect(listRecords(d, { eventType: ['award', 'maintain'] }).total).toBe(2)
  })

  it('filters by year (single and multiple), counting groups once', () => {
    const d = db()
    expect(listRecords(d, { year: [2024] }).total).toBe(2)
    expect(listRecords(d, { year: [2021] }).total).toBe(2)
    expect(listRecords(d, { year: [2025] }).total).toBe(1)
    // 甲(2021 review + 2024 award + 2025 maintain)只计一次。
    expect(listRecords(d, { year: [2021, 2024] }).total).toBe(3)
    expect(listRecords(d, { year: [2021, 2024, 2025] }).total).toBe(3)
    expect(listRecords(d, { year: [1999] }).total).toBe(0)
  })

  it('combines eventType and year conjunctively on the same event', () => {
    const d = db()
    expect(listRecords(d, { eventType: ['review'], year: [2021] }).total).toBe(1)
    expect(listRecords(d, { eventType: ['review'], year: [2024] }).total).toBe(0)
    expect(listRecords(d, { eventType: ['award'], year: [2021] }).total).toBe(0)
    expect(listRecords(d, { eventType: ['award'], year: [2024] }).total).toBe(2)
    // maintain 仅在 2025(工信部来源)。
    expect(listRecords(d, { eventType: ['maintain'], year: [2024] }).total).toBe(0)
  })

  it('filters by source (single and multiple)', () => {
    const d = db()
    expect(listRecords(d, { source: ['jxj'] }).total).toBe(3)
    expect(listRecords(d, { source: ['miit'] }).total).toBe(1)
    expect(listRecords(d, { source: ['jxj', 'miit'] }).total).toBe(3)
  })

  it('filters by title (single and multiple)', () => {
    const d = db()
    expect(listRecords(d, { title: ['specialized_sme'] }).total).toBe(3)
    expect(listRecords(d, { title: ['specialized_sme', 'little_giant'] }).total).toBe(3)
    expect(listRecords(d, { title: ['little_giant'] }).total).toBe(0)
  })

  it('filters which rows appear, but keeps each row whole (both sources)', () => {
    const d = db()
    // 只看工信部时,甲的组合因命中工信部而出现,但行内仍应显示**两个来源与全部事件**。
    const jia = listRecords(d, { source: ['miit'], q: '宁波甲' }).rows[0]!
    expect(jia.sources).toEqual(['jxj', 'miit'])
    expect(jia.events.map((e) => e.type).sort()).toEqual(['award', 'maintain', 'review'])
  })

  it('keeps a group whole when any event matches', () => {
    const d = db()
    // 按事件筛选时,行因命中 review 而出现,但事件列仍是该组合的全部事件。
    const rows = listRecords(d, { eventType: ['review'] }).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sources).toEqual(['jxj', 'miit'])
    expect(rows[0]!.events.map((e) => e.type).sort()).toEqual(['award', 'maintain', 'review'])
  })

  it('keeps allRecords (export) consistent with listRecords', () => {
    const d = db()
    expect(allRecords(d, {})).toHaveLength(3)
    expect(allRecords(d, { eventType: ['award'] })).toHaveLength(2)
    expect(allRecords(d, { year: [2021] })).toHaveLength(2)
    expect(allRecords(d, { eventType: ['nurture'], year: [2021] })).toHaveLength(1)
  })
})

describe('getStats counts groups (企业 × 称号 grain)', () => {
  it('totalRecords / buckets equal group counts, and every bucket equals the drill-down total', () => {
    const d = db()
    const stats = getStats(d)
    expect(stats.totalRecords).toBe(groupCount())
    expect(stats.totalRecords).toBe(3)
    expect(stats.totalEnterprises).toBe(3)
    for (const b of stats.byTitle) {
      expect(groupCount(eq(schema.record.titleCode, b.key)), `title=${b.key}`).toBe(b.n)
      expect(listRecords(d, { title: [b.key] }).total, `drill title=${b.key}`).toBe(b.n)
    }
    for (const b of stats.bySource) {
      expect(groupCount(eq(schema.record.source, b.key as 'jxj' | 'miit')), `source=${b.key}`).toBe(b.n)
      expect(listRecords(d, { source: [b.key] }).total, `drill source=${b.key}`).toBe(b.n)
    }
    for (const b of stats.byEvent) {
      expect(groupsWithEventType(b.key), `event=${b.key}`).toBe(b.n)
      expect(listRecords(d, { eventType: [b.key as EventType] }).total, `drill event=${b.key}`).toBe(b.n)
    }
    for (const b of stats.byYear) {
      if (!/^\d{4}$/.test(b.key)) continue
      expect(groupsWithYear(Number(b.key)), `year=${b.key}`).toBe(b.n)
      expect(listRecords(d, { year: [Number(b.key)] }).total, `drill year=${b.key}`).toBe(b.n)
    }
  })

  it('respects title / source filters in every bucket', () => {
    const stats = getStats(db(), { title: 'specialized_sme', source: 'jxj' })
    const expected = groupCount(
      and(eq(schema.record.titleCode, 'specialized_sme'), eq(schema.record.source, 'jxj')),
    )
    expect(stats.totalRecords).toBe(expected)
    expect(stats.totalRecords).toBe(3)
  })
})

describe('getQuality', () => {
  it('reports name_ambiguous with samples when a name maps to multiple subjects', () => {
    const d = db()
    // 同名(归一化后)、不同统代的两个主体 → 重名。
    d.insert(schema.enterprise)
      .values({ usccNorm: '91330200DUP0000001', name: '宁波重名测试有限公司', nameNorm: '宁波重名测试有限公司' })
      .run()
    d.insert(schema.enterprise)
      .values({ usccNorm: '91330200DUP0000002', name: '宁波重名测试有限公司', nameNorm: '宁波重名测试有限公司' })
      .run()

    const g = getQuality(d).find((x) => x.kind === 'name_ambiguous')!
    expect(g.n).toBe(2)
    expect(g.samples.length).toBeGreaterThan(0)
  })
})

describe('listRecords flags filter', () => {
  it('filters to groups whose enterprise has no USCC', () => {
    const d = db()
    expect(listRecords(d, { flags: 'uscc_missing' }).total).toBe(3)
  })
})

describe('getEnterpriseDetail 的出处页码(RL-10)', () => {
  /** 一条出处:文件 / 附件 / 序号 / 页码。页码给不出就是 `null`(Word / Excel 那条路)。 */
  const withEvidence = (name: string, evidence: { sourceFile: string; listNo: number; page: number | null }[]) => {
    const d = db()
    const enterpriseId = d
      .insert(schema.enterprise)
      .values({ usccNorm: null, name, nameNorm: name })
      .returning({ id: schema.enterprise.id })
      .get().id
    const recordId = d
      .insert(schema.record)
      .values({ enterpriseId, titleCode: 'specialized_sme', source: 'jxj', district: '海曙区' })
      .returning({ id: schema.record.id })
      .get().id
    const eventId = d
      .insert(schema.recordEvent)
      .values({ recordId, eventType: 'award', year: 2022, sortKey: 2022 })
      .returning({ id: schema.recordEvent.id })
      .get().id
    for (const v of evidence) {
      d.insert(schema.recordEvidence)
        .values({ recordEventId: eventId, sourceFile: v.sourceFile, attachment: '附件', listNo: v.listNo, page: v.page })
        .run()
    }
    return enterpriseId
  }

  it('详情逐条带页码 —— 有页码、没有页码都照实给(不补 0、不补 1)', () => {
    const F145 = 'jxj/announcement/2022/甬经信中小〔2022〕145号关于公布宁波市“专精特新”中小企业名单的通知.pdf'
    const id = withEvidence('宁波页码测试有限公司', [
      { sourceFile: F145, listNo: 6, page: 8 },
      { sourceFile: F145, listNo: 7, page: null },
    ])

    const detail = getEnterpriseDetail(db(), id)!
    expect(detail.records[0]!.events[0]!.evidence.map(({ id, ...locator }) => locator)).toEqual([
      { sourceFile: F145, attachment: '附件', listNo: 6, page: 8 },
      { sourceFile: F145, attachment: '附件', listNo: 7, page: null },
    ])
  })

  it('导出文本把页码拼在末尾;没有页码就**不写占位**(那一列读得出有没有值)', () => {
    const F145 = 'jxj/announcement/2022/甬经信中小〔2022〕145号关于公布宁波市“专精特新”中小企业名单的通知.pdf'
    withEvidence('宁波导出页码公司', [
      { sourceFile: F145, listNo: 6, page: 8 },
      { sourceFile: F145, listNo: 7, page: null },
    ])

    const row = allRecords(db(), { q: '宁波导出页码公司' })[0]!
    expect(row.evidence).toContain('序号6 / 第8页')
    expect(row.evidence).toContain('序号7')
    expect(row.evidence).not.toContain("序号7 / 第")
  })

  it('导出保留 DOCX / Excel 出处但忽略其不稳定页码', () => {
    withEvidence('宁波办公文件页码测试有限公司', [
      { sourceFile: 'synthetic/notice.docx', listNo: 7, page: 12 },
      { sourceFile: 'synthetic/export.xlsx', listNo: 8, page: 13 },
      { sourceFile: 'synthetic/notice.pdf', listNo: 9, page: 8 },
    ])

    const row = allRecords(db(), { q: '宁波办公文件页码测试有限公司' })[0]!
    expect(row.evidence).toContain('synthetic/notice.docx / 附件 / 序号7')
    expect(row.evidence).toContain('synthetic/export.xlsx / 附件 / 序号8')
    expect(row.evidence).not.toContain('第12页')
    expect(row.evidence).not.toContain('第13页')
    expect(row.evidence).toContain('synthetic/notice.pdf / 附件 / 序号9 / 第8页')
  })
})
