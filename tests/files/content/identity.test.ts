import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { storedFile } from '../../../db/postgresql/file-tables'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import { readPostgresFileIdentity, registerPostgresFile } from '../../../layers/core/server/utils/file-store-postgres'
import { compareFileContentIdentity } from '../../../layers/core/server/utils/file-identity'
import { readPostgresFileMaintenance } from '../../../layers/core/server/utils/file-maintenance-postgres'

const ABC_SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const XYZ_SHA = '3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282'
const relPath = 'uploads/identity.txt'
let dir: string
let root: string
const openDatabase = useIsolatedPostgresCases()
let db: ReturnType<typeof openDatabase>
function put(path: string, content: string) {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), content)
}
function register(path = relPath) {
  return registerPostgresFile(db, root, { relPath: path }, {})
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'file-identity-311-'))
  root = join(dir, 'files')
  db = openDatabase()
  put(relPath, 'abc')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("A registered content identity", () => {
  it('size disagreement remains a conflict even when the supplied hash agrees', async () => {
    const { row } = await register()
    const registered = (await readPostgresFileIdentity(db, row.id))!
    expect(compareFileContentIdentity(registered, { sha256: ABC_SHA, bytes: 4 })).toEqual({
      code: 'file_content_conflict', fileId: row.id, relPath,
      registered: { sha256: ABC_SHA, bytes: 3 }, observed: { sha256: ABC_SHA, bytes: 4 },
    })
  })

  it('upload rejects changed bytes with 409 and preserves removed state and maintenance history', async () => {
    const { row } = await register()
    const removedAt = '2026-11-05T00:00:00.000Z'
    await db.update(storedFile).set({ removedAt }).where(eq(storedFile.id, row.id))
    const before = await readPostgresFileMaintenance(db, row.id, 1, 10)
    put(relPath, 'xyz')
    await expect(register()).rejects.toMatchObject({ statusCode: 409, conflict: {
      code: 'file_content_conflict', fileId: row.id, relPath,
      registered: { sha256: ABC_SHA, bytes: 3 }, observed: { sha256: XYZ_SHA, bytes: 3 },
    } })
    expect(await readPostgresFileMaintenance(db, row.id, 1, 10)).toEqual(before)
    expect(await db.select().from(storedFile)).toMatchObject([{ id: row.id, removedAt, sha256: ABC_SHA }])
  })

  it('original bytes can be restored and retried without creating a new identity', async () => {
    const { row } = await register()
    put(relPath, 'longer replacement')
    await expect(register()).rejects.toMatchObject({ statusCode: 409 })
    put(relPath, 'abc')
    expect(await register()).toMatchObject({ created: false, row: { id: row.id, sha256: ABC_SHA, bytes: 3 } })
    expect((await readPostgresFileMaintenance(db, row.id, 1, 10))?.total).toBe(0)
  })

  it('matching bytes at another path retain a different stable file ID', async () => {
    const first = await register()
    const otherPath = 'uploads/other.txt'
    put(otherPath, 'abc')
    const second = await register(otherPath)
    expect(second.created).toBe(true)
    expect(second.row.id).not.toBe(first.row.id)
    expect(await readPostgresFileIdentity(db, second.row.id)).toEqual({ fileId: second.row.id, relPath: otherPath, sha256: ABC_SHA, bytes: 3 })
    expect(await readPostgresFileIdentity(db, 999999)).toBeNull()
  })

  it('concurrent first registration is idempotent for unchanged content', async () => {
    const results = await Promise.all([register(), register()])
    expect(results.filter(result => result.created)).toHaveLength(1)
    expect(results[0]!.row.id).toBe(results[1]!.row.id)
    expect(await db.select().from(storedFile)).toHaveLength(1)
  })
})
