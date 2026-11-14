import Database from 'better-sqlite3'
import { once } from 'node:events'
import { copyFileSync, mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { serialize } from 'node:v8'
import { afterEach, expect, it, vi } from 'vitest'
import { initializeDb, useRuntimeDb, useApplicationDb, useDb as useHistoricalDb } from '../db/client'
import { assertApplicationRuntime, RETIRED_PLATFORM_TABLES } from '../db/schema-phase'
import { retirePlatformModel } from '../upgrade/retire-platform-model'
import { createEnterpriseReadExecutor } from '../server/utils/enterprise-read'
import { createImportExecutionWorker } from '../server/utils/import-execution-worker-location'
import { createHash } from 'node:crypto'
import { getRosterEnterpriseDetail } from '../lib/roster/enterprise-roster'
import { enterprise } from '../db/schema'
import { writeNewCollectionTarget } from '../lib/platform/collection-target-command'

const fixture = process.env.FINAL_PLATFORM_RETIREMENT_FIXTURE
const evidence = process.env.FINAL_PLATFORM_RETIREMENT_EVIDENCE
if (!fixture || !evidence) throw new Error('Set owned FINAL_PLATFORM_RETIREMENT_FIXTURE and FINAL_PLATFORM_RETIREMENT_EVIDENCE')
const root = mkdtempSync(join(evidence, 'runtime-retirement-'))
const cleanup: Array<() => void | Promise<unknown>> = []
let serial = 0
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})
function target() {
  const path = join(root, `${++serial}.sqlite`)
  copyFileSync(fixture!, path)
  const db = new Database(path)
  db.pragma('foreign_keys=ON')
  cleanup.push(() => { if (db.open) db.close() })
  return { path, db }
}
const importantTables = ['platform_collection', 'platform_business_observation', 'platform_observation_assignment',
  'platform_archive_value', 'platform_apply_projection', 'platform_business_projection', 'platform_recognized_projection',
  'platform_collection_legacy_provenance', 'record_correspondence', 'difference_reason'] as const
function originalRows(db: Database.Database) {
  return importantTables.map(table => ({ table, rows: db.prepare(`SELECT * FROM ${table}`).all() }))
}
function oldTables(db: Database.Database) {
  return RETIRED_PLATFORM_TABLES.filter(name => db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name))
}

it('refuses schema0 at application and source-worker entries while preserving the historical tool adapter', async () => {
  const path = join(root, 'historical.sqlite')
  const legacy = useHistoricalDb({ dbPath: path })
  cleanup.push(() => legacy.$client.close())
  expect(legacy.$client.pragma('user_version', { simple: true })).toBe(0)
  expect(() => useApplicationDb({ dbPath: path })).toThrow('Unsupported final platform runtime schema')
  const reads = createEnterpriseReadExecutor()
  cleanup.push(() => reads.close())
  await expect(reads.list(path)).rejects.toMatchObject({ statusCode:503, code:'enterprise_read_failed' })
  const worker = createImportExecutionWorker()
  cleanup.push(() => worker.terminate())
  expect((await once(worker, 'message'))[0]).toMatchObject({ type:'ready' })
  const stat = statSync(path)
  const response = once(worker, 'message')
  worker.postMessage({ id:1, dbPath:path, readonly:true, identity:{ dev:stat.dev, ino:stat.ino,
    schemaVersion:legacy.$client.pragma('schema_version', { simple:true }),
    migration:legacy.$client.prepare('SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get() },
    action:'preflight', payload:serialize({ idempotencyKey:'historical-worker-refusal', sourceKind:'platform_archive',
      sourceIdentity:'historical-test', payload:{ platformQueries:[] } }), pageCountErrors:[] })
  expect((await response)[0]).toMatchObject({ type:'failure', error:{ message:'Unsupported final platform runtime schema' } })
})

it('keeps final enterprise details typed when a historical rollback environment remains set', () => {
  const owner = initializeDb({ dbPath:join(root, 'native-detail.sqlite'), create:true })
  cleanup.push(() => owner.$client.close())
  owner.insert(enterprise).values({ id:1, name:'Native Detail', nameNorm:'Native Detail', usccNorm:'U1' }).run()
  const rawFields = { id:'native-detail', rdjb:'2', qymc:'Native Detail', tyshxydm:'U1', year:'2025', cszt:'pending' }
  writeNewCollectionTarget(owner, {
    queryText:JSON.stringify({ interface:'apply_list', queryKey:'U1', rdjb:'2',
      queriedAt:'2026-11-14T00:00:00Z', status:'success', rawResponse:'native detail original',
      relations:[{ sequenceNo:1, relationKey:rawFields.id, nameRaw:rawFields.qymc, usccRaw:'U1', rawFields }] }),
    evidenceText:null, createdAt:'2026-11-14T00:00:00Z', assignments:[{ enterpriseId:1, nameRaw:rawFields.qymc,
      usccRaw:'U1', matchBasis:'uscc', verificationStatus:'confirmed', origin:'command',
      actor:{ type:'agent', id:'native-detail' }, basis:'confirmed native detail' }],
  })
  const asOf = Date.UTC(2026, 10, 14)
  const before = getRosterEnterpriseDetail(owner, 1, asOf)!
  expect(before.platform.businessRecords.flatMap(row => row.observationRefs).some(row => row.typedFields !== null)).toBe(true)
  vi.stubEnv('ROSTER_ENTERPRISE_DETAIL_TYPED_READ', 'legacy')
  expect(getRosterEnterpriseDetail(owner, 1, asOf)!.platform.businessRecords).toEqual(before.platform.businessRecords)
  expect(oldTables(owner.$client)).toEqual([])
})

it('serves migrated enterprise details with the reconcile capture collection marker', () => {
  const f = target()
  retirePlatformModel(f.db)
  const owner = useApplicationDb({ dbPath:f.path })
  cleanup.push(() => owner.$client.close())
  const detail = getRosterEnterpriseDetail(owner, 1, Date.UTC(2026, 10, 14))!
  expect(detail.platform.queries.length).toBeGreaterThan(0)
  expect(detail.platform.businessRecords.flatMap(row => row.observationRefs).some(row => row.typedFields !== null)).toBe(true)
  expect(oldTables(f.db)).toEqual([])
})

it('retires historical tables atomically and opens the completed runtime without expand migrations', () => {
  const f = target(), before = originalRows(f.db)
  expect(oldTables(f.db)).toHaveLength(6)
  expect(() => assertApplicationRuntime(f.db)).toThrow('retirement incomplete')
  expect(retirePlatformModel(f.db)).toEqual({ state: 'complete', version: 71613 })
  expect(oldTables(f.db)).toEqual([])
  expect(originalRows(f.db)).toEqual(before)
  expect(f.db.pragma('foreign_key_check')).toEqual([])
  expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok')
  expect(retirePlatformModel(f.db)).toEqual({ state: 'complete', version: 71613 })
  const absentMigrations = join(root, 'no-expand-migrations')
  const runtime = useRuntimeDb({ dbPath: f.path, readOnly: true, migrationsFolder: absentMigrations })
  cleanup.push(() => runtime.$client.close())
  expect(runtime.$client.prepare('SELECT count(*) n FROM platform_collection').get()).toEqual(f.db.prepare('SELECT count(*) n FROM platform_collection').get())
  const restarted = initializeDb({ dbPath: f.path, migrationsFolder: absentMigrations })
  cleanup.push(() => restarted.$client.close())
  expect(oldTables(restarted.$client)).toEqual([])
  expect(originalRows(f.db)).toEqual(before)
  expect(() => f.db.exec("UPDATE platform_runtime_completion SET rule='other'")).toThrow('immutable')
  f.db.exec('CREATE TABLE platform_query(id INTEGER PRIMARY KEY)')
  expect(() => assertApplicationRuntime(f.db)).toThrow('dependency remains')
})

it('keeps the original tables when a required migration is unfinished', () => {
  const f = target(), before = oldTables(f.db)
  f.db.exec("UPDATE platform_migration_run SET state='running' WHERE transform_version='reconcile-slot-capture-v1'")
  expect(() => retirePlatformModel(f.db)).toThrow('prerequisite incomplete')
  expect(oldTables(f.db)).toEqual(before)
  expect(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='platform_runtime_completion'").get()).toBeUndefined()
  expect(() => useRuntimeDb({ dbPath: f.path, readOnly: true })).toThrow('retirement incomplete')
})

it('preserves orphan body bytes and rolls back retirement', () => {
  const f = target(), bytes = Buffer.from('历史正文尾😀')
  f.db.prepare('INSERT INTO platform_body_leaf(id,digest,byte_length,bytes) VALUES(1,?,?,?)')
    .run(createHash('sha256').update(bytes).digest('hex'), bytes.length, bytes)
  expect(() => retirePlatformModel(f.db)).toThrow('orphan historical body leaf')
  expect(oldTables(f.db)).toHaveLength(6)
  expect(f.db.prepare('SELECT bytes FROM platform_body_leaf WHERE id=1').get()).toEqual({ bytes })
  expect(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='platform_runtime_completion'").get()).toBeUndefined()
})

it('serves ordinary and current reads and import preflight through the real source workers', async () => {
  const f = target()
  retirePlatformModel(f.db)
  // The retired target always uses typed source facts, even with an old host setting.
  vi.stubEnv('ROSTER_RECOGNIZED_FILTER_SOURCE', 'legacy')
  const executor = createEnterpriseReadExecutor()
  cleanup.push(() => executor.close())
  const list = await executor.list(f.path, { pageSize: 5 })
  expect(list.rows.length).toBeGreaterThan(0)
  const current = await executor.currentQualifiedJson(f.path, { titleCode: 'little_giant', pageSize: 5 })
  expect(current.found).toBe(true)
  expect(JSON.parse(current.body.toString())).toMatchObject({ titleCode: 'little_giant' })
  const stat = statSync(f.path)
  const identity = { dev: stat.dev, ino: stat.ino, schemaVersion: f.db.pragma('schema_version', { simple: true }),
    migration: f.db.prepare('SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get() }
  const worker = createImportExecutionWorker()
  cleanup.push(() => worker.terminate())
  expect((await once(worker, 'message'))[0]).toMatchObject({ type: 'ready' })
  const response = once(worker, 'message')
  worker.postMessage({ id: 1, dbPath: f.path, readonly: false, identity, action: 'preflight',
    payload: serialize({ idempotencyKey: 'final-runtime-worker', sourceKind: 'platform_archive', sourceIdentity: 'final-runtime',
      payload: { platformQueries: [] } }), pageCountErrors: [] })
  expect((await response)[0]).toMatchObject({ type: 'result', id: 1, result: { status: 'preflight' } })
  expect(f.db.pragma('foreign_key_check')).toEqual([])
  expect(oldTables(f.db)).toEqual([])
}, 30000)

it('creates an empty native target and serves a first import without historical migration rows', async () => {
  const path = join(root, 'native.sqlite')
  const owner = initializeDb({ dbPath: path, create: true })
  expect(useApplicationDb({ dbPath: path })).toBe(owner)
  cleanup.push(() => owner.$client.close())
  expect(oldTables(owner.$client)).toEqual([])
  expect(owner.$client.prepare('SELECT count(*) n FROM platform_migration_run').get()).toEqual({ n: 0 })
  const { commitRosterImport } = await import('../server/utils/roster-import')
  const result = commitRosterImport(owner, { idempotencyKey: 'native-first', sourceKind: 'platform_archive', sourceIdentity: 'native-test',
    payload: { platformQueries: [{ interface: 'business_list', queryKey: 'name:Native', rdjb: '2',
      queriedAt: '2026-11-14T00:00:00Z', status: 'success', rawResponse: 'native original', relations: [{ sequenceNo: 1,
        relationKey: 'native-business', rawFields: { id: 'native-business', rdjb: '2', qymc: 'Native' } }] }] } }, [], { deferCandidateTasks: true })
  expect(result.status, JSON.stringify(result)).toBe('committed')
  const { listTargetBusinessProcesses } = await import('../server/utils/platform-business-processes-target')
  expect(listTargetBusinessProcesses({}, owner).rows).toHaveLength(1)
  expect(owner.$client.pragma('foreign_key_check')).toEqual([])
  owner.$client.close()
  const restarted = initializeDb({ dbPath: path, migrationsFolder: join(root, 'absent') })
  cleanup.push(() => restarted.$client.close())
  expect(oldTables(restarted.$client)).toEqual([])
  expect(restarted.$client.prepare('SELECT count(*) n FROM platform_collection').get()).toEqual({ n: 1 })
  expect(useApplicationDb({ dbPath: path })).toBe(restarted)
  restarted.$client.exec('CREATE TABLE platform_query(id INTEGER PRIMARY KEY)')
  expect(() => useApplicationDb({ dbPath: path })).toThrow('dependency remains')
})
