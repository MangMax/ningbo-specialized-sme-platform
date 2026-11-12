import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { targetSchema } from '../lib/platform/target-schema'
import { witnessReaderFixture } from './helpers/recognized-witness-target-733'
import { finalizeProcessStored } from '../upgrade/process-stored'
import { transferCorrespondence } from '../upgrade/correspondence'
import { transferDifferenceReferences } from '../upgrade/difference-references'
import { reserveLegacyIds } from '../lib/platform/target-archive'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { preflightRosterImport, commitRosterImport, replayRosterImport, validateImportRequest } from '../server/utils/roster-import'
import type { RosterImportRequest } from '../lib/roster-import-client'
import { listPlatformQueries } from '../lib/platform/read'
import { rosterImportMcpPayloadSchema } from '../server/utils/roster-import-schema'
import { assertExpandRuntime } from '../db/schema-phase'
import { createApp, createRouter, toNodeListener } from 'h3'
import * as h3 from 'h3'
import { createServer } from 'node:http'
import { importExecutor } from '../server/utils/import-execution'
import { createRosterImportHandler } from '../server/utils/roster-import-route'
import { z } from 'zod'
import { platformResultToImport } from '../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../lib/platform/live-query'
import { captureQueryRevision113 } from '../server/utils/evidence-impact-113'
import { saveDecision102 } from '../server/utils/decision-lifecycle-102'

vi.mock('@db', () => ({ useDb: () => db }))
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))

let f: Awaited<ReturnType<typeof witnessReaderFixture>>, t: Database.Database, db: ReturnType<typeof drizzle<typeof schema>>
let serial = 0
const trace: string[] = []
const sources = ['apply_list', 'business_list', 'recognized_list'] as const
const raw = { id: 'SHARED', rdjb: '2', qymc: ' Alpha ', year: '2024', cszt: '终审通过', rddqrq: ' 2028 ', whpcyear: false, whpc: ' 2 ', extra: [null, false, 2, ' 2 '] }
const targetRaw = { id: 'TARGET', rdjb: '2', qymc: ' Alpha ', year: '2024', cszt: '终审通过' }
function collection(source: typeof sources[number], time = '2026-11-13T00:00:00Z') {
  const transport = source === 'apply_list' ? 'queryList' : source === 'business_list' ? 'businessList' : 'queryBusList'
  const result: PlatformLiveQueryResult = {
    source: transport, status: 'success', effectiveConditions: { uscc: '91330200712345678A', combination: 'and' },
    titleScope: transport === 'queryList' ? { mode: 'source_default', rdjb: [] } : { mode: 'selected', rdjb: ['2'] },
    queriedAt: time, completedAt: time, rows: [targetRaw], dataRows: [targetRaw],
    pages: [{ source: transport, rdjb: transport === 'queryList' ? null : '2', page: 1, maxPage: 1, fetchedCount: 1, declaredTotal: 1, status: 'success', error: null }],
    fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
    limits: { maxRequests: 10, maxRows: 100, maxDurationMs: 1000, pageSize: 50 },
  }
  return platformResultToImport(result)
}
const request = (ids: number[], key = 'repair'): RosterImportRequest => ({
  idempotencyKey: key, sourceKind: 'platform_archive', sourceIdentity: 'synthetic753',
  payload: { platformRecordObservations: ids.map(relationId => ({ relationId })) },
})
function commit(input: RosterImportRequest) { return commitRosterImport(db, input, [], { deferCandidateTasks: true }) }
beforeAll(async () => {
  f = await witnessReaderFixture(old => {
    old.exec("INSERT INTO enterprise(id,name,name_norm) VALUES(1,'Alpha','Alpha'),(2,'Beta','Beta')")
    const database = drizzle(old, { schema })
    sources.forEach((source, index) => {
      const queryId = 91 + index
      database.insert(schema.platformQuery).values({ id: queryId, interface: source, queryKey: 'original', rdjb: '2', queriedAt: '2026-10-01', rawResponse: '原响应\n  ', status: 'success' }).run()
      for (const offset of [0, 1, 2]) {
        const id = 101 + index * 10 + offset
        database.insert(schema.platformRelation).values({ id, queryId, sequenceNo: offset + 1, relationKey: 'SHARED', rawFields: raw, sourceText: ' 原观察\n', enterpriseId: 1, nameRaw: ' Original Alpha ', verificationStatus: 'confirmed', status: offset === 2 ? '退回' : '终审通过' }).run()
        if (offset !== 1) ensurePlatformObservation(database, id)
      }
      const cases = [
        { relationKey: 'FIRST', rawFields: { ...raw, id: 'FIRST' } },
        { relationKey: null, rawFields: { id: 42, rdjb: false } },
        { relationKey: 'CONFLICT', rawFields: { id: 'OTHER', rdjb: 2 } },
        { relationKey: 'NULL', rawFields: null },
        { relationKey: 'MALFORMED', rawFields: null },
      ]
      database.insert(schema.platformQuery).values({ id: 191 + index, interface: source, queryKey: 'malformed', rdjb: '2', queriedAt: '2026-10-01' }).run()
      cases.forEach((row, offset) => {
        const id = 104 + index * 10 + offset
        database.insert(schema.platformRelation).values({ id, queryId: offset === 4 ? 191 + index : queryId, sequenceNo: offset === 4 ? 1 : offset + 4, ...row, sourceText: ' \n original ', nameRaw: ' Original Alpha ', status: 'stored only' }).run()
        if (offset === 4) old.prepare('update platform_relation set raw_fields=? where id=?').run('{bad historical JSON', id)
      })
    })
    database.insert(schema.platformQuery).values({ id: 99, interface: 'apply_list', queryKey: 'bounded', queriedAt: '2026-10-02' }).run()
    for (let i = 0; i < 100; i++) {
      database.insert(schema.platformRelation).values({ id: 2001 + i, queryId: 99, sequenceNo: i + 1, relationKey: 'BOUND', rawFields: { id: 'BOUND' } }).run()
      ensurePlatformObservation(database, 2001 + i)
    }
    expect(commitRosterImport(database, request([101], 'historical753'), [], { deferCandidateTasks: true }).status).toBe('committed')
    captureQueryRevision113(database, 91)
    saveDecision102(database, { enterpriseId: 1, titleCode: 'specialized_sme', direction: 'missing_in_miit', action: 'replace', expectedCurrentId: null,
      idempotencyKey: 'historical-decision753', actor: { type: 'agent', id: '753' }, basis: 'preserve synthetic historical decision bytes',
      ruleVersion: 'existing', effectiveAt: '2026-10-02T00:00:00Z', decision: { status: 'needs_review', measureCode: 'manual_review', verificationStatus: 'pending' } })
    const profile = { enterpriseId: 1, name: 'Alpha', city: null, district: null }
    database.insert(schema.enterpriseProfileAudit).values({ enterpriseId: 1, idempotencyKey: 'audit753', requestHash: 'original audit hash',
      beforeVersion: 'before', afterVersion: 'after', before: profile, after: profile, actor: { type: 'agent', id: '753' }, basis: 'synthetic retained audit bytes' }).run()
  })
  f.close()
  const p = join(f.root, '71609.sqlite'); copyFileSync(f.target, p)
  finalizeProcessStored({ source: p, target: f.target, runId: 'process753', predecessorRunId: 'witness', legacySource: f.legacySource })
  const c = join(f.root, '71610.sqlite'); copyFileSync(f.target, c)
  transferCorrespondence({ source: c, target: f.target, runId: 'correspondence753' })
  const d = join(f.root, '71611.sqlite'); copyFileSync(f.target, d)
  transferDifferenceReferences({ source: d, target: f.target, runId: 'difference753' })
})
beforeEach(() => {
  const path = join(f.root, `case-${++serial}.sqlite`); copyFileSync(f.target, path)
  t = new Database(path, { verbose: q => trace.push(String(q)) }); t.pragma('foreign_keys=ON')
  db = drizzle(t, { schema })
  trace.length = 0
})
afterEach(() => {
  const root = process.env.CANDIDATE_SCOPE_EVIDENCE_DIR
  if (root) writeFileSync(join(root, `753-trace-${serial}.json`), JSON.stringify(trace, null, 2))
  t?.close(); vi.restoreAllMocks(); vi.useRealTimers()
})
afterAll(() => vi.unstubAllGlobals())
function noLegacy() {
  expect(trace.filter(q => /\b(?:from|join|into|update)\s+["`]?platform_(?:query|relation)["`]?\b/i.test(q))).toEqual([])
  expect(t.pragma('foreign_key_check')).toEqual([])
}
function immutable(connection = t) {
  return {
    archives: connection.prepare('select id,storage_class,hex(bytes) bytes,byte_length,sha256 from platform_archive_value order by id').all(),
    refs: connection.prepare('select * from platform_observation_archive_ref order by owner_id,field').all(),
    basis: connection.prepare("select 1 from sqlite_schema where name='platform_observation_fingerprint_basis'").get()
      ? connection.prepare('select * from platform_observation_fingerprint_basis order by observation_id').all() : [],
    assignments: connection.prepare('select * from platform_observation_assignment order by observation_id,revision').all(),
    history: ['evidence_revision_113', 'difference_reason', 'record_correspondence', 'enterprise_profile_audit'].map(name => connection.prepare(`select * from ${name}`).all()),
    batches: connection.prepare("select id,hex(preflight_result) p,hex(item_results) i,hex(summary) s from import_batch where idempotency_key='historical753'").all(),
    receipts: connection.prepare("select r.id,r.request_hash,hex(r.request_body) body,hex(r.item_results) items,hex(r.summary) summary from import_receipt r join import_batch b on b.id=r.batch_id where b.idempotency_key='historical753' order by r.id").all(),
  }
}
it.each(sources)('confirms migrated %s original fingerprints and independently bootstraps only at commit', source => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-11-13T03:00:00Z')
  const index = sources.indexOf(source), indexed = 101 + index * 10, first = indexed + 1
  const input = request([indexed, first, indexed + 2])
  const before = immutable()
  const originalIndex = t.prepare('select input_fingerprint hash,indexed_at at,batch_id from platform_business_observation where id=?').get(indexed)
  const observation = t.prepare('select * from platform_business_observation order by id').all()
  const pre = preflightRosterImport(db, input)
  expect(pre.preflight.conflicts).toEqual([])
  expect(immutable()).toEqual(before)
  expect(t.prepare('select * from platform_business_observation order by id').all()).toEqual(observation)
  expect(pre.preflight.platformObservationSources).toHaveLength(3)
  const saved = commit(input)
  expect(saved).toMatchObject({ status: 'committed', summary: { written: 0, canonicalProjection: { recordsCreated: 0, versionsCreated: 0, observationsCreated: 1, observationsReused: 2 }, platformFields: { status: 'ready', eligibleVersions: 1, projectionsCreated: 0, projectionsReused: 1, observationsChecked: 3 } } })
  expect(saved.items.map(i => i.detail?.rowsWritten)).toEqual([0, 0, 0])
  expect(t.prepare('select scheme from platform_observation_fingerprint_basis where observation_id=?').get(first)).toEqual({ scheme: 'legacy-bootstrap-v1' })
  const indexedMetadata = { indexed_at: '2026-11-13T03:00:00.000Z', batch_id: saved.batchId }
  expect(t.prepare('select indexed_at,batch_id from platform_business_observation where id=?').get(first)).toEqual(indexedMetadata)
  expect(t.prepare("select r.status from import_receipt r join platform_business_observation o on o.batch_id=r.batch_id where o.id=? order by r.id").all(first))
    .toEqual([{ status: 'preflight' }, { status: 'committed' }])
  expect(t.prepare('select input_fingerprint hash,indexed_at at,batch_id from platform_business_observation where id=?').get(indexed))
    .toEqual(originalIndex)
  const after = immutable()
  expect(after.archives.slice(0, before.archives.length)).toEqual(before.archives)
  expect(after.refs).toEqual(before.refs); expect(after.assignments).toEqual(before.assignments); expect(after.history).toEqual(before.history)
  expect(after.batches).toEqual(before.batches); expect(after.receipts).toEqual(before.receipts)
  expect(commit(input)).toEqual(saved)
  expect(replayRosterImport(db, input)).toMatchObject({ status: 'replayed', update: 0 })
  const again = commit(request([first], 'confirmation'))
  expect(again).toMatchObject({ status: 'committed', summary: { written: 0, canonicalProjection: { observationsCreated: 0, observationsReused: 1 } } })
  expect(again.batchId).not.toBe(saved.batchId)
  expect(t.prepare('select indexed_at,batch_id from platform_business_observation where id=?').get(first)).toEqual(indexedMetadata)
  expect(t.prepare('select input_fingerprint hash,indexed_at at,batch_id from platform_business_observation where id=?').get(indexed)).toEqual(originalIndex)
  const read = listPlatformQueries(db, { queryId: 91 + index })
  expect(read.rows[0]!.relations.slice(0, 3).map(r => r.id)).toEqual([indexed, first, indexed + 2])
  noLegacy()
})

it.each(sources)('keeps %s reference consumers read-only until the explicit ordinary historical command', source => {
  const relationId = 102 + sources.indexOf(source) * 10
  const input: RosterImportRequest = { ...request([], 'reference'), payload: { platformQueries: [{
    interface: source, queryKey: 'original', rdjb: '2', queriedAt: '2026-10-01', reuseExisting: true, relations: [{ sequenceNo: 2 }],
  }] } }
  const before = immutable(), observation = t.prepare('select * from platform_business_observation where id=?').get(relationId)
  expect(preflightRosterImport(db, input).preflight.conflicts).toEqual([])
  expect(commit(input)).toMatchObject({ status: 'committed', summary: { written: 0 } })
  expect(t.prepare('select * from platform_business_observation where id=?').get(relationId)).toEqual(observation)
  expect(immutable()).toEqual(before)
  noLegacy()
})

it('retains populated import receipt 113 decision and audit history bytes through migration and repair', () => {
  const old = new Database(f.legacySource, { readonly: true })
  try {
    const original = immutable(old), migrated = immutable()
    expect(original.receipts.length).toBeGreaterThan(0)
    expect(original.history[0]!.length).toBeGreaterThan(0)
    expect(original.history[1]!.length).toBeGreaterThan(0)
    expect(original.history[3]!.length).toBeGreaterThan(0)
    expect(migrated.history).toEqual(original.history)
    expect(migrated.batches).toEqual(original.batches); expect(migrated.receipts).toEqual(original.receipts)
    expect(commit(request([104, 114, 124])).status).toBe('committed')
    const after = immutable()
    expect(after.history).toEqual(original.history)
    expect(after.batches).toEqual(original.batches); expect(after.receipts).toEqual(original.receipts)
    noLegacy()
  } finally { old.close() }
})

it.each(sources)('matches schema0 %s repair previews results summaries and literal original bytes across valid and quarantined histories', source => {
  const base = 104 + sources.indexOf(source) * 10, ids = Array.from({ length: 5 }, (_, i) => base + i)
  const path = join(f.root, `oracle-${serial}.sqlite`); copyFileSync(f.legacySource, path)
  const old = new Database(path), oracle = drizzle(old, { schema })
  try {
    const input = request(ids)
    const actualPre = preflightRosterImport(db, input), oldPre = preflightRosterImport(oracle, input)
    expect(actualPre).toEqual(oldPre)
    expect(actualPre.preflight.canonicalProjection?.[0]).toMatchObject({ relationId: base, identityState: 'resolved', contentState: 'verified' })
    const original = t.prepare('select id,hex(bytes) bytes,sha256 from platform_archive_value order by id').all()
    const saved = commit(input), expected = commitRosterImport(oracle, input, [], { deferCandidateTasks: true })
    expect(saved.status).toBe('committed'); expect(expected.status).toBe('committed')
    expect(saved.items).toEqual(expected.items); expect(saved.summary).toEqual(expected.summary)
    expect(saved.summary).toMatchObject({ written: 0, canonicalProjection: { recordsCreated: 3, versionsCreated: 1, observationsCreated: 5, missingKey: 1, conflict: 1, unverifiable: 4 }, platformFields: { status: 'partial', eligibleVersions: 1, observationsChecked: 5, quarantinedObservations: 4 } })
    expect(t.prepare('select id,hex(bytes) bytes,sha256 from platform_archive_value order by id').all().slice(0, original.length)).toEqual(original)
    const rawText = JSON.stringify({ ...raw, id: 'FIRST' })
    expect(t.prepare("select cast(a.bytes as text) raw from platform_observation_archive_ref r join platform_archive_value a on a.id=r.archive_id where r.owner_id=? and r.field='rawFields'").get(base)).toEqual({ raw: rawText })
    // Independent literal envelope, including the original external query coordinate.
    const literal = `{"interface":"${source}","invalidRaw":null,"queriedAt":"2026-10-01","queryId":${91 + sources.indexOf(source)},"queryKey":"original","rawFields":{"cszt":"终审通过","extra":[null,false,2," 2 "],"id":"FIRST","qymc":" Alpha ","rddqrq":" 2028 ","rdjb":"2","whpc":" 2 ","whpcyear":false,"year":"2024"},"rdjb":"2","relationKey":"FIRST","sequenceNo":4}`
    const digest = createHash('sha256').update(literal).digest('hex')
    expect(actualPre.preflight.platformObservationSources?.[0]).toEqual({ relationId: base, inputFingerprint: digest })
    expect(t.prepare('select input_fingerprint hash from platform_business_observation where id=?').get(base)).toEqual({ hash: digest })
    expect(t.prepare('select request_hash,request_body from import_receipt order by id').all()).toEqual(old.prepare('select request_hash,request_body from import_receipt order by id').all())
    noLegacy()
  } finally { old.close() }
})

it('keeps observation-specific source conflicts and original identity separate from current assignment revision2', () => {
  const rows = t.prepare('select id,input_fingerprint,indexed_at,version_id from platform_business_observation where id in(111,113)').all()
  t.exec(`insert into platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,name_raw,origin,actor,basis)
    values(111,2,2,'manual','confirmed','Current Beta','command','{"type":"agent","id":"753"}','explicit reassignment')`)
  const pre = preflightRosterImport(db, request([111, 113]))
  expect(pre.preflight.conflicts).toEqual([])
  expect(commit(request([111, 113])).status).toBe('committed')
  expect(t.prepare('select id,input_fingerprint,indexed_at,version_id from platform_business_observation where id in(111,113)').all()).toEqual(rows)
  const read = listPlatformQueries(db, { queryId: 92 })
  expect(read.rows[0]!.relations.slice(0, 3).map(r => [r.enterpriseId, r.nameRaw, r.status, r.normalizationConflicts]))
    .toEqual([[2, ' Original Alpha ', '终审通过', []], [1, ' Original Alpha ', '终审通过', []], [1, ' Original Alpha ', null, [{ field: 'status', rawValue: '终审通过', storedValue: '退回' }]]])
  noLegacy()
})

it('preserves the 100-ID public bound and rejects malformed namespaces missing aliases and caller hashes', () => {
  const ids = Array.from({ length: 100 }, (_, i) => 2001 + i)
  expect(preflightRosterImport(db, request(ids)).preflight.conflicts).toEqual([])
  expect(commit(request(ids))).toMatchObject({ status: 'committed', summary: { written: 0, canonicalProjection: { observationsCreated: 0, observationsReused: 100 }, platformFields: { observationsChecked: 100, eligibleVersions: 1 } } })
  for (const rows of [[], [{ relationId: 0 }], [{ relationId: -1 }], [{ relationId: 1.5 }], [{ relationId: '101' }], [{ relationId: Number.MAX_SAFE_INTEGER + 1 }], [{ relationId: 101 }, { relationId: 101 }], [{ relationId: 101, inputFingerprint: 'caller' }], [...ids, 2101].map(relationId => ({ relationId }))]) {
    const input = { ...request([]), payload: { platformRecordObservations: rows } }
    expect(validateImportRequest(input).ok).toBe(false)
    expect(rosterImportMcpPayloadSchema.safeParse(input.payload).success).toBe(false)
  }
  expect(validateImportRequest({ ...request([101]), sourceKind: 'alias_evidence' }).ok).toBe(false)
  expect(commit(request([91], 'query-namespace'))).toMatchObject({ status: 'failed', items: [{ error: { code: 'projection_source_missing' } }] })
  expect(commit(request([99999], 'missing'))).toMatchObject({ status: 'failed', items: [{ error: { code: 'projection_source_missing' } }] })
  expect(() => assertExpandRuntime(t)).toThrow()
  t.pragma('user_version=71611')
  expect(() => preflightRosterImport(db, request([101], 'unsupported'))).toThrow('complete 71612')
  noLegacy()
})

it('requires the actual migration completion owner even when user_version already declares71612', () => {
  t.prepare("update platform_migration_run set state='running' where transform_version='difference-evidence-reference-v1'").run()
  expect(() => preflightRosterImport(db, request([101]))).toThrow('Difference reference migration incomplete')
})

it.each(['later-item', 'receipt', 'caller-caught'] as const)('rolls back historical bootstrap after %s failure and retries the frozen command', failure => {
  const input = request(failure === 'later-item' ? [104, 114] : [104])
  expect(preflightRosterImport(db, input).preflight.conflicts).toEqual([])
  const before = immutable(), rows = t.prepare('select * from platform_business_observation order by id').all()
  const trigger = failure === 'later-item'
    ? "before update of identity_state on platform_business_observation when new.id=114"
    : "before update of status on import_receipt when new.status='committed'"
  t.exec(`create trigger fail753 ${trigger} begin select raise(abort,'later753'); end`)
  if (failure === 'later-item') expect(commit(input)).toMatchObject({ status: 'failed', summary: { written: 0 } })
  else if (failure === 'receipt') expect(() => commit(input)).toThrow('later753')
  else db.transaction(() => { expect(() => commitRosterImport(db, input, [], { deferCandidateTasks: true })).toThrow('later753') })
  expect(immutable()).toEqual(before)
  expect(t.prepare('select * from platform_business_observation order by id').all()).toEqual(rows)
  expect(t.prepare("select count(*) n from import_receipt r join import_batch b on b.id=r.batch_id where r.status='committed' and b.idempotency_key!='historical753'").get()).toEqual({ n: 0 })
  t.exec('drop trigger fail753')
  const saved = commit(input)
  expect(saved).toMatchObject({ status: 'committed', summary: { written: 0 } })
  for (const { relationId } of input.payload.platformRecordObservations!) {
    expect(t.prepare('select batch_id from platform_business_observation where id=?').get(relationId)).toEqual({ batch_id: saved.batchId })
  }
  noLegacy()
})

it('freezes server inputs across preflight drift and requires a new request rather than silently rebasing', () => {
  const input = request([104])
  expect(preflightRosterImport(db, input).preflight.conflicts).toEqual([])
  t.prepare("update platform_collection set queried_at='changed' where id=91").run()
  expect(commit(input)).toMatchObject({ status: 'failed', items: [{ error: { code: 'projection_source_drift' } }] })
  expect(preflightRosterImport(db, input).preflight.conflicts).toMatchObject([{ error: { code: 'projection_source_drift' } }])
  expect(commit(request([104], 'new-request'))).toMatchObject({ status: 'committed' })
  expect(t.prepare('select indexed_at from platform_business_observation where id=104').get()).toEqual({ indexed_at: expect.stringMatching(/^2026-/) })
  noLegacy()
})

it.each(sources)('confirms new %s target-command through nonidentity external aliases and sees the next imported source', source => {
  reserveLegacyIds(drizzle(t, { schema: targetSchema }), { query: 8000, relation: 9000 })
  const query = collection(source)
  const input: RosterImportRequest = { ...request([], 'new-collection'), payload: { platformQueries: [query] } }
  expect(preflightRosterImport(db, input).preflight.conflicts).toEqual([])
  const imported = commit(input)
  expect(imported.status).toBe('committed')
  expect(t.prepare('select observation_id from platform_legacy_relation_alias where old_id=9001').get()).toEqual({ observation_id: 2101 })
  expect(commit(request([2101], 'physical-not-alias'))).toMatchObject({ status: 'failed', items: [{ error: { code: 'projection_source_missing' } }] })
  t.exec(`insert into platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,name_raw,origin,actor,basis)
    values(2101,2,2,'manual','confirmed','Current Target Beta','command','{"type":"agent","id":"753"}','explicit current target owner')`)
  const before = immutable(), original = t.prepare('select input_fingerprint,indexed_at,batch_id from platform_business_observation where id=2101').get()
  expect(original).toMatchObject({ batch_id: imported.batchId })
  expect(preflightRosterImport(db, request([9001])).preflight.conflicts).toEqual([])
  expect(immutable()).toEqual(before)
  expect(commit(request([9001]))).toMatchObject({ status: 'committed', summary: { written: 0, canonicalProjection: { observationsCreated: 0, observationsReused: 1, recordsCreated: 0, versionsCreated: 0 } } })
  expect(immutable()).toEqual(before)
  expect(t.prepare('select input_fingerprint,indexed_at,batch_id from platform_business_observation where id=2101').get()).toEqual(original)
  expect(t.prepare('select scheme from platform_observation_fingerprint_basis where observation_id=2101').get()).toEqual({ scheme: 'target-command-v1' })
  expect(listPlatformQueries(db, { queryId: 8001 })).toMatchObject({ total: 1, rows: [{ relations: [{ id: 9001, enterpriseId: 2, rawFields: targetRaw }] }] })
  expect(commit({ ...input, idempotencyKey: 'next-collection', payload: { platformQueries: [collection(source, '2026-11-14T00:00:00Z')] } })).toMatchObject({ status: 'committed', summary: { canonicalProjection: { recordsCreated: 0, versionsCreated: 0, observationsCreated: 1 } } })
  expect(preflightRosterImport(db, request([9002], 'next-repair')).preflight.conflicts).toEqual([])
  expect(commit(request([9002], 'next-repair')).status).toBe('committed')
  noLegacy()
})

it.each(['uncaptured', 'unknown'] as const)('refuses %s indexed lifecycle without replacing the sealed fingerprint or creating a bootstrap', scheme => {
  // Synthetic damaged lifecycle counterexample; normal writes cannot change this owner.
  const triggers = z.array(z.object({ name: z.string() })).parse(t.prepare("select name from sqlite_schema where type='trigger' and tbl_name='platform_observation_fingerprint_basis'").all())
  for (const { name } of triggers) t.exec(`drop trigger "${name}"`)
  t.pragma('ignore_check_constraints=ON')
  t.prepare('update platform_observation_fingerprint_basis set scheme=?,input_archive_id=null where observation_id=101').run(scheme)
  const before = immutable(), observations = t.prepare('select * from platform_business_observation order by id').all()
  expect(preflightRosterImport(db, request([101])).preflight.conflicts).toMatchObject([{ error: { code: 'projection_source_drift' } }])
  expect(commit(request([101]))).toMatchObject({ status: 'failed', items: [{ error: { code: 'projection_source_drift' } }] })
  expect(immutable()).toEqual(before)
  expect(t.prepare('select * from platform_business_observation order by id').all()).toEqual(observations)
  noLegacy()
})

it('refuses a sealed uncaptured basis on paired not_indexed rather than attempting to recapture history', () => {
  db.insert(targetSchema.platformObservationFingerprintBasis).values({ observationId: 104, scheme: 'uncaptured', inputArchiveId: null }).run()
  const before = immutable()
  expect(preflightRosterImport(db, request([104])).preflight.conflicts).toMatchObject([{ error: { code: 'projection_source_drift' } }])
  expect(commit(request([104]))).toMatchObject({ status: 'failed' })
  expect(immutable()).toEqual(before)
  noLegacy()
})

it('runs existing H3 and MCP historical preflight commit readback and replay on the same injected target', async () => {
  for (const key of ['defineEventHandler', 'getMethod', 'readBody', 'getHeader', 'setResponseStatus', 'setHeader', 'getQuery', 'getRouterParam', 'createError'] as const) vi.stubGlobal(key, h3[key])
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic753', mcpToken: 'synthetic753', filesDir: undefined }))
  vi.spyOn(importExecutor, 'execute').mockImplementation(async (database, action, input, errors, context) => action === 'preflight'
    ? preflightRosterImport(database, input, errors, context)
    : commitRosterImport(database, input, errors, { ...context, deferCandidateTasks: true }))
  const router = createRouter()
  for (const action of ['preflight', 'commit', 'replay'] as const) router.post(`/api/roster/import/${action}`, createRosterImportHandler(action))
  router.get('/api/platform/queries', (await import('../server/api/platform/queries.get')).default)
  const server = createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected local HTTP port')
  const base = `http://127.0.0.1:${address.port}`
  const post = async (action: string, input: RosterImportRequest, status = 200) => {
    const response = await fetch(`${base}/api/roster/import/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic753' }, body: JSON.stringify(input) })
    expect(response.status).toBe(status)
    return response.json()
  }
  try {
    const input = request([102, 112, 122])
    expect(await post('preflight', input)).toMatchObject({ status: 'preflight', preflight: { conflicts: [] } })
    expect(await post('commit', input)).toMatchObject({ status: 'committed', summary: { written: 0, canonicalProjection: { observationsCreated: 3 } } })
    expect(await post('commit', input)).toMatchObject({ status: 'committed', summary: { written: 0, canonicalProjection: { observationsCreated: 3 } } })
    expect(await post('replay', input, 400)).toEqual({ message: 'Historical projection uses preflight/commit with its original idempotency key; replay only converges announcement evidence' })
    const response = await fetch(`${base}/api/platform/queries?queryId=92`, { headers: { authorization: 'Bearer synthetic753' } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(listPlatformQueries(db, { queryId: 92 }))
    const preflight = (await import('../server/mcp/tools/preflight_roster_batch')).default
    const save = (await import('../server/mcp/tools/save_roster_batch')).default
    const nextRequest = request([104, 114, 124], 'mcp')
    const next = { ...nextRequest, sourceSha256: undefined, payload: { ...nextRequest.payload } }
    expect(await preflight.handler(next, {} as never)).toMatchObject({ status: 'preflight', preflight: { conflicts: [] } })
    const saved = await save.handler(next, {} as never)
    expect(saved).toMatchObject({ status: 'committed', summary: { written: 0, canonicalProjection: { recordsCreated: 3, versionsCreated: 3, observationsCreated: 3 } } })
    expect(await save.handler(next, {} as never)).toEqual(saved)
    const list = (await import('../server/mcp/tools/list_platform_queries')).default
    const readInput = { interface: undefined, queryKey: undefined, uscc: undefined, queryId: 92, view: undefined,
      enterpriseId: undefined, titleCode: undefined, status: undefined, page: undefined, pageSize: undefined, includeRawResponse: undefined }
    expect(await list.handler(readInput, {} as never)).toEqual(listPlatformQueries(db, { queryId: 92 }))
    noLegacy()
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
