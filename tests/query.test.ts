import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readDocxBlocks } from '../lib/docx'
import { parseAnnouncement } from '../lib/announcement'
import { importEntries, newImportContext } from '../lib/import'
import { allRecords, getQuality, getStats, listRecords, type EventType } from '../lib/query'
import { buildAnnouncementDocx } from './fixtures/docx'

let dir: string
let db: (typeof import('../db'))['useDb']
let schema: typeof import('../db/schema')

/**
 * Fixture 覆盖三种事件类型与两个年份:
 * - 附件1(award,2024-2):甲、乙
 * - 附件2(review,2021-2):甲  → 甲同一记录下 award + review 两条事件
 * - 附件3(nurture,2021):丙
 */
async function fixtureEntries() {
  const buf = await buildAnnouncementDocx([
    {
      attachment: '附 件 1',
      title: '2024年第二批宁波市“专精特新”中小企业名单',
      rows: [
        ['序号', '企业名称', '属地'],
        ['1', '宁波甲科技有限公司', '海曙区'],
        ['2', '宁波乙机械有限公司', '鄞州区'],
      ],
    },
    {
      attachment: '附件2',
      title: '2021年第二批宁波市“专精特新”中小企业复核通过名单',
      rows: [
        ['序号', '企业名称', '属地'],
        ['1', '宁波甲科技有限公司', '海曙区'],
      ],
    },
    {
      attachment: '附件3',
      title: '2021年入库培育名单',
      rows: [
        ['序号', '企业名称', '属地'],
        ['1', '宁波丙材料有限公司', '北仑区'],
      ],
    },
  ])
  const blocks = await readDocxBlocks(buf)
  return parseAnnouncement(blocks, { title: 'specialized_sme', sourceFile: 'fixture.docx' })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spztx-query-'))
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  ;({ useDb: db } = await import('../db'))
  schema = (await import('../db')).schema

  const d = db()
  const batch = d
    .insert(schema.importBatch)
    .values({ label: 'fixture', sourceRoot: '/tmp' })
    .returning({ id: schema.importBatch.id })
    .get()
  const ctx = newImportContext(batch.id)
  importEntries(d, ctx, 'specialized_sme', await fixtureEntries())
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
    // fixture 的三家企业均由公布文件导入,均无统代。
    expect(listRecords(d, { flags: 'uscc_missing' }).total).toBe(3)
  })
})
