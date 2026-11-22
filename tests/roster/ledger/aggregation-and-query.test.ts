import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { count } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { allPostgresLedgerRecords as allRecords, listPostgresLedgerRecords as listRecords, readPostgresLedgerEnterpriseDetail as getEnterpriseDetail } from '../../../layers/sme-roster/lib/query-postgres'
import * as schema from '../fixtures/postgres-tables'

let dir: string
let db: ReturnType<typeof usePostgresDirectoryDb>
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined

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
async function seed() {
  const d = db

  const ent = async (name: string, district: string) =>
    (await d
      .insert(schema.enterprise)
      .values({ usccNorm: null, name, nameNorm: name, district, qualityFlags: '["uscc_missing"]' })
      .returning({ id: schema.enterprise.id }))[0]!.id

  const rec = async (
    enterpriseId: number,
    source: 'jxj' | 'miit',
    district: string,
    events: { type: string; year: number | null; seq: number | null }[],
  ) => {
    const id = (await d
      .insert(schema.record)
      .values({ enterpriseId, titleCode: 'specialized_sme', source, district })
      .returning({ id: schema.record.id }))[0]!.id
    for (const ev of events) {
      const eventId = (await d
        .insert(schema.recordEvent)
        .values({ recordId: id, eventType: ev.type as never, year: ev.year, batchSeq: ev.seq, sortKey: ev.year ?? 0 })
        .returning({ id: schema.recordEvent.id }))[0]!.id
      await d.insert(schema.recordEvidence)
        .values({ recordEventId: eventId, sourceFile: `${source}.docx`, attachment: '附件', listNo: ev.seq })
    }
  }

  const jia = await ent('宁波甲科技有限公司', '海曙区')
  await rec(jia, 'jxj', '海曙区', [
    { type: 'award', year: 2024, seq: 2 },
    { type: 'review', year: 2021, seq: 2 },
  ])
  await rec(jia, 'miit', '海曙区', [{ type: 'maintain', year: 2025, seq: 1 }])
  await rec((await ent('宁波乙机械有限公司', '鄞州区')), 'jxj', '鄞州区', [{ type: 'award', year: 2024, seq: 2 }])
  await rec((await ent('宁波丙材料有限公司', '北仑区')), 'jxj', '北仑区', [{ type: 'nurture', year: 2021, seq: null }])
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spztx-query-'))
  postgres = await postgresRuntimeFixture({ dir })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  db = usePostgresDirectoryDb()
  await seed()
}, 60_000)

afterAll(async () => {
  await closePostgresDirectoryDb()
  postgres?.close()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('listRecords aggregation grain (企业 × 称号)', () => {
  it('seeds the expected records, events and groups', async () => {
    const d = db
    expect((await d.select().from(schema.record))).toHaveLength(4)
    expect((await d.select().from(schema.recordEvent))).toHaveLength(5)
    // 3 个「企业 × 称号」组合(甲的两个来源合并为一行)。
    expect((await listRecords(d, {})).total).toBe(3)
  })

  it('merges all sources of one enterprise × title into a single row', async () => {
    const d = db
    const rows = (await listRecords(d, { pageSize: 200 })).rows
    expect(rows).toHaveLength(3)
    const jia = rows.find((r) => r.name === '宁波甲科技有限公司')!
    expect(jia.sources).toEqual(['jxj', 'miit'])
    // 组合下全部事件,各带来源。
    expect(jia.events.map((e) => e.type).sort()).toEqual(['award', 'maintain', 'review'])
    expect(jia.events.map((e) => e.source).sort()).toEqual(['jxj', 'jxj', 'miit'])
  })

  it('orders sources 经信局 → 工信部 and exposes flags', async () => {
    const d = db
    const jia = (await listRecords(d, { q: '宁波甲' })).rows[0]!
    expect(jia.sources).toEqual(['jxj', 'miit'])
    expect(jia.flags).toEqual(['uscc_missing'])
    expect(jia.titleCode).toBe('specialized_sme')
  })
})

describe('listRecords multi-value filters (命中任一即匹配)', () => {
  it('filters by eventType (single and multiple)', async () => {
    const d = db
    expect((await listRecords(d, { eventType: ['award'] })).total).toBe(2)
    expect((await listRecords(d, { eventType: ['review'] })).total).toBe(1)
    expect((await listRecords(d, { eventType: ['maintain'] })).total).toBe(1)
    expect((await listRecords(d, { eventType: ['nurture'] })).total).toBe(1)
    expect((await listRecords(d, { eventType: ['award', 'nurture'] })).total).toBe(3)
    expect((await listRecords(d, { eventType: ['award', 'maintain'] })).total).toBe(2)
  })

  it('filters by year (single and multiple), counting groups once', async () => {
    const d = db
    expect((await listRecords(d, { year: [2024] })).total).toBe(2)
    expect((await listRecords(d, { year: [2021] })).total).toBe(2)
    expect((await listRecords(d, { year: [2025] })).total).toBe(1)
    // 甲(2021 review + 2024 award + 2025 maintain)只计一次。
    expect((await listRecords(d, { year: [2021, 2024] })).total).toBe(3)
    expect((await listRecords(d, { year: [2021, 2024, 2025] })).total).toBe(3)
    expect((await listRecords(d, { year: [1999] })).total).toBe(0)
  })

  it('combines eventType and year conjunctively on the same event', async () => {
    const d = db
    expect((await listRecords(d, { eventType: ['review'], year: [2021] })).total).toBe(1)
    expect((await listRecords(d, { eventType: ['review'], year: [2024] })).total).toBe(0)
    expect((await listRecords(d, { eventType: ['award'], year: [2021] })).total).toBe(0)
    expect((await listRecords(d, { eventType: ['award'], year: [2024] })).total).toBe(2)
    // maintain 仅在 2025(工信部来源)。
    expect((await listRecords(d, { eventType: ['maintain'], year: [2024] })).total).toBe(0)
  })

  it('filters by source (single and multiple)', async () => {
    const d = db
    expect((await listRecords(d, { source: ['jxj'] })).total).toBe(3)
    expect((await listRecords(d, { source: ['miit'] })).total).toBe(1)
    expect((await listRecords(d, { source: ['jxj', 'miit'] })).total).toBe(3)
  })

  it('filters by title (single and multiple)', async () => {
    const d = db
    expect((await listRecords(d, { title: ['specialized_sme'] })).total).toBe(3)
    expect((await listRecords(d, { title: ['specialized_sme', 'little_giant'] })).total).toBe(3)
    expect((await listRecords(d, { title: ['little_giant'] })).total).toBe(0)
  })

  it('filters which rows appear, but keeps each row whole (both sources)', async () => {
    const d = db
    // 只看工信部时,甲的组合因命中工信部而出现,但行内仍应显示**两个来源与全部事件**。
    const jia = (await listRecords(d, { source: ['miit'], q: '宁波甲' })).rows[0]!
    expect(jia.sources).toEqual(['jxj', 'miit'])
    expect(jia.events.map((e) => e.type).sort()).toEqual(['award', 'maintain', 'review'])
  })

  it('keeps a group whole when any event matches', async () => {
    const d = db
    // 按事件筛选时,行因命中 review 而出现,但事件列仍是该组合的全部事件。
    const rows = (await listRecords(d, { eventType: ['review'] })).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sources).toEqual(['jxj', 'miit'])
    expect(rows[0]!.events.map((e) => e.type).sort()).toEqual(['award', 'maintain', 'review'])
  })

  it('keeps allRecords (export) consistent with listRecords', async () => {
    const d = db
    expect((await allRecords(d, {}))).toHaveLength(3)
    expect((await allRecords(d, { eventType: ['award'] }))).toHaveLength(2)
    expect((await allRecords(d, { year: [2021] }))).toHaveLength(2)
    expect((await allRecords(d, { eventType: ['nurture'], year: [2021] }))).toHaveLength(1)
  })
})

describe('listRecords flags filter', () => {
  it('filters to groups whose enterprise has no USCC', async () => {
    const d = db
    expect((await listRecords(d, { flags: 'uscc_missing' })).total).toBe(3)
  })
})

describe('getEnterpriseDetail 的出处页码(RL-10)', () => {
  /** 一条出处:文件 / 附件 / 序号 / 页码。页码给不出就是 `null`(Word / Excel 那条路)。 */
  const withEvidence = async (name: string, evidence: { sourceFile: string; listNo: number; page: number | null }[]) => {
    const d = db
    const enterpriseId = (await d
      .insert(schema.enterprise)
      .values({ usccNorm: null, name, nameNorm: name })
      .returning({ id: schema.enterprise.id }))[0]!.id
    const recordId = (await d
      .insert(schema.record)
      .values({ enterpriseId, titleCode: 'specialized_sme', source: 'jxj', district: '海曙区' })
      .returning({ id: schema.record.id }))[0]!.id
    const eventId = (await d
      .insert(schema.recordEvent)
      .values({ recordId, eventType: 'award', year: 2022, sortKey: 2022 })
      .returning({ id: schema.recordEvent.id }))[0]!.id
    for (const v of evidence) {
      await d.insert(schema.recordEvidence)
        .values({ recordEventId: eventId, sourceFile: v.sourceFile, attachment: '附件', listNo: v.listNo, page: v.page })
    }
    return enterpriseId
  }

  it('详情逐条带页码 —— 有页码、没有页码都照实给(不补 0、不补 1)', async () => {
    const F145 = 'jxj/announcement/2022/甬经信中小〔2022〕145号关于公布宁波市“专精特新”中小企业名单的通知.pdf'
    const id = await withEvidence('宁波页码测试有限公司', [
      { sourceFile: F145, listNo: 6, page: 8 },
      { sourceFile: F145, listNo: 7, page: null },
    ])

    const detail = (await getEnterpriseDetail(db, id))!
    expect(detail.records[0]!.events[0]!.evidence.map(({ id, ...locator }) => locator)).toEqual([
      { sourceFile: F145, attachment: '附件', listNo: 6, page: 8 },
      { sourceFile: F145, attachment: '附件', listNo: 7, page: null },
    ])
  })

  it('导出文本把页码拼在末尾;没有页码就**不写占位**(那一列读得出有没有值)', async () => {
    const F145 = 'jxj/announcement/2022/甬经信中小〔2022〕145号关于公布宁波市“专精特新”中小企业名单的通知.pdf'
    await withEvidence('宁波导出页码公司', [
      { sourceFile: F145, listNo: 6, page: 8 },
      { sourceFile: F145, listNo: 7, page: null },
    ])

    const row = (await allRecords(db, { q: '宁波导出页码公司' }))[0]!
    expect(row.evidence).toContain('序号6 / 第8页')
    expect(row.evidence).toContain('序号7')
    expect(row.evidence).not.toContain("序号7 / 第")
  })

  it('导出保留 DOCX / Excel 出处但忽略其不稳定页码', async () => {
    await withEvidence('宁波办公文件页码测试有限公司', [
      { sourceFile: 'synthetic/notice.docx', listNo: 7, page: 12 },
      { sourceFile: 'synthetic/export.xlsx', listNo: 8, page: 13 },
      { sourceFile: 'synthetic/notice.pdf', listNo: 9, page: 8 },
    ])

    const row = (await allRecords(db, { q: '宁波办公文件页码测试有限公司' }))[0]!
    expect(row.evidence).toContain('synthetic/notice.docx / 附件 / 序号7')
    expect(row.evidence).toContain('synthetic/export.xlsx / 附件 / 序号8')
    expect(row.evidence).not.toContain('第12页')
    expect(row.evidence).not.toContain('第13页')
    expect(row.evidence).toContain('synthetic/notice.pdf / 附件 / 序号9 / 第8页')
  })
})
