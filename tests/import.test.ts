import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { readDocxBlocks } from '../lib/docx'
import { parseAnnouncement } from '../lib/announcement'
import { importEntries, newImportContext } from '../lib/import'
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
