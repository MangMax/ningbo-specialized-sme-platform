import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { normalizeUscc } from '../lib/domain'
import { currentCandidateBindings, currentCandidateSql } from '../lib/roster/current-candidates'
import type { CurrentTitle } from '../lib/roster/current-titles'

const titles = ['innovative_sme', 'specialized_sme', 'little_giant'] as const
const handles: Database.Database[] = []
afterEach(() => { for (const db of handles.splice(0)) db.close() })

// Real SQLite with the production column affinities at the shared SQL seam.
// No source bodies, HTTP server, worker, timing threshold or shared fixture.
function fixture() {
  const db = new Database(':memory:')
  handles.push(db)
  db.function('roster84_uscc', { deterministic: true }, (value: unknown) => normalizeUscc(value) || null)
  db.exec(`create table enterprise(id integer primary key, name text, uscc_norm text);
    create table record(enterprise_id integer, title_code text);
    create table difference_reason(enterprise_id integer, title_code text);
    create table record_correspondence(enterprise_id integer, title_code text);
    create table platform_query(id integer primary key, title_code text, rdjb text, collection_evidence text, status text);
    create table platform_relation(id integer primary key, query_id integer, enterprise_id integer, uscc_raw text, sequence_no integer);`)
  const enterprise = (id: number, uscc: string | null = null) => db.prepare('insert into enterprise values (?,?,?)').run(id, 'Synthetic ' + id, uscc)
  const query = (id: number, rdjb: string | null, title: string | null, evidence: string | null, status = 'failed') =>
    db.prepare('insert into platform_query values (?,?,?,?,?)').run(id, title, rdjb, evidence, status)
  const relation = (queryId: number, enterpriseId: number | null, sequence: number | string, uscc: string | null = null) =>
    db.prepare('insert into platform_relation(query_id,enterprise_id,sequence_no,uscc_raw) values (?,?,?,?)').run(queryId, enterpriseId, sequence, uscc)
  function ids(title: CurrentTitle) {
    const bindings = currentCandidateBindings(title)
    const rows = db.prepare(`select id from (${currentCandidateSql}) order by id`).all(bindings) as { id: number }[]
    // The workbook's independent count wrapper must agree with the same literal oracle.
    const count = db.prepare(`select count(*) as n from (${currentCandidateSql})`).get(bindings) as { n: number }
    expect(count.n).toBe(rows.length)
    return rows.map(row => row.id)
  }
  return { db, enterprise, query, relation, ids }
}

it('unions all four candidate sources, deduplicates and preserves assigned and normalized owners', () => {
  const f = fixture()
  for (let id = 1; id <= 10; id++) f.enterprise(id, id === 4 ? ' ab\u200bc ' : id === 5 ? 'ABC' : id === 7 ? '' : null)
  f.db.exec(`insert into record values (3,'specialized_sme'),(1,'specialized_sme'),(1,'specialized_sme'),(9,'little_giant');
    insert into difference_reason values (2,'specialized_sme'),(3,'specialized_sme');
    insert into record_correspondence values (6,'specialized_sme'),(null,'specialized_sme');`)
  f.query(1, '2', null, null)
  f.relation(1, null, 1, ' a b c ')
  f.relation(1, 8, 2, 'ABC') // Explicit owner wins over the normalized other owners.
  f.relation(1, 3, 3)
  f.relation(1, null, 4, null)
  f.relation(1, null, 5, ' ')
  f.relation(1, null, 6, 'NO-OWNER')
  f.relation(999, 10, 1) // No query to establish title scope.
  expect(f.ids('specialized_sme')).toEqual([1, 2, 3, 4, 5, 6, 8])
  expect(f.ids('little_giant')).toEqual([9])
  expect(f.ids('innovative_sme')).toEqual([])
})

it.each([
  ['1', null, [[1], [], []]],
  ['2', null, [[], [1], []]],
  ['3', null, [[], [], [1]]],
  ['1', 'specialized_sme', [[], [1], []]],
  ['unknown', null, [[], [], []]],
  [null, null, [[], [], []]],
] as const)('keeps single rdjb %s and explicit title %s independent of malformed evidence', (rdjb, title, expected) => {
  const f = fixture()
  f.enterprise(1)
  f.query(1, rdjb, title, '{broken')
  f.relation(1, 1, 1)
  expect(titles.map(f.ids)).toEqual(expected)
})

it('positions all three titles across successful pages and retains unknown sequences from failed queries', () => {
  const f = fixture()
  f.query(1, '1,2,3', null, JSON.stringify({ pages: [
    { rdjb: '1', status: 'success', fetchedCount: 2 },
    { rdjb: '2', status: 'failed', fetchedCount: 90 },
    { rdjb: '2', status: 'success', fetchedCount: 1 },
    { rdjb: '3', status: 'success', fetchedCount: 2 },
    { rdjb: '1', status: 'success', fetchedCount: 0 },
  ] }))
  for (let sequence = 0; sequence <= 6; sequence++) { f.enterprise(sequence + 1); f.relation(1, sequence + 1, sequence) }
  const before = f.db.serialize()
  expect(titles.map(f.ids)).toEqual([[1, 2, 3, 7], [1, 4, 7], [1, 5, 6, 7]])
  // Snapshot/count/order wrappers leave the source metadata and ownership untouched.
  expect(f.db.prepare('select status from platform_query').get()).toEqual({ status: 'failed' })
  expect(f.db.prepare('select count(*) as n from platform_relation').get()).toEqual({ n: 7 })
  expect(f.db.serialize()).toEqual(before)
})

it.each([
  ['missing JSON', null], ['malformed JSON', '{broken'], ['missing pages', '{}'],
  ['null pages', '{"pages":null}'], ['empty pages', '{"pages":[]}'],
  ['only failed or unknown pages', '{"pages":[{"rdjb":"1","status":"failed","fetchedCount":9},{"rdjb":"2","status":"unknown","fetchedCount":9}]}'],
])('keeps unknown title fallback for %s', (_name, evidence) => {
  const f = fixture()
  f.enterprise(1)
  f.query(1, '1,3', null, evidence)
  f.relation(1, 1, 1)
  expect(titles.map(f.ids)).toEqual([[1], [], [1]])
  f.db.prepare('update platform_query set title_code=?').run('specialized_sme')
  expect(titles.map(f.ids)).toEqual([[], [1], []])
})

it.each([
  ['text count', '[{"rdjb":"1","status":"success","fetchedCount":"2"},{"rdjb":"2","status":"success","fetchedCount":1}]', [[1, 2], [3], [4]]],
  ['boolean count', '[{"rdjb":"1","status":"success","fetchedCount":true},{"rdjb":"2","status":"success","fetchedCount":1}]', [[1], [2], [3, 4]]],
  ['fractional count', '[{"rdjb":"1","status":"success","fetchedCount":1.5},{"rdjb":"2","status":"success","fetchedCount":1}]', [[1], [2], [3, 4]]],
  ['negative count', '[{"rdjb":"1","status":"success","fetchedCount":2},{"rdjb":"3","status":"success","fetchedCount":-1},{"rdjb":"2","status":"success","fetchedCount":2}]', [[1, 2], [3], [4]]],
  ['missing/null counts', '[{"rdjb":"1","status":"success"},{"rdjb":"2","status":"success","fetchedCount":null},{"rdjb":"3","status":"success","fetchedCount":1}]', [[], [], [1, 2, 3, 4]]],
  ['zero count', '[{"rdjb":"1","status":"success","fetchedCount":0},{"rdjb":"2","status":"success","fetchedCount":1}]', [[], [1], [2, 3, 4]]],
  ['nonnumeric text count', '[{"rdjb":"1","status":"success","fetchedCount":"invalid"},{"rdjb":"2","status":"success","fetchedCount":1}]', [[], [1], [2, 3, 4]]],
  ['object count', '[{"rdjb":"1","status":"success","fetchedCount":{"n":2}},{"rdjb":"2","status":"success","fetchedCount":1}]', [[], [1], [2, 3, 4]]],
  ['array count', '[{"rdjb":"1","status":"success","fetchedCount":[2]},{"rdjb":"2","status":"success","fetchedCount":1}]', [[], [1], [2, 3, 4]]],
  ['object pages with tied integer keys', '{"a":{"rdjb":"2","status":"success","fetchedCount":1},"b":{"rdjb":"1","status":"success","fetchedCount":2}}', [[], [1, 2, 3], [4]]],
  ['unmapped first page', '[{"rdjb":"unknown","status":"success","fetchedCount":1},{"rdjb":"1","status":"success","fetchedCount":1},{"rdjb":2,"status":"success","fetchedCount":1}]', [[2], [], [1, 3, 4]]],
] as const)('preserves SQLite history semantics for %s', (_name, pages, expected) => {
  const f = fixture()
  f.query(1, '1,2,3', 'little_giant', '{"pages":' + pages + '}')
  for (let id = 1; id <= 4; id++) { f.enterprise(id); f.relation(1, id, id) }
  expect(titles.map(f.ids)).toEqual(expected)
})

it('keeps exact large integer sequence boundaries and SQLite sequence affinity', () => {
  const f = fixture()
  f.query(1, '1,2,3', null, '{"pages":[{"rdjb":"1","status":"success","fetchedCount":2147483647},{"rdjb":"2","status":"success","fetchedCount":2}]}')
  for (const [index, sequence] of [2147483647, 2147483648, 2147483649, 2147483650, '2', 'unknown'].entries()) {
    f.enterprise(index + 1); f.relation(1, index + 1, sequence)
  }
  expect(titles.map(f.ids)).toEqual([[1, 4, 5, 6], [2, 3, 4, 6], [4, 6]])
})

it('keeps counts above the optimized integer range in the legacy title rule', () => {
  const f = fixture()
  f.query(1, '1,2,3', null, '{"pages":[{"rdjb":"1","status":"success","fetchedCount":2147483648},{"rdjb":"2","status":"success","fetchedCount":1}]}')
  for (const [index, sequence] of [2147483648, 2147483649, 2147483650].entries()) {
    f.enterprise(index + 1); f.relation(1, index + 1, sequence)
  }
  expect(titles.map(f.ids)).toEqual([[1, 3], [2, 3], [3]])
})

it('keeps negative and fractional sequence comparisons without rounding', () => {
  const f = fixture()
  f.query(1, '1,2,3', null, '{"pages":[{"rdjb":"1","status":"success","fetchedCount":1},{"rdjb":"2","status":"success","fetchedCount":1}]}')
  for (const [index, sequence] of [-1, 0, 1, 1.5, 2, 3].entries()) {
    f.enterprise(index + 1); f.relation(1, index + 1, sequence)
  }
  expect(titles.map(f.ids)).toEqual([[1, 2, 3, 6], [1, 2, 4, 5, 6], [1, 2, 6]])
})

it('does not eagerly overflow a legacy upper sum that its sequence never evaluates', () => {
  const f = fixture()
  f.enterprise(1)
  f.query(1, '1,2', null, '{"pages":[{"rdjb":"1","status":"success","fetchedCount":9223372036854775807},{"rdjb":"2","status":"success","fetchedCount":1}]}')
  f.relation(1, 1, 1)
  expect(titles.map(f.ids)).toEqual([[1], [], []])
})

it('observes metadata and new candidates on each execution without cross-request caching', () => {
  const f = fixture()
  f.enterprise(1)
  f.query(1, '1,2', null, '{"pages":[{"rdjb":"1","status":"success","fetchedCount":1}]}')
  f.relation(1, 1, 1)
  expect(titles.map(f.ids)).toEqual([[1], [], []])
  f.db.prepare('update platform_query set collection_evidence=?').run('{"pages":[{"rdjb":"2","status":"success","fetchedCount":2}]}')
  f.enterprise(2); f.relation(1, 2, 2)
  expect(titles.map(f.ids)).toEqual([[], [1, 2], []])
})

it('retains malformed page-value errors instead of inventing an empty scope', () => {
  const f = fixture()
  f.enterprise(1)
  f.query(1, '1,2', null, '{"pages":["not-json"]}')
  f.relation(1, 1, 1)
  expect(() => f.ids('innovative_sme')).toThrow('malformed JSON')
})

const errorBoundaryRequests = titles.flatMap(title => (['list', 'count', 'join'] as const).map(wrapper => ({ title, wrapper })))
type ErrorBoundaryWrapper = typeof errorBoundaryRequests[number]['wrapper']
function readErrorBoundary(db: Database.Database, title: CurrentTitle, wrapper: ErrorBoundaryWrapper) {
  const sql = wrapper === 'count' ? `select count(*) as n from (${currentCandidateSql})`
    : wrapper === 'join' ? `select c.id from (${currentCandidateSql}) c join enterprise e on e.id=c.id order by c.id`
      : `select id from (${currentCandidateSql}) order by id`
  return db.prepare(sql).all(currentCandidateBindings(title))
}
function errorBoundaryFixture() {
  const f = fixture()
  // Existing production index shapes, confined to each tiny synthetic database.
  f.db.exec(`create unique index enterprise_uscc_norm_uq on enterprise(uscc_norm);
    create index record_title_idx on record(title_code);
    create index difference_reason_impact_title_113_idx on difference_reason(title_code);
    create index record_correspondence_enterprise_idx on record_correspondence(enterprise_id,title_code);
    create unique index platform_relation_query_seq_uq on platform_relation(query_id,sequence_no);
    create index platform_relation_enterprise_idx on platform_relation(enterprise_id);
    create index platform_relation_uscc_query_idx on platform_relation(uscc_raw,query_id);
    insert into record values (1,'specialized_sme');`)
  f.enterprise(1, 'ABC')
  return f
}

it.each(errorBoundaryRequests.flatMap(request => [
  { owner: 'no-code', enterpriseId: null, uscc: null },
  { owner: 'unmatched-code', enterpriseId: null, uscc: 'UNMATCHED' },
  { owner: 'assigned', enterpriseId: 1, uscc: null },
].map(owner => ({ ...request, ...owner }))))('F1 retains malformed-page error for $owner / $title / $wrapper', ({ title, wrapper, enterpriseId, uscc }) => {
  const f = errorBoundaryFixture()
  f.query(1, '1,2', null, '{"pages":["not-json"]}')
  f.relation(1, enterpriseId, 1, uscc)
  expect(() => readErrorBoundary(f.db, title, wrapper)).toThrowError(expect.objectContaining({ message: 'malformed JSON', code: 'SQLITE_ERROR' }))
})

it.each(errorBoundaryRequests)('F1 leaves an unreferenced malformed-page query unevaluated / $title / $wrapper', ({ title, wrapper }) => {
  const f = errorBoundaryFixture()
  f.query(1, '1,2', null, '{"pages":["not-json"]}')
  const expected = title === 'specialized_sme' ? (wrapper === 'count' ? [{ n: 1 }] : [{ id: 1 }]) : (wrapper === 'count' ? [{ n: 0 }] : [])
  expect(readErrorBoundary(f.db, title, wrapper)).toEqual(expected)
})

it.each(errorBoundaryRequests)('F1 preserves the single-rdjb page short circuit for unowned relations / $title / $wrapper', ({ title, wrapper }) => {
  const f = errorBoundaryFixture()
  f.query(1, '2', null, '{"pages":["not-json"]}')
  f.relation(1, null, 1)
  const expected = title === 'specialized_sme' ? (wrapper === 'count' ? [{ n: 1 }] : [{ id: 1 }]) : (wrapper === 'count' ? [{ n: 0 }] : [])
  expect(readErrorBoundary(f.db, title, wrapper)).toEqual(expected)
})

it.each(errorBoundaryRequests)('F1 preserves invalid outer JSON fallback / $title / $wrapper', ({ title, wrapper }) => {
  const f = errorBoundaryFixture()
  f.query(1, '1,2', null, '{broken')
  f.relation(1, 1, 1)
  const expected = title === 'little_giant' ? (wrapper === 'count' ? [{ n: 0 }] : []) : (wrapper === 'count' ? [{ n: 1 }] : [{ id: 1 }])
  expect(readErrorBoundary(f.db, title, wrapper)).toEqual(expected)
})

it.each(errorBoundaryRequests)('F1 keeps an unowned legacy upper overflow sum unevaluated / $title / $wrapper', ({ title, wrapper }) => {
  const f = errorBoundaryFixture()
  f.query(1, '1,2', null, '{"pages":[{"rdjb":"1","status":"success","fetchedCount":9223372036854775807},{"rdjb":"2","status":"success","fetchedCount":1}]}')
  f.relation(1, null, 1)
  const expected = title === 'specialized_sme' ? (wrapper === 'count' ? [{ n: 1 }] : [{ id: 1 }]) : (wrapper === 'count' ? [{ n: 0 }] : [])
  expect(readErrorBoundary(f.db, title, wrapper)).toEqual(expected)
})

it.each(errorBoundaryRequests)('F1 keeps exact sequence positioning beyond JavaScript integer precision / $title / $wrapper', ({ title, wrapper }) => {
  const f = errorBoundaryFixture()
  f.query(1, '1,2', null, '{"pages":[{"rdjb":"1","status":"success","fetchedCount":9007199254740992},{"rdjb":"2","status":"success","fetchedCount":1}]}')
  f.db.prepare('insert into platform_relation(query_id,enterprise_id,sequence_no) values (1,1,?)').run(9007199254740993n)
  const expected = title === 'specialized_sme' ? (wrapper === 'count' ? [{ n: 1 }] : [{ id: 1 }]) : (wrapper === 'count' ? [{ n: 0 }] : [])
  expect(readErrorBoundary(f.db, title, wrapper)).toEqual(expected)
})
