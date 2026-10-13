import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { readDocxBlocks } from '../lib/docx'
import { parseAnnouncement, type ParsedEntry } from '../lib/announcement'
import { importEntries, newImportContext, openImportBatch } from '../lib/import'
import { listBatches, listRecords } from '../lib/query'
import { buildAnnouncementDocx } from './fixtures/docx'

let dir: string
let db: (typeof import('../db'))['useDb']
let schema: typeof import('../db/schema')

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
  ])
  const blocks = await readDocxBlocks(buf)
  return parseAnnouncement(blocks, { title: 'specialized_sme', sourceFile: 'fixture.docx' })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spztx-import-'))
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  ;({ useDb: db } = await import('../db'))
  schema = (await import('../db')).schema
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('announcement parsing + import', () => {
  it('parses both attachment sections into typed events', async () => {
    const entries = await fixtureEntries()
    expect(entries).toHaveLength(3)
    expect(entries.filter((e) => e.eventType === 'award')).toHaveLength(2)
    expect(entries.filter((e) => e.eventType === 'review')).toHaveLength(1)
    expect(entries[0]).toMatchObject({ year: 2024, seq: 2, district: '海曙区' })
    const review = entries.find((e) => e.eventType === 'review')!
    expect(review).toMatchObject({ year: 2021, seq: 2 })
    expect(review.attachment).toBe('附件2')
  })

  it('writes enterprise / record / event / evidence and is idempotent', async () => {
    const db2 = db()
    const batch = db2
      .insert(schema.importBatch)
      .values({ label: 'fixture', sourceRoot: '/tmp' })
      .returning({ id: schema.importBatch.id })
      .get()

    const entries = await fixtureEntries()
    const ctx = newImportContext(batch.id)
    importEntries(db2, ctx, 'specialized_sme', entries)

    // 甲 appears in both sections → one enterprise, one record, two events (award + review).
    // 乙 appears once → one enterprise, one record, one event.
    expect(db2.select().from(schema.enterprise).all()).toHaveLength(2)
    expect(db2.select().from(schema.record).all()).toHaveLength(2)
    expect(db2.select().from(schema.recordEvent).all()).toHaveLength(3)
    expect(db2.select().from(schema.recordEvidence).all()).toHaveLength(3)

    // Re-import the same entries → no new rows.
    importEntries(db2, ctx, 'specialized_sme', entries)
    expect(db2.select().from(schema.recordEvent).all()).toHaveLength(3)
    expect(db2.select().from(schema.enterprise).all()).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 票 11:导入快照与幂等重跑
// ---------------------------------------------------------------------------

/** 最小 ParsedEntry 构造器,便于直接喂给导入管道。 */
function ev(p: Partial<ParsedEntry> & { name: string }): ParsedEntry {
  return {
    title: 'specialized_sme',
    source: 'jxj',
    eventType: 'award',
    year: 2024,
    seq: 2,
    district: '海曙区',
    uscc: null,
    sourceFile: 'fixture.docx',
    attachment: '附 件 1',
    listNo: 1,
    ...p,
  }
}

describe('import snapshots (ticket 11)', () => {
  /** 所有相关表的行数;幂等断言看它是否逐表不变。 */
  const rowCounts = () => {
    const d = db()
    return {
      batches: d.select().from(schema.importBatch).all().length,
      enterprises: d.select().from(schema.enterprise).all().length,
      records: d.select().from(schema.record).all().length,
      events: d.select().from(schema.recordEvent).all().length,
      evidence: d.select().from(schema.recordEvidence).all().length,
    }
  }

  it('same directory + same label is idempotent across every table', () => {
    const d = db()
    const entries = [
      ev({ name: '宁波幂等甲科技有限公司' }),
      ev({ name: '宁波幂等乙机械有限公司', district: '鄞州区' }),
    ]

    const b1 = openImportBatch(d, 'idem-20261013', '/data/idem')
    importEntries(d, newImportContext(b1), 'specialized_sme', entries)
    const before = rowCounts()

    // 完整重跑:同 label → 复用同一快照,全新 ctx。
    const b2 = openImportBatch(d, 'idem-20261013', '/data/idem')
    expect(b2).toBe(b1)
    importEntries(d, newImportContext(b2), 'specialized_sme', entries)

    expect(rowCounts()).toEqual(before)
  })

  it('a new label reuses identities by key and only adds the events it introduces', () => {
    const d = db()
    const a = openImportBatch(d, 'snap-a', '/data/a')
    importEntries(d, newImportContext(a), 'specialized_sme', [
      ev({ name: '宁波快照甲科技有限公司' }),
      ev({ name: '宁波快照乙机械有限公司', district: '鄞州区' }),
    ])
    const before = rowCounts()

    const b = openImportBatch(d, 'snap-b', '/data/a')
    expect(b).not.toBe(a)
    importEntries(d, newImportContext(b), 'specialized_sme', [
      ev({ name: '宁波快照甲科技有限公司' }), // 已存在 → 复用企业与记录
      ev({ name: '宁波快照甲科技有限公司', eventType: 'review', year: 2026, seq: 1 }), // 仅新增事件
      ev({ name: '宁波快照丙智能有限公司' }), // 新企业 → 新记录
    ])
    const after = rowCounts()

    expect(after.batches).toBe(before.batches + 1) // 新快照
    expect(after.enterprises).toBe(before.enterprises + 1) // 仅丙
    expect(after.records).toBe(before.records + 1) // 仅丙的记录
    expect(after.events).toBe(before.events + 2) // 甲的复核 + 丙的认定
    expect(after.evidence).toBe(before.evidence + 2)

    // 快照归属跟随最近一次包含该记录的导入:甲 → snap-b,乙 → snap-a。
    const batchOf = (name: string) =>
      d
        .select({ batchId: schema.record.importBatchId })
        .from(schema.record)
        .innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId))
        .where(eq(schema.enterprise.name, name))
        .get()?.batchId
    expect(batchOf('宁波快照甲科技有限公司')).toBe(b)
    expect(batchOf('宁波快照乙机械有限公司')).toBe(a)
  })

  it('lists snapshots newest-first and filters records by snapshot', () => {
    const d = db()
    const batches = listBatches(d)
    expect(batches.length).toBeGreaterThan(0)
    // 最新在前
    const ids = batches.map((x) => x.id)
    expect(ids).toEqual([...ids].sort((x, y) => y - x))

    const snapB = batches.find((x) => x.label === 'snap-b')!
    expect(snapB.recordCount).toBe(2) // 甲 + 丙

    const names = listRecords(d, { batchId: snapB.id, pageSize: 200 }).rows.map((r) => r.name).sort()
    expect(names).toContain('宁波快照甲科技有限公司')
    expect(names).toContain('宁波快照丙智能有限公司')
    expect(names).not.toContain('宁波快照乙机械有限公司') // 乙只在 snap-a
  })
})
