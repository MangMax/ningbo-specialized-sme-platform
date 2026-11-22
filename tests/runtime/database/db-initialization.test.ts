import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { useRuntimeDb as runtimeDb } from '../../../db/client'
import { validateRuntimeMode } from '../../../db/runtime-mode'

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

it('startup refuses missing and unrelated database paths', async () => {
  const { initializeDb } = await import('../../../db/client')
  const dbPath = path()
  expect(() => initializeDb({ dbPath })).toThrow()
  expect(existsSync(join(dbPath, '..'))).toBe(false)
  const dir = mkdtempSync(join(tmpdir(), 'db-316-')); dirs.push(dir)
  const unrelated = join(dir, 'other.db'), observer = new Database(unrelated)
  observer.exec('CREATE TABLE unrelated (id INTEGER)')
  try {
    expect(() => initializeDb({ dbPath: unrelated })).toThrow(/Unsupported final platform runtime schema/)
    expect(observer.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table')).toEqual([{ name: 'unrelated' }])
  } finally { observer.close() }
})

it('runtime and readonly snapshots preserve existing rows and never reseed deleted titles', async () => {
  const { initializeDb: setupDb, getDbOwnerIdentity } = await import('../../../db/client')
  const dbPath = path(), writer = setupDb({ dbPath, create: true })
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

it('native initialization refuses a retired-table sentinel without changing bytes', async () => {
  const { initializeDb } = await import('../../../db/client')
  const dbPath = path()
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(dbPath, '..'), { recursive: true })
  const old = { $client: new Database(dbPath) }
  old.$client.exec("CREATE TABLE enterprise(name TEXT); CREATE TABLE platform_query(id INTEGER); INSERT INTO enterprise VALUES ('保留旧库')")
  const before = old.$client.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all()
  old.$client.close()
  const bytes = readFileSync(dbPath)
  expect(() => initializeDb({ dbPath })).toThrow(/Unsupported final platform runtime schema/)
  expect(readFileSync(dbPath).equals(bytes), 'rejected source bytes remain unchanged').toBe(true)
  const observer = new Database(dbPath, { readonly: true })
  try {
    expect(observer.prepare('SELECT name FROM enterprise').all()).toEqual([{ name: '保留旧库' }])
    expect(observer.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all()).toEqual(before)
  } finally { observer.close() }
})

it('runtime preserves data_version invalidation and native backup under independent commits', async () => {
  const { initializeDb } = await import('../../../db/client')
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

it('requires a PostgreSQL URL even if a previously initialized local database exists', async () => {
  const { initializeDb } = await import('../../../db/client')
  const dbPath = path()
  initializeDb({ dbPath, create: true }).$client.close()
  vi.stubEnv('NUXT_DB_PATH', dbPath)
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', undefined)
  try {
    expect(() => validateRuntimeMode()).toThrow(/NUXT_POSTGRES_DIRECTORY_URL is required/)
  } finally { vi.unstubAllEnvs() }
})

it('allows distinct PostgreSQL roles on the same endpoint and rejects another database or host override', () => {
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', 'postgresql://business@db/roster?host=%2Fvar%2Frun%2Fpostgresql')
  try {
    vi.stubEnv('NUXT_POSTGRES_LOG_URL', 'postgres://log@other:5432/%72oster?host=%2Fvar%2Frun%2Fpostgresql')
    expect(() => validateRuntimeMode()).not.toThrow()
    vi.stubEnv('NUXT_POSTGRES_LOG_URL', 'postgres://log@db/logs?host=%2Fvar%2Frun%2Fpostgresql')
    expect(() => validateRuntimeMode()).toThrow(/same PostgreSQL database/)
    vi.stubEnv('NUXT_POSTGRES_LOG_URL', 'postgres://log@db/roster?host=%2Ftmp')
    expect(() => validateRuntimeMode()).toThrow(/same PostgreSQL database/)
  } finally { vi.unstubAllEnvs() }
})
