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
  const migrationSha256 = hash('db/migrations/0027_platform_query_title_scope_83.sql')
  const observed = { sourceSha, nodeVersion: process.version, serverIndexSha256: hash(serverIndex), nativeSha256, nativePath, migrationSha256 }
  const expected = expectedPath ? JSON.parse(readFileSync(expectedPath, 'utf8')) : null
  if (expected) qualifyArtifactAuthority(expected, observed)
  const journal = JSON.parse(readFileSync('db/migrations/meta/_journal.json', 'utf8')).entries
  const latest = journal.at(-1)
  assert.equal(latest.tag, '0027_platform_query_title_scope_83', 'benchmark migration guard requires requalification for a different journal')
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

/**
 * Explicit current-read v1 comparison seam; never selected by a legacy export.
 * No I/O, native loading, migration, measurement or qualification occurs here.
 * Expected artifact/workload must be delivered independently BEFORE observation.
 * Receipt identifiers/hashes below are comparison inputs, NOT authenticated
 * receipts: a provenance string (or even matching manifests) cannot prove origin.
 * B owns delivery/semantic oracles; D3 owns per-request/runtime verification.
 */
export function compareCurrentReadAuthority(artifact, workload, observed) {
  const reject = (code, path) => {
    throw Object.assign(new Error(`REJECTED current-read: ${code}: ${path}`), {
      status: 'REJECTED', exitCode: 1, code, path, qualified: false,
    })
  }
  const need = (ok, path) => { if (!ok) reject('INVALID_MANIFEST', path) }
  const object = (value, path) => need(value !== null && typeof value === 'object' && !Array.isArray(value), path)
  const text = (value, path) => need(typeof value === 'string' && value.trim().length > 0, path)
  const hash = (value, path, length = 64) => need(typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value), path)
  const header = (value, path) => {
    object(value, path)
    need(value.lane === 'current-read', `${path}.lane`)
    need(value.schemaVersion === 1, `${path}.schemaVersion`)
  }
  header(artifact, 'artifact')
  header(workload, 'workload')
  // Static fields and ordered closures are checked before runtime fields are read.
  object(artifact.identity, 'artifact.identity')
  const identity = artifact.identity
  hash(identity.sourceSha, 'artifact.identity.sourceSha', 40)
  hash(identity.sourceTree, 'artifact.identity.sourceTree', 40)
  for (const key of ['buildReceiptSha256', 'outputManifestSha256', 'dependencyManifestSha256', 'serverIndexSha256', 'journalSha256']) hash(identity[key], `artifact.identity.${key}`)
  text(artifact.receiptId, 'artifact.receiptId')
  need(Array.isArray(identity.files) && identity.files.length > 0, 'artifact.identity.files')
  const paths = new Set()
  for (const [i, file] of identity.files.entries()) {
    object(file, `artifact.identity.files[${i}]`)
    text(file.path, `artifact.identity.files[${i}].path`)
    need(!paths.has(file.path), `artifact.identity.files[${i}].path duplicate`)
    paths.add(file.path)
    hash(file.sha256, `artifact.identity.files[${i}].sha256`)
  }
  need(identity.files.some(file => file.path === 'server/index.mjs' && file.sha256 === identity.serverIndexSha256), 'artifact.identity.files server entry')
  need(Array.isArray(identity.journal) && identity.journal.length > 0, 'artifact.identity.journal')
  const tags = new Set()
  let lastWhen = -1
  for (const [i, entry] of identity.journal.entries()) {
    object(entry, `artifact.identity.journal[${i}]`)
    text(entry.tag, `artifact.identity.journal[${i}].tag`)
    need(!tags.has(entry.tag), `artifact.identity.journal[${i}].tag duplicate`)
    tags.add(entry.tag)
    need(Number.isSafeInteger(entry.when) && entry.when > lastWhen, `artifact.identity.journal[${i}].when`)
    lastWhen = entry.when
    hash(entry.sqlSha256, `artifact.identity.journal[${i}].sqlSha256`)
  }
  // manifestSha256 identifies a detached, independently delivered document,
  // NOT this comparison envelope (which would require a self-referential hash).
  // B must verify document bytes and their mapping to these fields; this pure
  // seam neither authenticates delivery nor hashes observations into expected.
  hash(artifact.manifestSha256, 'artifact.manifestSha256')
  need(workload.artifactManifestSha256 === artifact.manifestSha256, 'workload.artifactManifestSha256')
  text(workload.receiptId, 'workload.receiptId')
  text(workload.workloadId, 'workload.workloadId')
  for (const key of ['manifestSha256', 'seedManifestSha256', 'generatorBlob', 'fixtureSha256', 'ledgerReceiptSha256', 'parametersSha256', 'semanticExpectedSha256']) hash(workload[key], `workload.${key}`, key === 'generatorBlob' ? 40 : 64)
  need(['http', 'mcp'].includes(workload.transport), 'workload.transport')
  need(['inline', 'postvalidation'].includes(workload.timing), 'workload.timing')
  for (const key of ['samples', 'concurrency']) need(Number.isSafeInteger(workload[key]) && workload[key] > 0, `workload.${key}`)
  // Scenario hashes bind independent request + semantic expected documents.
  // This checks manifest identity/completeness, not response semantics or SLOs.
  need(Array.isArray(workload.scenarios) && workload.scenarios.length > 0, 'workload.scenarios')
  const ids = new Set()
  for (const [i, scenario] of workload.scenarios.entries()) {
    object(scenario, `workload.scenarios[${i}]`)
    text(scenario.id, `workload.scenarios[${i}].id`)
    need(!ids.has(scenario.id), `workload.scenarios[${i}].id duplicate`)
    ids.add(scenario.id)
    need(['full', 'summary', 'interface', 'title', 'key', 'chunk'].includes(scenario.mode), `workload.scenarios[${i}].mode`)
    hash(scenario.requestSha256, `workload.scenarios[${i}].requestSha256`)
    hash(scenario.expectedSha256, `workload.scenarios[${i}].expectedSha256`)
  }
  header(observed, 'observed')
  need(observed.artifact !== artifact && observed.workload !== workload, 'expected and observed must be separate inputs')
  const equal = (expected, actual, path) => {
    try { assert.deepStrictEqual(actual, expected) } catch { reject('IDENTITY_MISMATCH', path) }
  }
  equal(identity, observed.artifact?.identity, 'artifact.identity')
  equal(artifact.manifestSha256, observed.artifact?.manifestSha256, 'artifact.manifestSha256')
  equal(workload, observed.workload, 'workload')
  // Future collectors must supply the actual loaded Node/OS/arch/native identity
  // (readSqliteNativeIdentity), never a guessed addon path or advertised version.
  object(artifact.runtime, 'artifact.runtime')
  for (const key of ['nodeVersion', 'platform', 'arch']) text(artifact.runtime[key], `artifact.runtime.${key}`)
  hash(artifact.runtime.nativeSha256, 'artifact.runtime.nativeSha256')
  equal(artifact.runtime, observed.artifact?.runtime, 'artifact.runtime')
  return { status: 'COMPARED_UNVALIDATED', qualified: false, runtimeQualified: false,
    reason: 'Independent delivery receipts and actual runtime/request verification remain required' }
}
