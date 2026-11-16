import { commitRecordCorrespondences, preflightRecordCorrespondences } from '../../../server/utils/record-correspondence'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { createRuntimeSchema } from '../../../db/create-runtime'
import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as s from '../../../db/schema'
import { listCurrentQualified } from '../../../lib/roster/current-qualified-query'
import { writeCurrentWorkbook } from '../../../lib/roster/current-workbook'
import ExcelJS from 'exceljs'
import { readCurrentQualificationAssessment } from '../../../lib/roster/current-qualification'
import * as candidates from '../../../upgrade/frozen/current-candidates'
import { normalizeUscc } from '../../../lib/domain'

const relationIndex = 'platform_relation_current_candidate_cover_idx'
const queryIndex = 'platform_query_current_candidate_cover_idx'
const indexSql = `CREATE INDEX ${relationIndex} ON platform_relation(query_id,sequence_no,enterprise_id,uscc_raw);
CREATE INDEX ${queryIndex} ON platform_query(id,rdjb,title_code,collection_evidence);`
const handles: Database.Database[] = []
const directories: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const db of handles.splice(0)) if (db.open) db.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tiny() {
  const db = new Database(':memory:')
  handles.push(db)
  db.function('roster84_uscc', { deterministic: true }, normalizeUscc)
  db.exec(`CREATE TABLE enterprise(id INTEGER PRIMARY KEY,uscc_norm TEXT);
    CREATE TABLE record(enterprise_id INTEGER,title_code TEXT);
    CREATE TABLE difference_reason(enterprise_id INTEGER,title_code TEXT);
    CREATE TABLE record_correspondence(enterprise_id INTEGER,title_code TEXT);
    CREATE TABLE platform_query(id INTEGER PRIMARY KEY,rdjb TEXT,title_code TEXT,raw_response TEXT,collection_evidence TEXT);
    CREATE TABLE platform_relation(id INTEGER PRIMARY KEY,query_id INTEGER,enterprise_id INTEGER,sequence_no INTEGER,raw_fields TEXT,uscc_raw TEXT);`)
  return db
}
it('C01 selects both covering indexes only when available', () => {
  const db = tiny()
  db.exec("INSERT INTO enterprise VALUES(23,null); INSERT INTO platform_query VALUES(1,'1',null,'raw',null); INSERT INTO platform_relation VALUES(1,1,23,1,'raw',null)")
  expect(candidates.currentCandidateSqlFor(db)).toBe(candidates.currentCandidateSql)
  db.exec(indexSql)
  const sql = candidates.currentCandidateSqlFor(db)
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ title: 'innovative_sme', rdjb: '1' }) as { detail: string }[]).map(row => row.detail)
  expect(plan.some(line => /^(SCAN|SEARCH) r USING COVERING INDEX platform_relation_current_candidate_cover_idx(?: |$)/.test(line)), plan.join('\n')).toBe(true)
  expect(plan.some(line => /^(SCAN|SEARCH) q USING COVERING INDEX platform_query_current_candidate_cover_idx(?: |$)/.test(line)), plan.join('\n')).toBe(true)
  expect(db.prepare(sql).all({ title: 'innovative_sme', rdjb: '1' })).toEqual([{ id: 23 }])
})

// Consumer fixtures are newly created, tiny files. No app worker/server is imported.
function consumerFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cover363-consumer-'))
  const sqlite = new Database(join(dir, 'synthetic.sqlite'))
  handles.push(sqlite); directories.push(dir)
  sqlite.pragma('foreign_keys=ON')
  createRuntimeSchema(sqlite)
  const db = drizzle(sqlite)
  for (const [offset, title] of ['innovative_sme', 'specialized_sme', 'little_giant'].entries()) {
    for (let n = 1; n <= 4; n++) {
      const id = offset * 4 + n
      const name = n === 1 ? '=1+1' : n === 2 ? 'Zeta\n企业😀' : `候选${id}`
      db.insert(s.enterprise).values({ id, name, nameNorm: name, usccNorm: String(id).padStart(18, '0'), district: n === 2 ? '海曙区' : '鄞州区', city: '宁波市' }).run()
      db.insert(s.record).values({ id, enterpriseId: id, titleCode: title, source: 'jxj', nameRaw: name }).run()
      db.insert(s.recordEvent).values({ id, recordId: id, eventType: n === 4 ? 'nurture' : 'award', year: n === 3 ? 2020 : 2026, batchSeq: 1 }).run()
      db.insert(s.recordEvidence).values({ id, recordEventId: id, sourceFile: 'jxj/announcement/synthetic363.pdf', attachment: '名单\n附件', listNo: id, page: 7 }).run()
    }
  }
  return { db: sqlite, dir }
}
it.each([
  { name: 'relation-only', ddl: `DROP INDEX ${queryIndex}` },
  { name: 'query-only', ddl: `DROP INDEX ${relationIndex}` },
  { name: 'relation-reordered', ddl: `DROP INDEX ${relationIndex}; CREATE INDEX ${relationIndex} ON platform_relation(sequence_no,query_id,enterprise_id,uscc_raw)` },
  { name: 'query-missing-key', ddl: `DROP INDEX ${queryIndex}; CREATE INDEX ${queryIndex} ON platform_query(id,rdjb,title_code)` },
  { name: 'query-extra-key', ddl: `DROP INDEX ${queryIndex}; CREATE INDEX ${queryIndex} ON platform_query(id,rdjb,title_code,collection_evidence,raw_response)` },
  { name: 'relation-expression', ddl: `DROP INDEX ${relationIndex}; CREATE INDEX ${relationIndex} ON platform_relation(query_id,sequence_no,enterprise_id,lower(uscc_raw))` },
  { name: 'query-wrong-table', ddl: `DROP INDEX ${queryIndex}; CREATE TABLE other(id,rdjb,title_code,collection_evidence); CREATE INDEX ${queryIndex} ON other(id,rdjb,title_code,collection_evidence)` },
  { name: 'relation-partial', ddl: `DROP INDEX ${relationIndex}; CREATE INDEX ${relationIndex} ON platform_relation(query_id,sequence_no,enterprise_id,uscc_raw) WHERE enterprise_id IS NOT NULL` },
  { name: 'query-partial', ddl: `DROP INDEX ${queryIndex}; CREATE INDEX ${queryIndex} ON platform_query(id,rdjb,title_code,collection_evidence) WHERE rdjb='1'` },
])('C02 rejects $name and executes original SQL safely', ({ ddl }) => {
  const db = tiny(); db.exec(indexSql); db.exec(ddl)
  ent(db, 23); query(db, 1, '1'); relation(db, 1, 1, 23)
  expect(candidates.currentCandidateSqlFor(db)).toBe(candidates.currentCandidateSql)
  expect(db.prepare(candidates.currentCandidateSqlFor(db)).all({ title: 'innovative_sme', rdjb: '1' })).toEqual([{ id: 23 }])
})
it('C03 index additions and drops are visible on later requests without cross-connection caching', () => {
  const first = tiny(), second = tiny()
  expect(candidates.currentCandidateSqlFor(first)).toBe(candidates.currentCandidateSql)
  first.exec(indexSql)
  expect(candidates.currentCandidateSqlFor(first)).not.toBe(candidates.currentCandidateSql)
  expect(candidates.currentCandidateSqlFor(second)).toBe(candidates.currentCandidateSql)
  first.exec(`DROP INDEX ${queryIndex}`)
  expect(candidates.currentCandidateSqlFor(first)).toBe(candidates.currentCandidateSql)
  first.exec(`CREATE INDEX ${queryIndex} ON platform_query(id,rdjb,title_code,collection_evidence)`)
  expect(candidates.currentCandidateSqlFor(first)).not.toBe(candidates.currentCandidateSql)
})
it('C04 SQL bytes and bindings retain the frozen original with exactly two hints', () => {
  const db = tiny(); db.exec(indexSql)
  const wrap = (sql: string) => `select c.id from (${sql}) c join enterprise e on e.id=c.id order by c.id asc`
  const original = wrap(candidates.currentCandidateSql), covering = wrap(candidates.currentCandidateSqlFor(db))
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  expect(Buffer.byteLength(original)).toBe(3279)
  expect(sha(original)).toBe('90c4d25b4c53595410e6a3d4a27e391c84aff42ba254fef43831e443b4c13c48')
  expect(Buffer.byteLength(covering)).toBe(3390)
  expect(sha(covering)).toBe('c4ab7561a48d41aa9a7de6b776520aaed8926432bf1c542c6220bc833f672d19')
  expect(covering.replace(` INDEXED BY ${relationIndex}`, '').replace(` INDEXED BY ${queryIndex}`, '')).toBe(original)
  expect(candidates.currentCandidateBindings('innovative_sme')).toEqual({ title: 'innovative_sme', rdjb: '1' })
  expect(candidates.currentCandidateBindings('specialized_sme')).toEqual({ title: 'specialized_sme', rdjb: '2' })
  expect(candidates.currentCandidateBindings('little_giant')).toEqual({ title: 'little_giant', rdjb: '3' })
})

function ent(db: Database.Database, id: number, uscc: string | null = null) { db.prepare('INSERT INTO enterprise VALUES(?,?)').run(id, uscc) }
function query(db: Database.Database, id: number, rdjb: string, title: string | null = null, evidence: unknown = null) {
  db.prepare('INSERT INTO platform_query VALUES(?,?,?,?,?)').run(id, rdjb, title, '原响应\n🙂', typeof evidence === 'object' && evidence !== null ? JSON.stringify(evidence) : evidence)
}
function relation(db: Database.Database, id: number, queryId: number, owner: number | null, seq = 1, uscc: string | null = null) {
  db.prepare('INSERT INTO platform_relation VALUES(?,?,?,?,?,?)').run(id, queryId, owner, seq, '原行\n🙂', uscc)
}
const page = (rdjb: string, fetchedCount: unknown, status = 'success') => ({ rdjb, fetchedCount, status })
const titles = [
  { title: 'innovative_sme', rdjb: '1' },
  { title: 'specialized_sme', rdjb: '2' },
  { title: 'little_giant', rdjb: '3' },
] as const
// Each literal runs against both access paths and all three actual consumer wrappers.
function literal(setup: (db: Database.Database) => void, expected: number[], binding: { title: string; rdjb: string } = titles[0], innerExpected = expected, malformed = false) {
  for (const indexed of [false, true]) {
    const db = tiny(); setup(db); if (indexed) db.exec(indexSql)
    const sql = candidates.currentCandidateSqlFor(db)
    const wrappers = [
      `select c.id from (${sql}) c join enterprise e on e.id=c.id order by c.id asc`,
      `select id from (${sql}) order by id`,
      `select count(*) as n from (${sql})`,
    ]
    for (const [n, wrapper] of wrappers.entries()) {
      const run = () => db.prepare(wrapper).all(binding)
      if (malformed) expect(run).toThrow(/malformed JSON/)
      else expect(run()).toEqual(n === 2 ? [{ n: innerExpected.length }] : (n === 0 ? expected : innerExpected).map(id => ({ id })))
    }
  }
}
it.each(titles)('C10 four sources owned normalized unknown owners and duplicates for $title', binding => {
  literal(db => {
    for (const [id, uscc] of [[1, 'ABC'], [2, 'a b c'], [3, null], [4, null], [5, null], [6, null]] as const) ent(db, id, uscc)
    db.prepare('INSERT INTO record VALUES(?,?),(?,?),(?,?)').run(3, binding.title, 1, binding.title, 3, binding.title)
    db.prepare('INSERT INTO difference_reason VALUES(?,?)').run(4, binding.title)
    db.prepare('INSERT INTO record_correspondence VALUES(?,?),(?,?)').run(5, binding.title, null, binding.title)
    query(db, 1, binding.rdjb, null, { pages: ['bad'] })
    relation(db, 1, 1, 1); relation(db, 2, 1, null, 2, ' a\u200bb c '); relation(db, 3, 1, null, 3, 'NO_MATCH'); relation(db, 4, 1, 1, 4, 'ignored')
    query(db, 2, binding.rdjb === '1' ? '2' : '1'); relation(db, 5, 2, 6)
  }, [1, 2, 3, 4, 5], binding)
})
it.each(titles)('C11 single rdjb short circuits malformed pages for $title', binding => {
  literal(db => { ent(db, 23); query(db, 1, binding.rdjb, null, { pages: ['bad'] }); relation(db, 1, 1, 23) }, [23], binding)
})
it('C12 explicit single query title overrides rdjb', () => {
  literal(db => { ent(db, 23); query(db, 1, '2', 'innovative_sme', 'not JSON'); relation(db, 1, 1, 23) }, [23])
})
it.each([
  { ...titles[0], expected: [1, 2, 6, 7] },
  { ...titles[1], expected: [3, 6, 7] },
  { ...titles[2], expected: [4, 5, 6, 7] },
])('C13 T05 multi-page status zero and sequence boundaries for $title', ({ expected, ...binding }) => {
  literal(db => {
    query(db, 1, '1,2,3', null, { pages: [page('3', 100, 'failed'), page('3', 0), page('1', 2), page('2', 1), page('3', 2)] })
    for (let id = 1; id <= 7; id++) { ent(db, id); relation(db, id, 1, id, id === 6 ? 0 : id === 7 ? 6 : id) }
  }, expected, binding)
})
it.each([
  { name: 'explicit-negative', rdjb: '1,2', title: 'specialized_sme', expected: [] },
  { name: 'explicit-positive', rdjb: '1,2', title: 'innovative_sme', expected: [23] },
  { name: 'membership-positive', rdjb: '1,2', title: null, expected: [23] },
  { name: 'membership-negative', rdjb: '2,3', title: null, expected: [] },
])('C14 unknown first page fallback $name', ({ rdjb, title, expected }) => {
  literal(db => { ent(db, 23); query(db, 1, rdjb, title, { pages: [page('9', 1), page('1', 1)] }); relation(db, 1, 1, 23) }, expected)
})
it('C15 bad outer JSON retains unknown fallback', () => {
  literal(db => { ent(db, 23); query(db, 1, '1,2', null, 'not JSON'); relation(db, 1, 1, 23) }, [23])
})
it.each([{ name: 'owned', owner: 23 }, { name: 'no-owner', owner: null }])('C16 bad page retains malformed JSON error for $name', ({ owner }) => {
  literal(db => { ent(db, 23); query(db, 1, '1,2', null, { pages: ['bad'] }); relation(db, 1, 1, owner) }, [], titles[0], [], true)
})
it('C17 no relation does not newly evaluate malformed pages', () => {
  literal(db => { ent(db, 23); query(db, 1, '1,2', null, { pages: ['bad'] }) }, [])
})
it('C18 empty unknown owner is excluded', () => {
  literal(db => { ent(db, 23); query(db, 1, '1'); relation(db, 1, 1, null, 1, '') }, [])
})
it('C19 list enterprise join excludes missing owner while workbook candidate retains it', () => {
  literal(db => { ent(db, 23); query(db, 1, '1'); relation(db, 1, 1, 999) }, [], titles[0], [999])
})
it('C20 large sequence beyond all pages retains unknown fallback', () => {
  literal(db => { ent(db, 23); query(db, 1, '1,2', null, { pages: [page('2', 1)] }); relation(db, 1, 1, 23, 9007199254740991) }, [23])
})
it.each([
  { name: 'string-count', count: '2', seq: 2, expected: [23] },
  { name: 'large-count', count: 9007199254740991, seq: 9007199254740991, expected: [23] },
  { name: 'fraction-before-boundary', count: 1.5, seq: 1, expected: [23] },
  { name: 'fraction-at-boundary', count: 1.5, seq: 1.5, expected: [23] },
  { name: 'fraction-after-boundary', count: 1.5, seq: 2, expected: [] },
])('C21 original fetched count semantics $name', ({ count, seq, expected }) => {
  literal(db => { ent(db, 23); query(db, 1, '1,2', null, { pages: [page('1', count), page('2', 1)] }); relation(db, 1, 1, 23, seq) }, expected)
})
it('C22 empty database returns complete empty candidate sets', () => { literal(() => {}, []) })
it('C05 both covering indexes appear in every list count and eligible plan', () => {
  const db = tiny(); ent(db, 23); query(db, 1, '1'); relation(db, 1, 1, 23); db.exec(indexSql)
  const sql = candidates.currentCandidateSqlFor(db)
  for (const wrapper of [`select c.id from (${sql}) c join enterprise e on e.id=c.id order by c.id asc`, `select count(*) as n from (${sql})`, `select id from (${sql}) order by id`]) {
    const plan = (db.prepare('EXPLAIN QUERY PLAN ' + wrapper).all(titles[0]) as { detail: string }[]).map(row => row.detail)
    expect(plan.some(line => /^(SCAN|SEARCH) r USING COVERING INDEX platform_relation_current_candidate_cover_idx(?: |$)/.test(line)), plan.join('\n')).toBe(true)
    expect(plan.some(line => /^(SCAN|SEARCH) q USING COVERING INDEX platform_query_current_candidate_cover_idx(?: |$)/.test(line)), plan.join('\n')).toBe(true)
    expect(plan.filter(line => /^(SCAN|SEARCH) [rq] /.test(line)).every(line => line.includes('USING COVERING INDEX'))).toBe(true)
  }
})
// Source ledger: each title owns four records; offsets 1/5/9 have awards
// in 2026, +1 also awarded 2026, +2 awarded 2020, +3 nurture only.
// Lower-title 2020 awards expire annually; giant 11 retains original recognition
// and is included in both lower titles without fabricating their history.
const consumerOracle = {
  innovative_sme: { candidates: [1,2,3,4,5,6,7,8,9,10,11,12], eligible: [1,2,5,6,9,10,11], expired: [3], unrecognized: [4,7,8,12] },
  specialized_sme: { candidates: [5,6,7,8,9,10,11,12], eligible: [5,6,9,10,11], expired: [7], unrecognized: [8,12] },
  little_giant: { candidates: [9,10,11,12], eligible: [9,10,11], expired: [], unrecognized: [12] },
}
it.each(titles)('C32 fixed-time list literals preserve qualification filters options witnesses basis and references for $title', ({ title }) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
  const f = consumerFixture(), first = title === 'innovative_sme' ? 1 : title === 'specialized_sme' ? 5 : 9
  const oracle = consumerOracle[title], ids = oracle.eligible
  const filters = [
    {}, { page: 2, pageSize: 1 }, { q: '=1+1', district: '鄞州区' }, { q: String(first).padStart(18, '0') },
    { district: '不存在' }, { sort: 'name_desc' as const }, { sort: 'name_asc' as const }, { page: 4, pageSize: 1 },
    { recognitionFrom: '2026-01-01', recognitionTo: '2026-12-31' },
    { recognitionFrom: '2026-06-01', recognitionTo: '2026-12-31' },
    { validYear: 2026 }, { maintenanceYear: 2026 }, { maintenanceYear: 2026, maintenanceBatch: 1 },
  ]
  const read = () => filters.map(filter => listCurrentQualified(f.db, { titleCode: title, ...filter }))
  const covered = read()
  const all = covered[0]!
  expect(all).toMatchObject({ total: ids.length, uncertainTotal: 0, titleCode: title, ruleVersion: 'current-roster-116-v13', snapshotStartedAt: '2026-10-26T00:00:00.000Z', options: { recognitionYears: title === 'little_giant' ? [2020, 2026] : [2026], validYears: [], maintenanceYears: [], maintenanceBatchesByYear: {} } })
  expect(all.rows.map(row => row.enterpriseId)).toEqual(ids)
  expect(all.rows[0]).toMatchObject({ name: '=1+1', uscc: String(first).padStart(18, '0'), district: '鄞州区', group: 'eligible', firstYear: 2026, publishedNames: ['=1+1'], aliases: [], publication: '已见本称号宁波公布记录', basis: `event:${first}@1 award 2026/1 结论年:`, reviews: '', references: [`evidence:${first} jxj/announcement/synthetic363.pdf 名单\n附件 序号:${first}`], recognition: { precision: 'year', year: 2026 }, matchedValidYears: [], matchedMaintenance: [] })
  expect(all.rows[0]!.qualificationWitnesses).toEqual([{ cycle: { originYear: 2026, batchSeq: 1 }, awardEventId: first, recognition: { precision: 'year', year: 2026 }, matchedValidYear: null, matchedMaintenance: null, correspondenceId: null, conditionQueryId: null }])
  expect(covered[1]).toMatchObject({ total: ids.length, page: 2, pageSize: 1, rows: [{ enterpriseId: first + 1 }] })
  expect(covered[2]!.rows.map(row => row.enterpriseId)).toEqual(ids.filter(id => id % 4 === 1))
  expect(covered[3]!.rows.map(row => row.enterpriseId)).toEqual([first])
  expect(covered[4]).toMatchObject({ total: 0, rows: [] })
  expect(covered[5]!.rows.map(row => row.enterpriseId)).toEqual([...ids.filter(id => id % 4 === 3), ...ids.filter(id => id % 4 === 2), ...ids.filter(id => id % 4 === 1)])
  expect(covered[6]!.rows.map(row => row.enterpriseId)).toEqual([...ids.filter(id => id % 4 === 1), ...ids.filter(id => id % 4 === 2), ...ids.filter(id => id % 4 === 3)])
  expect(covered[7]).toMatchObject({ total: ids.length, rows: ids.length > 3 ? [{ enterpriseId: ids[3] }] : [] })
  // Recognition filters require own-title witnesses; inherited grants do not fabricate them.
  expect(covered[8]).toMatchObject({ total: 2, uncertainTotal: title === 'little_giant' ? 0 : ids.length - 2 })
  expect(covered[8]!.rows.map(row => row.enterpriseId)).toEqual([first, first + 1])
  expect(covered[9]).toMatchObject({ total: 0, uncertainTotal: title === 'little_giant' ? 2 : ids.length, rows: [] })
  for (const result of covered.slice(10)) expect(result).toMatchObject({ total: 0, uncertainTotal: 0, rows: [] })
  expect(JSON.stringify(all)).not.toMatch(/rawFields|rawResponse|workbookFacts/)
})
it.each(titles)('C33 fixed-time workbook literals preserve all sheets columns text and dataVersion for $title', async ({ title }) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
  const f = consumerFixture(), first = title === 'innovative_sme' ? 1 : title === 'specialized_sme' ? 5 : 9
  const run = async (name: string) => {
    const progress: unknown[] = [], path = join(f.dir, name)
    const result = await writeCurrentWorkbook(f.db, title, path, (...args) => progress.push(args))
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path)
    return { result, progress, workbook }
  }
  const covered = await run('native.xlsx')
  const oracle = consumerOracle[title]
  expect(covered.result).toMatchObject({ total: oracle.candidates.length, counts: { eligible: oracle.eligible.length, pending: 0, excluded: oracle.candidates.length - oracle.eligible.length }, generatedAt: '2026-10-26T00:00:00.000Z', snapshotStartedAt: '2026-10-26T00:00:00.000Z', ruleVersion: 'current-roster-116-v13' })
  // Hash independently from public full assessment scoped to the requested title
  // and ExcelJS's real text cells, never from writer rows or its returned digest.
  const hash = createHash('sha256').update(JSON.stringify(['current-export-assessment-title-v3', 'enterprise-qualification-740-v6', 'current-roster-116-v13', 2026, title]) + '\n')
  for (const [group, sheetName, ids] of [['effective', '有效企业', oracle.eligible], ['expired', '已到期', oracle.expired], ['unrecognized', '未认定', oracle.unrecognized]] as const) {
    const sheet = covered.workbook.getWorksheet(sheetName)!
    expect(sheet.rowCount).toBe(ids.length + 1)
    for (const [index, id] of ids.entries()) {
      const full = readCurrentQualificationAssessment(f.db, id, Date.parse('2026-10-26T00:00:00Z'))
      const { titles: allTitles, snapshotId: _fullDigest, ...scope } = full
      const selected = allTitles.filter(item => item.titleCode === title)
      expect(selected[0]!.effectiveQualification!.status).toBe(group)
      expect(scope).toMatchObject({ enterpriseId: id, assessmentVersion: 'enterprise-qualification-740-v6', ruleVersion: 'current-roster-116-v13' })
      const sourceTitle = id <= 4 ? 'innovative_sme' : id <= 8 ? 'specialized_sme' : 'little_giant'
      const source = allTitles.find(item => item.titleCode === sourceTitle)!
      expect(source.evidence).toEqual([{ eventId: id, revision: 1, eventType: id % 4 === 0 ? 'nurture' : 'award', year: id % 4 === 3 ? 2020 : 2026, batchSeq: 1, decidedYear: null, reviewOutcome: null, evidenceIds: [id] }])
      expect(source.sourceVersions).toEqual([{ evidenceId: id, eventId: id, sourceFile: 'jxj/announcement/synthetic363.pdf', storedFileId: null, sha256: null, bytes: null, removedAt: null, capturedRevision: null, capturedSha256: null }])
      if (group === 'effective' && sourceTitle !== title) {
        expect(selected[0]!.evidence).toEqual([])
        expect(selected[0]!.effectiveQualification!.localRuleBasis).toContain(sourceTitle === 'little_giant'
          ? '按有效小巨人资格计入；实际支撑称号：小巨人'
          : '按有效专精特新中小企业资格计入；实际支撑称号：专精特新中小企业')
      }
      const snapshotId = createHash('sha256').update(JSON.stringify([scope, selected])).digest('hex')
      const values = Array.from({ length: 15 }, (_, column) => sheet.getRow(index + 2).getCell(column + 1).value)
      expect(values[0]).toBe(String(index + 1))
      expect(values[1]).toBe(id % 4 === 1 ? '=1+1' : id % 4 === 2 ? 'Zeta\n企业😀' : `候选${id}`)
      expect(values[2]).toBe(String(id).padStart(18, '0'))
      values[13] ??= ''; values[14] ??= ''
      hash.update(JSON.stringify([group, id, scope, snapshotId, values]) + '\n')
    }
  }
  expect(covered.result.dataVersion).toBe('sha256:' + hash.digest('hex'))
  expect(covered.progress).toEqual([[0, oracle.candidates.length, '2026-10-26T00:00:00.000Z']])
  expect(covered.workbook.worksheets.map(sheet => sheet.name)).toEqual(['有效企业', '已到期', '已注销（吊销）', '已迁出', '未认定', '口径说明'])
  expect(covered.workbook.worksheets.map(sheet => sheet.rowCount)).toEqual([oracle.eligible.length + 1, oracle.expired.length + 1, 1, 1, oracle.unrecognized.length + 1, 9])
  const headers = ['序号', '企业名称', '统一社会信用代码', '区县', '称号', '首次认定年份', '认定及复核情况', '公布名称', '已确认曾用名', '公布对应情况', '情况说明', '来源及页码', '有效状态', '有效期及排除依据', '资料缺口与来源备注']
  for (const sheet of covered.workbook.worksheets.slice(0, 5)) {
    expect(sheet.getRow(1).values).toEqual([undefined, ...headers])
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', xSplit: 2, ySplit: 1 })
    sheet.eachRow(row => row.eachCell(cell => { expect(cell.type).not.toBe(ExcelJS.ValueType.Formula); expect(typeof cell.value).toBe('string') }))
  }
  const eligible = covered.workbook.getWorksheet('有效企业')!
  expect(eligible.getCell('B2').value).toBe('=1+1')
  expect(eligible.getCell('C2').value).toBe(String(first).padStart(18, '0'))
  expect(eligible.getCell('B3').value).toBe('Zeta\n企业😀')
  expect(eligible.getCell('F2').value).toBe('2026')
  expect(eligible.getCell('L2').value).toContain('名单\n附件')
  expect(eligible.getCell('L2').value).toContain(`名单序号${first}`)
  expect(eligible.getCell('L2').value).toContain('第7页')
  expect(eligible.autoFilter).toBe(`A1:O${oracle.eligible.length + 1}`)
  expect(covered.workbook.getWorksheet('已到期')!.getCell('B2').value).toBe(title === 'little_giant' ? null : `候选${first + 2}`)
  expect(covered.workbook.getWorksheet('未认定')!.getCell('B2').value).toBe(`候选${first + 3}`)
  expect(f.db.inTransaction).toBe(false)
})
it('C34 both consumers read a native readonly file without changing database bytes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
  const f = consumerFixture(), path = f.db.name
  f.db.close()
  const before = readFileSync(path), readonly = new Database(path, { readonly: true, fileMustExist: true }); handles.push(readonly)
  expect(listCurrentQualified(readonly, { titleCode: 'innovative_sme' })).toMatchObject({ total: 7, rows: [1,2,5,6,9,10,11].map(enterpriseId => ({ enterpriseId })) })
  expect(await writeCurrentWorkbook(readonly, 'innovative_sme', join(f.dir, 'readonly.xlsx'), () => {})).toMatchObject({ total: 12, counts: { eligible: 7, pending: 0, excluded: 5 } })
  expect(readFileSync(path).equals(before)).toBe(true)
})
it('C35 confirmed recognized witness preserves positive options filters and source pointers', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
  const f = consumerFixture(), db = drizzle(f.db, { schema: s }), stamp = '2026-10-25T00:00:00Z'
  const rawFields = { id: 'synthetic363-recognized', qymc:'=1+1',tyshxydm:'000000000000000001', rddqrq: '2028-11-20', whpc: '2025-2' }
  const seeded = submitNativePlatformQuery(db, { interface: 'recognized_list', queryKey: '000000000000000001', rdjb: '1', titleCode: 'innovative_sme', queriedAt: stamp, status: 'success', collectionEvidence: {
    source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and', rddqrq: '2028', whpcyear: '2025', whpc: '2' },
    titleScope: { mode: 'selected', rdjb: ['1'] }, queriedAt: stamp, completedAt: stamp,
    rows: [rawFields], pages: [{ source: 'queryBusList', rdjb: '1', page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, maxPage: 1, error:null }],
    fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
    limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 },
  }, relations:[{ sequenceNo:1,relationKey:rawFields.id,enterpriseId:1,usccRaw:'000000000000000001',nameRaw:'=1+1',rawFields,verificationStatus:'confirmed',matchBasis:'uscc' }] })
  const request = { idempotencyKey: 'cover363-recognized', sourceIdentity: 'synthetic/cover363', actor: { type: 'agent' as const, id: 'synthetic363' }, basis: 'Synthetic confirmed event and recognized row', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create' as const, status: 'confirmed' as const, edge: { type: 'event_recognized' as const, eventId: 1, relationId: seeded.relationIds[0]!, role: 'recognized_corrob' as const } }] }
  const plan = preflightRecordCorrespondences(db, request)
  commitRecordCorrespondences(db, request, plan.planHash)
  const filters = [{}, { validYear: 2028, maintenanceYear: 2025 }, { validYear: 2029 }, { maintenanceYear: 2025, maintenanceBatch: 2 }]
  const read = () => filters.map(filter => listCurrentQualified(f.db, { titleCode: 'innovative_sme', ...filter }))
  const covered = read()
  expect(covered[0]).toMatchObject({ total: 7, options: { recognitionYears: [2026], validYears: [2028], maintenanceYears: [2025], maintenanceBatchesByYear: {} } })
  expect(covered[1]).toMatchObject({ total: 1, rows: [{ enterpriseId: 1, matchedValidYears: [2028], matchedMaintenance: [{ year: 2025, batch: null }] }] })
  expect(covered[1]!.rows[0]!.qualificationWitnesses).toEqual([{ cycle: { originYear: 2026, batchSeq: 1 }, awardEventId: 1, recognition: { precision: 'year', year: 2026 }, matchedValidYear: 2028, matchedMaintenance: { year: 2025, batch: null }, correspondenceId: 1, conditionQueryId: 1 }])
  expect(covered[1]!.rows[0]!.references).toEqual(['evidence:1 jxj/announcement/synthetic363.pdf 名单\n附件 序号:1', 'platform-relation:1 query:1', 'correspondence:1@2 confirmed'])
  expect(covered[2]).toMatchObject({ total: 0, rows: [] })
  expect(covered[3]).toMatchObject({ total: 0, rows: [] })
})
it('C36 confirmed alias filtering preserves identity references and excludes pending aliases', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
  const f = consumerFixture(), db = drizzle(f.db)
  db.insert(s.enterpriseAlias).values({ id: 1, enterpriseId: 1, name: '原公布名称', nameNorm: '原公布名称', sourceKind: 'manual', verificationStatus: 'confirmed' }).run()
  db.insert(s.enterpriseAlias).values({ id: 2, enterpriseId: 2, name: '原公布名称', nameNorm: '原公布名称', sourceKind: 'manual', verificationStatus: 'pending' }).run()
  const read = () => listCurrentQualified(f.db, { titleCode: 'innovative_sme', q: '原公布名称', district: '鄞州区' })
  const covered = read()
  expect(covered).toMatchObject({ total: 1, rows: [{ enterpriseId: 1, aliases: ['原公布名称'], references: ['evidence:1 jxj/announcement/synthetic363.pdf 名单\n附件 序号:1', 'alias:1@1'] }] })
})
