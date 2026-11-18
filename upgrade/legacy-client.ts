/** Historical expand setup and offline oracle adapter. Never import from application code. */
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createDrizzleLogger } from '../layers/core/lib/logging/drizzle'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import * as schema from './legacy-schema'
import { assertApplicationRuntime, assertFinalPlatformRuntime, PLATFORM_RUNTIME_VERSION } from './schema-phase'
import { TITLE_SEED } from '../db/titles'
import { readOwnerIdentity, sameReadOwner, type ReadOwnerIdentity } from '../lib/roster/offmain-read-protocol'

export interface DbOptions {
  /** SQLite 文件路径。默认 `NUXT_DB_PATH` → `<cwd>/data/roster.db`。 */
  dbPath?: string
  /** 历史 expand 工具的显式迁移目录；终态建库和运行不依赖此目录。 */
  migrationsFolder?: string
  /** 只读打开已迁移的库;跳过迁移与称号字典写入。 */
  readOnly?: boolean
}

export function resolveDbPath(opts: DbOptions = {}): string {
  return resolve(opts.dbPath ?? process.env.NUXT_DB_PATH ?? join(process.cwd(), 'data/roster.db'))
}

function resolveMigrations(opts: DbOptions): string {
  return resolve(opts.migrationsFolder ?? join(process.cwd(), 'db/migrations'))
}

const cache = new Map<string, ReturnType<typeof drizzle<typeof schema>>>()
const ownerIdentities = new WeakMap<object, ReadOwnerIdentity>()
const applicationSchemas = new WeakMap<object, unknown>()

/** Only certify a managed disk handle whose identity was observed at open.
 * Cached owners never silently follow a replaced file or symlink. */
export function getDbOwnerIdentity(owner: unknown): ReadOwnerIdentity | undefined {
  if (!owner || typeof owner !== 'object') return
  const identity = ownerIdentities.get(owner)
  if (!identity) return
  try {
    const client = (owner as { $client?: Database.Database }).$client
    if (!client?.open || client.memory || client.inTransaction) return
    return sameReadOwner(identity, readOwnerIdentity(identity.dbPath)) ? { ...identity } : undefined
  } catch { return }
}

/** Runtime connections only open an existing, initialized database. */
export function useRuntimeDb(opts: DbOptions = {}) {
  const path = resolveDbPath(opts)
  const readOnly = opts.readOnly ?? process.env.NUXT_DB_READONLY === '1'
  const cacheKey = `${path}\u0000${readOnly ? 'readonly' : 'readwrite'}`
  const cached = cache.get(cacheKey)
  if (cached?.$client.open) return cached

  const beforeOpen = readOwnerIdentity(path)
  if (readOnly) {
    // Validation must not start the long-lived snapshot's first WAL read.
    const validation = new Database(path, { readonly: true, fileMustExist: true })
    try { validateDatabase(validation, opts) } finally { validation.close() }
  }
  const sqlite = new Database(path, { readonly: readOnly, fileMustExist: true })
  try {
    if (!readOnly) validateDatabase(sqlite, opts)
    const afterOpen = readOwnerIdentity(path)
    if (!readOnly) sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema, logger: createDrizzleLogger({ connection: 'primary' }) })
    if (!sqlite.memory && sameReadOwner(beforeOpen, afterOpen)) ownerIdentities.set(db, afterOpen!)
    cache.set(cacheKey, db)
    return db
  } catch (error) {
    sqlite.close()
    throw error
  }
}

function validateDatabase(sqlite: Database.Database, opts: DbOptions) {
  assertApplicationRuntime(sqlite)
  if (sqlite.pragma('user_version', { simple: true }) === PLATFORM_RUNTIME_VERSION) return
  const expected = readMigrationFiles({ migrationsFolder: resolveMigrations(opts) }).at(-1)
  if (!expected) throw new Error('Database migrations are empty')
  const actual = sqlite.prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get() as { hash: string; created_at: number } | undefined
  if (actual?.hash !== expected.hash || actual.created_at !== expected.folderMillis) {
    throw new Error('Database schema is not current; run explicit initialization')
  }
  sqlite.prepare('SELECT code, name_zh FROM title LIMIT 0').all()
  sqlite.prepare('SELECT id, name, name_norm FROM enterprise LIMIT 0').all()
  sqlite.prepare('SELECT id, enterprise_id, title_code, source FROM record LIMIT 0').all()
}

/** Public application entry: schema0 is available only to explicit historical tools. */
export function useApplicationDb(opts: DbOptions = {}) {
  const db = useRuntimeDb(opts)
  const version = db.$client.pragma('schema_version', { simple: true })
  if (!applicationSchemas.has(db) || applicationSchemas.get(db) !== version) {
    assertFinalPlatformRuntime(db.$client)
    applicationSchemas.set(db, version)
  }
  return db
}

/** Startup/CLI setup; new files require explicit create authorization. */
export function initializeDb(opts: DbOptions & { create?: boolean } = {}) {
  const path = resolveDbPath(opts)
  const readOnly = opts.readOnly ?? process.env.NUXT_DB_READONLY === '1'
  if (readOnly) return useRuntimeDb(opts)
  const migrationsFolder = resolveMigrations(opts)
  const beforeInitialization = readOwnerIdentity(path)
  readMigrationFiles({ migrationsFolder })
  if (opts.create) mkdirSync(dirname(path), { recursive: true })
  const sqlite = new Database(path, { fileMustExist: !opts.create })
  try {
    assertApplicationRuntime(sqlite)
    // An existing unrelated/empty file is not an upgrade target.
    if (!opts.create) sqlite.prepare('SELECT hash, created_at FROM __drizzle_migrations LIMIT 1').all()
    if (sqlite.pragma('user_version', { simple: true }) === 0) readMigrationFiles({ migrationsFolder })
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema, logger: createDrizzleLogger({ connection: 'primary' }) })
    if (sqlite.pragma('user_version', { simple: true }) === 0) {
      migrate(db, { migrationsFolder })
      for (const t of TITLE_SEED) db.insert(schema.title).values(t).onConflictDoNothing().run()
    }
    validateDatabase(sqlite, opts)
  } finally { sqlite.close() }
  const runtime = useRuntimeDb(opts)
  if (!beforeInitialization) ownerIdentities.delete(runtime)
  return runtime
}

/** Legacy pipeline/test setup adapter. Production imports useDb from db/index. */
export function useDb(opts: DbOptions = {}) {
  const path = resolveDbPath(opts)
  const readOnly = opts.readOnly ?? process.env.NUXT_DB_READONLY === '1'
  const cached = cache.get(`${path}\u0000${readOnly ? 'readonly' : 'readwrite'}`)
  if (cached?.$client.open) return cached
  return initializeDb({ ...opts, migrationsFolder: resolveMigrations(opts), create: true })
}

export { schema }
