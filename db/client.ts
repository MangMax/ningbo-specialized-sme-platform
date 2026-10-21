import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema'
import { TITLE_SEED } from './titles'
import { readOwnerIdentity, sameReadOwner, type ReadOwnerIdentity } from '../lib/roster/offmain-read-protocol'

export interface DbOptions {
  /** SQLite 文件路径。默认 `NUXT_DB_PATH` → `<cwd>/data/roster.db`。 */
  dbPath?: string
  /** 迁移目录。默认 `<cwd>/db/migrations`(存在才应用)。 */
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

/**
 * 打开(按路径缓存)SQLite 库,应用迁移,写入称号字典。
 *
 * app 只**读**台账;库由项目外的 `../pipeline` 解析后写入。这里应用迁移只为保证库结构
 * 存在(app 拥有数据契约),不产生任何业务数据。运行目录不用 app 根时用 `NUXT_DB_PATH`
 * 覆盖;pipeline 则传入它自己的 `dbPath` / `migrationsFolder`(见 `pipeline/src/db.ts`)。
 */
export function useDb(opts: DbOptions = {}) {
  const path = resolveDbPath(opts)
  const readOnly = opts.readOnly ?? process.env.NUXT_DB_READONLY === '1'
  const cacheKey = `${path}\u0000${readOnly ? 'readonly' : 'readwrite'}`
  const cached = cache.get(cacheKey)
  if (cached) return cached

  mkdirSync(dirname(path), { recursive: true })
  const beforeOpen = readOwnerIdentity(path)
  const sqlite = new Database(path, readOnly ? { readonly: true, fileMustExist: true } : undefined)
  const afterOpen = readOwnerIdentity(path)
  if (!readOnly) sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  const db = drizzle(sqlite, { schema })
  if (!sqlite.memory && sameReadOwner(beforeOpen, afterOpen)) ownerIdentities.set(db, afterOpen!)

  const migrationsFolder = resolveMigrations(opts)
  if (!readOnly && existsSync(migrationsFolder)) {
    migrate(db, { migrationsFolder })
  }

  if (!readOnly) {
    // 称号字典是静态参照数据(app 自己的词表),幂等写入。
    for (const t of TITLE_SEED) {
      db.insert(schema.title).values(t).onConflictDoNothing().run()
    }
  }

  cache.set(cacheKey, db)
  return db
}

export { schema }
