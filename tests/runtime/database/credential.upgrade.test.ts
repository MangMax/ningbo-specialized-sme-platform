import { resolveOcrConfig } from '../../../layers/core/server/utils/ocr-config-sqlite'
import { initializeDb } from '../../../db/client'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { schema } from '../../../db'
import { allRecords } from '../../../layers/sme-roster/lib/query'
import { allRosterEnterprises } from '../../../layers/sme-roster/lib/roster/enterprise-roster'
import { updateCredentials } from '../../../layers/core/server/utils/credential-state'
import { ocrImageFile } from '../../../layers/core/server/utils/ocr-api'
import { resolvePlatformCookie } from '../../../layers/sme-roster/server/utils/platform-credential'
import { queryAllRdjb } from '../../../layers/sme-roster/lib/platform/client'
import { startMiniOcrApi } from '../../files/ocr/fixtures/provider-api'
import { EMPTY_APPLY_RESPONSE, platformFixture } from '../../platform/fixtures/source-replay'
let dir: string
const connections: Database.Database[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'credential-db-')) })
afterEach(() => { for (const db of connections.splice(0)) if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }) })
it('upgrades both stored credential keys without changing values or timestamps and uses them for new requests', async () => {
  const path = join(dir, 'historical.sqlite')
  const db = initializeDb({ create: true, dbPath: path })
  connections.push(db.$client)
  // The previous native schema has the same TEXT primary key and no SQL enum.
  const insert = db.$client.prepare('INSERT INTO service_credential VALUES (?, ?, ?)')
  insert.run('ocrToken', 'synthetic-legacy-ocr', '2026-10-14T03:21:00.001Z')
  insert.run('miitCookie', 'session=synthetic-legacy-cookie', '2026-10-23T12:00:00.002Z')
  db.$client.close()

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync(process.execPath, ['scripts/upgrade-credential-keys.mjs', path], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout + result.stderr).not.toContain('synthetic-legacy')
  }
  const upgraded = initializeDb({ dbPath: path, readOnly: true })
  connections.push(upgraded.$client)
  expect(upgraded.select().from(schema.serviceCredential).orderBy(schema.serviceCredential.key).all()).toEqual([
    { key: 'core.ocrToken', value: 'synthetic-legacy-ocr', updatedAt: '2026-10-14T03:21:00.001Z' },
    { key: 'sme-roster.miitCookie', value: 'session=synthetic-legacy-cookie', updatedAt: '2026-10-23T12:00:00.002Z' },
  ])

  const receivedCookie: boolean[] = []
  const platform = createServer((req, res) => {
    receivedCookie.push(req.headers.cookie === 'session=synthetic-legacy-cookie')
    res.end(req.url?.includes('businessList') ? platformFixture('business-list-rdjb1-empty.html') : EMPTY_APPLY_RESPONSE)
  })
  const provider = await startMiniOcrApi({ pages: ['# Upgraded OCR'] })
  try {
    platform.listen(0, '127.0.0.1')
    await once(platform, 'listening')
    const address = platform.address()
    if (!address || typeof address === 'string') throw new Error('Expected a loopback address')
    vi.stubEnv('NUXT_DB_PATH', path)
    vi.stubEnv('NUXT_DB_READONLY', '1')
    const filePath = join(dir, 'page.png')
    writeFileSync(filePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=', 'base64'))
    const output = await ocrImageFile({ ...resolveOcrConfig(), filePath, baseUrl: provider.origin, pollIntervalMs: 1 })
    expect(output.page.markdown).toBe('# Upgraded OCR')
    expect(provider.stats).toMatchObject({ pngUploads: 1, polls: 1, jsonlFetches: 1 })
    expect(provider.authSeen.filter(Boolean)).toEqual(['Bearer synthetic-legacy-ocr', 'Bearer synthetic-legacy-ocr'])
    const result = await queryAllRdjb({
      uscc: '91330211255994457P',
      cookie: () => resolvePlatformCookie(undefined, { db: upgraded }),
      baseUrl: `http://127.0.0.1:${address.port}`,
    })
    expect(result.map(item => item.status)).toEqual(Array(4).fill('no_record'))
    expect(receivedCookie).toEqual(Array(4).fill(true))
  } finally {
    vi.unstubAllEnvs()
    await provider.close()
    if (platform.listening) await new Promise<void>(resolve => platform.close(() => resolve()))
  }
})
it('rolls back the entire credential migration if an existing destination key conflicts', () => {
  const path = join(dir, 'conflict.sqlite')
  const db = initializeDb({ create: true, dbPath: path })
  connections.push(db.$client)
  const insert = db.$client.prepare('INSERT INTO service_credential VALUES (?, ?, ?)')
  insert.run('ocrToken', 'synthetic-legacy-ocr', '2026-10-14')
  insert.run('miitCookie', 'session=synthetic-legacy-cookie', '2026-10-23')
  insert.run('sme-roster.miitCookie', 'session=synthetic-conflict', '2026-11-18')
  const rows = db.$client.prepare('SELECT key, value, updated_at FROM service_credential ORDER BY key')
  const before = rows.all()
  const result = spawnSync(process.execPath, ['scripts/upgrade-credential-keys.mjs', path], { encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('SQLITE_CONSTRAINT_PRIMARYKEY')
  expect(result.stdout + result.stderr).not.toContain('synthetic-')
  expect(rows.all()).toEqual(before)
})
it('keeps credential values out of ordinary roster export rows', () => {
  const db = initializeDb({ create: true, dbPath: join(dir, 'export.sqlite') }); connections.push(db.$client)
  const enterprise = db.insert(schema.enterprise).values({ name: 'Synthetic export enterprise', nameNorm: 'synthetic export enterprise' }).returning().get()
  db.insert(schema.rosterLegacyMember).values({ enterpriseId: enterprise.id }).run()
  db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).run()
  updateCredentials({ 'core.ocrToken': 'synthetic-not-exported-ocr', 'sme-roster.miitCookie': 'session=synthetic-not-exported-cookie' }, { db, env: {} })
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
  updateCredentials({ 'core.ocrToken': 'synthetic-native-secret-ocr', 'sme-roster.miitCookie': 'session=synthetic-native-secret-cookie' }, { db, env: {} })
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
  expect(readFileSync(source).equals(bytes)).toBe(true)
})
