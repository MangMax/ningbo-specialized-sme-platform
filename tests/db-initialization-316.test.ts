import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { useRuntimeDb as runtimeDb } from '../db/client'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function path() { const dir = mkdtempSync(join(tmpdir(), 'db-316-')); dirs.push(dir); return join(dir, 'nested', 'roster.db') }

it('runtime rejects a missing database without creating its parent directory', () => {
  const dbPath = path()
  expect(() => runtimeDb({ dbPath })).toThrow()
  expect(existsSync(join(dbPath, '..'))).toBe(false)
})

it('runtime rejects an empty existing database without migrating or seeding it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'db-316-')); dirs.push(dir)
  const dbPath = join(dir, 'empty.db')
  const observer = new Database(dbPath)
  try {
    expect(() => runtimeDb({ dbPath })).toThrow()
    expect(observer.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table')).toEqual([])
  } finally { observer.close() }
})

it('explicit setup refuses missing migrations before creating a database', async () => {
  const { initializeDb } = await import('../db/client')
  const dbPath = path()
  expect(() => initializeDb({ dbPath, create: true, migrationsFolder: join(dbPath, '..', 'missing') })).toThrow(/journal/)
  expect(existsSync(join(dbPath, '..'))).toBe(false)
})

it('startup refuses missing and unrelated database paths', async () => {
  const { initializeDb } = await import('../db/client')
  const dbPath = path()
  expect(() => initializeDb({ dbPath })).toThrow()
  expect(existsSync(join(dbPath, '..'))).toBe(false)
  const dir = mkdtempSync(join(tmpdir(), 'db-316-')); dirs.push(dir)
  const unrelated = join(dir, 'other.db'), observer = new Database(unrelated)
  observer.exec('CREATE TABLE unrelated (id INTEGER)')
  try {
    expect(() => initializeDb({ dbPath: unrelated })).toThrow(/__drizzle_migrations/)
    expect(observer.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table')).toEqual([{ name: 'unrelated' }])
  } finally { observer.close() }
})

it('runtime and readonly snapshots preserve legacy rows and never reseed deleted titles', async () => {
  const { useDb: setupDb, getDbOwnerIdentity } = await import('../db/client')
  const dbPath = path(), writer = setupDb({ dbPath })
  writer.$client.exec("INSERT INTO enterprise (name, name_norm) VALUES ('旧企业', '旧企业'); DELETE FROM title WHERE code = 'innovative_sme'")
  expect(getDbOwnerIdentity(writer)).toBeUndefined()
  const snapshot = runtimeDb({ dbPath, readOnly: true })
  const identity = getDbOwnerIdentity(snapshot)
  expect(identity).toBeDefined()
  snapshot.$client.close()
  writer.$client.close()
  const runtime = runtimeDb({ dbPath }), readonly = runtimeDb({ dbPath, readOnly: true })
  try {
    expect(runtime).toBe(runtimeDb({ dbPath }))
    expect(readonly).not.toBe(runtime)
    expect(getDbOwnerIdentity(runtime)).toEqual(identity)
    expect(runtime.$client.prepare('SELECT name FROM enterprise').all()).toEqual([{ name: '旧企业' }])
    expect(readonly.$client.prepare('SELECT name FROM enterprise').all()).toEqual([{ name: '旧企业' }])
    expect(runtime.$client.prepare('SELECT count(*) AS n FROM title').get()).toEqual({ n: 2 })
    expect(runtime.$client.prepare('SELECT total_changes() AS n').get()).toEqual({ n: 0 })
    expect(() => readonly.$client.exec("INSERT INTO enterprise (name, name_norm) VALUES ('拒绝', '拒绝')")).toThrow(/readonly/)
  } finally { readonly.$client.close(); runtime.$client.close() }
})

it('explicit initializer upgrades an old database, survives reopen and remains idempotent', async () => {
  const { initializeDb } = await import('../db/client')
  const { mkdirSync, readFileSync, writeFileSync, copyFileSync } = await import('node:fs')
  const dbPath = path(), folder = join(dbPath, '..', 'old-migrations')
  mkdirSync(join(folder, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync('db/migrations/meta/_journal.json', 'utf8'))
  const expectedMigrationCount = journal.entries.length
  journal.entries = journal.entries.slice(0, -1)
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal))
  for (const entry of journal.entries) copyFileSync(`db/migrations/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`))
  const old = initializeDb({ dbPath, create: true, migrationsFolder: folder })
  old.$client.exec("INSERT INTO enterprise (name, name_norm) VALUES ('保留旧库', '保留旧库')")
  old.$client.close()
  expect(() => runtimeDb({ dbPath })).toThrow(/schema is not current/)
  const upgraded = initializeDb({ dbPath })
  const before = upgraded.$client.prepare('SELECT * FROM __drizzle_migrations').all()
  upgraded.$client.close()
  const restarted = initializeDb({ dbPath })
  try {
    expect(restarted.$client.prepare('SELECT name FROM enterprise').all()).toEqual([{ name: '保留旧库' }])
    expect(restarted.$client.prepare('SELECT count(*) AS n FROM title').get()).toEqual({ n: 3 })
    expect(restarted.$client.prepare('SELECT * FROM __drizzle_migrations').all()).toEqual(before)
    expect(before).toHaveLength(expectedMigrationCount)
  } finally { restarted.$client.close() }
})

it('runtime preserves data_version invalidation and native backup under independent commits', async () => {
  const { initializeDb } = await import('../db/client')
  const dbPath = path(), owner = initializeDb({ dbPath, create: true })
  const reader = runtimeDb({ dbPath, readOnly: true }), external = new Database(dbPath)
  const version = reader.$client.pragma('data_version', { simple: true })
  try {
    external.exec("INSERT INTO enterprise (name, name_norm) VALUES ('外部提交', '外部提交')")
    expect(reader.$client.pragma('data_version', { simple: true })).not.toBe(version)
    expect(runtimeDb({ dbPath, readOnly: true })).toBe(reader)
    const destination = join(dbPath, '..', 'backup.db')
    await owner.$client.backup(destination)
    const backup = new Database(destination, { readonly: true, fileMustExist: true })
    try { expect(backup.prepare('SELECT name FROM enterprise').all()).toEqual([{ name: '外部提交' }]) }
    finally { backup.close() }
  } finally { external.close(); reader.$client.close(); owner.$client.close() }
})

it('startup plugin fails on a missing path and initializes an existing database before runtime consumers', async () => {
  const { initializeDb } = await import('../db/client')
  const previousPath = process.env.NUXT_DB_PATH, previousMode = process.env.NUXT_DB_READONLY
  const globals = globalThis as unknown as Record<string, unknown>
  const previousPlugin = globals.defineNitroPlugin
  globals.defineNitroPlugin = (plugin: unknown) => plugin
  const { default: plugin } = await import('../server/plugins/00-database')
  const start = plugin as unknown as () => void
  const dbPath = path()
  process.env.NUXT_DB_PATH = dbPath
  process.env.NUXT_DB_READONLY = '0'
  try {
    expect(start).toThrow()
    expect(existsSync(join(dbPath, '..'))).toBe(false)
    initializeDb({ dbPath, create: true }).$client.close()
    start()
    const db = runtimeDb()
    expect(db.$client.prepare('SELECT count(*) AS n FROM title').get()).toEqual({ n: 3 })
    db.$client.close()
  } finally {
    if (previousPath === undefined) delete process.env.NUXT_DB_PATH
    else process.env.NUXT_DB_PATH = previousPath
    if (previousMode === undefined) delete process.env.NUXT_DB_READONLY
    else process.env.NUXT_DB_READONLY = previousMode
    globals.defineNitroPlugin = previousPlugin
  }
})
