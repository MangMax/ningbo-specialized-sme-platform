/** Offline retirement boundary tests; native application tests live in final-native-runtime.test.ts. */
import Database from 'better-sqlite3'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { initializeDb, useRuntimeDb, useApplicationDb } from '../../../db/client'
import { assertFinalPlatformRuntime as assertApplicationRuntime } from '../../../db/schema-phase'
import { upgradeTitleCycleDisposition } from '../../../db/title-cycle-disposition'
import { retirePlatformModel } from '../../../upgrade/retire-platform-model'
import { createHash } from 'node:crypto'
import { getRosterEnterpriseDetail } from '../../../lib/roster/enterprise-roster'

const historicalTables = [
  'platform_query_legacy_provenance',
  'platform_relation_body_ref', 'platform_query_body_ref', 'platform_version_body_ref',
  'platform_body_part', 'platform_body_root', 'platform_body_leaf',
  'platform_relation', 'platform_query',
]
import { preRetirementFixture } from './fixtures/pre-retirement'
let fixture: string
let root: string
beforeAll(() => { const f = preRetirementFixture(); fixture=f.target; root=f.root }, 120000)
const cleanup: Array<() => void | Promise<unknown>> = []
let serial = 0
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})
function target() {
  const path = join(root, `${++serial}.sqlite`)
  copyFileSync(fixture, path)
  const db = new Database(path)
  db.pragma('foreign_keys=ON')
  cleanup.push(() => { if (db.open) db.close() })
  return { path, db }
}
const importantTables = ['platform_collection', 'platform_collection_page', 'platform_collection_condition',
  'platform_business_record', 'platform_business_record_version', 'platform_business_observation', 'platform_observation_assignment',
  'platform_observation_fingerprint_basis', 'platform_legacy_query_alias', 'platform_legacy_relation_alias',
  'platform_collection_archive_ref', 'platform_observation_archive_ref', 'platform_version_archive_ref',
  'platform_archive_value', 'platform_apply_projection', 'platform_business_projection', 'platform_recognized_projection',
  'platform_collection_legacy_provenance', 'record_correspondence', 'difference_reason'] as const
function originalRows(db: Database.Database) {
  return importantTables.map(table => ({ table, rows: db.prepare(`SELECT * FROM ${table}`).all() }))
}
function oldTables(db: Database.Database) {
  return historicalTables.filter(name => db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name))
}

it('serves migrated enterprise details with the reconcile capture collection marker', () => {
  const f = target()
  retirePlatformModel(f.db)
  upgradeTitleCycleDisposition(f.db)
  const owner = useApplicationDb({ dbPath:f.path })
  cleanup.push(() => { owner.$client.close() })
  const detail = getRosterEnterpriseDetail(owner, 1, Date.UTC(2026, 10, 14))!
  expect(detail.platform.queries.length).toBeGreaterThan(0)
  expect(detail.platform.businessRecords.flatMap(row => row.observationRefs).some(row => row.typedFields !== null)).toBe(true)
  expect(oldTables(f.db)).toEqual([])
})

it('refuses archive content corruption before retiring any historical table', () => {
  const f = target()
  const id = f.db.prepare('SELECT input_archive_id FROM platform_observation_fingerprint_basis WHERE input_archive_id IS NOT NULL LIMIT 1').pluck().get()
  const original = f.db.prepare('SELECT bytes FROM platform_archive_value WHERE id=?').pluck().get(id)
  const trigger = f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='platform_archive_no_update'").pluck().get()
  if(!Buffer.isBuffer(original)||!original.length||typeof trigger!=='string')throw new Error('Expected a captured fingerprint archive fixture')
  const corrupted = Buffer.from(original)
  corrupted[0] = corrupted[0]! ^ 255
  f.db.exec('DROP TRIGGER platform_archive_no_update')
  f.db.prepare('UPDATE platform_archive_value SET bytes=? WHERE id=?').run(corrupted,id)
  f.db.exec(trigger)
  expect(() => retirePlatformModel(f.db)).toThrow('Archive content digest mismatch')
  expect(oldTables(f.db)).toEqual(historicalTables)
  expect(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='platform_runtime_completion'").get()).toBeUndefined()
})

it('retires historical tables atomically and opens the completed runtime without expand migrations', () => {
  const f = target(), before = originalRows(f.db)
  expect(oldTables(f.db)).toEqual(historicalTables)
  expect(() => assertApplicationRuntime(f.db)).toThrow('retirement incomplete')
  expect(retirePlatformModel(f.db)).toEqual({ state: 'complete', version: 71613 })
  expect(oldTables(f.db)).toEqual([])
  expect(originalRows(f.db)).toEqual(before)
  expect(f.db.pragma('foreign_key_check')).toEqual([])
  expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok')
  expect(retirePlatformModel(f.db)).toEqual({ state: 'complete', version: 71613 })
  const runtime = useRuntimeDb({ dbPath: f.path, readOnly: true })
  cleanup.push(() => { runtime.$client.close() })
  expect(runtime.$client.prepare('SELECT count(*) n FROM platform_collection').get()).toEqual(f.db.prepare('SELECT count(*) n FROM platform_collection').get())
  const restarted = initializeDb({ dbPath: f.path })
  cleanup.push(() => { restarted.$client.close() })
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
  expect(oldTables(f.db)).toEqual(historicalTables)
  expect(f.db.prepare('SELECT bytes FROM platform_body_leaf WHERE id=1').get()).toEqual({ bytes })
  expect(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='platform_runtime_completion'").get()).toBeUndefined()
})

import { createRuntimeSchema } from '../../../db/create-runtime'
it('retired populated catalog matches native creation except the native capability receipt', () => {
 const f=target();retirePlatformModel(f.db)
 // The completed historical migration is frozen. Current readers require this
 // separate, explicit offline additive step before opening the current binary.
 const retainedTables=f.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]
 const retained=()=>retainedTables.map(({name})=>({name,rows:f.db.prepare(`SELECT * FROM "${name}"`).all()}))
 const before=retained()
 expect(f.db.prepare("SELECT name FROM sqlite_schema WHERE name='title_cycle_disposition_revision'").get()).toBeUndefined()
 upgradeTitleCycleDisposition(f.db)
 expect(retained()).toEqual(before) // Includes original source IDs, BLOB bytes and stored hashes.
 const upgraded=f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()
 upgradeTitleCycleDisposition(f.db)
 expect(retained()).toEqual(before)
 expect(f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()).toEqual(upgraded)
 const native=new Database(':memory:')
 try {
  native.pragma('foreign_keys=ON');createRuntimeSchema(native)
  const catalog=(db:Database.Database)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'platform_runtime_capability%' ORDER BY type,name").all()
  // 0053 and the additive capture helper spell this same column differently.
  const columnSql='`max_page_present` integer DEFAULT 0 NOT NULL CHECK (`max_page_present` IN (0,1))'
  const actual=catalog(f.db),expected=catalog(native).map(row=>{const r=row as {sql:string|null};return {...r,sql:r.sql?.replace('max_page_present INTEGER NOT NULL DEFAULT 0 CHECK(max_page_present IN (0,1))',columnSql)??null}})
  expect(actual.map(row=>{const {name,type}=row as {name:string,type:string};return {name,type}})).toEqual(expected.map(row=>{const {name,type}=row as {name:string,type:string};return {name,type}}))
  expect(actual.map((row,i)=>JSON.stringify(row)===JSON.stringify(expected[i])?null:{actual:row,expected:expected[i]}).filter(Boolean)).toEqual([])
  expect(f.db.pragma('foreign_key_check')).toEqual([])
 } finally {native.close()}
})
