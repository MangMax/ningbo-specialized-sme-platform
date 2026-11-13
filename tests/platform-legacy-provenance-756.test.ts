import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { chmodSync, copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '../db/schema'
import { targetSchema } from '../lib/platform/target-schema'
import { commitRosterImport, preflightRosterImport, planRosterImport } from '../server/utils/roster-import'
import { inspectLegacyPlatformProvenance, writeLegacyPlatformProvenance } from '../server/utils/platform-legacy-provenance'
import { originalLegacyProvenanceInput } from '../lib/platform/legacy-provenance-command'
import type { LegacyPlatformCollection, LegacyPlatformProvenanceInput } from '../lib/platform/legacy-provenance'
import type { RosterImportRequest } from '../lib/roster-import-client'
import { platformResultToImport, recognizedStoredStatus } from '../lib/platform/recognized-evidence'
import { reserveLegacyIds } from '../lib/platform/target-archive'
import { writeNewCollectionTarget } from '../lib/platform/collection-target-command'
import { assertExpandRuntime } from '../db/schema-phase'
import { witnessReaderFixture } from './helpers/recognized-witness-target-733'
import { finalizeProcessStored } from '../upgrade/process-stored'
import { transferCorrespondence } from '../upgrade/correspondence'
import { transferDifferenceReferences } from '../upgrade/difference-references'
import { indexLegacyProvenance } from '../upgrade/legacy-provenance'
import { createApp, createRouter, toNodeListener } from 'h3'
import * as h3 from 'h3'
import { createServer } from 'node:http'
import { importExecutor } from '../server/utils/import-execution'
import { createRosterImportHandler } from '../server/utils/roster-import-route'

vi.mock('@db', () => ({ useDb: () => db }))
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
const shared = '/Users/mang/.t3/acceptance/platform-complete-migration/shared-readonly-fixtures/71613'
const root = mkdtempSync(join(tmpdir(), 'provenance756-'))
let t: Database.Database, db: ReturnType<typeof drizzle<typeof schema>>, serial = 0
const trace: string[] = []
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
beforeEach(context => {
  const path = join(root, `case-${++serial}.sqlite`)
  copyFileSync(join(shared, 'absent-71613.sqlite'), path); chmodSync(path, 0o600)
  t = new Database(path, { verbose: sql => trace.push(String(sql)) }); t.pragma('foreign_keys=ON')
  db = drizzle(t, { schema }); trace.length = 0
  writeFileSync(join(root, `case-${serial}.json`), JSON.stringify({ test: context.task.name, path }))
})
afterEach(() => { t.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
afterAll(() => { /* Batch owner archives and releases this private root. */ })
function collection(rows: Record<string, string>[] = [{ id: 'new756', rdjb: '2', qymc: ' Alpha ', blank: '', value: '🙂' }], status: 'success' | 'partial' | 'no_record' = rows.length ? 'success' : 'no_record'): LegacyPlatformCollection {
  return { source: 'businessList', status, effectiveConditions: { uscc: '9133020078041158X6', combination: 'and' },
    titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: `2026-11-13T01:00:${String(serial).padStart(2, '0')}Z`,
    completedAt: '2026-11-13T02:00:00Z', rows,
    pages: [{ source: 'businessList', rdjb: '2', page: 1, fetchedCount: rows.length, declaredTotal: rows.length, status: 'success', error: null },
      ...(status === 'partial' ? [{ source: 'businessList' as const, rdjb: '2', page: 2, fetchedCount: 0, declaredTotal: null, status: 'failed' as const, error: { code: 'timeout' as const, message: ' original ' } }] : [])],
    fetchedCount: rows.length, declaredTotal: status === 'partial' ? null : rows.length,
    completeness: status === 'partial' ? 'partial' : 'complete', fullRange: status !== 'partial',
    unfinished: status === 'partial' ? [{ source: 'businessList', rdjb: '2', page: 2 }] : [], error: null,
    limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 } }
}
function request(inputs: LegacyPlatformProvenanceInput[], key = `command-${serial}`): RosterImportRequest {
  return { sourceKind: 'platform_archive', sourceIdentity: 'source756', idempotencyKey: key, payload: { platformLegacyProvenance: inputs } }
}
function commit(input: RosterImportRequest) { return commitRosterImport(db, input, [], { deferCandidateTasks: true }) }
function input(queryId: number, c: LegacyPlatformCollection): LegacyPlatformProvenanceInput {
  return { queryId, interface: 'business_list', queryKey: c.effectiveConditions.uscc!, rdjb: c.titleScope.rdjb.join(','), queriedAt: c.queriedAt,
    sourceIdentity: ' source file \n🙂 ', sourceSha256: digest(`source:${queryId}`), segmentIndex: 0, collection: c,
    relations: c.rows.map((rawFields, index) => ({ sequenceNo: index + 1, relationKey: rawFields.id ?? null, rawFields })) }
}
function fresh(c = collection()) {
  const result = commit({ sourceKind: 'platform_archive', sourceIdentity: 'source756', idempotencyKey: `new-${serial}-${c.queriedAt}`,
    payload: { platformQueries: [{ interface: 'business_list', queryKey: c.effectiveConditions.uscc!, rdjb: c.titleScope.rdjb.join(','), queriedAt: c.queriedAt,
      status: recognizedStoredStatus(c), rawResponse: ' original \n😀 ', relations: c.rows.map((rawFields, i) => ({ sequenceNo: i + 1, relationKey: rawFields.id, rawFields })) }] } })
  expect(result.status, JSON.stringify(result)).toBe('committed')
  return input(Number(result.items[0]!.ref!.split(':')[1]), c)
}
function supplementCount() { return t.prepare("SELECT count(*) n FROM platform_collection_legacy_provenance WHERE origin='supplement'").get() }
function noLegacy() {
  expect(trace.filter(sql => /\b(?:from|join|insert into|update|delete from)\s+["`]?platform_(?:query|relation|query_legacy_provenance)["`]?(?=\s|$|\()/i.test(sql))).toEqual([])
}
function protectedBytes(connection: Database.Database) {
  const tables = ['platform_collection', 'platform_collection_page', 'platform_collection_condition', 'platform_collection_archive_ref',
    'platform_business_observation', 'platform_observation_assignment', 'platform_observation_fingerprint_basis',
    'platform_business_record_version', 'evidence_revision_113', 'evidence_impact_progress_113', 'explanation_impact_113',
    'evidence_review_receipt_114', 'difference_reason']
  return tables.map(table => {
    const columns = connection.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]
    return [table, connection.prepare(`SELECT ${columns.flatMap(c => [`typeof("${c.name}")`, `hex(cast("${c.name}" as blob))`]).join(',')} FROM "${table}" ORDER BY rowid`).raw().all()]
  })
}
it('reconstructs literal query rows bytes and digest with 8001 9001 aliases and preserves all protected histories', () => {
  reserveLegacyIds(db, { query: 8000, relation: 9000 })
  writeNewCollectionTarget(db, {
    queryText: JSON.stringify({ interface: 'business_list', queryKey: '9133020078041158X6', rdjb: '2', queriedAt: '2026-11-13T00:00:00Z', status: 'success', rawResponse: ' original response ',
      relations: [{ sequenceNo: 1, relationKey: 'normal755', rawFields: { id: 'normal755', rdjb: '2', cszt: 'pending' } }] }),
    evidenceText: null, createdAt: 'c', assignments: [{ enterpriseId: null, nameRaw: null, usccRaw: null, matchBasis: 'none', verificationStatus: 'pending', origin: 'command', actor: { type: 'agent', id: '756' }, basis: 'original' }],
  })
  const c = collection([{ id: 'normal755', rdjb: '2', cszt: 'pending' }])
  c.queriedAt = '2026-11-13T00:00:00Z'; c.effectiveConditions.uscc = '9133020078041158X6'
  const command = input(8001, c)
  const expected = '{"query":{"id":8001,"interface":"business_list","queryKey":"9133020078041158X6","rdjb":"2","titleCode":null,"queriedAt":"2026-11-13T00:00:00Z","lastCollectedAt":null,"status":"success","failureReason":null,"rawResponse":" original response ","collectionEvidence":null,"createdAt":"c"},"rows":[{"id":9001,"sequenceNo":1,"relationKey":"normal755","rawFields":{"id":"normal755","rdjb":"2","cszt":"pending"},"rawBytes":"{\\"id\\":\\"normal755\\",\\"rdjb\\":\\"2\\",\\"cszt\\":\\"pending\\"}"}]}'
  const observationId = db.select().from(targetSchema.platformLegacyRelationAlias).where(eq(targetSchema.platformLegacyRelationAlias.oldId, 9001)).get()!.observationId
  const assignment = db.select().from(targetSchema.platformObservationAssignment).where(eq(targetSchema.platformObservationAssignment.observationId, observationId)).get()!
  db.insert(targetSchema.platformObservationAssignment).values({ ...assignment, revision: 2, enterpriseId: 2, actor: { type: 'agent', id: '756' }, basis: 'current ownership cannot change original query rows' }).run()
  const before = protectedBytes(t), original = originalLegacyProvenanceInput(db, 8001)
  expect(original.collectionId).not.toBe(8001)
  expect(JSON.stringify({ query: original.query, rows: original.rows })).toBe(expected)
  expect(inspectLegacyPlatformProvenance(db, command)).toEqual({ inputFingerprint: digest(expected), exists: false, relationCount: 1 })
  const req = request([command])
  expect(preflightRosterImport(db, req).preflight).toMatchObject({ add: 1, platformLegacyProvenanceSources: [{ queryId: 8001, inputFingerprint: digest(expected) }] })
  expect(protectedBytes(t)).toEqual(before)
  const saved = commit(req)
  expect(saved).toMatchObject({ status: 'committed', summary: { written: 1 }, items: [{ kind: 'platform_legacy_provenance', detail: { rowsWritten: 1, typedState: 'unknown', relationCount: 1 } }] })
  expect(protectedBytes(t)).toEqual(before)
  const metadata = t.prepare("SELECT p.*,a.bytes,a.storage_class FROM platform_collection_legacy_provenance p JOIN platform_archive_value a ON a.id=p.archive_id WHERE origin='supplement'").get() as { input_fingerprint: string; bytes: Buffer; storage_class: string }
  expect(metadata.input_fingerprint).toBe(digest(expected))
  expect(metadata.bytes).toEqual(Buffer.from(JSON.stringify(command.collection))); expect(metadata.storage_class).toBe('text')
  expect(commit(req)).toEqual(saved)
  const receiptBytes = t.prepare('SELECT * FROM import_receipt ORDER BY id').raw().all()
  expect(commit(req)).toEqual(saved); expect(t.prepare('SELECT * FROM import_receipt ORDER BY id').raw().all()).toEqual(receiptBytes)
  expect(commit({ ...req, idempotencyKey: 'duplicate756' })).toMatchObject({ status: 'committed', summary: { written: 0, skipped: 1 } })
  expect(t.prepare("SELECT p.*,a.bytes,a.storage_class FROM platform_collection_legacy_provenance p JOIN platform_archive_value a ON a.id=p.archive_id WHERE origin='supplement'").get()).toEqual(metadata)
  expect(supplementCount()).toEqual({ n: 1 }); noLegacy()
})

it.each(['success', 'partial', 'no_record'] as const)('supplements normal newly imported %s collection without rewriting original completeness', status => {
  const command = fresh(collection(status === 'no_record' ? [] : undefined, status))
  const before = protectedBytes(t)
  expect(preflightRosterImport(db, request([command])).preflight).toMatchObject({ add: 1, conflicts: [] })
  expect(commit(request([command]))).toMatchObject({ status: 'committed', summary: { written: 1 } })
  expect(protectedBytes(t)).toEqual(before); noLegacy()
})

it('retains original freeze across drift repeat preflight failed correction and retry', () => {
  const command = fresh(), req = request([command])
  const first = preflightRosterImport(db, req).preflight.platformLegacyProvenanceSources
  const oldTime = t.prepare('SELECT last_collected_at FROM platform_collection WHERE id=(SELECT collection_id FROM platform_legacy_query_alias WHERE old_id=?)').get(command.queryId) as { last_collected_at: null }
  t.prepare("UPDATE platform_collection SET last_collected_at='changed' WHERE id=(SELECT collection_id FROM platform_legacy_query_alias WHERE old_id=?)").run(command.queryId)
  expect(commit(req)).toMatchObject({ status: 'failed', items: [{ error: { code: 'legacy_source_drift' } }] })
  expect(preflightRosterImport(db, req).preflight).toMatchObject({ platformLegacyProvenanceSources: first, conflicts: [{ error: { code: 'legacy_source_drift' } }] })
  expect(commit({ ...req, payload: { platformLegacyProvenance: [{ ...command, sourceIdentity: ' corrected ' }] } })).toMatchObject({ status: 'failed', items: [{ error: { code: 'legacy_source_drift' } }] })
  t.prepare('UPDATE platform_collection SET last_collected_at=? WHERE id=(SELECT collection_id FROM platform_legacy_query_alias WHERE old_id=?)').run(oldTime.last_collected_at, command.queryId)
  expect(commit(req).status).toBe('committed'); noLegacy()
})

it('preserves same key request locks and new key immutable metadata conflicts', () => {
  const command = fresh(), req = request([command])
  expect(commit(req).status).toBe('committed')
  expect(() => commit({ ...req, sourceIdentity: 'other' })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
  expect(() => commit({ ...req, payload: { platformLegacyProvenance: [{ ...command, sourceIdentity: 'other' }] } })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
  for (const changed of [{ ...command, sourceIdentity: 'other' }, { ...command, sourceSha256: 'f'.repeat(64) },
    { ...command, segmentIndex: 1 }, { ...command, collection: { ...command.collection, completedAt: '2026-11-13T03:00:00Z' } }])
    expect(commit(request([changed], `conflict-${JSON.stringify(changed)}`))).toMatchObject({ status: 'failed', items: [{ error: { code: 'legacy_provenance_conflict' } }] })
  expect(supplementCount()).toEqual({ n: 1 }); noLegacy()
})

it('shares the SHA segment conflict domain with original T04 metadata', () => {
  t.close()
  const path = join(root, 'populated-normal.sqlite')
  copyFileSync(join(shared, 'normal-71613.sqlite'), path); chmodSync(path, 0o600)
  t = new Database(path, { verbose: sql => trace.push(String(sql)) }); t.pragma('foreign_keys=ON'); db = drizzle(t, { schema })
  const command = fresh()
  command.sourceSha256 = '1'.repeat(64); command.segmentIndex = 7
  const before = protectedBytes(t), count = supplementCount()
  const receipts = t.prepare("SELECT * FROM import_receipt WHERE batch_id IN (SELECT id FROM import_batch WHERE idempotency_key NOT LIKE 'new-%') ORDER BY id").raw().all()
  expect(commit(request([command]))).toMatchObject({ status: 'failed', items: [{ error: { code: 'legacy_source_identity_conflict' } }] })
  expect(protectedBytes(t)).toEqual(before); expect(supplementCount()).toEqual(count)
  expect(t.prepare("SELECT * FROM import_receipt WHERE id<=? ORDER BY id").raw().all(receipts.length)).toEqual(receipts); noLegacy()
})

it.each(['later-item', 'receipt', 'caller-caught'] as const)('rolls back archives metadata batch and receipt after %s failure then retries', failure => {
  const command = fresh(), second = fresh({ ...collection(), queriedAt: '2026-11-14T00:00:00Z', completedAt: '2026-11-14T02:00:00Z' }), req = request([command, second])
  const preflight = preflightRosterImport(db, req)
  const archives = t.prepare('SELECT * FROM platform_archive_value ORDER BY id').raw().all()
  const before = protectedBytes(t)
  const collectionId = (t.prepare('SELECT collection_id id FROM platform_legacy_query_alias WHERE old_id=?').get(second.queryId) as { id: number }).id
  t.exec(failure === 'receipt'
    ? "CREATE TRIGGER fail756 BEFORE UPDATE OF status ON import_receipt WHEN NEW.status='committed' BEGIN SELECT RAISE(ABORT,'receipt756'); END"
    : `CREATE TRIGGER fail756 BEFORE INSERT ON platform_collection_legacy_provenance WHEN NEW.collection_id=${collectionId} BEGIN SELECT RAISE(ABORT,'later756'); END`)
  if (failure === 'caller-caught') {
    const fingerprint = inspectLegacyPlatformProvenance(db, second).inputFingerprint
    db.transaction(tx => { expect(() => writeLegacyPlatformProvenance(tx, second, preflight.batchId, fingerprint)).toThrow('later756') })
  } else if (failure === 'receipt') expect(() => commit(req)).toThrow('receipt756')
  else expect(commit(req)).toMatchObject({ status: 'failed', items: [{ error: { code: 'commit_rolled_back' } }, { ok: false }] })
  expect(supplementCount()).toEqual({ n: 0 })
  expect(t.prepare('SELECT * FROM platform_archive_value ORDER BY id').raw().all()).toEqual(archives)
  expect(protectedBytes(t)).toEqual(before)
  t.exec('DROP TRIGGER fail756')
  expect(commit(req)).toMatchObject({ status: 'committed', summary: { written: 2 } }); noLegacy()
})

it('rechecks the planned closure and rejects incomplete readiness aliases and archives without source writes', () => {
  const command = fresh(), req = request([command]), batchId = preflightRosterImport(db, req).batchId
  const plan = planRosterImport(db, req, { batchId })
  db.transaction(tx => {
    t.prepare("UPDATE platform_collection SET last_collected_at='drift' WHERE id=(SELECT collection_id FROM platform_legacy_query_alias WHERE old_id=?)").run(command.queryId)
    expect(plan.items[0]!.run!(tx)).toMatchObject({ ok: false, error: { code: 'legacy_source_drift' } })
  })
  expect(supplementCount()).toEqual({ n: 0 })
  expect(() => inspectLegacyPlatformProvenance(db, { ...command, queryId: 999999 })).toThrow(expect.objectContaining({ code: 'legacy_query_missing' }))
  t.exec("UPDATE platform_migration_run SET state='running' WHERE transform_version='collection-legacy-provenance-v1'")
  expect(() => preflightRosterImport(db, req)).toThrow('migration incomplete')
  expect(() => assertExpandRuntime(t)).toThrow()
})

it('runs three source imports and historical commands with shared versions and revision2 ownership', () => {
  reserveLegacyIds(db, { query: 8100, relation: 9100 })
  const imported = ['queryList', 'businessList', 'queryBusList'].map((source, index) => {
    const c = collection()
    return platformResultToImport({ ...c, source: source as 'queryList' | 'businessList' | 'queryBusList',
      dataRows: c.rows, titleScope: source === 'queryList' ? { mode: 'source_default', rdjb: [] } : c.titleScope,
      queriedAt: `2026-11-16T00:00:0${index}Z`, completedAt: '2026-11-16T02:00:00Z', pages: c.pages.map(page => ({ ...page, source: source as 'queryList' | 'businessList' | 'queryBusList', rdjb: source === 'queryList' ? null : page.rdjb })) })
  })
  const req: RosterImportRequest = { sourceKind: 'platform_archive', sourceIdentity: 'three756', idempotencyKey: 'three756', payload: { platformQueries: imported } }
  expect(preflightRosterImport(db, req).preflight.conflicts).toEqual([])
  const first = commit(req)
  expect(first).toMatchObject({ status: 'committed', summary: { written: 6 } })
  expect(commit({ ...req, idempotencyKey: 'three-next', payload: { platformQueries: imported.map((q, index) => ({ ...q, queriedAt: `2026-11-17T00:00:0${index}Z`,
    collectionEvidence: { ...q.collectionEvidence!, queriedAt: `2026-11-17T00:00:0${index}Z`, completedAt: '2026-11-17T02:00:00Z' } })) } })).toMatchObject({ status: 'committed', summary: { canonicalProjection: { versionsCreated: 0, observationsCreated: 3 } } })
  const rows = t.prepare('SELECT a.old_id,o.id,o.version_id FROM platform_business_observation o JOIN platform_legacy_relation_alias a ON a.observation_id=o.id WHERE a.old_id>9100 ORDER BY a.old_id').all() as { old_id: number; id: number; version_id: number }[]
  expect(rows).toHaveLength(6)
  expect(new Set(rows.map(row => row.version_id)).size).toBe(3)
  const assignment = db.select().from(targetSchema.platformObservationAssignment).where(eq(targetSchema.platformObservationAssignment.observationId, rows[1]!.id)).get()!
  db.insert(targetSchema.platformObservationAssignment).values({ ...assignment, revision: 2, enterpriseId: 2, origin: 'command', actor: { type: 'agent', id: '756' }, basis: 'revision2 original input unchanged' }).run()
  const historical: RosterImportRequest = { ...req, idempotencyKey: 'historical756', payload: { platformRecordObservations: rows.map(row => ({ relationId: row.old_id })) } }
  expect(preflightRosterImport(db, historical).preflight.conflicts).toEqual([])
  expect(commit(historical)).toMatchObject({ status: 'committed', summary: { written: 0, canonicalProjection: { observationsReused: 6 } } })
  noLegacy()
})

it('matches schema0 literal SQLite driver bytes and old service across TEXT BLOB NULL and full-chain completed-run replay', async () => {
  const originals: LegacyPlatformProvenanceInput[] = []
  const f = await witnessReaderFixture(old => {
    const database = drizzle(old, { schema })
    for (const [index, kind] of ['text', 'blob', 'null', 'partial'].entries()) {
      const c = collection(kind === 'null' ? [] : undefined, kind === 'partial' ? 'partial' : undefined)
      c.queriedAt = `2026-11-20T00:00:0${index}Z`; c.completedAt = '2026-11-20T02:00:00Z'
      const id = 100 + index
      const rawResponse = kind === 'blob' ? Buffer.from([0, 255, 32, 10]) : kind === 'null' ? null : ' raw \n🙂 '
      old.prepare("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,raw_response,created_at) VALUES(?,'business_list',?,'2',?,?,?,'original-time')").run(id, c.effectiveConditions.uscc, c.queriedAt, c.status, rawResponse)
      if (kind === 'blob') old.prepare('UPDATE platform_query SET failure_reason=?,last_collected_at=? WHERE id=?').run(Buffer.from([0, 32, 255]), ' original last time \n', id)
      const rawText = ' { "id":"new756", "rdjb":"2", "qymc":" Alpha ", "blank":"", "value":"🙂" } \n'
      if (c.rows.length) old.prepare("INSERT INTO platform_relation(id,query_id,sequence_no,relation_key,raw_fields,created_at) VALUES(?,?,1,'new756',?,'row-time')").run(id + 1000, id, rawText)
      originals.push(input(id, c))
      // Old service remains the independent implementation of the original command.
      expect(inspectLegacyPlatformProvenance(database, originals[index]!).exists).toBe(false)
    }
    expect(commitRosterImport(database, request([originals[0]!], 'original-history756'), [], { deferCandidateTasks: true })).toMatchObject({ status: 'committed', summary: { written: 1 } })
  })
  f.close()
  const a = join(f.root, 'pre-process756.sqlite'); copyFileSync(f.target, a)
  finalizeProcessStored({ source: a, target: f.target, runId: 'process756', predecessorRunId: 'witness', legacySource: f.legacySource })
  const b = join(f.root, 'pre-correspondence756.sqlite'); copyFileSync(f.target, b)
  transferCorrespondence({ source: b, target: f.target, runId: 'correspondence756' })
  const c = join(f.root, 'pre-difference756.sqlite'); copyFileSync(f.target, c)
  transferDifferenceReferences({ source: c, target: f.target, runId: 'difference756' })
  const predecessor = join(f.root, 'pre-provenance756.sqlite'); copyFileSync(f.target, predecessor)
  indexLegacyProvenance({ source: predecessor, target: f.target, runId: 'provenance756', batchSize: 2 })
  const old = new Database(f.legacySource), target = new Database(f.target)
  old.pragma('foreign_keys=ON'); target.pragma('foreign_keys=ON')
  const oldDb = drizzle(old, { schema }), targetDb = drizzle(target, { schema })
  try {
    const historicalReceipt = target.prepare('SELECT * FROM import_receipt ORDER BY id').raw().all()
    const historicalReceiptMax = (target.prepare('SELECT max(id) n FROM import_receipt').get() as { n: number }).n
    for (const command of originals) {
      // Explicit SELECT insertion order, independent of the new projection and its helpers.
      const query = old.prepare('SELECT id,interface,query_key queryKey,rdjb,title_code titleCode,queried_at queriedAt,last_collected_at lastCollectedAt,status,failure_reason failureReason,raw_response rawResponse,collection_evidence collectionEvidence,created_at createdAt FROM platform_query WHERE id=?').get(command.queryId)
      const rows = (old.prepare('SELECT id,sequence_no sequenceNo,relation_key relationKey,raw_fields rawBytes FROM platform_relation WHERE query_id=? ORDER BY sequence_no,id').all(command.queryId) as { id: number; sequenceNo: number; relationKey: string; rawBytes: string | Buffer }[]).map(row => ({ id: row.id, sequenceNo: row.sequenceNo, relationKey: row.relationKey, rawFields: JSON.parse(String(row.rawBytes)), rawBytes: row.rawBytes }))
      const bytes = JSON.stringify({ query, rows })
      const original = originalLegacyProvenanceInput(targetDb, command.queryId)
      expect(JSON.stringify({ query: original.query, rows: original.rows })).toBe(bytes)
      expect(inspectLegacyPlatformProvenance(oldDb, command).inputFingerprint).toBe(digest(bytes))
      expect(inspectLegacyPlatformProvenance(targetDb, command).inputFingerprint).toBe(digest(bytes))
      const req = request([command], `old-${command.queryId}`)
      expect(preflightRosterImport(oldDb, req).preflight).toEqual(preflightRosterImport(targetDb, req).preflight)
      const oldResult = commitRosterImport(oldDb, req, [], { deferCandidateTasks: true })
      const result = commitRosterImport(targetDb, req, [], { deferCandidateTasks: true })
      expect(result.status).toBe('committed'); expect(result.items).toEqual(oldResult.items); expect(result.summary).toEqual(oldResult.summary)
      writeFileSync(join(f.root, `oracle-${command.queryId}.json`), bytes)
    }
    expect(target.prepare('SELECT * FROM import_receipt WHERE id<=? ORDER BY id').raw().all(historicalReceiptMax)).toEqual(historicalReceipt)
    const next = { ...collection(), queriedAt: '2026-11-22T00:00:00Z', completedAt: '2026-11-22T02:00:00Z' }
    const imported = commitRosterImport(targetDb, { sourceKind: 'platform_archive', sourceIdentity: 'after-S', idempotencyKey: 'after-S',
      payload: { platformQueries: [{ interface: 'business_list', queryKey: next.effectiveConditions.uscc!, rdjb: '2', queriedAt: next.queriedAt,
        status: 'success', rawResponse: ' original after S ', relations: next.rows.map((rawFields, index) => ({ sequenceNo: index + 1, relationKey: rawFields.id, rawFields })) }] } }, [], { deferCandidateTasks: true })
    expect(imported).toMatchObject({ status: 'committed', summary: { written: 2 } })
    const newQueryId = Number(imported.items[0]!.ref!.split(':')[1])
    expect(commitRosterImport(targetDb, request([input(newQueryId, next)], 'supplement-after-S'), [], { deferCandidateTasks: true })).toMatchObject({ status: 'committed', summary: { written: 1 } })
    const before = target.prepare("SELECT * FROM platform_collection_legacy_provenance WHERE origin='supplement' ORDER BY collection_id").raw().all()
    const collections = target.prepare('SELECT * FROM platform_collection ORDER BY id').raw().all()
    const receipts = target.prepare('SELECT * FROM import_receipt ORDER BY id').raw().all()
    target.close()
    expect(indexLegacyProvenance({ source: predecessor, target: f.target, runId: 'provenance756', batchSize: 2 })).toMatchObject({ state: 'complete' })
    const after = new Database(f.target, { readonly: true })
    try {
      expect(after.prepare("SELECT * FROM platform_collection_legacy_provenance WHERE origin='supplement' ORDER BY collection_id").raw().all()).toEqual(before)
      expect(after.prepare('SELECT * FROM platform_collection ORDER BY id').raw().all()).toEqual(collections)
      expect(after.prepare('SELECT * FROM import_receipt ORDER BY id').raw().all()).toEqual(receipts)
      expect(after.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]); expect(after.pragma('foreign_key_check')).toEqual([])
    } finally { after.close() }
  } finally { old.close(); if (target.open) target.close() }
}, 120000)

it('reconstructs synthetic archived BLOB NULL and scalar JSON cells with an independent schema0 driver oracle', () => {
  // This corpus exercises the input projection, not the predecessor full-chain admission.
  // Only this private copy's archive update barriers are removed to substitute original cells.
  const barriers = t.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='platform_archive_value'").all() as { name: string }[]
  for (const { name } of barriers) t.exec(`DROP TRIGGER "${name}"`)
  const legacy = new Database(':memory:')
  try {
    const rawValues = [Buffer.from(' {"id":"A","rdjb":"2","n":0,"flag":false,"nested":[null,2," 2 "]} \n'), null, '42'] as const
    const observations = t.prepare("SELECT o.id,r.archive_id FROM platform_business_observation o JOIN platform_observation_archive_ref r ON r.owner_id=o.id AND r.field='legacyRowSnapshot' WHERE o.collection_id=11 ORDER BY o.sequence_no").all() as { id: number; archive_id: number }[]
    for (const [index, observation] of observations.entries()) {
      const value = t.prepare('SELECT bytes FROM platform_archive_value WHERE id=?').get(observation.archive_id) as { bytes: Buffer }
      const snapshot = JSON.parse(value.bytes.toString()) as { fields: { name: string; storageClass: string; hex: string }[] }
      const raw = rawValues[index]!
      const cell = snapshot.fields.find(c => c.name === 'raw_fields')!
      cell.storageClass = raw === null ? 'null' : Buffer.isBuffer(raw) ? 'blob' : 'text'
      cell.hex = raw === null ? '' : Buffer.from(raw).toString('hex')
      const bytes = Buffer.from(JSON.stringify(snapshot))
      t.prepare('UPDATE platform_archive_value SET bytes=?,byte_length=?,sha256=? WHERE id=?').run(bytes, bytes.length, digest(bytes), observation.archive_id)
      const rawBytes = raw === null ? null : Buffer.from(raw)
      t.prepare("UPDATE platform_archive_value SET storage_class=?,bytes=?,byte_length=?,sha256=? WHERE id=(SELECT archive_id FROM platform_observation_archive_ref WHERE owner_id=? AND field='rawFields')")
        .run(cell.storageClass, rawBytes, rawBytes?.length ?? null, rawBytes === null ? null : digest(rawBytes), observation.id)
      const original = originalLegacyProvenanceInput(db, 11).rows[index]!
      const driver = legacy.prepare('SELECT ? rawBytes').get(raw) as { rawBytes: Buffer | string | null }
      expect(original.rawBytes).toEqual(driver.rawBytes)
      expect(original.rawFields).toEqual(driver.rawBytes === null ? null : JSON.parse(String(driver.rawBytes)))
      expect(Object.keys(original)).toEqual(['id', 'sequenceNo', 'relationKey', 'rawFields', 'rawBytes'])
      if (Buffer.isBuffer(raw)) expect(JSON.stringify(original.rawBytes)).toBe(`{"type":"Buffer","data":[${[...raw].join(',')}]}`)
    }
  } finally { legacy.close() }
})

it.each([
  ['queryKey', 'legacy_query_identity_conflict'],
  ['collection', 'legacy_collection_identity_conflict'],
  ['set', 'legacy_relation_set_conflict'],
  ['payload', 'legacy_relation_payload_conflict'],
  ['page', 'legacy_page_title_conflict'],
  ['typed', 'legacy_query_not_legacy'],
] as const)('retains the public %s rejection on the explicit successor', (variant, code) => {
  const c = collection()
  if (variant === 'page') {
    c.titleScope.rdjb = ['1', '2', '3']
    c.pages.unshift({ source: 'businessList', rdjb: '1', page: 1, status: 'success', fetchedCount: 0, declaredTotal: 0, error: null })
    c.pages.push({ source: 'businessList', rdjb: '3', page: 1, status: 'success', fetchedCount: 0, declaredTotal: 0, error: null })
  }
  const command = fresh(c)
  if (variant === 'queryKey') command.queryKey = 'different'
  if (variant === 'collection') command.collection.effectiveConditions.uscc = '9133020078041158X7'
  if (variant === 'set') command.relations = []
  if (variant === 'payload') command.relations[0]!.rawFields = { wrong: 'row' }
  if (variant === 'page') { command.collection.pages[1]!.rdjb = '3'; command.collection.pages[2]!.rdjb = '2' }
  if (variant === 'typed') {
    const next = { ...collection(), queriedAt: '2026-11-21T00:00:00Z', completedAt: '2026-11-21T02:00:00Z' }
    const typed = platformResultToImport({ ...next, dataRows: next.rows })
    const result = commit({ sourceKind: 'platform_archive', sourceIdentity: 'typed', idempotencyKey: 'typed756', payload: { platformQueries: [typed] } })
    expect(result.status).toBe('committed')
    command.queryId = Number(result.items[0]!.ref!.split(':')[1]); command.queriedAt = next.queriedAt; command.collection = next
  }
  expect(commit(request([command]))).toMatchObject({ status: 'failed', items: [{ error: { code } }] })
  expect(supplementCount()).toEqual({ n: 0 }); noLegacy()
})

it('preserves populated history receipt hashes decisions and 113 114 bytes when a new supplement succeeds', () => {
  t.close()
  const path = join(root, 'history-normal.sqlite')
  copyFileSync(join(shared, 'normal-71613.sqlite'), path); chmodSync(path, 0o600)
  t = new Database(path, { verbose: sql => trace.push(String(sql)) }); t.pragma('foreign_keys=ON'); db = drizzle(t, { schema })
  const command = fresh()
  db.insert(schema.differenceReason).values({ id: 101, enterpriseId: 1, titleCode: 'specialized_sme', direction: 'missing_in_miit',
    status: 'needs_review', evidenceQueryId: 11, evidenceRelationId: 1, requestHash: ' old hash ', basis: ' { "queryId":11 } ', recordedAt: 't' }).run()
  t.exec(`INSERT INTO evidence_revision_113(id,source_kind,source_key,source_version,coverage_digest,fact_digest,coverage_changed,fact_changed,metadata,max_decision_id,created_at) VALUES(11,'platform','old','v','hash1','hash2',1,1,' { "queryId":11 } ',101,' old time ');
    INSERT INTO evidence_impact_progress_113 VALUES(11,101,1);
    INSERT INTO explanation_impact_113(id,enterprise_id,title_code,direction,decision_id,latest_revision_id,pending_since_revision_id,classification) VALUES(12,1,'specialized_sme','missing_in_miit',101,11,11,'review');
    INSERT INTO evidence_review_receipt_114(id,idempotency_key,request_hash,kind,enterprise_id,title_code,direction,decision_id,source_decision_id,reviewed_revision_id,actor,basis,response,recorded_at)
    VALUES(13,'old756',' old hash ','review',1,'specialized_sme','missing_in_miit',101,101,11,' { "type":"agent" } ',' 原始 ',' { "queryId":11 } ',' time ');`)
  for (const table of ['evidence_revision_113', 'evidence_impact_progress_113', 'explanation_impact_113', 'evidence_review_receipt_114', 'difference_reason'])
    expect((t.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n).toBeGreaterThan(0)
  const before = protectedBytes(t)
  const receipts = t.prepare('SELECT * FROM import_receipt ORDER BY id').raw().all()
  const max = (t.prepare('SELECT max(id) n FROM import_receipt').get() as { n: number }).n
  expect(commit(request([command]))).toMatchObject({ status: 'committed', summary: { written: 1 } })
  expect(protectedBytes(t)).toEqual(before)
  expect(t.prepare('SELECT * FROM import_receipt WHERE id<=? ORDER BY id').raw().all(max)).toEqual(receipts)
  expect(t.pragma('foreign_key_check')).toEqual([]); expect(t.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]); noLegacy()
})

it.each(['archive-hash', 'missing-raw-ref', 'relation-alias'] as const)('fails closed on %s material gaps without allocating a supplement', variant => {
  const command = fresh()
  const row = t.prepare("SELECT o.id,r.archive_id FROM platform_business_observation o JOIN platform_legacy_query_alias q ON q.collection_id=o.collection_id JOIN platform_observation_archive_ref r ON r.owner_id=o.id AND r.field='rawFields' WHERE q.old_id=?").get(command.queryId) as { id: number; archive_id: number }
  const table = variant === 'archive-hash' ? 'platform_archive_value' : variant === 'missing-raw-ref' ? 'platform_observation_archive_ref' : 'platform_legacy_relation_alias'
  const barriers = t.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(table) as { name: string }[]
  for (const { name } of barriers) t.exec(`DROP TRIGGER "${name}"`)
  if (variant === 'archive-hash') t.prepare('UPDATE platform_archive_value SET sha256=? WHERE id=?').run('0'.repeat(64), row.archive_id)
  if (variant === 'missing-raw-ref') t.prepare("DELETE FROM platform_observation_archive_ref WHERE owner_id=? AND field='rawFields'").run(row.id)
  if (variant === 'relation-alias') t.prepare('DELETE FROM platform_legacy_relation_alias WHERE observation_id=?').run(row.id)
  const count = t.prepare('SELECT count(*) n FROM platform_archive_value').get()
  expect(() => inspectLegacyPlatformProvenance(db, command)).toThrow(expect.objectContaining({ code: variant === 'relation-alias' ? 'legacy_query_missing' : 'legacy_source_drift' }))
  expect(supplementCount()).toEqual({ n: 0 }); expect(t.prepare('SELECT count(*) n FROM platform_archive_value').get()).toEqual(count)
})

it('executes actual H3 and MCP preflight commit receipt readback and HTTP replay400', async () => {
  const command = fresh(), req = request([command])
  for (const key of ['defineEventHandler', 'getMethod', 'readBody', 'getHeader', 'setResponseStatus', 'setHeader', 'getQuery', 'getRouterParam', 'createError'] as const) vi.stubGlobal(key, h3[key])
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic756', mcpToken: 'synthetic756', filesDir: undefined }))
  vi.spyOn(importExecutor, 'execute').mockImplementation(async (database, action, input, errors, context) => action === 'preflight' ? preflightRosterImport(database, input, errors, context) : commitRosterImport(database, input, errors, { ...context, deferCandidateTasks: true }))
  const router = createRouter()
  for (const action of ['preflight', 'commit', 'replay'] as const) router.post(`/api/roster/import/${action}`, createRosterImportHandler(action))
  router.get('/api/roster/import/receipts', (await import('../server/api/roster/import/receipts/index.get')).default)
  router.get('/api/roster/import/receipts/items', (await import('../server/api/roster/import/receipts/items.get')).default)
  const server = createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected local HTTP port')
  const post = async (action: string, status = 200) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/roster/import/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic756' }, body: JSON.stringify(req) })
    expect(response.status).toBe(status); return response.json()
  }
  try {
    expect(await post('preflight')).toMatchObject({ preflight: { add: 1, conflicts: [] } })
    const result = await post('commit')
    expect(result).toMatchObject({ status: 'committed', summary: { written: 1 } })
    const receipt = await fetch(`http://127.0.0.1:${address.port}/api/roster/import/receipts?idempotencyKey=${req.idempotencyKey}`, { headers: { authorization: 'Bearer synthetic756' } })
    expect(receipt.status).toBe(200); expect(receipt.headers.get('cache-control')).toBe('no-store')
    expect(await receipt.json()).toMatchObject({ status: 'committed', sourceKind: 'platform_archive', itemCount: 1, summary: { written: 1 } })
    const items = await fetch(`http://127.0.0.1:${address.port}/api/roster/import/receipts/items?idempotencyKey=${req.idempotencyKey}`, { headers: { authorization: 'Bearer synthetic756' } })
    expect(items.status).toBe(200)
    expect(await items.json()).toMatchObject({ rows: [{ ok: true, kind: 'platform_legacy_provenance', ref: `query:${command.queryId}` }] })
    expect(await post('commit')).toEqual(result)
    expect(await post('replay', 400)).toEqual({ message: 'Legacy provenance uses preflight/commit with its original idempotency key' })
    const preflight = (await import('../server/mcp/tools/preflight_roster_batch')).default
    const save = (await import('../server/mcp/tools/save_roster_batch')).default
    const next = { ...req, idempotencyKey: 'mcp756', sourceSha256: undefined, payload: { ...req.payload } }
    expect(await preflight.handler(next, {} as never)).toMatchObject({ preflight: { add: 0, conflicts: [] } })
    const saved = await save.handler(next, {} as never)
    expect(saved).toMatchObject({ status: 'committed', summary: { skipped: 1, written: 0 } })
    expect(await save.handler(next, {} as never)).toEqual(saved); noLegacy()
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
