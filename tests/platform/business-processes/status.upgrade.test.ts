import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { sourceFieldComparison, sourceValueKind } from '../../../upgrade/frozen/source-extraction'
import { checkedBusinessStatus, BUSINESS_STATUS_V1, BUSINESS_STATUS_V2 } from '../../../layers/sme-roster/lib/platform/business-status'
import { businessStatusRule } from '../../../upgrade/business-status-catalog'
import { installBusinessStatusPrerequisite } from '../../../upgrade/business-status'
import { withFrozenSource } from '../../../upgrade/collections'
import { projectionManifest } from '../../../upgrade/projections'
import { ensurePlatformObservation } from '../../../upgrade/frozen/server/platform-business-record'
import * as schema from '../../../upgrade/legacy-schema'

const root = mkdtempSync(join(process.env.ISSUE760_EVIDENCE ?? tmpdir(), 'status760-'))
const source = join(root, 'source.sqlite')
beforeAll(() => {
  const t = new Database(source)
  try {
    migrate(drizzle(t), { migrationsFolder: 'db/migrations' })
    t.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'business_list','Q','2','t','success','c');
      INSERT INTO platform_relation(id,query_id,sequence_no,relation_key,raw_fields,created_at) VALUES(1,1,1,'K','{"id":"K","rdjb":"2","cszt":"pending"}','c')`)
    ensurePlatformObservation(drizzle(t, { schema }), 1)
    // A high sequence is observable even when no row owns that ID.
    t.exec("UPDATE sqlite_sequence SET seq=760 WHERE name='platform_business_projection'")
  } finally { t.close() }
})
afterAll(() => { if (!process.env.ISSUE760_EVIDENCE) rmSync(root, { recursive: true, force: true }) })

it('classifies only native business status as blob and preserves bytes, empty blobs and conflicts', () => {
  const stored = { province: null, status: null, batch: null, declareKind: null, appliedAt: null, awardBatchLabel: null, year: null }
  for (const status of [Buffer.from([0, 255]), Buffer.alloc(0), Buffer.from('通过')]) {
    expect(sourceValueKind(status)).toBe('object')
    expect(checkedBusinessStatus(status)).toBe(status)
    expect(sourceFieldComparison('business_list', { ...stored, status }, {}, 'valid')).toMatchObject({
      storedStatusKind: 'blob', storedStatus: status, parsedStatus: null, reconciledStatus: status, statusConflict: 0,
    })
    expect(sourceFieldComparison('business_list', { ...stored, status }, { cszt: 'done' }, 'valid')).toMatchObject({
      storedStatusKind: 'blob', storedStatus: status, parsedStatus: 'done', reconciledStatus: null, statusConflict: 1,
    })
  }
  expect(sourceFieldComparison('business_list', { ...stored, status: ' \t ' }, {}, 'valid')).toMatchObject({ storedStatusKind: 'text', storedStatus: null, reconciledStatus: null })
  for (const invalid of [{ type: 'Buffer', data: [0, 255] }, new Uint8Array([0, 255]), 42, true]) expect(() => checkedBusinessStatus(invalid)).toThrow('Invalid business stored status')
  expect(() => sourceFieldComparison('apply_list', { ...stored, status: 'pending' }, { cszt: Buffer.from('done') }, 'valid')).not.toThrow()
})

it('installs before T04 preserving populated versions, catalog, sequence and migration ledger', () => {
  const target = join(root, 'installed.sqlite'), receipt = join(root, 'installed.json')
  copyFileSync(source, target)
  const before = new Database(target, { readonly: true })
  const cells = projectionManifest(before), ledger = before.prepare('SELECT * FROM __drizzle_migrations').all()
  expect(businessStatusRule(before)).toBe(BUSINESS_STATUS_V1)
  before.close()
  withFrozenSource(source, frozen => installBusinessStatusPrerequisite(target, frozen, receipt))
  const t = new Database(target, { readonly: true })
  try {
    expect(businessStatusRule(t)).toBe(BUSINESS_STATUS_V2)
    expect(projectionManifest(t)).toBe(cells)
    expect(t.prepare('SELECT * FROM __drizzle_migrations').all()).toEqual(ledger)
    expect(t.prepare("SELECT seq FROM sqlite_sequence WHERE name='platform_business_projection'").get()).toEqual({ seq: 760 })
    expect(t.prepare('SELECT * FROM platform_migration_run').all()).toEqual([])
    expect(t.pragma('foreign_key_check')).toEqual([])
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({ transform: BUSINESS_STATUS_V2, beforeCells: cells, afterCells: cells })
  } finally { t.close() }
  const bytes = readFileSync(target)
  expect(() => withFrozenSource(source, frozen => installBusinessStatusPrerequisite(target, frozen, join(root, 'reinstall.json')))).toThrow('Fresh expand')
  expect(readFileSync(target).equals(bytes)).toBe(true)
})

it.each(['dropped', 'created', 'restored', 'receipt'])('rolls back prerequisite failure at %s and retries on the same new target', stage => {
  const target = join(root, stage + '.sqlite'), receipt = join(root, stage + '.json')
  copyFileSync(source, target)
  const bytes = readFileSync(target)
  expect(() => withFrozenSource(source, frozen => installBusinessStatusPrerequisite(target, frozen, receipt, at => {
    if (at === stage) throw new Error('injected prerequisite ' + stage)
  }))).toThrow('injected prerequisite')
  expect(readFileSync(target).equals(bytes)).toBe(true)
  expect(existsSync(receipt)).toBe(false)
  withFrozenSource(source, frozen => installBusinessStatusPrerequisite(target, frozen, receipt))
  const t = new Database(target, { readonly: true })
  try { expect(businessStatusRule(t)).toBe(BUSINESS_STATUS_V2); expect(t.pragma('foreign_key_check')).toEqual([]) } finally { t.close() }
})

it('refuses begun migration, unknown incoming owners and receipt collisions without changing the target', () => {
  for (const [label, sql] of [
    ['run', "INSERT INTO platform_migration_run(run_id,state,source_snapshot_sha256,source_schema_hash,source_manifest_sha256,target_schema_version,transform_version) VALUES('r','running','s','h','m','v','t')"],
    ['incoming', 'CREATE TABLE foreign_status_owner(id INTEGER REFERENCES platform_business_projection(id))'],
  ]) {
    const target = join(root, label + '.sqlite')
    copyFileSync(source, target)
    const t = new Database(target); t.exec(sql!); t.close()
    const bytes = readFileSync(target)
    expect(() => withFrozenSource(source, frozen => installBusinessStatusPrerequisite(target, frozen, join(root, label + '.json')))).toThrow()
    expect(readFileSync(target).equals(bytes)).toBe(true)
  }
  const target = join(root, 'collision.sqlite')
  copyFileSync(source, target)
  const bytes = readFileSync(target), originalReceipt = readFileSync(join(root, 'installed.json'))
  expect(() => withFrozenSource(source, frozen => installBusinessStatusPrerequisite(target, frozen, join(root, 'installed.json')))).toThrow()
  expect(readFileSync(target).equals(bytes)).toBe(true)
  expect(readFileSync(join(root, 'installed.json')).equals(originalReceipt)).toBe(true)
})
