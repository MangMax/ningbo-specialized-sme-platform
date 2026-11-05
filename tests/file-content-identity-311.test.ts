import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema'
import { backfillFromDisk, getStoredFile, listStoredFiles } from '../server/utils/stored-files'
import { parseUploadDeclaration, registerStoredFile } from '../server/utils/stored-files-upload'
import { compareFileContentIdentity, readStoredFileContentIdentity } from '../server/utils/file-content-identity'
import { readFileMaintenance } from '../server/utils/file-maintenance'

const ABC_SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const XYZ_SHA = '3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282'
const relPath = 'jxj/announcement/2024/1/identity.txt'
let dir: string
let root: string
let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
function put(path: string, content: string) {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), content)
}
function register(path = relPath) {
  return registerStoredFile(db, root, parseUploadDeclaration({ relPath: path }))
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'file-identity-311-'))
  root = join(dir, 'files')
  sqlite = new Database(join(dir, 'fixture.sqlite'))
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: join(process.cwd(), 'db/migrations') })
  put(relPath, 'abc')
})
afterEach(() => {
  sqlite?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('#311 A registered content identity', () => {
  it('size disagreement remains a conflict even when the supplied hash agrees', async () => {
    const { row } = await register()
    const registered = readStoredFileContentIdentity(db, row.id)!
    expect(compareFileContentIdentity(registered, { sha256: ABC_SHA, bytes: 4 })).toEqual({
      code: 'file_content_conflict', fileId: row.id, relPath,
      registered: { sha256: ABC_SHA, bytes: 3 }, observed: { sha256: ABC_SHA, bytes: 4 },
    })
  })

  it('scan reports same-size replacement without changing registered identity or parse state', async () => {
    await backfillFromDisk(db, root)
    const first = listStoredFiles(db).rows[0]!
    db.update(schema.storedFile).set({ parseState: 'parsed', displayName: 'Reviewed notice' }).where(eq(schema.storedFile.id, first.id)).run()
    const before = getStoredFile(db, first.id)
    const maintenance = readFileMaintenance(db, first.id)
    put(relPath, 'xyz')
    const expected = [{ code: 'file_content_conflict', fileId: first.id, relPath,
      registered: { sha256: ABC_SHA, bytes: 3 }, observed: { sha256: XYZ_SHA, bytes: 3 } }]
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await backfillFromDisk(db, root)).toMatchObject({ inserted: 0, updated: 0, unchanged: 0, conflicts: expected })
      expect(getStoredFile(db, first.id)).toEqual(before)
      expect(readFileMaintenance(db, first.id)).toEqual(maintenance)
    }
    expect(readStoredFileContentIdentity(db, first.id)).toEqual({ fileId: first.id, relPath, sha256: ABC_SHA, bytes: 3 })
  })

  it('upload rejects changed bytes with 409 and preserves removed state and maintenance history', async () => {
    const { row } = await register()
    db.update(schema.storedFile).set({ removedAt: '2026-11-05T00:00:00.000Z', parseState: 'parsed' }).where(eq(schema.storedFile.id, row.id)).run()
    const before = readFileMaintenance(db, row.id)
    put(relPath, 'xyz')
    await expect(register()).rejects.toMatchObject({ statusCode: 409, conflict: {
      code: 'file_content_conflict', fileId: row.id, relPath,
      registered: { sha256: ABC_SHA, bytes: 3 }, observed: { sha256: XYZ_SHA, bytes: 3 },
    } })
    expect(readFileMaintenance(db, row.id)).toEqual(before)
  })

  it('original bytes can be restored and retried without creating a new identity', async () => {
    const { row } = await register()
    put(relPath, 'longer replacement')
    const scan = await backfillFromDisk(db, root)
    expect(scan.conflicts).toMatchObject([{ fileId: row.id, observed: { bytes: 18 } }])
    await expect(register()).rejects.toMatchObject({ statusCode: 409 })
    put(relPath, 'abc')
    expect(await backfillFromDisk(db, root)).toEqual({ inserted: 0, updated: 0, unchanged: 1, skipped: [], excluded: [] })
    expect(await register()).toMatchObject({ created: false, row: { id: row.id, sha256: ABC_SHA, bytes: 3 } })
    expect(readFileMaintenance(db, row.id).total).toBe(0)
  })

  it('matching bytes at another path retain a different stable file ID', async () => {
    const first = await register()
    const otherPath = 'jxj/announcement/2024/1/other.txt'
    put(otherPath, 'abc')
    const second = await register(otherPath)
    expect(second.created).toBe(true)
    expect(second.row.id).not.toBe(first.row.id)
    expect(readStoredFileContentIdentity(db, second.row.id)).toEqual({ fileId: second.row.id, relPath: otherPath, sha256: ABC_SHA, bytes: 3 })
    expect(readStoredFileContentIdentity(db, 999999)).toBeNull()
  })

  it('concurrent first registration is idempotent for unchanged content', async () => {
    const results = await Promise.all([register(), register()])
    expect(results.filter(result => result.created)).toHaveLength(1)
    expect(results[0]!.row.id).toBe(results[1]!.row.id)
    expect(listStoredFiles(db).total).toBe(1)
  })
})
