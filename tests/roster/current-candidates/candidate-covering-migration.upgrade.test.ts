import { createHash } from 'node:crypto'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import * as s from '../../../upgrade/legacy-schema'
import { normalizeUscc } from '../../../lib/domain'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterAll, expect, it } from 'vitest'
import { currentCandidateSql, currentCandidateSqlFor } from '../../../upgrade/frozen/current-candidates'

const sourceFolder = resolve('db/migrations')
const folder = mkdtempSync(join(tmpdir(), 'offline-covering31-'))
const journal = JSON.parse(readFileSync(join(sourceFolder, 'meta/_journal.json'), 'utf8'))
const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 31)
mkdirSync(join(folder, 'meta'))
writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
for (const entry of entries) copyFileSync(join(sourceFolder, entry.tag + '.sql'), join(folder, entry.tag + '.sql'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))
const rIndex = 'platform_relation_current_candidate_cover_idx'
const qIndex = 'platform_query_current_candidate_cover_idx'
function indexColumns(db: Database.Database, name: string) {
  return (db.pragma(`index_info('${name}')`) as { name: string }[]).map(row => row.name)
}
it('M01 fresh file migration creates both indexes and restart is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cover363-new-')), path = join(dir, 'synthetic.sqlite')
  let db = new Database(path)
  try {
    migrate(drizzle(db), { migrationsFolder: folder })
    expect(indexColumns(db, rIndex)).toEqual(['query_id', 'sequence_no', 'enterprise_id', 'uscc_raw'])
    expect(indexColumns(db, qIndex)).toEqual(['id', 'rdjb', 'title_code', 'collection_evidence'])
    const ledger = db.prepare('select * from __drizzle_migrations').all()
    expect(currentCandidateSqlFor(db)).not.toBe(currentCandidateSql)
    db.close(); db = new Database(path)
    migrate(drizzle(db), { migrationsFolder: folder })
    expect(db.prepare('select * from __drizzle_migrations').all()).toEqual(ledger)
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

/** Migrations after the 0030 baseline: an additive upgrade must apply all of them. */
function laterEntries() {
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'))
  return (journal.entries as { idx: number; tag: string }[]).filter(entry => entry.idx > 30)
}
function oldDatabase(dir: string) {
  const baseline = join(dir, 'baseline'), journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'))
  mkdirSync(join(baseline, 'meta'), { recursive: true })
  const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 30)
  writeFileSync(join(baseline, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
  for (const entry of entries) copyFileSync(join(folder, `${entry.tag}.sql`), join(baseline, `${entry.tag}.sql`))
  const db = new Database(join(dir, 'synthetic.sqlite'))
  db.pragma('foreign_keys=ON')
  migrate(drizzle(db), { migrationsFolder: baseline })
  const d = drizzle(db), createdAt = '2026-01-02T03:04:05Z'
  d.insert(s.title).values({ code: 'innovative_sme', nameZh: '创新型中小企业', level: 'municipal', rank: 1 }).run()
  d.insert(s.enterprise).values({ id: 23, name: '原名\n🙂', nameNorm: '原名', usccNorm: '000000000000000023' }).run()
  d.insert(s.record).values({ id: 17, enterpriseId: 23, titleCode: 'innovative_sme', source: 'jxj', nameRaw: '原名\n🙂' }).run()
  // Raw legacy insert: the drizzle schema carries columns added after this
  // baseline (formal_validity), which the pre-0031 database must not require.
  db.prepare('insert into record_event (id, record_id, event_type, year, batch_seq) values (?, ?, ?, ?, ?)').run(19, 17, 'award', 2026, 1)
  d.insert(s.recordEvidence).values({ id: 29, recordEventId: 19, sourceFile: 'synthetic/original.pdf', attachment: '附件\n一', page: 3, listNo: 7 }).run()
  d.insert(s.importBatch).values({ id: 31, idempotencyKey: 'legacy-key', sourceKind: 'platform_archive', sourceIdentity: 'synthetic-original', sourceSha256: 'legacy-hash-kept', status: 'committed', createdAt }).run()
  d.insert(s.importReceipt).values({ id: 37, batchId: 31, operation: 'commit', requestHash: 'legacy-request-hash', requestBody: '{ "original": "原文\\n🙂" }', status: 'committed', createdAt, completedAt: createdAt }).run()
  // Bind only columns present in the 0030 database; preserve original bytes.
  db.prepare('insert into platform_query (id, interface, query_key, rdjb, queried_at, status, raw_response, collection_evidence, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(41, 'business_list', '000000000000000023', '1', createdAt, 'success', '原响应\n🙂\u0000尾', JSON.stringify({ pages: [] }), createdAt)
  db.prepare('insert into platform_relation (id, query_id, sequence_no, enterprise_id, uscc_raw, relation_key, raw_fields, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)').run(43, 41, 1, 23, '000000000000000023', 'legacy-relation-key', JSON.stringify({ original: '原字段\n🙂', number: '0001' }), createdAt)
  d.insert(s.platformBusinessRecord).values({ id: 47, interface: 'business_list', platformKey: 'old-business-id', identityRuleVersion: 'old-v1', createdAt }).run()
  db.prepare('INSERT INTO platform_business_record_version(id,record_id,hash_algorithm,content_hash,canonical_raw_json,created_at) VALUES(?,?,?,?,?,?)').run(53,47,'legacy-hash-v1','unrecomputed-hash','{ "raw": "old🙂" }',createdAt)
  db.prepare('INSERT INTO platform_business_observation(relation_id,record_id,version_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at,batch_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(43,47,53,'resolved','verified','relation_key','old-v1','old-input-fingerprint',createdAt,31)
  d.insert(s.comparisonScopeProof).values({ id: 59, kind: 'official_coverage', evidence: { original: '证明原文🙂' }, sourceFingerprint: 'old-proof-fingerprint', createdAt }).run()
  d.insert(s.comparisonScopeProofAudit).values({ id: 61, proofId: 59, batchId: 31, idempotencyKey: 'legacy-key', toStatus: 'candidate', expectedRevision: 0, resultingRevision: 1, actorType: 'agent', actorId: 'synthetic', basis: '原依据', ruleId: 'old-rule', ruleVersion: '1', decidedAt: createdAt }).run()
  d.insert(s.recordCorrespondence).values({ id: 67, edgeKey: 'old-edge', type: 'event_process', role: 'context', eventId: 19, relationId: 43, enterpriseId: 23, titleCode: 'innovative_sme', status: 'candidate', revision: 1, targetIdentity: { legacy: 'identity' }, provenance: { original: 'old🙂' }, sourceFingerprint: 'old-edge-hash', ruleId: 'old-rule', ruleVersion: '1', createdAt }).run()
  d.insert(s.recordCorrespondenceAudit).values({ id: 71, correspondenceId: 67, batchId: 31, idempotencyKey: 'legacy-key', toStatus: 'candidate', expectedRevision: 0, resultingRevision: 1, actorType: 'agent', actorId: 'synthetic', basis: '原依据', ruleId: 'old-rule', ruleVersion: '1', evidence: { original: '原审计' }, decidedAt: createdAt }).run()
  d.insert(s.job).values({ id: 'old-job', kind: 'current-roster-export', params: { clientRequestId: 'old-request' }, state: 'done', result: { dataVersion: 'old-data-version', artifact: 'old-pointer' }, createdAt, finishedAt: createdAt }).run()
  return db
}
/**
 * Pre-migration table/column shape. Later migrations legitimately add tables and
 * columns; this fixture compares only the rows and columns the baseline had, so
 * an additive migration cannot be mistaken for row loss.
 */
function shape(db: Database.Database) {
  const tables = db.prepare("select name from sqlite_master where type='table' and name!='__drizzle_migrations' order by name").all() as { name: string }[]
  return new Map(tables.map(({ name }) => [name, (db.pragma(`table_info('${name}')`) as { name: string }[]).map(row => row.name)]))
}
function contents(db: Database.Database, baseline = shape(db)) {
  return [...baseline].map(([name, columns]) => [name, db.prepare(`select ${columns.map(column => `"${column}"`).join(',')} from "${name}" order by rowid`).all()])
}
function schemaObjects(db: Database.Database) { return db.prepare('select type,name,tbl_name,sql from sqlite_master order by type,name').all() }

it('M02 old file upgrade preserves all rows IDs hashes proofs audits jobs receipts raw text and old schema objects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cover363-upgrade-'))
  let db = oldDatabase(dir)
  try {
    const baseline = shape(db), before = contents(db, baseline), objects = schemaObjects(db), history = db.prepare('select * from __drizzle_migrations').all()
    expect(currentCandidateSqlFor(db)).toBe(currentCandidateSql)
    migrate(drizzle(db), { migrationsFolder: folder })
    expect(contents(db, baseline)).toEqual(before)
    // Every baseline object must survive; later migrations may only add objects.
    const afterObjects = schemaObjects(db) as { name: string; type: string }[]
    const afterKeys = new Set(afterObjects.map(row => `${row.type}:${row.name}`))
    for (const row of objects as { name: string; type: string }[]) expect(afterKeys.has(`${row.type}:${row.name}`)).toBe(true)
    expect(afterObjects.filter(row => row.name === rIndex || row.name === qIndex)).toHaveLength(2)
    const afterHistory = db.prepare('select * from __drizzle_migrations').all() as { hash: string; created_at: number }[]
    const later = laterEntries()
    expect(afterHistory.slice(0, history.length)).toEqual(history)
    expect(afterHistory).toHaveLength(history.length + later.length)
    expect(afterHistory.slice(history.length).map(row => row.hash)).toEqual(later.map(entry => createHash('sha256').update(readFileSync(join(folder, `${entry.tag}.sql`))).digest('hex')))
    expect(db.pragma('foreign_key_check')).toEqual([])
    db.close(); db = new Database(join(dir, 'synthetic.sqlite'))
    migrate(drizzle(db), { migrationsFolder: folder })
    expect(contents(db, baseline)).toEqual(before)
    expect(db.prepare('select * from __drizzle_migrations').all()).toEqual(afterHistory)
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})
it('M03 existing migrator rolls back first index and ledger when second index fails then restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cover363-rollback-'))
  let db = oldDatabase(dir)
  try {
    db.exec(`CREATE INDEX ${qIndex} ON platform_query(id)`)
    const baseline = shape(db), before = contents(db, baseline), objects = schemaObjects(db), history = db.prepare('select * from __drizzle_migrations').all()
    let failure: unknown
    try { migrate(drizzle(db), { migrationsFolder: folder }) } catch (error) { failure = error }
    expect(String(failure) + String((failure as { cause?: unknown })?.cause)).toContain(`index ${qIndex} already exists`)
    expect(db.inTransaction).toBe(false)
    expect(indexColumns(db, rIndex)).toEqual([])
    expect(contents(db, baseline)).toEqual(before)
    expect(schemaObjects(db)).toEqual(objects)
    expect(db.prepare('select * from __drizzle_migrations').all()).toEqual(history)
    db.close(); db = new Database(join(dir, 'synthetic.sqlite'))
    expect(contents(db, baseline)).toEqual(before)
    expect(schemaObjects(db)).toEqual(objects)
    // Repair only the deliberately injected synthetic collision, then use the same migrator.
    db.exec(`DROP INDEX ${qIndex}`)
    migrate(drizzle(db), { migrationsFolder: folder })
    expect(currentCandidateSqlFor(db)).not.toBe(currentCandidateSql)
    expect(contents(db, baseline)).toEqual(before)
    expect(db.prepare('select * from __drizzle_migrations').all()).toHaveLength(history.length + laterEntries().length)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})
it('M04 readonly old file stays byte intact and sees later external index create and drop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cover363-readonly-')), path = join(dir, 'synthetic.sqlite')
  const writer = oldDatabase(dir)
  writer.close()
  const before = readFileSync(path), reader = new Database(path, { readonly: true, fileMustExist: true })
  const update = new Database(path)
  try {
    reader.function('roster84_uscc', { deterministic: true }, normalizeUscc)
    expect(currentCandidateSqlFor(reader)).toBe(currentCandidateSql)
    expect(reader.prepare(currentCandidateSqlFor(reader)).all({ title: 'innovative_sme', rdjb: '1' })).toEqual([{ id: 23 }])
    expect(readFileSync(path).equals(before)).toBe(true)
    migrate(drizzle(update), { migrationsFolder: folder })
    const migrated = readFileSync(path)
    expect(currentCandidateSqlFor(reader)).not.toBe(currentCandidateSql)
    expect(reader.prepare(currentCandidateSqlFor(reader)).all({ title: 'innovative_sme', rdjb: '1' })).toEqual([{ id: 23 }])
    expect(readFileSync(path).equals(migrated)).toBe(true)
    update.exec(`DROP INDEX ${rIndex}`)
    expect(currentCandidateSqlFor(reader)).toBe(currentCandidateSql)
    expect(reader.prepare(currentCandidateSqlFor(reader)).all({ title: 'innovative_sme', rdjb: '1' })).toEqual([{ id: 23 }])
  } finally { reader.close(); update.close(); rmSync(dir, { recursive: true, force: true }) }
})
it('M05 schema declares exactly the two migrated nonpartial index key lists', () => {
  for (const [table, name, keys] of [
    [s.platformRelation, rIndex, ['query_id', 'sequence_no', 'enterprise_id', 'uscc_raw']],
    [s.platformQuery, qIndex, ['id', 'rdjb', 'title_code', 'collection_evidence']],
  ] as const) {
    const index = getTableConfig(table).indexes.find(index => index.config.name === name)!
    expect(index.config.columns.map(column => 'name' in column ? column.name : null)).toEqual(keys)
    expect(index.config.where).toBeUndefined()
    expect(index.config.unique).toBe(false)
  }
  const statements = readFileSync(join(folder, '0031_current_candidate_covering_indexes.sql'), 'utf8').split('--> statement-breakpoint').map(text => text.trim())
  expect(statements).toEqual([
    'CREATE INDEX platform_relation_current_candidate_cover_idx ON platform_relation(query_id,sequence_no,enterprise_id,uscc_raw);',
    'CREATE INDEX platform_query_current_candidate_cover_idx ON platform_query(id,rdjb,title_code,collection_evidence);',
  ])
})
