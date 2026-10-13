import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { allRecords, getQuality, getStats, listRecords, type EventType } from '../lib/query'

let dir: string
let db: (typeof import('../db'))['useDb']
let schema: typeof import('../db/schema')

/**
 * 直接铺一份固定数据集(app 只读台账 —— 测试用 drizzle 插桩,不经过项目外的导入管道)。
 * - 甲:专精特新(经信局) award 2024-2 + review 2021-2 → 同一记录两条事件
 * - 乙:专精特新(经信局) award 2024-2
 * - 丙:专精特新(经信局) nurture 2021
 * 三家企业均无统代 → `uscc_missing`。
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
    district: string,
    events: { type: string; year: number | null; seq: number | null }[],
  ) => {
    const id = d
      .insert(schema.record)
      .values({ enterpriseId, titleCode: 'specialized_sme', source: 'jxj', district })
      .returning({ id: schema.record.id })
      .get().id
    for (const ev of events) {
      const eventId = d
        .insert(schema.recordEvent)
        .values({ recordId: id, eventType: ev.type as never, year: ev.year, batchSeq: ev.seq, sortKey: ev.year ?? 0 })
        .returning({ id: schema.recordEvent.id })
        .get().id
      d.insert(schema.recordEvidence)
        .values({ recordEventId: eventId, sourceFile: 'fixture.docx', attachment: '附件', listNo: ev.seq })
        .run()
    }
  }

  rec(ent('宁波甲科技有限公司', '海曙区'), '海曙区', [
    { type: 'award', year: 2024, seq: 2 },
    { type: 'review', year: 2021, seq: 2 },
  ])
  rec(ent('宁波乙机械有限公司', '鄞州区'), '鄞州区', [{ type: 'award', year: 2024, seq: 2 }])
  rec(ent('宁波丙材料有限公司', '北仑区'), '北仑区', [{ type: 'nurture', year: 2021, seq: null }])
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spztx-query-'))
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  ;({ useDb: db } = await import('../db'))
  schema = (await import('../db')).schema
  seed()
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('listRecords event / year filters', () => {
  it('seeds the expected records and events', () => {
    const d = db()
    expect(d.select().from(schema.record).all()).toHaveLength(3)
    expect(d.select().from(schema.recordEvent).all()).toHaveLength(4)
  })

  it('filters by eventType', () => {
    const d = db()
    expect(listRecords(d, { eventType: 'award' }).total).toBe(2)
    expect(listRecords(d, { eventType: 'review' }).total).toBe(1)
    expect(listRecords(d, { eventType: 'nurture' }).total).toBe(1)
    expect(listRecords(d, { eventType: 'maintain' }).total).toBe(0)
  })

  it('filters by year, counting records (not events) that have a matching event', () => {
    const d = db()
    expect(listRecords(d, { year: 2024 }).total).toBe(2)
    // 甲 (review 2021) + 丙 (nurture 2021);甲 also has a 2024 event but counts once.
    expect(listRecords(d, { year: 2021 }).total).toBe(2)
    expect(listRecords(d, { year: 1999 }).total).toBe(0)
  })

  it('combines eventType and year conjunctively', () => {
    const d = db()
    expect(listRecords(d, { eventType: 'review', year: 2021 }).total).toBe(1)
    expect(listRecords(d, { eventType: 'review', year: 2024 }).total).toBe(0)
    expect(listRecords(d, { eventType: 'award', year: 2021 }).total).toBe(0)
    expect(listRecords(d, { eventType: 'award', year: 2024 }).total).toBe(2)
  })

  it('returns the full matching record with all its events', () => {
    const d = db()
    const rows = listRecords(d, { eventType: 'review' }).rows
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.events).toHaveLength(2)
    expect(row.events.map((e) => e.type).sort()).toEqual(['award', 'review'])
  })

  it('keeps allRecords (export) consistent with listRecords', () => {
    const d = db()
    expect(allRecords(d, { eventType: 'award' })).toHaveLength(2)
    expect(allRecords(d, { year: 2021 })).toHaveLength(2)
    expect(allRecords(d, { eventType: 'nurture', year: 2021 })).toHaveLength(1)
  })
})

describe('getStats counts records, consistent with listRecords', () => {
  it('every bucket equals the matching listRecords total', () => {
    const d = db()
    const stats = getStats(d)
    for (const b of stats.byEvent) {
      expect(listRecords(d, { eventType: b.key as EventType }).total, `eventType=${b.key}`).toBe(b.n)
    }
    for (const b of stats.byYear) {
      if (!/^\d{4}$/.test(b.key)) continue
      expect(listRecords(d, { year: Number(b.key) }).total, `year=${b.key}`).toBe(b.n)
    }
    for (const b of stats.byTitle) {
      expect(listRecords(d, { title: b.key }).total, `title=${b.key}`).toBe(b.n)
    }
    for (const b of stats.bySource) {
      expect(listRecords(d, { source: b.key }).total, `source=${b.key}`).toBe(b.n)
    }
    for (const b of stats.byDistrict) {
      expect(listRecords(d, { district: b.key }).total, `district=${b.key}`).toBe(b.n)
    }
  })

  it('respects title / source / district filters in every bucket', () => {
    const d = db()
    const filter = { title: 'specialized_sme', source: 'jxj' as const }
    const stats = getStats(d, filter)
    expect(stats.totalRecords).toBe(listRecords(d, filter).total)
    for (const b of stats.byEvent) {
      expect(listRecords(d, { ...filter, eventType: b.key as EventType }).total, `eventType=${b.key}`).toBe(b.n)
    }
    for (const b of stats.byYear) {
      if (!/^\d{4}$/.test(b.key)) continue
      expect(listRecords(d, { ...filter, year: Number(b.key) }).total, `year=${b.key}`).toBe(b.n)
    }
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
  it('filters to records whose enterprise has no USCC', () => {
    const d = db()
    expect(listRecords(d, { flags: 'uscc_missing' }).total).toBe(3)
  })
})
