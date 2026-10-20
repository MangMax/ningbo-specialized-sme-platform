import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { qualifyArtifactAuthority, qualifyMigrationAuthority, readSqliteNativeIdentity } from '../scripts/lib/benchmark-authority.mjs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

it('identifies the native addon actually loaded by the installed SQLite driver', () => {
  const require = createRequire(import.meta.url)
  const identity = readSqliteNativeIdentity(require)
  expect(identity.nativeSha256).toHaveLength(64)
  expect(require.cache[identity.nativePath]?.loaded).toBe(true)
})

it('accepts a pending clean seed and recognizes actual Node migration completion', () => {
  const db = new Database(':memory:')
  try {
    db.exec('CREATE TABLE __drizzle_migrations(id SERIAL PRIMARY KEY,hash TEXT NOT NULL,created_at NUMERIC)')
    const latest = { timestamp: 1792400021006, hash: createHash('sha256').update(readFileSync('db/migrations/0025_platform_query_title_scope_83.sql')).digest('hex') }
    expect(qualifyMigrationAuthority(db, latest).needsCanonicalMigration).toBe(true)
    migrate(drizzle(db), { migrationsFolder: resolve('db/migrations') })
    const authority = qualifyMigrationAuthority(db, latest)
    expect(authority.needsCanonicalMigration).toBe(false)
    expect(authority.ledgerRows).toBe(26)
    expect(authority.lastCreatedAt).toBe(1792400021006)
    expect(authority.objects).toHaveLength(7)
  } finally { db.close() }
})

it('rejects a different compiled runtime even when its advertised source SHA matches', () => {
  const expected = { sourceSha: 'a'.repeat(40), nodeVersion: 'v22.23.3', serverIndexSha256: 'b'.repeat(64), nativeSha256: 'c'.repeat(64), migrationSha256: 'd'.repeat(64) }
  expect(() => qualifyArtifactAuthority(expected, { ...expected, serverIndexSha256: 'e'.repeat(64) })).toThrow('artifact authority mismatch: serverIndexSha256')
  expect(() => qualifyArtifactAuthority(expected, { ...expected, nodeVersion: 'v24.18.0' })).toThrow('artifact authority mismatch: nodeVersion')
  expect(qualifyArtifactAuthority(expected, expected)).toEqual(expected)
})

it('rejects a raw-SQL query artifact whose derived schema lacks the canonical migration receipt', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`CREATE TABLE __drizzle_migrations(id SERIAL PRIMARY KEY,hash TEXT,created_at NUMERIC);
      INSERT INTO __drizzle_migrations(hash,created_at) VALUES('previous',25);
      CREATE TABLE platform_query(id INTEGER PRIMARY KEY,title_code TEXT);
      CREATE INDEX platform_query_title_code_idx ON platform_query(title_code,id);`)
    expect(() => qualifyMigrationAuthority(db, { timestamp: 26, hash: 'canonical-26' })).toThrow('query artifact is not a canonical Node migration source')
    expect(db.prepare('select count(*) n,count(id) ids from __drizzle_migrations').get()).toEqual({ n: 1, ids: 0 })
  } finally { db.close() }
})
