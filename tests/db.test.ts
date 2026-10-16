import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let dir: string
let useDb: typeof import('@db/client').useDb
let schema: typeof import('@db/schema')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spztx-db-'))
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  ;({ useDb } = await import('@db/client'))
  schema = await import('@db/schema')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('database bootstrap', () => {
  it('applies migrations and seeds the title dictionary', () => {
    const db = useDb()
    const titles = db.select().from(schema.title).all()
    expect(titles.map((t) => t.code).sort()).toEqual([
      'innovative_sme',
      'little_giant',
      'specialized_sme',
    ])
  })

  it('seeding is idempotent', () => {
    const db = useDb()
    expect(db.select().from(schema.title).all()).toHaveLength(3)
  })

  it('只读打开时不运行迁移或写入称号字典', () => {
    const readOnlyPath = join(dir, 'readonly.db')
    const writable = useDb({ dbPath: readOnlyPath })
    expect(writable.select().from(schema.title).all()).toHaveLength(3)
    writable.$client.close()

    const before = readFileSync(readOnlyPath)
    const readOnly = useDb({ dbPath: readOnlyPath, readOnly: true })
    expect(readOnly.select().from(schema.title).all()).toHaveLength(3)
    expect(() =>
      readOnly
        .insert(schema.title)
        .values({ code: 'no_write', nameZh: '不可写', level: 'municipal', rank: 99 })
        .run(),
    ).toThrow()
    readOnly.$client.close()
    expect(readFileSync(readOnlyPath)).toEqual(before)
  })

  it('enforces (enterprise, title, source) uniqueness on records', () => {
    const db = useDb()
    const ent = db
      .insert(schema.enterprise)
      .values({ name: '测试企业', nameNorm: '测试企业' })
      .returning()
      .get()
    const row = {
      enterpriseId: ent.id,
      titleCode: 'specialized_sme',
      source: 'jxj' as const,
    }
    db.insert(schema.record).values(row).run()
    expect(() => db.insert(schema.record).values(row).run()).toThrow()
    expect(db.select().from(schema.record).all()).toHaveLength(1)
  })
})
