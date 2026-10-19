import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
import * as schema from '../db/schema'
import { handleEvidenceCorrectionRequest } from '../server/utils/roster-evidence-correction-api'
import { startHttpFixture } from './helpers/http-fixture'
import { minimalPdf } from './helpers/minimal-pdf'

it.each(['fresh', 'upgrade', 'integration-upgrade'])('executes evidence correction migration and public writes on %s SQLite', async mode => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence101-migrate-')), filesDir = join(dir, 'files')
  mkdirSync(filesDir)
  const bytes = minimalPdf({ pages: 2 }); writeFileSync(join(filesDir, 'notice.pdf'), bytes)
  const sqlite = new Database(join(dir, 'isolated.db'))
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  const migrationsFolder = resolve('db/migrations')
  const seed = () => sqlite.exec(`
    INSERT INTO title (code,name_zh,level,rank) VALUES ('specialized_sme','专精特新中小企业','municipal',2);
    INSERT INTO enterprise (id,name,name_norm) VALUES (101,'升级保留企业','升级保留企业');
    INSERT INTO record (id,enterprise_id,title_code,source) VALUES (201,101,'specialized_sme','jxj');
    INSERT INTO record_event (id,record_id,event_type,year) VALUES (301,201,'award',2022);
    INSERT INTO record_evidence (id,record_event_id,source_file,attachment,list_no,page) VALUES (401,301,'notice.pdf','附件1',6,1);
  `)
  let oldLedger: unknown[] = []
  if (mode !== 'fresh') {
    const baseline = join(dir, 'baseline'), meta = join(baseline, 'meta'); mkdirSync(meta, { recursive: true })
    const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'))
    journal.entries = journal.entries.filter((entry: { tag: string }) => {
      const tag = Number(entry.tag.slice(0, 4))
      return mode === 'upgrade' ? tag <= 13 : tag <= 16 || tag === 21 || tag === 22
    })
    for (const entry of journal.entries) cpSync(join(migrationsFolder, entry.tag + '.sql'), join(baseline, entry.tag + '.sql'))
    writeFileSync(join(meta, '_journal.json'), JSON.stringify(journal))
    migrate(db, { migrationsFolder: baseline })
    seed()
    oldLedger = sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all()
  }
  migrate(db, { migrationsFolder })
  expect(sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY id LIMIT ?').all(oldLedger.length)).toEqual(oldLedger)
  const upgradedLedger = sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all()
  migrate(db, { migrationsFolder })
  expect(sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all()).toEqual(upgradedLedger)
  if (mode === 'fresh') seed()
  db.insert(schema.storedFile).values({ relPath: 'notice.pdf', filename: 'notice.pdf', ext: 'pdf', bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), source: 'jxj', kind: 'announcement' }).run()
  const app = await startHttpFixture({ routes: {
    '/evidence': r => handleEvidenceCorrectionRequest({ ...r, action: 'get', id: 401 }, { db }),
    '/preflight': r => handleEvidenceCorrectionRequest({ ...r, action: 'preflight' }, { db, filesDir, apiToken: 'synthetic' }),
    '/commit': r => handleEvidenceCorrectionRequest({ ...r, action: 'commit' }, { db, filesDir, apiToken: 'synthetic' }),
  } })
  try {
    const row = await (await fetch(app.baseUrl + '/evidence')).json() as any
    expect(row).toMatchObject({ evidenceId: 401, eventId: 301, recordId: 201, enterpriseId: 101, event: { revision: 1 }, coordinate: { page: 1, listNo: 6 } })
    const request = { idempotencyKey: 'migration-case', actor: { type: 'agent', id: 'test' }, basis: 'explicit reviewed source', operations: [{ evidenceId: 401, eventId: 301, recordId: 201, enterpriseId: 101, expectedVersion: row.version, coordinate: { sourceFile: 'notice.pdf', attachment: '附件1', listNo: 6, page: 2 } }] }
    const post = (path: string, body: unknown) => fetch(app.baseUrl + path, { method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const preflight = await (await post('/preflight', request)).json() as any
    expect((await post('/commit', { request, planHash: preflight.planHash })).status).toBe(200)
    expect(await (await fetch(app.baseUrl + '/evidence')).json()).toMatchObject({ evidenceId: 401, eventId: 301, event: { revision: 2 }, coordinate: { page: 2 } })
    const indexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'record_evidence'").all() as { name: string }[]
    expect(indexes.map(i => i.name)).toEqual(expect.arrayContaining(['record_evidence_event_idx', 'record_evidence_source_file_105_idx', 'record_evidence_coordinate_idx']))
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
  } finally { await app.close(); sqlite.close(); rmSync(dir, { recursive: true, force: true }) }
})
