import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
import * as schema from '../../../db/schema'
import { initializeDb } from '../../../db/client'
import { assertFinalPlatformRuntime } from '../../../db/schema-phase'
import { TITLE_SEED } from '../../../db/titles'
import { executeNativeImport, startRosterApi } from '../imports/fixtures/import-server'
import { createRosterImportClient } from '../../../layers/sme-roster/lib/roster-import-client'
import { listEvidenceImpacts113, processEvidenceImpacts113 } from '../../../layers/sme-roster/server/utils/evidence-impact-113'

it.each(['fresh', 'upgrade'])('adds empty durable impact storage and preserves existing facts on %s SQLite', async mode => {
  const dir = mkdtempSync(join(tmpdir(), 'impact113-migrate-')), sqlite = new Database(join(dir, 'isolated.db'))
  sqlite.pragma('foreign_keys=ON')
  const db = drizzle(sqlite, { schema }), migrationsFolder = resolve('db/migrations')
  const seed = () => {
    for (const title of TITLE_SEED) db.insert(schema.title).values(title).run()
    db.insert(schema.enterprise).values({ id: 113, name: '升级保留主体', nameNorm: '升级保留主体' }).run()
    // Seed the historical columns: the upgrade baseline predates optional qualification.
    sqlite.prepare("insert into difference_reason(id,enterprise_id,title_code,direction,status,measure_code,verification_status,recorded_at,created_at) values(113,113,'specialized_sme','missing_in_miit','confirmed_no_diff','none','confirmed','2026-10-01','2026-10-01')").run()
    // A malformed unrelated historical archive must not be parsed by migration or impact drain.
    sqlite.prepare("insert into platform_query(interface,query_key,rdjb,queried_at,raw_response,collection_evidence,created_at) values ('business_list','UNRELATED','2','2026-10-01',?,'invalid historical json','2026-10-01')").run('RAW_SOURCE_UNCHANGED'.repeat(10000))
  }
  let oldLedger: unknown[] = [], original: unknown[] = []
  if (mode === 'upgrade') {
    const baseline = join(dir, 'baseline'); mkdirSync(join(baseline, 'meta'), { recursive: true })
    const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'))
    journal.entries = journal.entries.slice(0, journal.entries.findIndex((e: { tag: string }) => e.tag === '0023_evidence_impact_113'))
    for (const e of journal.entries) cpSync(join(migrationsFolder, e.tag + '.sql'), join(baseline, e.tag + '.sql'))
    writeFileSync(join(baseline, 'meta/_journal.json'), JSON.stringify(journal)); migrate(db, { migrationsFolder: baseline }); seed()
    oldLedger = sqlite.prepare('select * from __drizzle_migrations order by id').all()
    original = sqlite.prepare('select * from difference_reason').all()
  }
  migrate(db, { migrationsFolder })
  if (mode === 'fresh') seed()
  expect(sqlite.prepare('select * from __drizzle_migrations order by id limit ?').all(oldLedger.length)).toEqual(oldLedger)
  if (mode === 'upgrade') expect(sqlite.prepare('select * from difference_reason').all()).toEqual(original.map(row => ({...(row as Record<string,unknown>),current_qualification:null,fact_references:null})))
  const ledger = sqlite.prepare('select * from __drizzle_migrations order by id').all()
  migrate(db, { migrationsFolder }); expect(sqlite.prepare('select * from __drizzle_migrations order by id').all()).toEqual(ledger)
  // These are historical expand migrations, owned by the offline upgrade lane.
  // A migrated legacy schema must stay closed to the current runtime.
  expect(() => assertFinalPlatformRuntime(sqlite)).toThrow()
  expect(sqlite.prepare('select count(*) n from explanation_impact_113').get()).toEqual({ n: 0 })
  expect(sqlite.prepare('select raw_response, collection_evidence from platform_query').get()).toEqual({
    raw_response: 'RAW_SOURCE_UNCHANGED'.repeat(10000), collection_evidence: 'invalid historical json',
  })
  expect(sqlite.prepare('select count(*) n from evidence_revision_113').get()).toEqual({ n: 0 })
  // Current public writes have their own native runtime owner. Do not pass the
  // offline migration connection through the final application's admission guard.
  const native = initializeDb({ create: true, dbPath: join(dir, 'native.db') })
  native.insert(schema.enterprise).values({ id: 113, name: '升级保留主体', nameNorm: '升级保留主体' }).run()
  native.$client.prepare("insert into difference_reason(id,enterprise_id,title_code,direction,status,measure_code,verification_status,recorded_at,created_at) values(113,113,'specialized_sme','missing_in_miit','confirmed_no_diff','none','confirmed','2026-10-01','2026-10-01')").run()
  expect(processEvidenceImpacts113(native, { limit: 1 })).toEqual({ processed: 0, unfinished: false, watermark: 0 })
  expect(listEvidenceImpacts113(native)).toEqual([])
  const app = await startRosterApi({ db: native, apiToken: 'synthetic-113', executeImport: executeNativeImport })
  try {
    const client = createRosterImportClient({ baseUrl: app.baseUrl, token: 'synthetic-113' })
    expect((await client.commit({ idempotencyKey: 'migration-alias', sourceKind: 'alias_evidence', sourceIdentity: 'synthetic/migration', payload: { aliases: [{ enterpriseName: '升级保留主体', name: '升级保留旧名称', sourceKind: 'manual', sourceRefId: 0, verificationStatus: 'confirmed' }] } })).status).toBe('committed')
    processEvidenceImpacts113(native)
    expect(listEvidenceImpacts113(native, { enterpriseId: 113 })).toEqual([expect.objectContaining({ enterpriseId: 113, decisionId: 113, classification: 'evidence_changed' })])
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
    expect((sqlite.prepare("select name from sqlite_master where type='index'").all() as { name: string }[]).map(r => r.name)).toEqual(expect.arrayContaining(['evidence_revision_source_113_uq', 'evidence_impact_pending_113_idx', 'explanation_impact_coordinate_113_uq', 'difference_reason_impact_title_113_idx', 'platform_export_row_identity_113_idx']))
  } finally { await app.close(); native.$client.close(); sqlite.close(); rmSync(dir, { recursive: true, force: true }) }
})
