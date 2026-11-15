import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function path() { const dir = mkdtempSync(join(tmpdir(), 'historical-startup-')); dirs.push(dir); return join(dir, 'old.db') }
it('native initialization refuses historical migration databases without changing their schema or rows', async () => {
  const { initializeDb } = await import('../../../db/client')
  const { useDb: createHistoricalDb } = await import('../../../upgrade/legacy-client')
  const dbPath = path(), old = createHistoricalDb({ dbPath })
  old.$client.exec("INSERT INTO enterprise (name, name_norm) VALUES ('保留旧库', '保留旧库')")
  const before = old.$client.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all()
  old.$client.close()
  expect(() => initializeDb({ dbPath })).toThrow(/Unsupported final platform runtime schema/)
  const observer = new Database(dbPath, { readonly: true })
  try {
    expect(observer.prepare('SELECT name FROM enterprise').all()).toEqual([{ name: '保留旧库' }])
    expect(observer.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all()).toEqual(before)
  } finally { observer.close() }
})
