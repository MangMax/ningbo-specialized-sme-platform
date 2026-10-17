import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { schema, useDb } from '../db'
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
  const db = useDb({ dbPath: join(dir, 'export.sqlite') }); connections.push(db.$client)
  const enterprise = db.insert(schema.enterprise).values({ name: 'Synthetic export enterprise', nameNorm: 'synthetic export enterprise' }).returning().get()
  db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).run()
  updateCredentials({ ocrToken: 'synthetic-not-exported-ocr', miitCookie: 'session=synthetic-not-exported-cookie' }, { db, env: {} })
  const records = allRecords(db, {})
  const enterprises = allRosterEnterprises(db, {})
  expect(records).toHaveLength(1)
  expect(enterprises.rows).toHaveLength(1)
  expect(JSON.stringify({ records, enterprises })).not.toMatch(/synthetic-not-exported|service_credential|ocrToken|miitCookie/)
})
it('removes credentials and their raw bytes from demo database copies without changing the source', () => {
  const source = join(dir, 'source.sqlite'), out = join(dir, 'demo.sqlite')
  const db = useDb({ dbPath: source }); connections.push(db.$client)
  for (const name of ['宁波上航测绘股份有限公司', '宁波上航测绘有限公司']) db.insert(schema.enterprise).values({ name, nameNorm: name }).run()
  updateCredentials({ ocrToken: 'synthetic-demo-secret-ocr', miitCookie: 'session=synthetic-demo-secret-cookie' }, { db, env: {} })
  const before = db.$client.serialize()
  const output = execFileSync(process.execPath, ['scripts/seed-platform-evidence-demo.mjs', '--db', source, '--out', out], { cwd: process.cwd(), encoding: 'utf8' })
  expect(output).not.toContain('synthetic-demo-secret')
  const copy = new Database(out, { readonly: true }); connections.push(copy)
  expect(copy.prepare('SELECT * FROM service_credential').all()).toEqual([])
  expect(copy.prepare('SELECT count(*) AS count FROM platform_query').get()).toMatchObject({ count: 5 })
  expect(readFileSync(out).includes(Buffer.from('synthetic-demo-secret'))).toBe(false)
  expect(db.$client.serialize()).toEqual(before)
})
