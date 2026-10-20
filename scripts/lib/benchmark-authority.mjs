import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve, sep } from 'node:path'

export function qualifyArtifactAuthority(expected, observed) {
  for (const key of ['sourceSha', 'nodeVersion', 'serverIndexSha256', 'nativeSha256', 'migrationSha256']) {
    assert.ok(typeof expected[key] === 'string' && expected[key].length, `missing expected artifact authority: ${key}`)
    assert.equal(observed[key], expected[key], `artifact authority mismatch: ${key}`)
  }
  return observed
}

export function readSqliteNativeIdentity(require) {
  const Database = require('better-sqlite3')
  const probe = new Database(':memory:'); probe.close()
  const packageRoot = dirname(require.resolve('better-sqlite3/package.json')) + sep
  const loaded = Object.keys(require.cache).filter(path => path.startsWith(packageRoot) && path.endsWith('.node'))
  assert.equal(loaded.length, 1, 'identify the actual loaded SQLite addon; do not guess a build path')
  const nativePath = loaded[0]
  return { nativePath, nativeSha256: createHash('sha256').update(readFileSync(nativePath)).digest('hex') }
}

/** The expected manifest must come from the independently qualified image, never this observation. */
export function readBenchmarkAuthority(sourceSha) {
  const expectedPath = process.env.PERF_EXPECTED_ARTIFACT_MANIFEST
  if (process.env.NODE_PERF_CELL_DIR) assert.ok(expectedPath, 'controlled measurement requires an independently frozen artifact manifest')
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
  const serverIndex = resolve('.output/server/index.mjs')
  const require = createRequire(serverIndex)
  const { nativeSha256, nativePath } = readSqliteNativeIdentity(require)
  const migrationSha256 = hash('db/migrations/0025_platform_query_title_scope_83.sql')
  const observed = { sourceSha, nodeVersion: process.version, serverIndexSha256: hash(serverIndex), nativeSha256, nativePath, migrationSha256 }
  const expected = expectedPath ? JSON.parse(readFileSync(expectedPath, 'utf8')) : null
  if (expected) qualifyArtifactAuthority(expected, observed)
  const journal = JSON.parse(readFileSync('db/migrations/meta/_journal.json', 'utf8')).entries
  const latest = journal.at(-1)
  assert.equal(latest.tag, '0025_platform_query_title_scope_83', 'benchmark migration guard requires requalification for a different journal')
  return { ...observed, guarded: !!expected, imageSourceSha: expected?.imageSourceSha, latest: { timestamp: latest.when, hash: migrationSha256 } }
}

/** Read metadata only; this never repairs a ledger or applies migrations. */
export function qualifyMigrationAuthority(db, latest) {
  const ledger = db.prepare('select hash, created_at from __drizzle_migrations order by created_at').all()
  const objects = db.prepare("select name from sqlite_master where name in ('platform_query_title_code_idx','platform_query_title_scope','platform_query_title_scope_rdjb_query_idx','platform_query_title_scope_error','platform_query_title_scope_insert','platform_query_title_scope_update','platform_query_title_scope_delete') order by name").all().map(row => row.name)
  const lastCreatedAt = Number(ledger.at(-1)?.created_at ?? 0)
  const recorded = ledger.some(row => Number(row.created_at) === latest.timestamp && row.hash === latest.hash)
  const report = { ledgerRows: ledger.length, lastCreatedAt, objects, needsCanonicalMigration: !recorded, expectedLatest: latest }
  assert.ok(lastCreatedAt <= latest.timestamp, 'source migrations are newer than the pinned application')
  if (!recorded && objects.length) throw Object.assign(Error('query artifact is not a canonical Node migration source: derived schema exists without its ledger receipt; recreate from PRE0025, never patch the ledger'), { authority: report })
  assert.ok(lastCreatedAt < latest.timestamp || recorded, 'canonical migration receipt hash mismatch')
  if (recorded) assert.equal(objects.length, 7, 'canonical migration receipt has incomplete derived schema')
  return report
}
