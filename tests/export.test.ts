import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { allRecords, listRecords, type RecordQuery } from '../lib/query'

let dir: string
let db: (typeof import('../db'))['useDb']
let schema: typeof import('../db')['schema']

/**
 * 直接铺一份跨「来源 × 称号 × 区县 × 事件类型 × 年份」的固定数据集,
 * 用于断言导出(`allRecords`)与列表(`listRecords`)在同一筛选下结果集一致。
 *
 * 9 条记录(经信局 5 + 工信部 4),覆盖 award/review/maintain/nurture 与 2021/2023/2024/2025。
 * 粒度 = 企业 × 称号:甲(专精特新 经信局+工信部)与戊(创新型 经信局+工信部)各合并为一行,
 * 故 9 条记录 → **7 个组合**。
 */
function seed() {
  const d = db()
  const ent = (uscc: string | null, name: string, district: string) =>
    d.insert(schema.enterprise)
      .values({ usccNorm: uscc, name, nameNorm: name, district })
      .returning({ id: schema.enterprise.id })
      .get().id

  const e1 = ent('91330200AAAA000001', '宁波甲科技有限公司', '海曙区')
  const e2 = ent('91330200AAAA000002', '宁波乙机械有限公司', '鄞州区')
  const e3 = ent(null, '宁波丙材料有限公司', '北仑区') // 无统代
  const e4 = ent('91330200AAAA000004', '宁波丁电子有限公司', '慈溪市')
  const e5 = ent('91330200AAAA000005', '宁波戊装备有限公司', '海曙区')
  const e6 = ent('91330200AAAA000006', '宁波己智能有限公司', '海曙区')

  const rec = (
    enterpriseId: number,
    titleCode: string,
    source: 'jxj' | 'miit',
    district: string,
    events: { type: string; year: number | null; seq: number | null }[],
  ) => {
    const id = d
      .insert(schema.record)
      .values({ enterpriseId, titleCode, source, district })
      .returning({ id: schema.record.id })
      .get().id
    for (const ev of events) {
      const eventId = d
        .insert(schema.recordEvent)
        .values({ recordId: id, eventType: ev.type as never, year: ev.year, batchSeq: ev.seq, sortKey: ev.year ?? 0 })
        .returning({ id: schema.recordEvent.id })
        .get().id
      d.insert(schema.recordEvidence)
        .values({ recordEventId: eventId, sourceFile: `${source}.docx`, attachment: '第一部分', listNo: ev.seq })
        .run()
    }
    return id
  }

  rec(e1, 'specialized_sme', 'jxj', '海曙区', [
    { type: 'award', year: 2024, seq: 2 },
    { type: 'review', year: 2021, seq: 2 },
  ])
  rec(e2, 'specialized_sme', 'jxj', '鄞州区', [{ type: 'award', year: 2024, seq: 2 }])
  rec(e3, 'specialized_sme', 'jxj', '北仑区', [{ type: 'nurture', year: 2021, seq: null }])
  rec(e1, 'specialized_sme', 'miit', '海曙区', [{ type: 'maintain', year: 2025, seq: 1 }])
  rec(e4, 'little_giant', 'miit', '慈溪市', [{ type: 'maintain', year: 2025, seq: 1 }])
  rec(e5, 'innovative_sme', 'jxj', '海曙区', [{ type: 'award', year: 2023, seq: 1 }])
  rec(e5, 'innovative_sme', 'miit', '海曙区', [{ type: 'maintain', year: 2025, seq: 1 }])
  rec(e1, 'little_giant', 'miit', '海曙区', [{ type: 'maintain', year: 2024, seq: 1 }])
  rec(e6, 'innovative_sme', 'miit', '海曙区', [{ type: 'maintain', year: 2025, seq: 1 }])
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spztx-export-'))
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  ;({ useDb: db } = await import('../db'))
  schema = (await import('../db')).schema
  seed()
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

interface Keyed {
  name: string
  uscc: string | null
  district: string | null
  titleCode: string
  sources: string[]
}
/** 可见字段组成的组合键,用于跨导出/列表比较结果集(来源按序连接)。 */
function keyOf(r: Keyed): string {
  return [r.name, r.uscc ?? '', r.district ?? '', r.titleCode, r.sources.join(',')].join('|')
}

/** 用列表端点同样的分页上限翻完所有页(导出不分页)。 */
function listAll(params: RecordQuery): { rows: Keyed[]; total: number } {
  const rows: Keyed[] = []
  let page = 1
  let total = 0
  for (;;) {
    const res = listRecords(db(), { ...params, page, pageSize: 200 })
    total = res.total
    rows.push(...res.rows)
    if (rows.length >= total || res.rows.length === 0) break
    page++
  }
  return { rows, total }
}

/** 同一筛选下,导出与列表的条数与结果集(名称等可见字段)必须一致。 */
function assertConsistent(params: RecordQuery, label: string): number {
  const exported = allRecords(db(), params)
  const listed = listAll(params)
  expect(exported.length, `${label} · 条数`).toBe(listed.total)
  expect(exported.map(keyOf).sort(), `${label} · 结果集`).toEqual(listed.rows.map(keyOf).sort())
  return listed.total
}

describe('export ↔ list filter consistency (企业 × 称号 粒度)', () => {
  it('exports one row per enterprise × title when unfiltered', () => {
    expect(assertConsistent({}, 'all')).toBe(7)
  })

  it('stays consistent across title / source / district filters', () => {
    expect(assertConsistent({ title: ['specialized_sme'] }, 'title=specialized_sme')).toBe(3)
    expect(assertConsistent({ title: ['little_giant'] }, 'title=little_giant')).toBe(2)
    expect(assertConsistent({ title: ['innovative_sme'] }, 'title=innovative_sme')).toBe(2)
    expect(assertConsistent({ source: ['jxj'] }, 'source=jxj')).toBe(4)
    expect(assertConsistent({ source: ['miit'] }, 'source=miit')).toBe(5)
    expect(assertConsistent({ district: '海曙区' }, 'district=海曙区')).toBe(4)
  })

  it('stays consistent across eventType and year filters', () => {
    expect(assertConsistent({ eventType: ['award'] }, 'eventType=award')).toBe(3)
    expect(assertConsistent({ eventType: ['review'] }, 'eventType=review')).toBe(1)
    expect(assertConsistent({ eventType: ['maintain'] }, 'eventType=maintain')).toBe(5)
    expect(assertConsistent({ eventType: ['nurture'] }, 'eventType=nurture')).toBe(1)
    expect(assertConsistent({ year: [2021] }, 'year=2021')).toBe(2)
    expect(assertConsistent({ year: [2024] }, 'year=2024')).toBe(3)
    expect(assertConsistent({ year: [2025] }, 'year=2025')).toBe(4)
  })

  it('stays consistent across multi-value filters (命中任一)', () => {
    expect(assertConsistent({ title: ['little_giant', 'innovative_sme'] }, 'title=lg,innov')).toBe(4)
    expect(assertConsistent({ eventType: ['review', 'nurture'] }, 'eventType=review,nurture')).toBe(2)
    expect(assertConsistent({ year: [2021, 2023] }, 'year=2021,2023')).toBe(3)
    expect(assertConsistent({ source: ['jxj', 'miit'] }, 'source=jxj,miit')).toBe(7)
  })

  it('stays consistent across combined filters', () => {
    expect(assertConsistent({ source: ['miit'], eventType: ['maintain'] }, 'miit+maintain')).toBe(5)
    expect(assertConsistent({ source: ['jxj'], eventType: ['award'] }, 'jxj+award')).toBe(3)
    expect(assertConsistent({ title: ['specialized_sme'], year: [2021] }, 'spec+2021')).toBe(2)
    expect(
      assertConsistent({ source: ['jxj'], eventType: ['review'], year: [2021] }, 'jxj+review+2021'),
    ).toBe(1)
    expect(assertConsistent({ district: '海曙区', eventType: ['maintain'] }, '海曙区+maintain')).toBe(4)
    expect(assertConsistent({ q: '宁波甲' }, 'q=宁波甲')).toBe(2)
    // 无命中:两边都应为空集。
    expect(assertConsistent({ eventType: ['award'], year: [2025] }, 'award+2025(空)')).toBe(0)
    expect(assertConsistent({ title: ['little_giant'], source: ['jxj'] }, 'little_giant+jxj(空)')).toBe(0)
  })
})

describe('aggregation: 企业 × 称号 合并来源', () => {
  it('merges a dual-source group into one export row with both sources', () => {
    const rows = allRecords(db(), { title: ['specialized_sme'], q: '宁波甲' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sources).toEqual(['jxj', 'miit'])
    // 合并该组合下全部事件(经信局 award/review + 工信部 maintain)。
    expect(rows[0]!.events.split('; ').sort()).toEqual(['认定 2024-2', '复核 2021-2', '维护 2025-1'].sort())
  })

  it('merges the sources and events in the list row too', () => {
    const rows = listRecords(db(), { title: ['specialized_sme'], q: '宁波甲' }).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sources).toEqual(['jxj', 'miit'])
    expect(rows[0]!.events.map((e) => e.source).sort()).toEqual(['jxj', 'jxj', 'miit'])
  })
})

describe('导出事件与出处', () => {
  it('exports each matching group whole (all sources and events)', () => {
    const rows = allRecords(db(), { title: ['specialized_sme'], source: ['jxj'], q: '宁波甲' })
    expect(rows).toHaveLength(1)
    // 只看经信局时,行因命中经信局而出现,但导出仍含该组合的**两个来源与全部事件**。
    expect(rows[0]!.sources).toEqual(['jxj', 'miit'])
    expect(rows[0]!.events.split('; ').sort()).toEqual(
      ['认定 2024-2', '复核 2021-2', '维护 2025-1'].sort(),
    )
  })

  it('includes a non-empty 出处 (evidence) cell per group, merged over all events', () => {
    const rows = allRecords(db(), { title: ['specialized_sme'], q: '宁波甲' })
    expect(rows).toHaveLength(1)
    // 两条经信局事件 + 一条工信部事件,各带一条出处,以 "; " 连接。
    expect(rows[0]!.evidence).toContain('jxj.docx')
    expect(rows[0]!.evidence).toContain('miit.docx')
    expect(rows[0]!.evidence).toContain('序号2')
    expect(rows[0]!.evidence.split('; ')).toHaveLength(3)
  })
})
