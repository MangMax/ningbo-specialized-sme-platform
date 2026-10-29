/** #427 explicit reader integration; original RED/source evidence stays outside Git. */
import Database from 'better-sqlite3'
import { adjudicateQualificationCycles } from '../lib/roster/qualification-cycles'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as queryReads from '../lib/roster/query-assessment'
import { prepareCurrentReader } from '../lib/roster/current-qualification'
import type { PlatformLiveQueryResult } from '../lib/platform/live-query'
import * as schema from '../db/schema'
import { TITLE_SEED } from '../db/titles'
import { createCurrentQualificationAssessmentReader } from '../lib/roster/current-qualification'
import * as core from '../lib/roster/platform-comparison'
import type { PlatformComparison, CandidateComparisonInput } from '../lib/roster/platform-comparison'

const U = '91330211255994457P', T = 'specialized_sme' as const
const AS_OF = Date.parse('2026-06-01T00:00:00Z')
const Q_AT = '2026-05-31T00:00:00Z', SHA = 'a'.repeat(64)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

type ProposedReader = {
  readPlatformComparison(enterpriseId: number, asOf: number, title: typeof T): PlatformComparison
}

it('Z_2024_formal_2026_complete_zero_preserves_legacy', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: 'db/migrations' })
    db.insert(schema.title).values([...TITLE_SEED]).run()
    const enterprise = db.insert(schema.enterprise).values({ name: '合成427', nameNorm: '合成427', usccNorm: U }).returning().get()
    const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: T, source: 'jxj', nameRaw: '合成427', usccRaw: U }).returning().get()
    const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024, batchSeq: 1, decidedYear: null, reviewOutcome: null }).returning().get()
    const file = db.insert(schema.storedFile).values({ relPath: 'synthetic/427.pdf', filename: '427.pdf', ext: 'pdf', bytes: 10, sha256: SHA }).returning().get()
    const evidence = db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: file.relPath, listNo: 1, page: 1 }).returning().get()
    const batch = db.insert(schema.importBatch).values({ idempotencyKey: '427-synthetic-only', sourceKind: 'announcement', sourceIdentity: '427-fixture', status: 'committed' }).returning().get()
    db.insert(schema.officialEvidenceRowRevision).values({
      evidenceId: evidence.id, revision: 1, eventId: event.id,
      capturedRecordId: record.id, capturedEnterpriseId: enterprise.id,
      nameRaw: '合成427', usccRaw: U, storedFileId: file.id, path: file.relPath, sha256: SHA, bytes: 10,
      sourceBindingKnown: false, listNo: 1, page: 1,
      actor: { type: 'agent', id: 'synthetic-427' }, basis: '合成逐行留档', commandKind: 'import', importBatchId: batch.id,
      createdAt: '2024-06-01T00:00:00Z',
    }).run()
    // sourceBindingKnown=false is legal without source_document, not a fabricated bound source.
    // Z's existing core source guard requires actual current/captured hash and revision, supplied above.
    const metadata = {
      source: 'queryBusList', status: 'no_record',
      effectiveConditions: { uscc: U, combination: 'and' },
      titleScope: { mode: 'selected', rdjb: ['2'] },
      queriedAt: Q_AT, completedAt: '2026-05-31T00:00:01Z', rows: [],
      pages: [{ source: 'queryBusList', rdjb: '2', page: 1, status: 'success', fetchedCount: 0, declaredTotal: 0, error: null }],
      fetchedCount: 0, declaredTotal: 0, completeness: 'complete', fullRange: true, unfinished: [], error: null,
      limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 },
    } satisfies NonNullable<typeof schema.platformQuery.$inferInsert.collectionEvidence>
    const query = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: U, rdjb: '2', titleCode: T, queriedAt: Q_AT, status: 'no_record', collectionEvidence: metadata }).returning().get()
    expect(sqlite.prepare('select count(*) as n from platform_relation').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('select count(*) as n from platform_query').get()).toEqual({ n: 1 })
    // Default source reader is real SQLite; no mocks/overrides of coverage, names, cycle policy.
    const reader = createCurrentQualificationAssessmentReader(sqlite)
    sqlite.pragma('query_only = ON')
    expect(sqlite.pragma('query_only', { simple: true })).toBe(1)
    const changes = sqlite.prepare('select total_changes() as n').get()
    const before = reader.read(enterprise.id, AS_OF)
    const old = before.snapshot
    expect(old.titles).toHaveLength(3)
    const scope = { enterpriseId: enterprise.id, asOf: '2026-06-01T00:00:00.000Z', ruleVersion: 'current-roster-116-v8', assessmentVersion: 'enterprise-qualification-407-v1' }
    const { titles, snapshotId, ...actualScope } = old
    expect(actualScope).toEqual(scope)
    expect(snapshotId).toBe(hash(JSON.stringify([scope, titles])))
    const selected = old.titles.find(t => t.titleCode === T)!
    // Fixture validity guards precede the missing method assertion.
    expect(selected.group).toBe('eligible')
    expect(selected.officialQualification.group).toBe('eligible')
    expect(selected.cycles).toEqual([{ originYear: 2024, batchSeq: 1, precision: 'year' }])
    expect(selected.evidence).toEqual([{ eventId: event.id, revision: 1, eventType: 'award', year: 2024, batchSeq: 1, decidedYear: null, reviewOutcome: null, evidenceIds: [evidence.id] }])
    expect(selected.sourceVersions).toEqual([{ evidenceId: evidence.id, eventId: event.id, sourceFile: file.relPath, storedFileId: file.id, sha256: SHA, bytes: 10, removedAt: null, capturedRevision: 1, capturedSha256: SHA }])
    expect(selected.completeness.publishedNames).toEqual([{ evidenceId: evidence.id, availability: 'captured', nameKnown: true }])
    expect(selected.platform.comparison).toBe('not_established')
    expect(selected.platform.truncated).toBe(false)
    expect(selected.platform.observations).toEqual([{
      queryId: query.id, interface: 'recognized_list', queriedAt: Q_AT, queryStatus: 'no_record', status: 'complete',
      titleCode: T, rdjb: '2', conditions: { uscc: U, combination: 'and' }, pages: metadata.pages,
      fullRange: true, completeness: 'complete', unfinished: [], outcome: 'no_record', subjectMatch: 'exact_uscc',
      applicability: 'at_or_before_as_of', rows: [],
    }])
    expect(sqlite.prepare('select total_changes() as n').get()).toEqual(changes)
    expect(sqlite.inTransaction).toBe(false)

    const legacyBytes = JSON.stringify(old)
    expect(old).toEqual(LEGACY_ORACLE)
    expect(hash(legacyBytes)).toBe('12e1859b34a137bf6e567ab8b660d57be4b3fdbe284669d629e65caa1f0f35d9')
    // Missing method was the original guarded RED; now exercise the real interface.
    const proposed = reader as typeof reader & ProposedReader
    expect(proposed.readPlatformComparison).toBeTypeOf('function')
    const compare = vi.spyOn(core, 'comparePlatformComparison') // call-through, no synthesized result
    try {
      const result = proposed.readPlatformComparison(enterprise.id, AS_OF, T)
      expect(result.version).toBe('platform-comparison-410-v1')
      expect(result.scope).toEqual({ ...scope, titleCode: T, legacySnapshotId: snapshotId })
      expect(result.observation.state).toBe('no_record') // independent literal, never core-generated expected
      expect(result.comparison.state).toBe('unsynchronized')
      expect(result.comparison.cycles).toEqual([{
        originYear: 2024, batchSeq: 1, state: 'unsynchronized', reasons: ['no_record_in_applicable_scope'],
        refs: { eventIds: [event.id], evidenceIds: [evidence.id], queryIds: [query.id], relationIds: [],
          events: [{ id: event.id, revision: 1 }], sources: [{ evidenceId: evidence.id, sha256: SHA }],
          versions: [], decisions: [], sourceGenerations: [] },
      }])
      expect(compare).toHaveBeenCalledTimes(1)
      const input: CandidateComparisonInput = compare.mock.calls[0]![0]
      expect(input.legacy).toEqual(old)
      expect(input.processes).toEqual([])
      expect(input.formal.cycles).toHaveLength(1)
      expect(input.formal.cycles[0]).toMatchObject({ cycle: { originYear: 2024, batchSeq: 1, precision: 'year' },
        judgment: { originYear: 2024, batch: 1, group: 'eligible', awardEventIds: [event.id],
          anchor: { id: event.id, eventType: 'award', year: 2024, batchSeq: 1, decidedYear: null, reviewOutcome: null } }, eventIds: [event.id] })
      const { rows: _rows, queriedAt: _at, completedAt: _done, fetchedCount: _count, declaredTotal: _total, ...narrow } = metadata
      expect(input.queries).toEqual({ truncated: false, sources: [{
        source: (({ applicability: _applicability, rows: _observedRows, ...source }) => source)(selected.platform.observations[0]!),
        queryKey: U, metadata: narrow,
      }] })
      // Whole legacy fields and old hash survive the explicit call; not just group.
      expect(JSON.stringify(reader.read(enterprise.id, AS_OF).snapshot)).toBe(legacyBytes)
      expect(compare).toHaveBeenCalledTimes(1) // default read didn't invoke core
      expect(sqlite.prepare('select total_changes() as n').get()).toEqual(changes)
      expect(sqlite.inTransaction).toBe(false)
      // Full double digest independent recomputation is a later matrix case, not claimed here.
      expect(result.inputDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(result.resultDigest).toMatch(/^[a-f0-9]{64}$/)
    } finally { compare.mockRestore() }
  } finally { sqlite.close() }
})

it('legacy_null_origin_award_decided_year_preserves_null_after_430', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: 'db/migrations' })
    db.insert(schema.title).values([...TITLE_SEED]).run()
    db.insert(schema.enterprise).values({ id: 1, name: '合成427空原年', nameNorm: '合成427空原年', usccNorm: U }).run()
    db.insert(schema.record).values({ id: 1, enterpriseId: 1, titleCode: T, source: 'jxj', nameRaw: '合成427空原年', usccRaw: U }).run()
    db.insert(schema.recordEvent).values({ id: 1, recordId: 1, eventType: 'award', year: null, batchSeq: 1, decidedYear: 2024, reviewOutcome: null }).run()
    db.insert(schema.storedFile).values({ id: 1, relPath: 'synthetic/null-year-427.pdf', filename: '427.pdf', ext: 'pdf', bytes: 10, sha256: SHA }).run()
    db.insert(schema.recordEvidence).values({ id: 1, recordEventId: 1, sourceFile: 'synthetic/null-year-427.pdf', listNo: 1, page: 1 }).run()
    db.insert(schema.importBatch).values({ id: 1, idempotencyKey: '427-null-origin', sourceKind: 'announcement', sourceIdentity: '427-null-origin', status: 'committed' }).run()
    db.insert(schema.officialEvidenceRowRevision).values({
      evidenceId: 1, revision: 1, eventId: 1, capturedRecordId: 1, capturedEnterpriseId: 1,
      nameRaw: '合成427空原年', usccRaw: U, storedFileId: 1, path: 'synthetic/null-year-427.pdf', sha256: SHA, bytes: 10,
      sourceBindingKnown: false, listNo: 1, page: 1, actor: { type: 'agent', id: 'synthetic-427' },
      basis: '合成原年未知但结论年已知', commandKind: 'import', importBatchId: 1, createdAt: '2024-06-01T00:00:00Z',
    }).run()
    sqlite.pragma('query_only = ON')
    const changes = sqlite.prepare('select total_changes() as n').get()
    const legacy = createCurrentQualificationAssessmentReader(sqlite).read(1, AS_OF).snapshot
    const a = legacy.titles.find(t => t.titleCode === T)!
    const { titles, snapshotId, ...scope } = legacy
    expect(snapshotId).toBe(hash(JSON.stringify([scope, titles])))
    expect(a.group).toBe('eligible')
    expect(a.officialQualification.group).toBe('eligible')
    expect(a.cycles).toEqual([{ originYear: 2024, batchSeq: 1, precision: 'year' }])
    expect(a.evidence).toEqual([{ eventId: 1, revision: 1, eventType: 'award', year: null, batchSeq: 1, decidedYear: 2024, reviewOutcome: null, evidenceIds: [1] }])
    expect(a.sourceVersions).toMatchObject([{ sha256: SHA, capturedSha256: SHA, capturedRevision: 1, removedAt: null }])
    // Same authority and exact SQL projection as existing evaluator; no guessed year or platform cycle.
    const formal = sqlite.prepare(`select e.id,e.event_type as eventType,e.year,e.decided_year as decidedYear,
      e.batch_seq as batchSeq,e.review_outcome as reviewOutcome,e.revision,
      r.name_raw as nameRaw,r.uscc_raw as usccRaw,r.source
      from record r join record_event e on e.record_id=r.id where r.enterprise_id=1 and r.title_code=? order by e.id`).all(T) as import('../lib/roster/qualification-cycles').QualificationEvent[]
    const selected = adjudicateQualificationCycles(formal, 2026)
    expect(selected.group).toBe('eligible')
    const judgment = selected.cycles[0]!
    expect(judgment.anchor?.year).toBeNull()
    expect(judgment.originYear).toBe(2024)
    const input: CandidateComparisonInput = {
      version: 'platform-comparison-410-v1', legacy, titleCode: T,
      formal: { assessment: { titleCode: a.titleCode, group: a.group, officialQualification: a.officialQualification,
        subject: a.subject, region: a.region, cycles: a.cycles, versions: a.versions,
        evidence: a.evidence, sourceVersions: a.sourceVersions, completeness: a.completeness, correspondence: a.correspondence },
      cycles: [{ cycle: a.cycles[0]!, judgment: { anchor: judgment.anchor, originYear: judgment.originYear,
        batch: judgment.batch, group: judgment.group, awardEventIds: judgment.awardEventIds }, eventIds: [1] }] },
      queries: { sources: [], truncated: false }, processes: [],
    }
    const original = NULL_ORIGIN_ORACLE
    expect(input).toEqual(original)
    const projection = core.comparePlatformComparison(input)
    expect(projection.observation.state).toBe('not_queried')
    expect(projection.comparison.state).toBe('not_established')
    expect(projection.comparison.cycles[0]!.reasons).toEqual(['not_queried'])
    const actual = createCurrentQualificationAssessmentReader(sqlite).readPlatformComparison(1, AS_OF, T)
    expect(actual.scope).toEqual(projection.scope)
    expect(actual.observation).toEqual(projection.observation)
    expect(actual.comparison).toEqual(projection.comparison)
    expect(createCurrentQualificationAssessmentReader(sqlite).read(1, AS_OF).snapshot).toEqual(legacy)
    expect(input).toEqual(original)
    expect(sqlite.prepare('select total_changes() as n').get()).toEqual(changes)
    expect(sqlite.pragma('query_only', { simple: true })).toBe(1)
    expect(sqlite.inTransaction).toBe(false)
  } finally { sqlite.close() }
})

// Real SQLite fixture; no mocked verdict, coverage or source inputs.
function fixture427(filename = ':memory:', year = 2024, batch: number | null = 1) {
  let statements = 0
  const sqlite = new Database(filename, { verbose() { statements++ } })
  sqlite.pragma('foreign_keys=ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'db/migrations' })
  db.insert(schema.title).values([...TITLE_SEED]).run()
  db.insert(schema.enterprise).values({ id: 1, name: '合成427', nameNorm: '合成427', usccNorm: U }).run()
  db.insert(schema.record).values({ id: 1, enterpriseId: 1, titleCode: T, source: 'jxj', nameRaw: '合成427', usccRaw: U }).run()
  db.insert(schema.recordEvent).values({ id: 1, recordId: 1, eventType: 'award', year, batchSeq: batch }).run()
  db.insert(schema.storedFile).values({ id: 1, relPath: 'synthetic/427.pdf', filename: '427.pdf', ext: 'pdf', bytes: 10, sha256: SHA }).run()
  db.insert(schema.recordEvidence).values({ id: 1, recordEventId: 1, sourceFile: 'synthetic/427.pdf', listNo: 1, page: 1 }).run()
  db.insert(schema.importBatch).values({ id: 1, idempotencyKey: '427-fixture', sourceKind: 'announcement', sourceIdentity: '427-fixture', status: 'committed' }).run()
  db.insert(schema.officialEvidenceRowRevision).values({ evidenceId: 1, revision: 1, eventId: 1, capturedRecordId: 1, capturedEnterpriseId: 1,
    nameRaw: '合成427', usccRaw: U, storedFileId: 1, path: 'synthetic/427.pdf', sha256: SHA, bytes: 10, sourceBindingKnown: false,
    listNo: 1, page: 1, actor: { type: 'agent', id: 'synthetic-427' }, basis: 'fixture', commandKind: 'import', importBatchId: 1, createdAt: '2024-06-01T00:00:00Z' }).run()
  const reader = createCurrentQualificationAssessmentReader(sqlite)
  return { sqlite, db, reader, statements: () => statements }
}
type Fixture427 = ReturnType<typeof fixture427>
function query427(f: Fixture427, options: {
  at?: string; status?: 'no_record' | 'success' | 'failed' | 'partial' | 'not_queried';
  interface?: 'recognized_list' | 'business_list' | 'apply_list'; title?: 'specialized_sme' | 'innovative_sme';
  metadata?: PlatformLiveQueryResult | null; conditions?: PlatformLiveQueryResult['effectiveConditions']; key?: string;
} = {}) {
  const at = options.at ?? Q_AT, status = options.status ?? 'no_record', endpoint = options.interface ?? 'recognized_list'
  const title = options.title ?? T, rdjb = endpoint === 'apply_list' ? '' : title === T ? '2' : '1'
  const source = endpoint === 'apply_list' ? 'queryList' : endpoint === 'business_list' ? 'businessList' : 'queryBusList'
  const metadata: PlatformLiveQueryResult = { source, status,
    effectiveConditions: options.conditions ?? { uscc: U, combination: 'and' },
    titleScope: { mode: endpoint === 'apply_list' ? 'source_default' : 'selected', rdjb: rdjb ? [rdjb] : [] },
    queriedAt: at, completedAt: at, rows: [],
    pages: status === 'failed' || status === 'not_queried' ? [] : [{ source, rdjb: rdjb || null, page: 1, status: 'success', fetchedCount: status === 'success' ? 1 : 0, declaredTotal: status === 'success' ? 1 : 0, error: null }],
    fetchedCount: status === 'success' ? 1 : 0, declaredTotal: status === 'success' ? 1 : 0,
    completeness: status === 'failed' || status === 'partial' || status === 'not_queried' ? 'partial' : 'complete',
    fullRange: true, unfinished: status === 'partial' ? [{ source, rdjb: rdjb || null, page: 2 }] : [],
    error: status === 'failed' ? { code: 'upstream_failed', message: 'SECRET_427_ERROR' } : null,
    limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 } }
  const q = f.db.insert(schema.platformQuery).values({ interface: endpoint, titleCode: endpoint === 'apply_list' ? null : title,
    rdjb, queryKey: options.key ?? U, queriedAt: at, status,
    collectionEvidence: options.metadata === undefined ? metadata : options.metadata,
    rawResponse: 'SECRET_427_BODY' }).returning().get()
  if (status === 'success') f.db.insert(schema.platformRelation).values({ queryId: q.id, sequenceNo: 1, enterpriseId: 1,
    usccRaw: U, status: '终审不通过', year: 2024, batch: '2024-1', matchBasis: 'uscc', verificationStatus: 'confirmed',
    rawFields: { secret: 'SECRET_427_RAW' } }).run()
  return q
}
function read427(f: Fixture427, o: PlatformComparison['observation']['state'], c: PlatformComparison['comparison']['state'], reason: string) {
  f.sqlite.pragma('query_only=ON')
  const before = f.sqlite.prepare('select total_changes() as n').get()
  const legacy = f.reader.read(1, AS_OF).snapshot
  const projection = f.reader.readPlatformComparison(1, AS_OF, T)
  expect(projection.observation.state).toBe(o)
  expect(projection.comparison.state).toBe(c)
  expect(projection.comparison.cycles[0]!.reasons).toContain(reason)
  expect(projection.scope.legacySnapshotId).toBe(legacy.snapshotId)
  expect(f.reader.read(1, AS_OF).snapshot).toEqual(legacy)
  expect(f.sqlite.prepare('select total_changes() as n').get()).toEqual(before)
  expect(JSON.stringify(projection)).not.toMatch(/SECRET_427|synthetic\/|合成427/)
  return projection
}

it.each([
  ['failed_only', { status: 'failed' }, 'query_failed', 'query_failed'],
  ['partial_only', { status: 'partial' }, 'unknown', 'coverage_incomplete'],
  ['missing_metadata', { metadata: null }, 'unknown', 'coverage_incomplete'],
  ['not_queried_metadata', { status: 'not_queried' }, 'not_queried', 'not_queried'],
  ['future_only', { at: '2027-01-01T00:00:00Z' }, 'not_queried', 'observation_after_as_of'],
  ['no_timezone', { at: '2026-05-31T00:00:00' }, 'unknown', 'invalid_query_time'],
  ['invalid_calendar', { at: '2026-02-30T00:00:00Z' }, 'unknown', 'invalid_query_time'],
  ['invalid_hour', { at: '2026-05-31T24:00:00Z' }, 'unknown', 'invalid_query_time'],
  ['cross_title', { title: 'innovative_sme' }, 'not_queried', 'not_queried'],
  ['restricted_zero', { conditions: { uscc: U, combination: 'and', whpcyear: '2024' } }, 'unknown', 'cycle_unresolved'],
  ['apply_is_not_single_title_zero', { interface: 'apply_list' }, 'unknown', 'coverage_incomplete'],
  ['recognized_records_no_process', { status: 'success' }, 'records', 'cycle_unresolved'],
  ['business_records_no_process', { status: 'success', interface: 'business_list' }, 'records', 'coverage_incomplete'],
] as const)('reader427 %s', (_name, options, observation, reason) => {
  const f = fixture427()
  try { query427(f, options); read427(f, observation, 'not_established', reason) }
  finally { f.sqlite.close() }
})
it('reader427 no_queries', () => { const f = fixture427(); try { read427(f, 'not_queried', 'not_established', 'not_queried') } finally { f.sqlite.close() } })
it.each([
  ['future_retry', { at: '2027-01-01T00:00:00Z', status: 'failed' }, 'no_record', 'unsynchronized', 'no_record_in_applicable_scope'],
  ['current_retry', { at: '2026-05-31T01:00:00Z', status: 'failed' }, 'query_failed', 'not_established', 'query_failed'],
  ['narrow_partial', { at: '2026-05-31T01:00:00Z', status: 'partial', conditions: { uscc: U, combination: 'and', whpcyear: '2024' } }, 'no_record', 'unsynchronized', 'no_record_in_applicable_scope'],
  ['same_time_conflict', { status: 'success', interface: 'business_list' }, 'unknown', 'not_established', 'source_conflict'],
] as const)('reader427 %s', (_name, options, o, c, reason) => {
  const f = fixture427()
  try { query427(f); query427(f, options); read427(f, o, c, reason) } finally { f.sqlite.close() }
})
it.each([50, 51])('reader427 top_%i', count => {
  const f = fixture427()
  try {
    for (let i = 1; i <= count; i++) query427(f, { at: `2026-05-31T00:00:${String(i).padStart(2, '0')}Z` })
    const result = read427(f, count === 50 ? 'no_record' : 'unknown', count === 50 ? 'unsynchronized' : 'not_established', count === 50 ? 'no_record_in_applicable_scope' : 'metadata_truncated')
    expect(result.observation.sources).toHaveLength(50)
  } finally { f.sqlite.close() }
})
it('reader427 future_top50_does_not_hide_truncation', () => {
  const f = fixture427()
  try {
    query427(f)
    for (let i = 1; i <= 50; i++) query427(f, { at: `2027-05-31T00:00:${String(i).padStart(2, '0')}Z` })
    expect(read427(f, 'unknown', 'not_established', 'metadata_truncated').observation.sources).toHaveLength(50)
  } finally { f.sqlite.close() }
})
it.each([
  ['same_year', 2026, 1, 'temporal_order_unresolved'],
  ['null_batch', 2024, null, 'cycle_unresolved'],
] as const)('reader427 %s', (_name, year, batch, reason) => {
  const f = fixture427(':memory:', year, batch)
  try { query427(f); read427(f, 'no_record', 'not_established', reason) } finally { f.sqlite.close() }
})
it('reader427 stale_hash_preserves_formal', () => {
  const f = fixture427()
  try {
    query427(f); f.sqlite.prepare('update stored_file set sha256=? where id=1').run('b'.repeat(64))
    expect(f.reader.read(1, AS_OF).snapshot.titles.find(t => t.titleCode === T)!.group).toBe('eligible')
    read427(f, 'no_record', 'not_established', 'source_requires_revalidation')
  } finally { f.sqlite.close() }
})
it('reader427 current_failure_not_revived', () => {
  const f = fixture427()
  try {
    f.db.insert(schema.recordEvent).values({ id: 2, recordId: 1, eventType: 'review', year: 2024, batchSeq: 1, decidedYear: 2025, reviewOutcome: 'failed' }).run()
    f.db.insert(schema.recordEvidence).values({ id: 2, recordEventId: 2, sourceFile: 'synthetic/427.pdf', listNo: 2 }).run()
    query427(f)
    expect(f.reader.read(1, AS_OF).snapshot.titles.find(t => t.titleCode === T)!.group).toBe('excluded')
    read427(f, 'no_record', 'not_established', 'formal_unresolved')
  } finally { f.sqlite.close() }
})

it('reader427 selector_own_ids_variants_and_all_retry_candidates', () => {
  const f = fixture427()
  try {
    const a = query427(f), b = query427(f, { at: '2026-05-31T01:00:00Z', status: 'failed' })
    const scope = { enterpriseId: 1, titleCode: T, direction: 'missing_in_miit' as const }
    const db = prepareCurrentReader(f.sqlite)
    const legacy = queryReads.readQueryCoverage(db, scope)
    const witnesses = queryReads.readQueryComparisonWitnesses(db, scope)
    expect(legacy.status).toBe('failed')
    expect(witnesses.sources.map(q => q.source.queryId)).toEqual([b.id, a.id])
    expect(witnesses.sources.map(q => q.source)).toEqual(legacy.sources)
    expect(queryReads.readQueryComparisonWitnesses(db, scope, undefined, []).sources).toEqual([])
    expect(queryReads.readQueryComparisonWitnesses(db, scope, undefined, [a.id]).sources.map(q => q.source.queryId)).toEqual([a.id])
    const variant = query427(f, { at: '2026-05-31T02:00:00Z', key: U.toLowerCase() })
    const variants = new Map([[U, [U.toLowerCase()]]])
    const withVariants = queryReads.readQueryComparisonWitnesses(db, scope, variants)
    expect(withVariants.sources.map(q => q.source.queryId)).toEqual([variant.id, b.id, a.id])
    // Actual query key is retained; normalized matching never forges the original key.
    expect(withVariants.sources[0]!.queryKey).toBe(U.toLowerCase())
  } finally { f.sqlite.close() }
})
it('reader427 unchanged_legacy_coverage_and_two_additional_statements', () => {
  const f = fixture427()
  try {
    query427(f)
    f.reader.read(1, AS_OF) // warm request-owned handles
    let at = f.statements(); f.reader.read(1, AS_OF); const legacyCost = f.statements() - at
    at = f.statements(); f.reader.readPlatformComparison(1, AS_OF, T); const cost = f.statements() - at
    expect(cost - legacyCost).toBe(2)
    expect(cost).toBeGreaterThan(2)
  } finally { f.sqlite.close() }
})
it('reader427 caller_transaction_and_busy_iterator', () => {
  const f = fixture427()
  try {
    query427(f); f.sqlite.exec('BEGIN')
    expect(f.reader.readPlatformComparison(1, AS_OF, T).observation.state).toBe('no_record')
    expect(f.sqlite.inTransaction).toBe(true)
    const iterator = f.sqlite.prepare('select id from enterprise').iterate()
    try { expect(iterator.next().done).toBe(false); expect(() => f.reader.readPlatformComparison(1, AS_OF, T)).toThrow(/busy|progress|savepoint/i) }
    finally { iterator.return?.() }
    expect(f.sqlite.inTransaction).toBe(true)
    expect(f.reader.readPlatformComparison(1, AS_OF, T).comparison.state).toBe('unsynchronized')
    f.sqlite.exec('ROLLBACK'); expect(f.sqlite.inTransaction).toBe(false)
  } finally { f.sqlite.close() }
})
it('reader427 WAL_same_snapshot_then_new_read_no_cache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reader427-wal-')), filename = join(dir, 'synthetic.db')
  const f = fixture427(filename)
  let writer: Database.Database | undefined
  try {
    f.sqlite.pragma('journal_mode=WAL'); query427(f)
    writer = new Database(filename)
    const writeDb = drizzle(writer, { schema })
    const original = queryReads.readQueryComparisonWitnesses
    const spy = vi.spyOn(queryReads, 'readQueryComparisonWitnesses').mockImplementationOnce((...args) => {
      // Writer commits after the complete T2 read but before comparison metadata.
      query427({ ...f, db: writeDb }, { at: '2026-05-31T01:00:00Z', status: 'failed' })
      return original(...args)
    })
    let first: PlatformComparison
    try { first = f.reader.readPlatformComparison(1, AS_OF, T) } finally { spy.mockRestore() }
    expect(first.observation.state).toBe('no_record'); expect(first.comparison.state).toBe('unsynchronized')
    expect(first.observation.sources).toHaveLength(1)
    const next = f.reader.readPlatformComparison(1, AS_OF, T)
    expect(next.observation.state).toBe('query_failed'); expect(next.comparison.state).toBe('not_established')
    expect(next.inputDigest).not.toBe(first.inputDigest); expect(next.resultDigest).not.toBe(first.resultDigest)
    expect(next.scope.legacySnapshotId).not.toBe(first.scope.legacySnapshotId)
    expect(f.sqlite.inTransaction).toBe(false)
  } finally { writer?.close(); f.sqlite.close(); rmSync(dir, { recursive: true, force: true }) }
})

// Independent digest verification follows the documented JSON protocol, not core output.
function canonical427(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical427).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical427((value as Record<string, unknown>)[k])).join(',') + '}'
  return JSON.stringify(value)
}
function digestInput427(input: CandidateComparisonInput, scope: PlatformComparison['scope']) {
  const sets = new Set('titles cycles evidence sourceVersions groups observationRefs existingCorrespondenceIds existingCorrespondences currentDecisionRefs decisionRefs eventIds awardEventIds evidenceIds decisionIds relationIds queryIds observations titleScopeRefs coverage scopeGaps sources publishedNames fieldGaps'.split(' '))
  function normalize(value: unknown, key = ''): unknown {
    if (Array.isArray(value)) {
      const items = value.map(v => normalize(v))
      return sets.has(key) ? items.sort((a, b) => canonical427(a) < canonical427(b) ? -1 : canonical427(a) > canonical427(b) ? 1 : 0) : items
    }
    if (value !== null && typeof value === 'object') {
      const object = value as Record<string, unknown>, result: Record<string, unknown> = {}
      for (const k of Object.keys(object)) result[k] = normalize(object[k], k)
      if ('page' in object && 'fetchedCount' in object && !('maxPage' in object)) result.maxPage = null
      if ('publishedNames' in object && 'gaps' in object && !('fieldGaps' in object)) result.fieldGaps = null
      if ('groups' in object && 'coverage' in object && 'event' in object && !('scopeGaps' in object)) result.scopeGaps = null
      return result
    }
    return value
  }
  return hash(canonical427(['platform-comparison-410-v1', scope, normalize(input)]))
}
it('reader427 independently_verifies_both_complete_digests_and_secret_error_changes', () => {
  const f = fixture427(), spy = vi.spyOn(core, 'comparePlatformComparison')
  try {
    const q = query427(f, { status: 'failed' })
    const first = f.reader.readPlatformComparison(1, AS_OF, T)
    const input = spy.mock.calls[0]![0]
    expect(first.inputDigest).toBe(digestInput427(input, first.scope))
    expect(first.resultDigest).toBe(hash(canonical427([first.inputDigest, first.observation, first.comparison])))
    const metadata = q.collectionEvidence!
    metadata.error = { code: 'upstream_failed', message: 'SECRET_427_CHANGED' }
    f.sqlite.prepare('update platform_query set collection_evidence=? where id=?').run(JSON.stringify(metadata), q.id)
    const next = f.reader.readPlatformComparison(1, AS_OF, T), nextInput = spy.mock.calls[1]![0]
    expect(next.inputDigest).toBe(digestInput427(nextInput, next.scope))
    expect(next.resultDigest).toBe(hash(canonical427([next.inputDigest, next.observation, next.comparison])))
    expect(next.inputDigest).not.toBe(first.inputDigest)
    expect(next.resultDigest).not.toBe(first.resultDigest)
    expect(next.observation).toEqual(first.observation); expect(next.comparison).toEqual(first.comparison)
    expect(JSON.stringify(next)).not.toMatch(/SECRET_427/)
    expect(nextInput.processes).toEqual([])
  } finally { spy.mockRestore(); f.sqlite.close() }
})
it.each([65536, 65537])('reader427 witness_byte_budget_%i', bytes => {
  const f = fixture427()
  try {
    const q = query427(f, { status: 'failed' }), metadata = q.collectionEvidence!
    metadata.error = { code: 'upstream_failed', message: 'x' }
    f.sqlite.prepare('update platform_query set collection_evidence=? where id=?').run(JSON.stringify(metadata), q.id)
    const scope = { enterpriseId: 1, titleCode: T, direction: 'missing_in_miit' as const }
    const originalSize = Buffer.byteLength(canonical427(queryReads.readQueryComparisonWitnesses(prepareCurrentReader(f.sqlite), scope).sources[0]))
    metadata.error.message = 'x'.repeat(1 + bytes - originalSize)
    f.sqlite.prepare('update platform_query set collection_evidence=? where id=?').run(JSON.stringify(metadata), q.id)
    const actual = queryReads.readQueryComparisonWitnesses(prepareCurrentReader(f.sqlite), scope).sources[0]!
    expect(Buffer.byteLength(canonical427(actual))).toBe(bytes)
    f.sqlite.pragma('query_only=ON')
    const changes = f.sqlite.prepare('select total_changes() as n').get()
    if (bytes === 65536) {
      const result = f.reader.readPlatformComparison(1, AS_OF, T)
      expect(result.observation.state).toBe('query_failed'); expect(result.comparison.state).toBe('not_established')
    } else expect(() => f.reader.readPlatformComparison(1, AS_OF, T)).toThrowError('input_resource_limit')
    expect(f.sqlite.prepare('select total_changes() as n').get()).toEqual(changes)
    expect(f.sqlite.inTransaction).toBe(false)
  } finally { f.sqlite.close() }
})
it.each([50, 51])('reader427 page_budget_%i', count => {
  const f = fixture427()
  try {
    const q = query427(f), metadata = q.collectionEvidence!
    metadata.pages = Array.from({ length: count }, (_, i) => ({ source: 'queryBusList', rdjb: '2', page: i + 1, status: 'success', fetchedCount: 0, declaredTotal: 0, error: null }))
    f.sqlite.prepare('update platform_query set collection_evidence=? where id=?').run(JSON.stringify(metadata), q.id)
    read427(f, count === 50 ? 'no_record' : 'unknown', count === 50 ? 'unsynchronized' : 'not_established', count === 50 ? 'no_record_in_applicable_scope' : 'coverage_incomplete')
  } finally { f.sqlite.close() }
})
it.each([40, 41])('reader427 cycle_budget_%i_preserves_complete_legacy', count => {
  const f = fixture427()
  try {
    for (let i = 2; i <= count; i++) {
      f.db.insert(schema.recordEvent).values({ id: i, recordId: 1, eventType: 'award', year: 2024, batchSeq: i }).run()
      f.db.insert(schema.recordEvidence).values({ id: i, recordEventId: i, sourceFile: 'synthetic/427.pdf', listNo: i }).run()
    }
    query427(f)
    const legacy = f.reader.read(1, AS_OF).snapshot
    expect(legacy.titles.find(t => t.titleCode === T)!.cycles).toHaveLength(count)
    f.sqlite.pragma('query_only=ON')
    if (count === 40) expect(f.reader.readPlatformComparison(1, AS_OF, T).comparison.cycles).toHaveLength(40)
    else expect(() => f.reader.readPlatformComparison(1, AS_OF, T)).toThrowError('invalid_cycle_join')
    expect(f.reader.read(1, AS_OF).snapshot).toEqual(legacy)
  } finally { f.sqlite.close() }
})
it('reader427 changed_asOf_requires_independent_digest_not_masking', () => {
  const f = fixture427(), spy = vi.spyOn(core, 'comparePlatformComparison')
  try {
    query427(f)
    const first = f.reader.readPlatformComparison(1, AS_OF, T)
    const next = f.reader.readPlatformComparison(1, AS_OF + 1, T)
    expect(first.inputDigest).toBe(digestInput427(spy.mock.calls[0]![0], first.scope))
    expect(next.inputDigest).toBe(digestInput427(spy.mock.calls[1]![0], next.scope))
    expect(next.scope.asOf).toBe('2026-06-01T00:00:00.001Z')
    expect(next.scope.legacySnapshotId).not.toBe(first.scope.legacySnapshotId)
    expect(next.inputDigest).not.toBe(first.inputDigest); expect(next.resultDigest).not.toBe(first.resultDigest)
    expect(next.observation.state).toBe('no_record'); expect(next.comparison.state).toBe('unsynchronized')
  } finally { spy.mockRestore(); f.sqlite.close() }
})

// Full synthetic DTO/input frozen on original production before #427 implementation.
const LEGACY_ORACLE = {
  "enterpriseId": 1,
  "asOf": "2026-06-01T00:00:00.000Z",
  "ruleVersion": "current-roster-116-v8",
  "assessmentVersion": "enterprise-qualification-407-v1",
  "snapshotId": "4b31cc766121ce8f88fe3a00fc100bc26d2d3e87ae12edb0279494fb921e9ef4",
  "titles": [
    {
      "titleCode": "little_giant",
      "group": "pending",
      "cycles": [],
      "versions": {
        "facts": "62bca7493f42412765934a2b5e3f594ceac390b489795af0ab47666bc6658a7f",
        "sources": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
        "decisions": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
        "observations": "fde5898c71060f1c5aadf68018968f659c530e2a88ab3d1493e06a7a7dda95d8"
      },
      "officialQualification": {
        "group": "pending",
        "message": "正式资格待核；已有公布及具体缺口保留",
        "basis": "",
        "notes": [
          "缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格"
        ]
      },
      "subject": {
        "status": "not_established",
        "message": "未见可适用的已确认主体终止事实；不据此证明存续",
        "decisionIds": []
      },
      "region": {
        "status": "not_established",
        "message": "未见可适用的迁移决定；沿用正式公布地域范围",
        "decisionIds": []
      },
      "platform": {
        "status": "not_queried",
        "comparison": "not_established",
        "message": "截至评估时点尚无可适用平台查询；其它观察保留",
        "truncated": false,
        "observations": []
      },
      "correspondence": {
        "status": "unmatched",
        "message": "尚无已确认对应；不据此否定正式资格",
        "refs": []
      },
      "completeness": {
        "status": "recorded",
        "message": "既有字段已记录；未推断具体有效日或未录入的政策条款",
        "gaps": [],
        "publishedNames": [],
        "eventIds": [],
        "fieldGaps": []
      },
      "evidence": [],
      "sourceVersions": [],
      "references": [],
      "notes": [
        "缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格"
      ],
      "shadow": {
        "legacyGroup": "pending",
        "difference": null
      }
    },
    {
      "titleCode": "specialized_sme",
      "group": "eligible",
      "cycles": [
        {
          "originYear": 2024,
          "batchSeq": 1,
          "precision": "year"
        }
      ],
      "versions": {
        "facts": "afcacee681383592d9b4fa949e73ca3a196e1bf11a8f06e1da293a20eac03583",
        "sources": "fb2650ff27443a8b8766ed917f1029a1340dc10f52fcebbcc792257054e554d0",
        "decisions": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
        "observations": "ed43da9c3c1a047aa07aa378cce0f193a85e5d441e5c5d8cf69051b1ee453826"
      },
      "officialQualification": {
        "group": "eligible",
        "message": "正式资格当前有效（按已录入的年份或已核实有效期间）",
        "basis": "event:1@1 award 2024/1 结论年:",
        "notes": []
      },
      "subject": {
        "status": "not_established",
        "message": "未见可适用的已确认主体终止事实；不据此证明存续",
        "decisionIds": []
      },
      "region": {
        "status": "not_established",
        "message": "未见可适用的迁移决定；沿用正式公布地域范围",
        "decisionIds": []
      },
      "platform": {
        "status": "requires_verification",
        "comparison": "not_established",
        "message": "平台观察已保留；同主体、称号、周期、时点及覆盖尚需核实，未自动确认一致或未同步",
        "truncated": false,
        "observations": [
          {
            "queryId": 1,
            "interface": "recognized_list",
            "queriedAt": "2026-05-31T00:00:00Z",
            "queryStatus": "no_record",
            "status": "complete",
            "titleCode": "specialized_sme",
            "rdjb": "2",
            "conditions": {
              "uscc": "91330211255994457P",
              "combination": "and"
            },
            "pages": [
              {
                "source": "queryBusList",
                "rdjb": "2",
                "page": 1,
                "status": "success",
                "fetchedCount": 0,
                "declaredTotal": 0,
                "error": null
              }
            ],
            "fullRange": true,
            "completeness": "complete",
            "unfinished": [],
            "outcome": "no_record",
            "subjectMatch": "exact_uscc",
            "applicability": "at_or_before_as_of",
            "rows": []
          }
        ]
      },
      "correspondence": {
        "status": "unmatched",
        "message": "尚无已确认对应；不据此否定正式资格",
        "refs": []
      },
      "completeness": {
        "status": "recorded",
        "message": "既有字段已记录；未推断具体有效日或未录入的政策条款",
        "gaps": [],
        "publishedNames": [
          {
            "evidenceId": 1,
            "availability": "captured",
            "nameKnown": true
          }
        ],
        "eventIds": [],
        "fieldGaps": [
          {
            "eventId": 1,
            "field": "decidedYear",
            "valueState": "unknown",
            "inputState": "null"
          }
        ]
      },
      "evidence": [
        {
          "eventId": 1,
          "revision": 1,
          "eventType": "award",
          "year": 2024,
          "batchSeq": 1,
          "decidedYear": null,
          "reviewOutcome": null,
          "evidenceIds": [
            1
          ]
        }
      ],
      "sourceVersions": [
        {
          "evidenceId": 1,
          "eventId": 1,
          "sourceFile": "synthetic/427.pdf",
          "storedFileId": 1,
          "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "bytes": 10,
          "removedAt": null,
          "capturedRevision": 1,
          "capturedSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      ],
      "references": [
        "evidence:1 synthetic/427.pdf  序号:1"
      ],
      "notes": [],
      "shadow": {
        "legacyGroup": "eligible",
        "difference": null
      }
    },
    {
      "titleCode": "innovative_sme",
      "group": "pending",
      "cycles": [],
      "versions": {
        "facts": "62bca7493f42412765934a2b5e3f594ceac390b489795af0ab47666bc6658a7f",
        "sources": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
        "decisions": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
        "observations": "fde5898c71060f1c5aadf68018968f659c530e2a88ab3d1493e06a7a7dda95d8"
      },
      "officialQualification": {
        "group": "pending",
        "message": "正式资格待核；已有公布及具体缺口保留",
        "basis": "",
        "notes": [
          "缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格"
        ]
      },
      "subject": {
        "status": "not_established",
        "message": "未见可适用的已确认主体终止事实；不据此证明存续",
        "decisionIds": []
      },
      "region": {
        "status": "not_established",
        "message": "未见可适用的迁移决定；沿用正式公布地域范围",
        "decisionIds": []
      },
      "platform": {
        "status": "not_queried",
        "comparison": "not_established",
        "message": "截至评估时点尚无可适用平台查询；其它观察保留",
        "truncated": false,
        "observations": []
      },
      "correspondence": {
        "status": "unmatched",
        "message": "尚无已确认对应；不据此否定正式资格",
        "refs": []
      },
      "completeness": {
        "status": "recorded",
        "message": "既有字段已记录；未推断具体有效日或未录入的政策条款",
        "gaps": [],
        "publishedNames": [],
        "eventIds": [],
        "fieldGaps": []
      },
      "evidence": [],
      "sourceVersions": [],
      "references": [],
      "notes": [
        "缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格"
      ],
      "shadow": {
        "legacyGroup": "pending",
        "difference": null
      }
    }
  ]
}
const NULL_ORIGIN_ORACLE = {
  "version": "platform-comparison-410-v1",
  "legacy": {
    "enterpriseId": 1,
    "asOf": "2026-06-01T00:00:00.000Z",
    "ruleVersion": "current-roster-116-v8",
    "assessmentVersion": "enterprise-qualification-407-v1",
    "snapshotId": "c6f5dbbd184deaa354405b92176b0fc055d74e20c10e7a24c1d6fd481f70a110",
    "titles": [
      {
        "titleCode": "little_giant",
        "group": "pending",
        "cycles": [],
        "versions": {
          "facts": "ca196556529bf6b9e0a8645d689a8511d61a4ec2a92406d94b08b7dbef067a9e",
          "sources": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
          "decisions": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
          "observations": "fde5898c71060f1c5aadf68018968f659c530e2a88ab3d1493e06a7a7dda95d8"
        },
        "officialQualification": {
          "group": "pending",
          "message": "正式资格待核；已有公布及具体缺口保留",
          "basis": "",
          "notes": [
            "缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格"
          ]
        },
        "subject": {
          "status": "not_established",
          "message": "未见可适用的已确认主体终止事实；不据此证明存续",
          "decisionIds": []
        },
        "region": {
          "status": "not_established",
          "message": "未见可适用的迁移决定；沿用正式公布地域范围",
          "decisionIds": []
        },
        "platform": {
          "status": "not_queried",
          "comparison": "not_established",
          "message": "截至评估时点尚无可适用平台查询；其它观察保留",
          "truncated": false,
          "observations": []
        },
        "correspondence": {
          "status": "unmatched",
          "message": "尚无已确认对应；不据此否定正式资格",
          "refs": []
        },
        "completeness": {
          "status": "recorded",
          "message": "既有字段已记录；未推断具体有效日或未录入的政策条款",
          "gaps": [],
          "publishedNames": [],
          "eventIds": [],
          "fieldGaps": []
        },
        "evidence": [],
        "sourceVersions": [],
        "references": [],
        "notes": [
          "缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格"
        ],
        "shadow": {
          "legacyGroup": "pending",
          "difference": null
        }
      },
      {
        "titleCode": "specialized_sme",
        "group": "eligible",
        "cycles": [
          {
            "originYear": 2024,
            "batchSeq": 1,
            "precision": "year"
          }
        ],
        "versions": {
          "facts": "285152a22cdf32253a562cb51d98d0cf1394cd5e6a3f48c5bc5e14ac44c1c510",
          "sources": "8241fd8584a6a62efdc0d2c4dc3cc2958e9ec794c7d7bcae5cfa0bbcdb7072c7",
          "decisions": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
          "observations": "fde5898c71060f1c5aadf68018968f659c530e2a88ab3d1493e06a7a7dda95d8"
        },
        "officialQualification": {
          "group": "eligible",
          "message": "正式资格当前有效（按已录入的年份或已核实有效期间）",
          "basis": "event:1@1 award /1 结论年:2024",
          "notes": []
        },
        "subject": {
          "status": "not_established",
          "message": "未见可适用的已确认主体终止事实；不据此证明存续",
          "decisionIds": []
        },
        "region": {
          "status": "not_established",
          "message": "未见可适用的迁移决定；沿用正式公布地域范围",
          "decisionIds": []
        },
        "platform": {
          "status": "not_queried",
          "comparison": "not_established",
          "message": "截至评估时点尚无可适用平台查询；其它观察保留",
          "truncated": false,
          "observations": []
        },
        "correspondence": {
          "status": "unmatched",
          "message": "尚无已确认对应；不据此否定正式资格",
          "refs": []
        },
        "completeness": {
          "status": "recorded",
          "message": "既有字段已记录；未推断具体有效日或未录入的政策条款",
          "gaps": [],
          "publishedNames": [
            {
              "evidenceId": 1,
              "availability": "captured",
              "nameKnown": true
            }
          ],
          "eventIds": [],
          "fieldGaps": [
            {
              "eventId": 1,
              "field": "year",
              "valueState": "unknown",
              "inputState": "null"
            }
          ]
        },
        "evidence": [
          {
            "eventId": 1,
            "revision": 1,
            "eventType": "award",
            "year": null,
            "batchSeq": 1,
            "decidedYear": 2024,
            "reviewOutcome": null,
            "evidenceIds": [
              1
            ]
          }
        ],
        "sourceVersions": [
          {
            "evidenceId": 1,
            "eventId": 1,
            "sourceFile": "synthetic/null-year-427.pdf",
            "storedFileId": 1,
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bytes": 10,
            "removedAt": null,
            "capturedRevision": 1,
            "capturedSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        ],
        "references": [
          "evidence:1 synthetic/null-year-427.pdf  序号:1"
        ],
        "notes": [],
        "shadow": {
          "legacyGroup": "eligible",
          "difference": null
        }
      },
      {
        "titleCode": "innovative_sme",
        "group": "pending",
        "cycles": [],
        "versions": {
          "facts": "ca196556529bf6b9e0a8645d689a8511d61a4ec2a92406d94b08b7dbef067a9e",
          "sources": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
          "decisions": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
          "observations": "fde5898c71060f1c5aadf68018968f659c530e2a88ab3d1493e06a7a7dda95d8"
        },
        "officialQualification": {
          "group": "pending",
          "message": "正式资格待核；已有公布及具体缺口保留",
          "basis": "",
          "notes": [
            "缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格"
          ]
        },
        "subject": {
          "status": "not_established",
          "message": "未见可适用的已确认主体终止事实；不据此证明存续",
          "decisionIds": []
        },
        "region": {
          "status": "not_established",
          "message": "未见可适用的迁移决定；沿用正式公布地域范围",
          "decisionIds": []
        },
        "platform": {
          "status": "not_queried",
          "comparison": "not_established",
          "message": "截至评估时点尚无可适用平台查询；其它观察保留",
          "truncated": false,
          "observations": []
        },
        "correspondence": {
          "status": "unmatched",
          "message": "尚无已确认对应；不据此否定正式资格",
          "refs": []
        },
        "completeness": {
          "status": "recorded",
          "message": "既有字段已记录；未推断具体有效日或未录入的政策条款",
          "gaps": [],
          "publishedNames": [],
          "eventIds": [],
          "fieldGaps": []
        },
        "evidence": [],
        "sourceVersions": [],
        "references": [],
        "notes": [
          "缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格"
        ],
        "shadow": {
          "legacyGroup": "pending",
          "difference": null
        }
      }
    ]
  },
  "titleCode": "specialized_sme",
  "formal": {
    "assessment": {
      "titleCode": "specialized_sme",
      "group": "eligible",
      "officialQualification": {
        "group": "eligible",
        "message": "正式资格当前有效（按已录入的年份或已核实有效期间）",
        "basis": "event:1@1 award /1 结论年:2024",
        "notes": []
      },
      "subject": {
        "status": "not_established",
        "message": "未见可适用的已确认主体终止事实；不据此证明存续",
        "decisionIds": []
      },
      "region": {
        "status": "not_established",
        "message": "未见可适用的迁移决定；沿用正式公布地域范围",
        "decisionIds": []
      },
      "cycles": [
        {
          "originYear": 2024,
          "batchSeq": 1,
          "precision": "year"
        }
      ],
      "versions": {
        "facts": "285152a22cdf32253a562cb51d98d0cf1394cd5e6a3f48c5bc5e14ac44c1c510",
        "sources": "8241fd8584a6a62efdc0d2c4dc3cc2958e9ec794c7d7bcae5cfa0bbcdb7072c7",
        "decisions": "5ae1625b488b3935122d8dd627fe575b388a5aa360378fa4407aad08baaed1e2",
        "observations": "fde5898c71060f1c5aadf68018968f659c530e2a88ab3d1493e06a7a7dda95d8"
      },
      "evidence": [
        {
          "eventId": 1,
          "revision": 1,
          "eventType": "award",
          "year": null,
          "batchSeq": 1,
          "decidedYear": 2024,
          "reviewOutcome": null,
          "evidenceIds": [
            1
          ]
        }
      ],
      "sourceVersions": [
        {
          "evidenceId": 1,
          "eventId": 1,
          "sourceFile": "synthetic/null-year-427.pdf",
          "storedFileId": 1,
          "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "bytes": 10,
          "removedAt": null,
          "capturedRevision": 1,
          "capturedSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      ],
      "completeness": {
        "status": "recorded",
        "message": "既有字段已记录；未推断具体有效日或未录入的政策条款",
        "gaps": [],
        "publishedNames": [
          {
            "evidenceId": 1,
            "availability": "captured",
            "nameKnown": true
          }
        ],
        "eventIds": [],
        "fieldGaps": [
          {
            "eventId": 1,
            "field": "year",
            "valueState": "unknown",
            "inputState": "null"
          }
        ]
      },
      "correspondence": {
        "status": "unmatched",
        "message": "尚无已确认对应；不据此否定正式资格",
        "refs": []
      }
    },
    "cycles": [
      {
        "cycle": {
          "originYear": 2024,
          "batchSeq": 1,
          "precision": "year"
        },
        "judgment": {
          "anchor": {
            "id": 1,
            "eventType": "award",
            "year": null,
            "decidedYear": 2024,
            "batchSeq": 1,
            "reviewOutcome": null,
            "revision": 1,
            "nameRaw": "合成427空原年",
            "usccRaw": "91330211255994457P",
            "source": "jxj"
          },
          "originYear": 2024,
          "batch": 1,
          "group": "eligible",
          "awardEventIds": [
            1
          ]
        },
        "eventIds": [
          1
        ]
      }
    ]
  },
  "queries": {
    "sources": [],
    "truncated": false
  },
  "processes": []
}


// #427 R2: append-only real SQLite regressions; frozen independent expectations.
// Only reader427_r2_double_null_batch_distinct_decided_year is authorized for the first RED.
const READER427_R2_CASES = [
  {
    "name": "reader427_r2_failed_only_null_anchor",
    "events": [
      {
        "id": 1,
        "eventType": "review",
        "year": 2024,
        "batchSeq": 1,
        "decidedYear": 2025,
        "reviewOutcome": "failed"
      }
    ],
    "group": "excluded",
    "expectedBindings": [
      {
        "cycle": {
          "originYear": 2024,
          "batchSeq": 1,
          "precision": "year"
        },
        "judgment": {
          "anchor": null,
          "originYear": 2024,
          "batch": 1,
          "group": "excluded",
          "awardEventIds": []
        },
        "eventIds": [
          1
        ]
      }
    ],
    "expectedResults": [
      {
        "originYear": 2024,
        "batchSeq": 1,
        "state": "not_established",
        "reasons": [
          "formal_unresolved"
        ],
        "refs": {
          "eventIds": [
            1
          ],
          "evidenceIds": [
            1
          ],
          "queryIds": [],
          "relationIds": [],
          "events": [
            {
              "id": 1,
              "revision": 1
            }
          ],
          "sources": [
            {
              "evidenceId": 1,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          ],
          "versions": [],
          "decisions": [],
          "sourceGenerations": []
        }
      }
    ]
  },
  {
    "name": "reader427_r2_future_known_batch_empty_award_ids",
    "events": [
      {
        "id": 1,
        "eventType": "award",
        "year": 2027,
        "batchSeq": 1,
        "decidedYear": null,
        "reviewOutcome": null
      }
    ],
    "group": "pending",
    "expectedBindings": [
      {
        "cycle": {
          "originYear": 2027,
          "batchSeq": 1,
          "precision": "year"
        },
        "judgment": {
          "anchor": null,
          "originYear": 2027,
          "batch": 1,
          "group": "pending",
          "awardEventIds": []
        },
        "eventIds": [
          1
        ]
      }
    ],
    "expectedResults": [
      {
        "originYear": 2027,
        "batchSeq": 1,
        "state": "not_established",
        "reasons": [
          "formal_unresolved"
        ],
        "refs": {
          "eventIds": [
            1
          ],
          "evidenceIds": [
            1
          ],
          "queryIds": [],
          "relationIds": [],
          "events": [
            {
              "id": 1,
              "revision": 1
            }
          ],
          "sources": [
            {
              "evidenceId": 1,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          ],
          "versions": [],
          "decisions": [],
          "sourceGenerations": []
        }
      }
    ]
  },
  {
    "name": "reader427_r2_future_null_batch_empty_award_ids",
    "events": [
      {
        "id": 1,
        "eventType": "award",
        "year": 2027,
        "batchSeq": null,
        "decidedYear": null,
        "reviewOutcome": null
      }
    ],
    "group": "pending",
    "expectedBindings": [
      {
        "cycle": {
          "originYear": 2027,
          "batchSeq": null,
          "precision": "year"
        },
        "judgment": {
          "anchor": null,
          "originYear": 2027,
          "batch": null,
          "group": "pending",
          "awardEventIds": []
        },
        "eventIds": [
          1
        ]
      }
    ],
    "expectedResults": [
      {
        "originYear": 2027,
        "batchSeq": null,
        "state": "not_established",
        "reasons": [
          "cycle_unresolved"
        ],
        "refs": {
          "eventIds": [
            1
          ],
          "evidenceIds": [
            1
          ],
          "queryIds": [],
          "relationIds": [],
          "events": [
            {
              "id": 1,
              "revision": 1
            }
          ],
          "sources": [
            {
              "evidenceId": 1,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          ],
          "versions": [],
          "decisions": [],
          "sourceGenerations": []
        }
      }
    ]
  },
  {
    "name": "reader427_r2_double_null_batch_distinct_decided_year",
    "events": [
      {
        "id": 1,
        "eventType": "award",
        "year": 2024,
        "batchSeq": null,
        "decidedYear": 2024,
        "reviewOutcome": null
      },
      {
        "id": 2,
        "eventType": "award",
        "year": 2024,
        "batchSeq": null,
        "decidedYear": 2025,
        "reviewOutcome": null
      }
    ],
    "group": "eligible",
    "expectedBindings": [
      {
        "cycle": {
          "originYear": 2024,
          "batchSeq": null,
          "precision": "year"
        },
        "judgment": {
          "anchor": {
            "id": 1,
            "eventType": "award",
            "year": 2024,
            "batchSeq": null,
            "decidedYear": 2024,
            "reviewOutcome": null
          },
          "originYear": 2024,
          "batch": null,
          "group": "eligible",
          "awardEventIds": [
            1
          ]
        },
        "eventIds": [
          1
        ]
      },
      {
        "cycle": {
          "originYear": 2024,
          "batchSeq": null,
          "precision": "year"
        },
        "judgment": {
          "anchor": {
            "id": 2,
            "eventType": "award",
            "year": 2024,
            "batchSeq": null,
            "decidedYear": 2025,
            "reviewOutcome": null
          },
          "originYear": 2024,
          "batch": null,
          "group": "eligible",
          "awardEventIds": [
            2
          ]
        },
        "eventIds": [
          2
        ]
      }
    ],
    "expectedResults": [
      {
        "originYear": 2024,
        "batchSeq": null,
        "state": "not_established",
        "reasons": [
          "cycle_unresolved"
        ],
        "refs": {
          "eventIds": [
            1
          ],
          "evidenceIds": [
            1
          ],
          "queryIds": [],
          "relationIds": [],
          "events": [
            {
              "id": 1,
              "revision": 1
            }
          ],
          "sources": [
            {
              "evidenceId": 1,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          ],
          "versions": [],
          "decisions": [],
          "sourceGenerations": []
        }
      },
      {
        "originYear": 2024,
        "batchSeq": null,
        "state": "not_established",
        "reasons": [
          "cycle_unresolved"
        ],
        "refs": {
          "eventIds": [
            2
          ],
          "evidenceIds": [
            2
          ],
          "queryIds": [],
          "relationIds": [],
          "events": [
            {
              "id": 2,
              "revision": 1
            }
          ],
          "sources": [
            {
              "evidenceId": 2,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          ],
          "versions": [],
          "decisions": [],
          "sourceGenerations": []
        }
      }
    ]
  },
  {
    "name": "reader427_r2_known_unknown_awards_ambiguous_review_dependencies",
    "events": [
      {
        "id": 1,
        "eventType": "award",
        "year": 2024,
        "batchSeq": 1,
        "decidedYear": 2024,
        "reviewOutcome": null
      },
      {
        "id": 2,
        "eventType": "award",
        "year": 2024,
        "batchSeq": null,
        "decidedYear": 2024,
        "reviewOutcome": null
      },
      {
        "id": 3,
        "eventType": "award",
        "year": 2024,
        "batchSeq": null,
        "decidedYear": 2025,
        "reviewOutcome": null
      },
      {
        "id": 4,
        "eventType": "review",
        "year": 2024,
        "batchSeq": null,
        "decidedYear": 2026,
        "reviewOutcome": "passed"
      }
    ],
    "group": "pending",
    "expectedBindings": [
      {
        "cycle": {
          "originYear": 2024,
          "batchSeq": 1,
          "precision": "year"
        },
        "judgment": {
          "anchor": {
            "id": 1,
            "eventType": "award",
            "year": 2024,
            "batchSeq": 1,
            "decidedYear": 2024,
            "reviewOutcome": null
          },
          "originYear": 2024,
          "batch": 1,
          "group": "pending",
          "awardEventIds": [
            1
          ]
        },
        "eventIds": [
          1
        ]
      },
      {
        "cycle": {
          "originYear": 2024,
          "batchSeq": null,
          "precision": "year"
        },
        "judgment": {
          "anchor": {
            "id": 2,
            "eventType": "award",
            "year": 2024,
            "batchSeq": null,
            "decidedYear": 2024,
            "reviewOutcome": null
          },
          "originYear": 2024,
          "batch": null,
          "group": "pending",
          "awardEventIds": [
            2
          ]
        },
        "eventIds": [
          2
        ]
      },
      {
        "cycle": {
          "originYear": 2024,
          "batchSeq": null,
          "precision": "year"
        },
        "judgment": {
          "anchor": {
            "id": 3,
            "eventType": "award",
            "year": 2024,
            "batchSeq": null,
            "decidedYear": 2025,
            "reviewOutcome": null
          },
          "originYear": 2024,
          "batch": null,
          "group": "pending",
          "awardEventIds": [
            3
          ]
        },
        "eventIds": [
          3
        ]
      }
    ],
    "expectedResults": [
      {
        "originYear": 2024,
        "batchSeq": null,
        "state": "not_established",
        "reasons": [
          "cycle_unresolved"
        ],
        "refs": {
          "eventIds": [
            2,
            4
          ],
          "evidenceIds": [
            2,
            4
          ],
          "queryIds": [],
          "relationIds": [],
          "events": [
            {
              "id": 2,
              "revision": 1
            },
            {
              "id": 4,
              "revision": 1
            }
          ],
          "sources": [
            {
              "evidenceId": 2,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            },
            {
              "evidenceId": 4,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          ],
          "versions": [],
          "decisions": [],
          "sourceGenerations": []
        }
      },
      {
        "originYear": 2024,
        "batchSeq": null,
        "state": "not_established",
        "reasons": [
          "cycle_unresolved"
        ],
        "refs": {
          "eventIds": [
            3,
            4
          ],
          "evidenceIds": [
            3,
            4
          ],
          "queryIds": [],
          "relationIds": [],
          "events": [
            {
              "id": 3,
              "revision": 1
            },
            {
              "id": 4,
              "revision": 1
            }
          ],
          "sources": [
            {
              "evidenceId": 3,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            },
            {
              "evidenceId": 4,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          ],
          "versions": [],
          "decisions": [],
          "sourceGenerations": []
        }
      },
      {
        "originYear": 2024,
        "batchSeq": 1,
        "state": "not_established",
        "reasons": [
          "formal_unresolved"
        ],
        "refs": {
          "eventIds": [
            1,
            4
          ],
          "evidenceIds": [
            1,
            4
          ],
          "queryIds": [],
          "relationIds": [],
          "events": [
            {
              "id": 1,
              "revision": 1
            },
            {
              "id": 4,
              "revision": 1
            }
          ],
          "sources": [
            {
              "evidenceId": 1,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            },
            {
              "evidenceId": 4,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          ],
          "versions": [],
          "decisions": [],
          "sourceGenerations": []
        }
      }
    ]
  },
  {
    "name": "reader427_r2_reviews_only_null_batch",
    "events": [
      {
        "id": 1,
        "eventType": "review",
        "year": 2024,
        "batchSeq": null,
        "decidedYear": 2025,
        "reviewOutcome": "passed"
      },
      {
        "id": 2,
        "eventType": "review",
        "year": 2024,
        "batchSeq": null,
        "decidedYear": 2026,
        "reviewOutcome": "failed"
      }
    ],
    "group": "pending",
    "expectedBindings": [
      {
        "cycle": {
          "originYear": 2024,
          "batchSeq": null,
          "precision": "year"
        },
        "judgment": {
          "anchor": null,
          "originYear": 2024,
          "batch": null,
          "group": "pending",
          "awardEventIds": []
        },
        "eventIds": [
          1,
          2
        ]
      }
    ],
    "expectedResults": [
      {
        "originYear": 2024,
        "batchSeq": null,
        "state": "not_established",
        "reasons": [
          "cycle_unresolved"
        ],
        "refs": {
          "eventIds": [
            1,
            2
          ],
          "evidenceIds": [
            1,
            2
          ],
          "queryIds": [],
          "relationIds": [],
          "events": [
            {
              "id": 1,
              "revision": 1
            },
            {
              "id": 2,
              "revision": 1
            }
          ],
          "sources": [
            {
              "evidenceId": 1,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            },
            {
              "evidenceId": 2,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          ],
          "versions": [],
          "decisions": [],
          "sourceGenerations": []
        }
      }
    ]
  },
  {
    "name": "reader427_r2_identical_judgments_distinct_direct_forward",
    "events": [
      {
        "id": 1,
        "eventType": "award",
        "year": 2027,
        "batchSeq": null,
        "decidedYear": null,
        "reviewOutcome": null
      },
      {
        "id": 2,
        "eventType": "award",
        "year": 2027,
        "batchSeq": null,
        "decidedYear": null,
        "reviewOutcome": null
      }
    ],
    "group": "pending",
    "expectedBindings": [
      {
        "cycle": {
          "originYear": 2027,
          "batchSeq": null,
          "precision": "year"
        },
        "judgment": {
          "anchor": null,
          "originYear": 2027,
          "batch": null,
          "group": "pending",
          "awardEventIds": []
        },
        "eventIds": [
          1
        ]
      },
      {
        "cycle": {
          "originYear": 2027,
          "batchSeq": null,
          "precision": "year"
        },
        "judgment": {
          "anchor": null,
          "originYear": 2027,
          "batch": null,
          "group": "pending",
          "awardEventIds": []
        },
        "eventIds": [
          2
        ]
      }
    ],
    "expectedResults": [
      {
        "originYear": 2027,
        "batchSeq": null,
        "state": "not_established",
        "reasons": [
          "cycle_unresolved"
        ],
        "refs": {
          "eventIds": [
            1
          ],
          "evidenceIds": [
            1
          ],
          "queryIds": [],
          "relationIds": [],
          "events": [
            {
              "id": 1,
              "revision": 1
            }
          ],
          "sources": [
            {
              "evidenceId": 1,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          ],
          "versions": [],
          "decisions": [],
          "sourceGenerations": []
        }
      },
      {
        "originYear": 2027,
        "batchSeq": null,
        "state": "not_established",
        "reasons": [
          "cycle_unresolved"
        ],
        "refs": {
          "eventIds": [
            2
          ],
          "evidenceIds": [
            2
          ],
          "queryIds": [],
          "relationIds": [],
          "events": [
            {
              "id": 2,
              "revision": 1
            }
          ],
          "sources": [
            {
              "evidenceId": 2,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          ],
          "versions": [],
          "decisions": [],
          "sourceGenerations": []
        }
      }
    ]
  },
  {
    "name": "reader427_r2_identical_judgments_distinct_direct_reverse_insert",
    "events": [
      {
        "id": 2,
        "eventType": "award",
        "year": 2027,
        "batchSeq": null,
        "decidedYear": null,
        "reviewOutcome": null
      },
      {
        "id": 1,
        "eventType": "award",
        "year": 2027,
        "batchSeq": null,
        "decidedYear": null,
        "reviewOutcome": null
      }
    ],
    "group": "pending",
    "expectedBindings": [
      {
        "cycle": {
          "originYear": 2027,
          "batchSeq": null,
          "precision": "year"
        },
        "judgment": {
          "anchor": null,
          "originYear": 2027,
          "batch": null,
          "group": "pending",
          "awardEventIds": []
        },
        "eventIds": [
          1
        ]
      },
      {
        "cycle": {
          "originYear": 2027,
          "batchSeq": null,
          "precision": "year"
        },
        "judgment": {
          "anchor": null,
          "originYear": 2027,
          "batch": null,
          "group": "pending",
          "awardEventIds": []
        },
        "eventIds": [
          2
        ]
      }
    ],
    "expectedResults": [
      {
        "originYear": 2027,
        "batchSeq": null,
        "state": "not_established",
        "reasons": [
          "cycle_unresolved"
        ],
        "refs": {
          "eventIds": [
            1
          ],
          "evidenceIds": [
            1
          ],
          "queryIds": [],
          "relationIds": [],
          "events": [
            {
              "id": 1,
              "revision": 1
            }
          ],
          "sources": [
            {
              "evidenceId": 1,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          ],
          "versions": [],
          "decisions": [],
          "sourceGenerations": []
        }
      },
      {
        "originYear": 2027,
        "batchSeq": null,
        "state": "not_established",
        "reasons": [
          "cycle_unresolved"
        ],
        "refs": {
          "eventIds": [
            2
          ],
          "evidenceIds": [
            2
          ],
          "queryIds": [],
          "relationIds": [],
          "events": [
            {
              "id": 2,
              "revision": 1
            }
          ],
          "sources": [
            {
              "evidenceId": 2,
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          ],
          "versions": [],
          "decisions": [],
          "sourceGenerations": []
        }
      }
    ]
  }
] as const

it.each(READER427_R2_CASES)('$name', spec => {
  const sqlite = new Database(':memory:')
  const compare = vi.spyOn(core, 'comparePlatformComparison') // actual core call-through; never stub a result
  try {
    sqlite.pragma('foreign_keys=ON')
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: 'db/migrations' })
    db.insert(schema.title).values([...TITLE_SEED]).run()
    db.insert(schema.enterprise).values({ id: 1, name: '合成427R2', nameNorm: '合成427R2', usccNorm: U }).run()
    db.insert(schema.record).values({ id: 1, enterpriseId: 1, titleCode: T, source: 'jxj', nameRaw: '合成427R2', usccRaw: U }).run()
    db.insert(schema.storedFile).values({ id: 1, relPath: 'synthetic/427-r2.pdf', filename: '427-r2.pdf', ext: 'pdf', bytes: 10, sha256: SHA }).run()
    db.insert(schema.importBatch).values({ id: 1, idempotencyKey: '427-r2-fixture', sourceKind: 'announcement', sourceIdentity: '427-r2-fixture', status: 'committed' }).run()
    for (const event of spec.events) {
      db.insert(schema.recordEvent).values({ ...event, recordId: 1, revision: 1 }).run()
      db.insert(schema.recordEvidence).values({ id: event.id, recordEventId: event.id, sourceFile: 'synthetic/427-r2.pdf', listNo: event.id, page: 1 }).run()
      db.insert(schema.officialEvidenceRowRevision).values({ evidenceId: event.id, revision: 1, eventId: event.id,
        capturedRecordId: 1, capturedEnterpriseId: 1, nameRaw: '合成427R2', usccRaw: U, storedFileId: 1,
        path: 'synthetic/427-r2.pdf', sha256: SHA, bytes: 10, sourceBindingKnown: false, listNo: event.id, page: 1,
        actor: { type: 'agent', id: 'synthetic-427-r2' }, basis: '独立合成正式逐行事实', commandKind: 'import', importBatchId: 1,
        createdAt: '2026-01-01T00:00:00Z' }).run()
    }
    const reader = createCurrentQualificationAssessmentReader(sqlite)
    sqlite.pragma('query_only=ON')
    const changes = sqlite.prepare('select total_changes() as n').get()
    const legacy = reader.read(1, AS_OF).snapshot
    const selected = legacy.titles.find(t => t.titleCode === T)!
    const expectedScope = { enterpriseId: 1, asOf: '2026-06-01T00:00:00.000Z', ruleVersion: 'current-roster-116-v8', assessmentVersion: 'enterprise-qualification-407-v1' }
    const { titles, snapshotId, ...scope } = legacy
    expect(scope).toEqual(expectedScope)
    expect(titles.map(t => t.titleCode).sort()).toEqual(['innovative_sme', 'little_giant', 'specialized_sme'])
    expect(snapshotId).toBe(hash(JSON.stringify([expectedScope, titles])))
    expect(selected.group).toBe(spec.group)
    expect(selected.officialQualification.group).toBe(spec.group)
    expect(selected.cycles).toEqual(spec.expectedBindings.map(b => b.cycle))
    // Exact recorded values, not guessed cycle fields or production-helper-generated expected verdicts.
    expect(selected.evidence).toEqual([...spec.events].sort((a, b) => a.id - b.id).map(e => ({ eventId: e.id, revision: 1,
      eventType: e.eventType, year: e.year, batchSeq: e.batchSeq, decidedYear: e.decidedYear, reviewOutcome: e.reviewOutcome, evidenceIds: [e.id] })))
    expect(selected.sourceVersions).toEqual([...spec.events].sort((a, b) => a.id - b.id).map(e => ({ evidenceId: e.id, eventId: e.id,
      sourceFile: 'synthetic/427-r2.pdf', storedFileId: 1, sha256: SHA, bytes: 10, removedAt: null, capturedRevision: 1, capturedSha256: SHA })))
    expect(selected.platform.comparison).toBe('not_established')
    expect(selected.platform.observations).toEqual([])
    expect(sqlite.prepare('select count(*) as n from platform_query').get()).toEqual({ n: 0 })
    expect(sqlite.pragma('query_only', { simple: true })).toBe(1)
    expect(sqlite.prepare('select total_changes() as n').get()).toEqual(changes)
    expect(sqlite.inTransaction).toBe(false)
    expect(compare).not.toHaveBeenCalled()
    console.info('READER427_R2_GUARDS', JSON.stringify({ name: spec.name, legacy, changes, guardsReached: true }))
    try {
      // First RED must fail here, after all legacy/metadata/zero-write guards above.
      // Current candidate is predeclared to throw invalid_cycle_event for the selected double-null case.
      const projection = reader.readPlatformComparison(1, AS_OF, T)
      expect(compare).toHaveBeenCalledTimes(1)
      const input = compare.mock.calls[0]![0]
      expect(input.legacy).toEqual(legacy)
      expect(input.formal.cycles).toEqual(spec.expectedBindings)
      expect(input.processes).toEqual([])
      expect(input.queries).toEqual({ sources: [], truncated: false })
      expect(projection.scope).toEqual({ ...expectedScope, titleCode: T, legacySnapshotId: snapshotId })
      expect(projection.observation).toEqual({ state: 'not_queried', sources: [] })
      expect(projection.comparison).toEqual({ state: 'not_established', cycles: spec.expectedResults })
      expect(projection.inputDigest).toBe(digestInput427(input, projection.scope))
      expect(projection.resultDigest).toBe(hash(canonical427([projection.inputDigest, projection.observation, projection.comparison])))
    } finally {
      const attempted = compare.mock.calls[0]?.[0]
      console.info('READER427_R2_ATTEMPT', JSON.stringify({ name: spec.name, actualBindings: attempted?.formal.cycles,
        expectedBindings: spec.expectedBindings, legacySnapshotId: snapshotId }))
      expect(reader.read(1, AS_OF).snapshot).toEqual(legacy)
      expect(sqlite.prepare('select total_changes() as n').get()).toEqual(changes)
      expect(sqlite.pragma('query_only', { simple: true })).toBe(1)
      expect(sqlite.inTransaction).toBe(false)
    }
  } finally { compare.mockRestore(); sqlite.close() }
})
