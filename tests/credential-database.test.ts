import { initializeDb } from '../db/client'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { schema } from '../db'
import { allRecords } from '../lib/query'
import { allRosterEnterprises } from '../lib/roster/enterprise-roster'
import { updateCredentials } from '../server/utils/credential-state'
let dir: string
const connections: Database.Database[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'credential-db-')) })
afterEach(() => { for (const db of connections.splice(0)) if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }) })
it('upgrades an existing database without changing business rows', () => {
  const previous = join(dir, 'previous-migrations')
  mkdirSync(join(previous, 'meta'), { recursive: true })
  const migrations = resolve('db/migrations')
  const journal = JSON.parse(readFileSync(join(migrations, 'meta/_journal.json'), 'utf8'))
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 9)
  writeFileSync(join(previous, 'meta/_journal.json'), JSON.stringify(journal))
  for (const entry of journal.entries) copyFileSync(join(migrations, entry.tag + '.sql'), join(previous, entry.tag + '.sql'))
  const sqlite = new Database(join(dir, 'upgrade.sqlite')); connections.push(sqlite)
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: previous })
  db.insert(schema.enterprise).values({ name: 'Synthetic kept enterprise', nameNorm: 'synthetic kept enterprise' }).run()
  const before = db.select().from(schema.enterprise).all()
  migrate(db, { migrationsFolder: migrations })
  expect(db.select().from(schema.enterprise).all()).toEqual(before)
  expect(db.select().from(schema.serviceCredential).all()).toEqual([])
  updateCredentials({ ocrToken: 'synthetic-upgraded' }, { db, env: {} })
  expect(db.select().from(schema.serviceCredential).get()?.value).toBe('synthetic-upgraded')
  expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok')
})
it('keeps credential values out of ordinary roster export rows', () => {
  const db = initializeDb({ create: true, dbPath: join(dir, 'export.sqlite') }); connections.push(db.$client)
  const enterprise = db.insert(schema.enterprise).values({ name: 'Synthetic export enterprise', nameNorm: 'synthetic export enterprise' }).returning().get()
  db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).run()
  updateCredentials({ ocrToken: 'synthetic-not-exported-ocr', miitCookie: 'session=synthetic-not-exported-cookie' }, { db, env: {} })
  const records = allRecords(db, {})
  const enterprises = allRosterEnterprises(db, {})
  expect(records).toHaveLength(1)
  expect(enterprises.rows).toHaveLength(1)
  expect(JSON.stringify({ records, enterprises })).not.toMatch(/synthetic-not-exported|service_credential|ocrToken|miitCookie/)
})
it('reopens the native credential database without changing its provenance or business rows', () => {
  const source = join(dir, 'source.sqlite')
  const db = initializeDb({ create: true, dbPath: source }); connections.push(db.$client)
  db.insert(schema.enterprise).values({ name: 'Synthetic native credential enterprise', nameNorm: 'synthetic native credential enterprise' }).run()
  updateCredentials({ ocrToken: 'synthetic-native-secret-ocr', miitCookie: 'session=synthetic-native-secret-cookie' }, { db, env: {} })
  const business = db.select().from(schema.enterprise).all()
  const credentials = db.select().from(schema.serviceCredential).all()
  const completion = db.$client.prepare('SELECT rule,schema_version FROM platform_runtime_completion WHERE id=1').get()
  expect(completion).toEqual({ rule: 'platform-mixed-model-retirement-v1', schema_version: 71613 })
  expect(db.$client.prepare("SELECT name FROM sqlite_schema WHERE name IN ('platform_query','platform_relation')").all()).toEqual([])
  db.$client.close()
  const bytes = readFileSync(source)
  const readonly = initializeDb({ dbPath: source, readOnly: true }); connections.push(readonly.$client)
  expect(readonly.select().from(schema.enterprise).all()).toEqual(business)
  expect(readonly.select().from(schema.serviceCredential).all()).toEqual(credentials)
  expect(readonly.$client.prepare('SELECT total_changes() AS n').get()).toEqual({ n: 0 })
  readonly.$client.close()
  expect(readFileSync(source)).toEqual(bytes)
})
