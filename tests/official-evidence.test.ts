import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import {
  appendOfficialEvidenceRevision, readLatestOfficialEvidence, readOfficialEvidenceCandidates,
  readOfficialEvidenceHistory, listEventOfficialEvidence, OfficialEvidenceError,
  type OfficialEvidenceCapture, type OfficialEvidenceSourceKey,
} from '../server/utils/official-evidence'

// Retain each isolated synthetic database on failure, alongside RED/GREEN logs in /tmp.
const handles: Database.Database[] = []
afterEach(() => { handles.splice(0).forEach(db => { if (db.open) db.close() }) })
const folder = resolve('db/migrations')
function fixture() {
  const dir = mkdtempSync('/tmp/issue349-sqlite-')
  const sqlite = new Database(join(dir, 'synthetic.sqlite')); handles.push(sqlite)
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: folder })
  sqlite.exec(`
    INSERT INTO title(code,name_zh,level,rank) VALUES ('specialized_sme','合成称号','municipal',2);
    INSERT INTO enterprise(id,name,name_norm) VALUES (1,'当前甲','当前甲'),(2,'当前乙','当前乙');
    INSERT INTO record(id,enterprise_id,title_code,source,name_raw) VALUES (1,1,'specialized_sme','jxj','容器首名'),(2,2,'specialized_sme','jxj','另名');
    INSERT INTO record_event(id,record_id,event_type,year) VALUES (1,1,'award',2021),(2,2,'award',2024);
    INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES (1,1,'old.pdf',1),(2,2,'other.pdf',2);
    INSERT INTO source_document(id,source,title,path) VALUES (1,'jxj','明确声明甲','old.pdf'),(2,'jxj','独立声明乙','same.pdf');
    INSERT INTO stored_file(id,rel_path,filename,ext,bytes,sha256,created_at) VALUES (1,'old.pdf','old.pdf','pdf',12,'${'a'.repeat(64)}','synthetic'),(2,'same.pdf','same.pdf','pdf',12,'${'a'.repeat(64)}','synthetic');
    INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,created_at) VALUES (1,'synthetic-command','announcement','synthetic','synthetic');
    INSERT INTO evidence_correction_batch(idempotency_key,request_hash,plan_hash,receipt,created_at) VALUES ('synthetic-correction','old-hash','old-plan','{"kept":true}','synthetic');
  `)
  return { db, sqlite, dir }
}
function capture(overrides: Partial<OfficialEvidenceCapture> = {}): OfficialEvidenceCapture {
  return { evidenceId: 1, eventId: 1, capturedRecordId: 1, capturedEnterpriseId: 1,
    nameRaw: '  公布旧名🙂\u0000é  ', usccRaw: '', districtRaw: null,
    sourceDocumentId: 1, storedFileId: 1, path: '公布/old.pdf', sha256: 'a'.repeat(64), bytes: 12,
    attachment: null, sectionKey: '第一段', listNo: 1, page: null, sourceBindingKnown: true,
    actor: { type: 'agent', id: 'synthetic-agent' }, basis: '逐行核实依据', command: { kind: 'import', batchId: 1 }, ...overrides }
}
function sourceKey(overrides: Partial<OfficialEvidenceSourceKey> = {}): OfficialEvidenceSourceKey {
  return { sourceDocumentId: 1, sha256: 'a'.repeat(64), bytes: 12, attachment: null, sectionKey: '第一段', listNo: 1, ...overrides }
}
function error(run: () => unknown, statusCode: number, code: string) {
  let caught: unknown
  try { run() } catch (failure) { caught = failure }
  expect(caught).toBeInstanceOf(OfficialEvidenceError)
  expect(caught).toMatchObject({ statusCode, code })
}
function addEvidence(sqlite: Database.Database, count: number, eventId = 1, start = 3) {
  const insert = sqlite.prepare('INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES (?, ?, ?, ?)')
  for (let i = start; i < start + count; i++) insert.run(i, eventId, 'synthetic.pdf', i)
}

it('preserves raw null empty Unicode and versioned capture without backfilling legacy evidence', () => {
  const { db, sqlite } = fixture()
  expect(readLatestOfficialEvidence(db, 1)).toEqual({ formatVersion: 1, row: null })
  const before = sqlite.prepare('SELECT * FROM record_evidence ORDER BY id').all()
  expect(appendOfficialEvidenceRevision(db, capture(), 0)).toEqual({ formatVersion: 1, evidenceId: 1, eventId: 1, revision: 1 })
  const result = readLatestOfficialEvidence(db, 1)
  expect(result.row).toMatchObject({ formatVersion: 1, evidenceId: 1, eventId: 1, revision: 1,
    nameRaw: '  公布旧名🙂\u0000é  ', usccRaw: '', districtRaw: null, path: '公布/old.pdf', page: null,
    capturedRecordId: 1, capturedEnterpriseId: 1, currentOwner: { recordId: 1, enterpriseId: 1 },
    sourceBindingKnown: true, actor: { type: 'agent', id: 'synthetic-agent' }, command: { kind: 'import', batchId: 1 } })
  appendOfficialEvidenceRevision(db, capture({ nameRaw: null, usccRaw: null, districtRaw: '原属地', sourceBindingKnown: false, sourceDocumentId: null, storedFileId: null, path: null, sha256: null, bytes: null, sectionKey: null, listNo: null,
    command: { kind: 'evidence_correction', batchKey: 'synthetic-correction' } }), 1)
  expect(readLatestOfficialEvidence(db, 1).row).toMatchObject({ revision: 2, nameRaw: null, usccRaw: null, districtRaw: '原属地', sourceBindingKnown: false, command: { kind: 'evidence_correction', batchKey: 'synthetic-correction' } })
  expect(readLatestOfficialEvidence(db, 2).row).toBeNull()
  expect(sqlite.prepare('SELECT * FROM record_evidence ORDER BY id').all()).toEqual(before)
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})

it('uses atomic expected revision CAS across two SQLite handles and rolls back the caller batch', () => {
  const { db, sqlite, dir } = fixture()
  const second = new Database(join(dir, 'synthetic.sqlite')); handles.push(second); second.pragma('foreign_keys=ON')
  const other = drizzle(second, { schema })
  appendOfficialEvidenceRevision(db, capture(), 0)
  error(() => appendOfficialEvidenceRevision(other, capture({ nameRaw: 'stale' }), 0), 409, 'revision_conflict')
  appendOfficialEvidenceRevision(other, capture({ nameRaw: 'second' }), 1)
  error(() => appendOfficialEvidenceRevision(db, capture(), 1), 409, 'revision_conflict')
  expect(() => db.transaction(tx => {
    appendOfficialEvidenceRevision(tx, capture({ nameRaw: 'rolled back' }), 2)
    expect(readLatestOfficialEvidence(tx, 1).row).toMatchObject({ revision: 3, nameRaw: 'rolled back' })
    appendOfficialEvidenceRevision(tx, capture({ evidenceId: 2, eventId: 2, capturedRecordId: 2, capturedEnterpriseId: 2, command: { kind: 'import', batchId: 999 } }), 0)
  }, { behavior: 'immediate' })).toThrow()
  expect(readOfficialEvidenceHistory(db, 1).rows.map(r => [r.revision, r.nameRaw])).toEqual([[2, 'second'], [1, '  公布旧名🙂\u0000é  ']])
  expect(readLatestOfficialEvidence(other, 2).row).toBeNull()
  expect(sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 2 })
})

it('validates new capture references and keeps historical owners readable after a legal record fold', () => {
  const { db, sqlite } = fixture()
  for (const invalid of [{ eventId: 2 }, { capturedRecordId: 2 }, { capturedEnterpriseId: 2 }, { evidenceId: 999 }])
    error(() => appendOfficialEvidenceRevision(db, capture(invalid), 0), 409, 'reference_mismatch')
  for (const invalid of [{ sourceDocumentId: 999 }, { storedFileId: 999 }, { command: { kind: 'import', batchId: 999 } }, { command: { kind: 'evidence_correction', batchKey: 'missing' } }] as Partial<OfficialEvidenceCapture>[])
    error(() => appendOfficialEvidenceRevision(db, capture(invalid), 0), 409, 'reference_mismatch')
  appendOfficialEvidenceRevision(db, capture(), 0)
  db.transaction(() => { sqlite.exec('UPDATE record_event SET record_id=2 WHERE id=1; DELETE FROM record WHERE id=1; DELETE FROM enterprise WHERE id=1;') })
  expect(readLatestOfficialEvidence(db, 1).row).toMatchObject({ capturedRecordId: 1, capturedEnterpriseId: 1, currentOwner: { recordId: 2, enterpriseId: 2 } })
  expect(readOfficialEvidenceCandidates(db, sourceKey()).candidates[0]).toMatchObject({ evidenceId: 1, capturedRecordId: 1, currentOwner: { recordId: 2, enterpriseId: 2 } })
  expect(readOfficialEvidenceHistory(db, 1).rows[0]?.capturedEnterpriseId).toBe(1)
  expect(() => sqlite.prepare('DELETE FROM record_evidence WHERE id=1').run()).toThrow(/FOREIGN KEY/)
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
  // Corrupt/missing current owner must be explicit unknown, never lose the fact in INNER JOIN.
  sqlite.pragma('foreign_keys=OFF'); sqlite.exec('DELETE FROM record WHERE id=2'); sqlite.pragma('foreign_keys=ON')
  expect(readOfficialEvidenceCandidates(db, sourceKey()).candidates).toHaveLength(1)
  expect(readLatestOfficialEvidence(db, 1).row?.currentOwner).toBeNull()
})

it('takes latest over all revisions before filtering K so moved and unknown revisions suppress old claims', () => {
  const { db } = fixture()
  appendOfficialEvidenceRevision(db, capture(), 0)
  appendOfficialEvidenceRevision(db, capture({ sectionKey: '第二段' }), 1)
  expect(readOfficialEvidenceCandidates(db, sourceKey()).candidates).toEqual([])
  expect(readOfficialEvidenceCandidates(db, sourceKey({ sectionKey: '第二段' })).candidates.map(r => r.revision)).toEqual([2])
  appendOfficialEvidenceRevision(db, capture({ sourceBindingKnown: false }), 2)
  expect(readOfficialEvidenceCandidates(db, sourceKey()).candidates).toEqual([])
  expect(readOfficialEvidenceCandidates(db, sourceKey({ sectionKey: '第二段' })).candidates).toEqual([])
  expect(readLatestOfficialEvidence(db, 1).row?.revision).toBe(3)
})

it('matches only explicit K across events and returns conflicting metadata without making business decisions', () => {
  const { db } = fixture()
  appendOfficialEvidenceRevision(db, capture(), 0)
  appendOfficialEvidenceRevision(db, capture({ evidenceId: 2, eventId: 2, capturedRecordId: 2, capturedEnterpriseId: 2, path: 'changed-path.pdf', storedFileId: 2, page: 9, nameRaw: '相矛盾原名' }), 0)
  expect(readOfficialEvidenceCandidates(db, sourceKey()).candidates.map(r => [r.evidenceId, r.currentOwner?.enterpriseId, r.nameRaw])).toEqual([[1, 1, '  公布旧名🙂\u0000é  '], [2, 2, '相矛盾原名']])
  for (const key of [{ sourceDocumentId: 2 }, { attachment: '' }, { sectionKey: '第一段 ' }, { listNo: 2 }, { sha256: 'b'.repeat(64) }, { bytes: 13 }])
    expect(readOfficialEvidenceCandidates(db, sourceKey(key)).candidates).toEqual([])
  for (const key of [{ sourceDocumentId: null }, { sectionKey: null }, { sectionKey: '' }, { listNo: null }, { bytes: null }, { sha256: null }, { eventId: 1 }, { path: 'old.pdf' }, { storedFileId: 1 }, { enterpriseId: 1 }])
    error(() => readOfficialEvidenceCandidates(db, { ...sourceKey(), ...key } as never), 400, 'invalid_input')
})

it('rejects the 101st candidate without truncation even when the last row alone conflicts', () => {
  const { db, sqlite } = fixture(); addEvidence(sqlite, 100)
  appendOfficialEvidenceRevision(db, capture(), 0)
  for (let id = 3; id <= 101; id++) appendOfficialEvidenceRevision(db, capture({ evidenceId: id, nameRaw: '' }), 0)
  expect(readOfficialEvidenceCandidates(db, sourceKey(), { maxBytes: 65536 }).candidates).toHaveLength(100)
  appendOfficialEvidenceRevision(db, capture({ evidenceId: 102, nameRaw: '第101条冲突' }), 0)
  error(() => readOfficialEvidenceCandidates(db, sourceKey(), { maxBytes: 65536 }), 413, 'source_limit')
  appendOfficialEvidenceRevision(db, capture({ evidenceId: 102, sourceBindingKnown: false }), 1)
  expect(readOfficialEvidenceCandidates(db, sourceKey(), { maxBytes: 65536 }).candidates).toHaveLength(100)
})

it('paginates history by revision with default 20 maximum 50 and no gaps or repeated revisions', () => {
  const { db } = fixture()
  for (let i = 0; i < 53; i++) appendOfficialEvidenceRevision(db, capture({ nameRaw: `revision-${i + 1}` }), i)
  const first = readOfficialEvidenceHistory(db, 1, { maxBytes: 65536 })
  expect(first.rows.map(r => r.revision)).toEqual(Array.from({ length: 20 }, (_, i) => 53 - i)); expect(first.nextBeforeRevision).toBe(34)
  const next = readOfficialEvidenceHistory(db, 1, { beforeRevision: first.nextBeforeRevision!, pageSize: 50, maxBytes: 65536 })
  expect(next.rows.map(r => r.revision)).toEqual(Array.from({ length: 33 }, (_, i) => 33 - i)); expect(next.nextBeforeRevision).toBeNull()
  const maximum = readOfficialEvidenceHistory(db, 1, { pageSize: 50, maxBytes: 65536 })
  expect(maximum.rows.map(r => r.revision)).toEqual(Array.from({ length: 50 }, (_, i) => 53 - i)); expect(maximum.nextBeforeRevision).toBe(4)
  expect(readOfficialEvidenceHistory(db, 2)).toEqual({ formatVersion: 1, evidenceId: 2, rows: [], nextBeforeRevision: null })
  for (const options of [{ pageSize: 51 }, { pageSize: 0 }, { beforeRevision: 0 }, { maxBytes: 65537 }, { maxBytes: '16384' }, { unexpected: true }])
    error(() => readOfficialEvidenceHistory(db, 1, options as never), 400, 'invalid_input')
})

it('paginates event projections by evidence id and refuses more than 300 evidence entries', () => {
  const { db, sqlite } = fixture(); addEvidence(sqlite, 52)
  for (let id = 3; id <= 54; id++) appendOfficialEvidenceRevision(db, capture({ evidenceId: id }), 0)
  const first = listEventOfficialEvidence(db, 1, { maxBytes: 65536 })
  expect(first.rows.map(r => r.evidenceId)).toEqual(Array.from({ length: 20 }, (_, i) => 3 + i)); expect(first.nextAfterEvidenceId).toBe(22)
  const next = listEventOfficialEvidence(db, 1, { afterEvidenceId: 22, pageSize: 50, maxBytes: 65536 })
  expect(next.rows.map(r => r.evidenceId)).toEqual(Array.from({ length: 32 }, (_, i) => 23 + i)); expect(next.nextAfterEvidenceId).toBeNull()
  addEvidence(sqlite, 248, 1, 55)
  error(() => listEventOfficialEvidence(db, 1, { afterEvidenceId: 302, maxBytes: 65536 }), 413, 'source_limit')
})

it('enforces strict field types and 4000 UTF16 characters while preserving whitespace and empty raw', () => {
  const { db } = fixture()
  for (const invalid of [{ evidenceId: '1' }, { eventId: 1.5 }, { capturedRecordId: -1 }, { capturedEnterpriseId: Number.MAX_SAFE_INTEGER + 1 }, { nameRaw: 7 }, { usccRaw: false }, { districtRaw: {} }, { sourceBindingKnown: 1 }, { bytes: -1 }, { listNo: 0 }, { page: 0 }, { sha256: 'BAD' }, { sectionKey: null }, { unexpected: true }, { actor: { type: 'user', id: 1 } }, { command: { kind: 'other', batchId: 1 } }, { command: { kind: 'import', batchId: '1' } }])
    error(() => appendOfficialEvidenceRevision(db, { ...capture(), ...invalid } as never, 0), 400, 'invalid_input')
  for (const value of ['x'.repeat(4001), '🙂'.repeat(2001), '\u0000'.repeat(4001)])
    error(() => appendOfficialEvidenceRevision(db, capture({ nameRaw: value }), 0), 400, 'field_limit')
  appendOfficialEvidenceRevision(db, capture({ nameRaw: '🙂'.repeat(2000), usccRaw: ' '.repeat(4000) }), 0)
  expect(readLatestOfficialEvidence(db, 1, { maxBytes: 65536 }).row).toMatchObject({ nameRaw: '🙂'.repeat(2000), usccRaw: ' '.repeat(4000) })
})

it('guards exact JSON response bytes in SQLite before hydration and rejects oversized complete new rows', () => {
  const { db } = fixture()
  error(() => appendOfficialEvidenceRevision(db, capture({ nameRaw: '\u0000'.repeat(4000), usccRaw: '\u0000'.repeat(4000), districtRaw: '\u0000'.repeat(4000) }), 0), 400, 'input_limit')
  expect(readLatestOfficialEvidence(db, 1).row).toBeNull()
  appendOfficialEvidenceRevision(db, capture({ nameRaw: '汉'.repeat(4000), usccRaw: '汉'.repeat(2000) }), 0)
  const get = vi.spyOn(db, 'get')
  error(() => readLatestOfficialEvidence(db, 1), 413, 'response_limit')
  expect(JSON.stringify(get.mock.results)).not.toContain('汉'.repeat(100))
  get.mockRestore()
  const full = readLatestOfficialEvidence(db, 1, { maxBytes: 65536 })
  const exact = Buffer.byteLength(JSON.stringify(full))
  expect(exact).toBeGreaterThan(16384)
  expect(readLatestOfficialEvidence(db, 1, { maxBytes: exact })).toEqual(full)
  error(() => readLatestOfficialEvidence(db, 1, { maxBytes: exact - 1 }), 413, 'response_limit')
  // Older/uncontrolled oversized fields stay stored but may not enter JS unbounded.
  db.$client.prepare('UPDATE official_evidence_row_revision SET name_raw=? WHERE evidence_id=1').run('x'.repeat(200000))
  const guarded = vi.spyOn(db, 'get')
  error(() => readLatestOfficialEvidence(db, 1, { maxBytes: 65536 }), 413, 'field_limit')
  expect(JSON.stringify(guarded.mock.results)).not.toContain('x'.repeat(100)); guarded.mockRestore()
  expect(db.$client.prepare('SELECT length(name_raw) n FROM official_evidence_row_revision').get()).toEqual({ n: 200000 })
})

it.each([28, 29])('upgrades real SQLite from journal index %i with old data schema triggers and ledger prefix unchanged', lastIndex => {
  const dir = mkdtempSync('/tmp/issue349-upgrade-'), oldFolder = join(dir, 'baseline')
  mkdirSync(join(oldFolder, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'))
  const entries = journal.entries.filter((e: { idx: number }) => e.idx <= lastIndex)
  writeFileSync(join(oldFolder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
  for (const entry of entries) copyFileSync(join(folder, entry.tag + '.sql'), join(oldFolder, entry.tag + '.sql'))
  const sqlite = new Database(join(dir, 'synthetic.sqlite')); handles.push(sqlite); sqlite.pragma('foreign_keys=ON')
  const db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: oldFolder })
  sqlite.exec(`
    INSERT INTO title(code,name_zh,level,rank) VALUES ('specialized_sme','旧称号','municipal',2);
    INSERT INTO enterprise(id,name,name_norm) VALUES(41,'旧企业','旧企业');
    INSERT INTO record(id,enterprise_id,title_code,source,name_raw,uscc_raw) VALUES(51,41,'specialized_sme','jxj','旧原名🙂','');
    INSERT INTO record_event(id,record_id,event_type,year) VALUES(61,51,'award',2021);
    INSERT INTO record_evidence(id,record_event_id,source_file,list_no) VALUES(71,61,'old.pdf',1);
    INSERT INTO platform_query(interface,query_key,queried_at,raw_response,created_at) VALUES('business_list','synthetic','synthetic','旧raw🙂','synthetic');
    INSERT INTO comparison_scope_proof(kind,evidence,source_fingerprint,created_at) VALUES('official_coverage','{"original":"旧proof"}','old-hash','synthetic');
    INSERT INTO evidence_correction_batch(idempotency_key,request_hash,plan_hash,receipt,created_at) VALUES('old-key','old-hash','old-plan','{"original":"旧receipt"}','synthetic');
    CREATE TRIGGER issue349_synthetic_preserved AFTER UPDATE ON record_evidence BEGIN SELECT 1; END;
  `)
  const objects = () => sqlite.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as { type: string; name: string; tbl_name: string; sql: string }[]
  const oldObjects = objects(), tables = oldObjects.filter(o => o.type === 'table').map(o => o.name)
  const contents = () => tables.map(name => [name, sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
  const before = contents(), ledger = sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all()
  migrate(db, { migrationsFolder: folder })
  expect(objects().filter(o => oldObjects.some(old => old.name === o.name))).toEqual(oldObjects)
  for (const [name, data] of before) {
    if (name === '__drizzle_migrations') continue
    expect(sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).toEqual(data)
  }
  expect(sqlite.prepare('SELECT * FROM __drizzle_migrations ORDER BY id LIMIT ?').all(ledger.length)).toEqual(ledger)
  expect(sqlite.prepare('SELECT count(*) n FROM official_evidence_row_revision').get()).toEqual({ n: 0 })
  expect(readLatestOfficialEvidence(db, 71).row).toBeNull()
  const added = objects().filter(o => !oldObjects.some(old => old.name === o.name))
  expect(added.filter(o => o.type === 'table').map(o => o.name)).toEqual(lastIndex === 28 ? ['official_evidence_row_revision', 'platform_body_leaf', 'platform_body_part', 'platform_body_root', 'platform_query_body_ref', 'platform_relation_body_ref', 'platform_version_body_ref'] : ['official_evidence_row_revision'])
  expect(added.filter(o => o.tbl_name === 'official_evidence_row_revision' && o.type === 'index').map(o => o.name)).toEqual(expect.arrayContaining(['official_evidence_row_revision_uq', 'official_evidence_row_source_idx', 'official_evidence_row_event_idx']))
  const after = contents(); migrate(db, { migrationsFolder: folder }); expect(contents()).toEqual(after)
  expect(sqlite.pragma('foreign_key_check')).toEqual([]); expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok')
})

it('enforces unique revision real foreign keys and version type binding command constraints in SQLite', () => {
  const { db, sqlite } = fixture(); appendOfficialEvidenceRevision(db, capture(), 0)
  expect(() => sqlite.exec('INSERT INTO official_evidence_row_revision SELECT * FROM official_evidence_row_revision')).toThrow(/UNIQUE/)
  for (const update of ['evidence_id=999', 'event_id=999', 'source_document_id=999', 'stored_file_id=999', 'import_batch_id=999', "command_kind='evidence_correction',import_batch_id=NULL,correction_batch_key='missing'"])
    expect(() => sqlite.exec(`UPDATE official_evidence_row_revision SET ${update}`)).toThrow(/FOREIGN KEY/)
  for (const update of ['format_version=2', 'revision=0', 'revision=1.5', 'captured_record_id=0', 'captured_enterprise_id=-1', 'bytes=-1', 'page=0', 'list_no=NULL', 'source_document_id=NULL', 'sha256=NULL', 'source_binding_known=2', "name_raw=x'6162'", "actor='{}'", "actor='not-json'", 'import_batch_id=NULL', "correction_batch_key='synthetic-correction'"])
    expect(() => sqlite.exec(`UPDATE official_evidence_row_revision SET ${update}`)).toThrow(/CHECK/)
  expect(readLatestOfficialEvidence(db, 1).row?.revision).toBe(1)
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})

it('keeps Unicode K byte exact including NUL and distinguishes confirmed empty attachment from no attachment', () => {
  const { db } = fixture()
  appendOfficialEvidenceRevision(db, capture({ attachment: '', sectionKey: '\u0000é', bytes: 0, storedFileId: null }), 0)
  expect(readOfficialEvidenceCandidates(db, sourceKey({ attachment: '', sectionKey: '\u0000é', bytes: 0 })).candidates.map(r => r.evidenceId)).toEqual([1])
  for (const key of [{ attachment: null }, { sectionKey: '\u0000é' }, { sectionKey: 'é' }, { bytes: 12 }])
    expect(readOfficialEvidenceCandidates(db, sourceKey({ attachment: '', sectionKey: '\u0000é', bytes: 0, ...key })).candidates).toEqual([])
})

it('applies read field and byte limits to each bounded projection without hydrating oversized lookahead rows', () => {
  const { db, sqlite } = fixture()
  for (let i = 0; i < 21; i++) appendOfficialEvidenceRevision(db, capture({ nameRaw: `r${i + 1}` }), i)
  sqlite.prepare('UPDATE official_evidence_row_revision SET name_raw=? WHERE revision=1').run('x'.repeat(200000))
  const page = readOfficialEvidenceHistory(db, 1, { maxBytes: 65536 })
  expect(page.rows.map(r => r.revision)).toEqual(Array.from({ length: 20 }, (_, i) => 21 - i)); expect(page.nextBeforeRevision).toBe(2)
  error(() => readOfficialEvidenceHistory(db, 1, { beforeRevision: 2, maxBytes: 65536 }), 413, 'field_limit')
  appendOfficialEvidenceRevision(db, capture({ nameRaw: 'x'.repeat(4000), usccRaw: 'x'.repeat(4000), districtRaw: 'x'.repeat(4000), path: 'x'.repeat(4000), basis: 'x'.repeat(4000) }), 21)
  error(() => listEventOfficialEvidence(db, 1), 413, 'response_limit')
  expect(listEventOfficialEvidence(db, 1, { maxBytes: 65536 }).rows[0]?.nameRaw).toBe('x'.repeat(4000))
  // Candidate metadata intentionally omits unrelated path/basis, but raw stays exact and bounded.
  expect(readOfficialEvidenceCandidates(db, sourceKey()).candidates[0]?.nameRaw).toBe('x'.repeat(4000))
  sqlite.prepare('UPDATE official_evidence_row_revision SET name_raw=? WHERE revision=22').run('🙂'.repeat(2001))
  for (const read of [() => readLatestOfficialEvidence(db, 1, { maxBytes: 65536 }), () => readOfficialEvidenceCandidates(db, sourceKey(), { maxBytes: 65536 }), () => readOfficialEvidenceHistory(db, 1, { pageSize: 1, maxBytes: 65536 }), () => listEventOfficialEvidence(db, 1, { maxBytes: 65536 })])
    error(read, 413, 'field_limit')
  for (const revision of [-1, 0.5, '0', Number.MAX_SAFE_INTEGER])
    error(() => appendOfficialEvidenceRevision(db, capture(), revision as never), 400, 'invalid_input')
})
