import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema'
import { TITLE_SEED } from './titles'

export interface DbOptions {
  /** SQLite 文件路径。默认 `NUXT_DB_PATH` → `<cwd>/data/roster.db`。 */
  dbPath?: string
  /** 迁移目录。默认 `<cwd>/db/migrations`(存在才应用)。 */
  migrationsFolder?: string
}

export function resolveDbPath(opts: DbOptions = {}): string {
  return resolve(opts.dbPath ?? process.env.NUXT_DB_PATH ?? join(process.cwd(), 'data/roster.db'))
}

function resolveMigrations(opts: DbOptions): string {
  return resolve(opts.migrationsFolder ?? join(process.cwd(), 'db/migrations'))
}

const cache = new Map<string, ReturnType<typeof drizzle<typeof schema>>>()

/**
 * 打开(按路径缓存)SQLite 库,应用迁移,写入称号字典。
 *
 * app 只**读**台账;库由项目外的 `../pipeline` 解析后写入。这里应用迁移只为保证库结构
 * 存在(app 拥有数据契约),不产生任何业务数据。运行目录不用 app 根时用 `NUXT_DB_PATH`
 * 覆盖;pipeline 则传入它自己的 `dbPath` / `migrationsFolder`(见 `pipeline/src/db.ts`)。
 */
export function useDb(opts: DbOptions = {}) {
  const path = resolveDbPath(opts)
  const cached = cache.get(path)
  if (cached) return cached

  mkdirSync(dirname(path), { recursive: true })
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  const db = drizzle(sqlite, { schema })

  const migrationsFolder = resolveMigrations(opts)
  if (existsSync(migrationsFolder)) {
    migrate(db, { migrationsFolder })
  }

  // 称号字典是静态参照数据(app 自己的词表),幂等写入。
  for (const t of TITLE_SEED) {
    db.insert(schema.title).values(t).onConflictDoNothing().run()
  }

  cache.set(path, db)
  return db
}

export { schema }
