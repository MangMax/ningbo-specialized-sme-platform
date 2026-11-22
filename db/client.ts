import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createDrizzleLogger } from '../layers/core/lib/logging/drizzle'
import * as schema from './schema'
import { assertApplicationSchema } from './schema-phase'
import { createRuntimeSchema } from './create-runtime'
import { readOwnerIdentity, sameReadOwner, type ReadOwnerIdentity } from './read-owner-identity'

export interface DbOptions {
  /** SQLite 文件路径。默认 `NUXT_DB_PATH` → `<cwd>/data/roster.db`。 */
  dbPath?: string
  /** 只读打开已完成原生初始化或离线升级的库。 */
  readOnly?: boolean
}

export function resolveDbPath(opts: DbOptions = {}): string {
  return resolve(opts.dbPath ?? process.env.NUXT_DB_PATH ?? join(process.cwd(), 'data/roster.db'))
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
    try { assertApplicationSchema(validation) } finally { validation.close() }
  }
  const sqlite = new Database(path, { readonly: readOnly, fileMustExist: true })
  try {
    if (!readOnly) assertApplicationSchema(sqlite)
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

export function useApplicationDb(opts: DbOptions = {}) {
  return useRuntimeDb(opts)
}

export function initializeDb(opts: DbOptions & { create?: boolean } = {}) {
  const path = resolveDbPath(opts)
  const readOnly = opts.readOnly ?? process.env.NUXT_DB_READONLY === '1'
  if (readOnly) return useRuntimeDb(opts)
  const beforeInitialization = readOwnerIdentity(path)
  if (opts.create) mkdirSync(dirname(path), { recursive: true })
  const sqlite = new Database(path, { fileMustExist: !opts.create })
  try {
    sqlite.pragma('foreign_keys = ON')
    if (!beforeInitialization && opts.create) createRuntimeSchema(sqlite)
    assertApplicationSchema(sqlite)
    sqlite.pragma('journal_mode = WAL')
  } finally { sqlite.close() }
  const runtime = useRuntimeDb(opts)
  if (!beforeInitialization) ownerIdentities.delete(runtime)
  return runtime
}

export { schema }
