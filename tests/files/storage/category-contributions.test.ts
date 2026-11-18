import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inArray, sql } from 'drizzle-orm'
import { initializeDb } from '../../../db/client'
import { storedFile } from '../../../db/schema'
import { createFileStore, type FileStoreDb, type FileQueryFilters } from '../../../server/utils/file-store'
import { extendFileOpenApi } from '../../../server/utils/file-openapi'
import { rosterFileServerCategory } from '../../../server/modules/sme-roster/files'

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'file-categories-')) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

it('composes a second registered category for backfill, fields, filters, placement and metadata', () => {
  const db = initializeDb({ create: true, dbPath: join(dir, 'files.sqlite') })
  // A fixture-owned metadata table, populated and read only through the contribution.
  db.run(sql`create table collection_file (file_id integer primary key, collection text)`)
  const catalog = {
    id: 'catalog',
    filters: [{
      key: 'collection', label: '馆藏', placeholder: '全部馆藏', width: 'w-28',
      options: [{ value: 'local', label: '本地' }, { value: 'remote', label: '外部' }],
      description: '馆藏,多值:`local` / `remote`。',
    }],
    readFields(db: FileStoreDb, ids: readonly number[]) {
      return new Map(db.all<{ file_id: number; collection: string }>(sql`
        select file_id, collection from collection_file where file_id in ${ids}
      `).map(({ file_id, collection }) => [file_id, { collection }]))
    },
    constraint(db: FileStoreDb, filters: FileQueryFilters) {
      if (!filters.collection?.length) return
      const matching = db.all<{ file_id: number }>(sql`
        select file_id from collection_file where collection in ${filters.collection}
      `)
      return inArray(storedFile.id, matching.map(row => row.file_id))
    },
    prepareBackfill(path: string) {
      if (!path.startsWith('catalog/')) return null
      return (db: FileStoreDb, id: number) => {
        db.run(sql`insert into collection_file values (${id}, 'local')`)
      }
    },
    landing: (metadata: Record<string, string | null | undefined>) => ['catalog', metadata.filename!],
    metadata: {
      properties: { collection: { type: 'string' } },
      parse: (input: Record<string, unknown>) => ({ collection: String(input.collection) }),
      write(db: FileStoreDb, id: number, patch: Record<string, unknown>) {
        return db.run(sql`update collection_file set collection = ${patch.collection} where file_id = ${id}`).changes === 1
      },
    },
  }
  const categories = [rosterFileServerCategory, catalog] as const
  const files = createFileStore(categories)
  const list = { parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }] }
  extendFileOpenApi({ paths: { '/api/files': { get: list } } }, categories)
  expect(list.parameters.map(parameter => parameter.name))
    .toEqual(['source', 'categoryState', 'parseState', 'collection', 'q'])
  const scan = (relPath: string, filename: string) => ({ relPath, filename, bytes: 3, ext: 'pdf', sha256: 'a'.repeat(64) })
  expect(files.backfillStoredFiles(db, [
    scan('jxj/announcement/2024/notice.pdf', 'notice.pdf'),
    scan('catalog/guide.pdf', 'guide.pdf'),
  ])).toMatchObject({ inserted: 2, skipped: [] })

  const { rows, total } = files.listStoredFiles(db, { collection: 'local' })
  expect(total).toBe(1)
  const [guide] = rows
  expect(guide).toMatchObject({ filename: 'guide.pdf', collection: 'local' })
  expect(files.getStoredFile(db, guide!.id)).toMatchObject({ collection: 'local' })
  expect(files.listStoredFiles(db, { source: 'jxj', collection: 'local' }).total).toBe(0)

  expect(files.resolveUploadPlacement({ fileCategory: 'catalog', filename: 'guide.pdf' })).toEqual(['catalog', 'guide.pdf'])
  expect(files.resolveUploadPlacement({ source: 'jxj', kind: 'announcement', filename: 'notice.pdf' }))
    .toEqual(['jxj', 'announcement', 'notice.pdf'])

  const notice = files.listStoredFiles(db, { q: 'notice' }).rows[0]!
  // A combined patch may reach more than one owner. A declined write rolls back all changes.
  const mixedPatch = files.parseMetadataPatch({ year: '2026', collection: 'remote' })
  expect(mixedPatch).toEqual({ year: 2026, collection: 'remote' })
  expect(files.updateStoredFile(db, notice.id, mixedPatch)).toBeNull()
  expect(files.getStoredFile(db, notice.id)).toMatchObject({ year: 2024 })
  expect(files.updateStoredFile(db, guide!.id, files.parseMetadataPatch({ collection: 'remote' })))
    .toMatchObject({ collection: 'remote' })
  expect(files.listStoredFiles(db, { collection: ['remote', 'local'] }).total).toBe(1)
})
