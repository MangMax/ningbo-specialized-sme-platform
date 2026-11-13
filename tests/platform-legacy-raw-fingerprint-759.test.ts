import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { upgradeCollections } from '../upgrade/collections'
import { upgradeObservations, rowSnapshot } from '../upgrade/observations'
import { upgradeProjections } from '../upgrade/projections'
import { finalizeObservations, finalizeCollectionScopes } from '../upgrade/finalize-observations'
import { finalizeFingerprintBasis } from '../upgrade/fingerprint-basis'
import { finalizeApplyStored } from '../upgrade/apply-stored'
import { finalizeCandidateScopes } from '../upgrade/candidate-scope'
import { finalizeRecognizedStored } from '../upgrade/recognized-stored'
import { finalizeRecognizedWitness } from '../upgrade/recognized-witness'
import { finalizeProcessStored } from '../upgrade/process-stored'
import { transferCorrespondence } from '../upgrade/correspondence'
import { transferDifferenceReferences } from '../upgrade/difference-references'
import { indexLegacyProvenance } from '../upgrade/legacy-provenance'
import { preflightRosterImport, commitRosterImport } from '../server/utils/roster-import'
import { inspectLegacyPlatformProvenance } from '../server/utils/platform-legacy-provenance'
import { originalLegacyProvenanceInput } from '../lib/platform/legacy-provenance-command'
import { readPlatformQueryEvidence } from '../lib/platform/evidence-read'
import { assertExpandRuntime } from '../db/schema-phase'
import type { LegacyPlatformCollection, LegacyPlatformProvenanceInput } from '../lib/platform/legacy-provenance'
import type { RosterImportRequest } from '../lib/roster-import-client'
import { ensurePlatformObservation, readPlatformObservationPlan } from '../server/utils/platform-business-record'
import { legacyFingerprintInput, verifyFingerprint } from '../lib/platform/fingerprint-verifier'

vi.mock('@db', () => ({ useDb: () => { throw new Error('No global database in #759') } }))
const root = mkdtempSync(join(process.env.ISSUE759_EVIDENCE ?? tmpdir(), 'raw759-'))
afterAll(() => { if (!process.env.ISSUE759_EVIDENCE) rmSync(root, { recursive: true, force: true }) })
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const rawText = ' { "id":"new756", "rdjb":"2", "qymc":" Alpha ", "blank":"", "value":"🙂" } \n'
const rawRow = { id: 'new756', rdjb: '2', qymc: ' Alpha ', blank: '', value: '🙂' }
const originalDigest = '3dca93cd8caf7260b177d11e5d18d51c4be9d5e273620725edf5f64d1a781016'
const collection: LegacyPlatformCollection = {
  source: 'businessList', status: 'success', effectiveConditions: { uscc: '9133020078041158X6', combination: 'and' },
  titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-11-13T09:00:00Z', completedAt: '2026-11-14T04:00:00Z',
  rows: [rawRow], pages: [{ source: 'businessList', rdjb: '2', page: 1, fetchedCount: 1, declaredTotal: 1, status: 'success', error: null }],
  fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
  limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 },
}
const command: LegacyPlatformProvenanceInput = {
  queryId: 101, interface: 'business_list', queryKey: '9133020078041158X6', rdjb: '2', queriedAt: collection.queriedAt,
  sourceIdentity: 'review old BLOB source', sourceSha256: 'b'.repeat(64), segmentIndex: 3, collection,
  relations: [{ sequenceNo: 1, relationKey: 'new756', rawFields: rawRow }],
}
function request(key: string): RosterImportRequest {
  return { sourceKind: 'platform_archive', sourceIdentity: 'review old source', idempotencyKey: key,
    payload: { platformLegacyProvenance: [command] } }
}
function copy(source: string, destination: string) { copyFileSync(source, destination); chmodSync(destination, 0o600); return destination }
function schema0(name: string) {
  const path = join(root, name + '.sqlite')
  if (process.env.ISSUE759_SOURCE) return copy(process.env.ISSUE759_SOURCE, path)
  const old = new Database(path)
  try {
    migrate(drizzle(old), { migrationsFolder: 'db/migrations' })
    old.exec("INSERT INTO title(code,name_zh,level,rank) VALUES('innovative_sme','创新型中小企业','municipal',1),('specialized_sme','专精特新中小企业','municipal',2),('little_giant','小巨人','national',3)")
    old.prepare("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,raw_response,created_at) VALUES(101,'business_list','9133020078041158X6','2',?,'success',' raw ',' source time ')").run(collection.queriedAt)
    old.prepare("INSERT INTO platform_relation(id,query_id,sequence_no,relation_key,raw_fields,created_at) VALUES(1101,101,1,'new756',?,'rowtime')").run(Buffer.from(rawText))
  } finally { old.close() }
  chmodSync(path, 0o600)
  return path
}
function complete(source: string, name: string) {
  const target = copy(source, join(root, name + '-target.sqlite'))
  const checkpoint = (version: string) => copy(target, join(root, name + '-' + version + '.sqlite'))
  const opts = { source, target, collectionRunId: 'c', observationRunId: 'o', projectionRunId: 'p', finalizationRunId: 'f', batchSize: 10 }
  upgradeCollections({ ...opts, runId: 'c' })
  upgradeObservations({ ...opts, runId: 'o' })
  upgradeProjections({ ...opts, runId: 'p' })
  finalizeObservations({ ...opts, runId: 'f' })
  finalizeCollectionScopes({ ...opts, runId: 'scopes' })
  finalizeFingerprintBasis({ source: checkpoint('71606'), target, runId: 'basis', predecessorRunId: 'scopes', legacySource: source })
  finalizeApplyStored({ source: checkpoint('71607'), target, runId: 'stored', predecessorRunId: 'basis', legacySource: source })
  finalizeCandidateScopes({ source: checkpoint('71608'), target, runId: 'candidate', predecessorRunId: 'stored' })
  finalizeRecognizedStored({ source: checkpoint('candidate'), target, runId: 'recognized', predecessorRunId: 'candidate' })
  finalizeRecognizedWitness({ source: checkpoint('recognized'), target, runId: 'witness', predecessorRunId: 'recognized' })
  finalizeProcessStored({ source: checkpoint('71609'), target, runId: 'process', predecessorRunId: 'witness', legacySource: source })
  transferCorrespondence({ source: checkpoint('71610'), target, runId: 'correspondence' })
  transferDifferenceReferences({ source: checkpoint('71611'), target, runId: 'difference' })
  const predecessor = checkpoint('71612')
  indexLegacyProvenance({ source: predecessor, target, runId: 'provenance', batchSize: 2 })
  return { target, predecessor }
}
const historyTables = ['record_correspondence', 'difference_reason', 'evidence_revision_113', 'evidence_impact_progress_113',
  'explanation_impact_113', 'evidence_review_receipt_114', 'import_receipt']
function tableBytes(t: Database.Database, tables: string[]) {
  return tables.map(table => {
    const columns = t.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]
    if (!columns.length) throw new Error('Missing protected table ' + table)
    return [table, t.prepare(`SELECT ${columns.flatMap(c => [`typeof("${c.name}")`, `hex(cast("${c.name}" AS blob))`]).join(',')} FROM "${table}" ORDER BY rowid`).raw().all()]
  })
}
function orderedOriginal(old: Database.Database) {
  const query = old.prepare('SELECT id,interface,query_key queryKey,rdjb,title_code titleCode,queried_at queriedAt,last_collected_at lastCollectedAt,status,failure_reason failureReason,raw_response rawResponse,collection_evidence collectionEvidence,created_at createdAt FROM platform_query WHERE id=101').get()
  return JSON.stringify({ query, rows: [{ id: 1101, sequenceNo: 1, relationKey: 'new756', rawFields: rawRow, rawBytes: Buffer.from(rawText) }] })
}

it('migrates the frozen schema0 BLOB through complete71613 and preserves the old command receipt replay and generic exact evidence', () => {
  const source = schema0('frozen')
  const old = new Database(copy(source, join(root, 'old-coordinator.sqlite')))
  const frozen = new Database(source, { readonly: true })
  old.pragma('foreign_keys=ON')
  const oldDb = drizzle(old, { schema })
  try {
    expect(frozen.pragma('user_version', { simple: true })).toBe(0)
    expect(frozen.prepare('SELECT typeof(raw_fields) storage,raw_fields bytes FROM platform_relation WHERE id=1101').get())
      .toEqual({ storage: 'blob', bytes: Buffer.from(rawText) })
    const ordered = orderedOriginal(frozen)
    expect(hash(ordered)).toBe(originalDigest)
    expect(inspectLegacyPlatformProvenance(oldDb, command)).toMatchObject({ exists: false, inputFingerprint: originalDigest })
    const oldPreflight = preflightRosterImport(oldDb, request('old759'))
    expect(oldPreflight.preflight).toMatchObject({ add: 1, conflicts: [], platformLegacyProvenanceSources: [{ inputFingerprint: originalDigest }] })
    const oldResult = commitRosterImport(oldDb, request('old759'), [], { deferCandidateTasks: true })
    expect(oldResult).toMatchObject({ status: 'committed', summary: { written: 1 } })
    expect(commitRosterImport(oldDb, request('old759'), [], { deferCandidateTasks: true })).toEqual(oldResult)
    expect(rowSnapshot(old, 'platform_relation', 'id', 1101)).toEqual(rowSnapshot(frozen, 'platform_relation', 'id', 1101))
    writeFileSync(join(root, 'old-normal-oracle.json'), JSON.stringify({ ordered, digest: originalDigest, oldPreflight, oldResult }, null, 2))

    const originalHistory = tableBytes(frozen, historyTables)
    const migrated = complete(source, 'frozen')
    const statements: string[] = []
    const t = new Database(migrated.target, { verbose: sql => statements.push(String(sql)) })
    t.pragma('foreign_keys=ON')
    const db = drizzle(t, { schema })
    try {
      expect(t.pragma('user_version', { simple: true })).toBe(71613)
      expect(tableBytes(t, historyTables)).toEqual(originalHistory)
      expect(t.prepare('SELECT old_id,collection_id FROM platform_legacy_query_alias WHERE old_id=101').get()).toEqual({ old_id: 101, collection_id: 101 })
      expect(t.prepare('SELECT old_id,observation_id FROM platform_legacy_relation_alias WHERE old_id=1101').get()).toEqual({ old_id: 1101, observation_id: 1101 })
      expect(t.prepare("SELECT a.storage_class,a.bytes FROM platform_observation_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.owner_id=1101 AND r.field='rawFields'").get())
        .toEqual({ storage_class: 'blob', bytes: Buffer.from(rawText) })
      const restored = originalLegacyProvenanceInput(db, 101)
      expect(JSON.stringify({ query: restored.query, rows: restored.rows })).toBe(ordered)
      const protectedTables = ['platform_collection', 'platform_collection_archive_ref', 'platform_collection_page',
        'platform_collection_condition', 'platform_business_observation', 'platform_observation_assignment',
        'platform_observation_fingerprint_basis', 'platform_business_record_version', ...historyTables]
      const before = tableBytes(t, protectedTables)
      statements.length = 0
      expect(preflightRosterImport(db, request('target759')).preflight).toEqual(oldPreflight.preflight)
      const result = commitRosterImport(db, request('target759'), [], { deferCandidateTasks: true })
      expect(result).toMatchObject({ status: 'committed', summary: { written: 1 } })
      expect(result.items).toEqual(oldResult.items)
      expect(commitRosterImport(db, request('target759'), [], { deferCandidateTasks: true })).toEqual(result)
      expect(commitRosterImport(db, request('skip759'), [], { deferCandidateTasks: true })).toMatchObject({ status: 'committed', summary: { written: 0, skipped: 1 } })
      const evidence = readPlatformQueryEvidence(db, { queryId: 101, field: 'legacyProvenance', offset: 0, length: 65536 })
      expect('data' in evidence).toBe(true)
      if (!('data' in evidence)) throw new Error('Expected exact evidence')
      expect(Buffer.from(evidence.data, 'base64')).toEqual(Buffer.from(JSON.stringify(collection)))
      const relation = readPlatformQueryEvidence(db, { queryId: 101, relationId: 1101, field: 'relation', offset: 0, length: 65536 })
      expect('data' in relation).toBe(true)
      if (!('data' in relation)) throw new Error('Expected raw evidence')
      expect(relation).toEqual(readPlatformQueryEvidence(oldDb, { queryId: 101, relationId: 1101, field: 'relation', offset: 0, length: 65536 }))
      expect(JSON.parse(Buffer.from(relation.data, 'base64').toString()).rawFields).toEqual(rawRow)
      // New receipt rows are allowed; every existing historical cell is protected.
      expect(tableBytes(t, protectedTables.filter(n => !n.startsWith('import_receipt')))).toEqual(before.filter(([n]) => typeof n === 'string' && !n.startsWith('import_receipt')))
      expect(statements.filter(sql => /\b(?:from|join|insert into|update|delete from)\s+["`]?platform_(?:query|relation|query_legacy_provenance)["`]?(?=\s|$|\()/i.test(sql))).toEqual([])
      expect(() => assertExpandRuntime(t)).toThrow()
      expect(t.pragma('foreign_key_check')).toEqual([])
      expect(t.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      const postWrites = tableBytes(t, [...protectedTables, 'platform_collection_legacy_provenance', 'platform_archive_value'])
      writeFileSync(join(root, 'normal-composed.json'), JSON.stringify({ state: 'complete71613', originalDigest, oldResult, result, evidence, relation, postWrites }, null, 2))
      t.close()
      expect(indexLegacyProvenance({ source: migrated.predecessor, target: migrated.target, runId: 'provenance', batchSize: 2 })).toMatchObject({ state: 'complete' })
      const replay = new Database(migrated.target, { readonly: true })
      try { expect(tableBytes(replay, [...protectedTables, 'platform_collection_legacy_provenance', 'platform_archive_value'])).toEqual(postWrites) }
      finally { replay.close() }
    } finally { if (t.open) t.close() }
  } finally { old.close(); frozen.close() }
}, 120000)

describe('authenticated original fingerprint cells', () => {
  const values = [
    rawText, Buffer.from(rawText), null, 'null', ' 42 \n', Buffer.from(' false \n'),
    ' "🙂\\u0000" \n', Buffer.from(' [1,"🙂",null] \n'),
    ' { "value":"🙂", "blank":"", "qymc":" Alpha ", "rdjb":"2", "id":"new756" } \n',
  ]
  let baseline: string, corpusSource: string
  let expected: { id: number; queryId: number; fingerprint: string; bytes: unknown; storage: string; hex: string; rawFields: unknown }[]
  let protectedHistory: ReturnType<typeof tableBytes>
  beforeAll(() => {
    corpusSource = schema0('corpus-source')
    const old = new Database(corpusSource)
    old.pragma('foreign_keys=ON')
    const oldDb = drizzle(old, { schema })
    try {
      expected = values.map((value, index) => {
        const queryId = index + 102, id = index + 1102
        old.prepare("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(?,'business_list','Q','2',?,'success',' c ')").run(queryId, `2026-11-13T10:00:0${index}Z`)
        old.prepare("INSERT INTO platform_relation(id,query_id,sequence_no,relation_key,raw_fields,created_at) VALUES(?,?,1,'new756',?,' c ')").run(id, queryId, value)
        const driver = old.prepare('SELECT typeof(raw_fields) storage,hex(cast(raw_fields AS blob)) hex,raw_fields bytes FROM platform_relation WHERE id=?').get(id) as { storage: string; hex: string; bytes: string | Buffer | null }
        // This is the actual original service, evaluated before migration or the new decoder.
        const rawFields: unknown = driver.bytes === null ? null : JSON.parse(String(driver.bytes))
        const fingerprint = readPlatformObservationPlan(oldDb, id).inputFingerprint
        ensurePlatformObservation(oldDb, id)
        return { id, queryId, fingerprint, ...driver, rawFields }
      })
      // Non-empty original histories and receipts make preservation assertions substantive.
      oldDb.insert(schema.enterprise).values({ id: 1, name: 'Alpha', nameNorm: 'Alpha', usccNorm: 'U1' }).run()
      oldDb.insert(schema.recordCorrespondence).values({ enterpriseId: 1, titleCode: 'specialized_sme', relationId: 1102,
        edgeKey: 'edge759', type: 'event_process', role: 'candidate', status: 'rejected', revision: 1,
        targetIdentity: { queryId: 102 }, provenance: { raw: ' 原始 \n' }, sourceFingerprint: ' original fingerprint ',
        ruleId: 'rule', ruleVersion: 'v', createdAt: ' c ' }).run()
      oldDb.insert(schema.differenceReason).values({ id: 101, enterpriseId: 1, titleCode: 'specialized_sme', direction: 'missing_in_miit',
        status: 'needs_review', evidenceQueryId: 102, evidenceRelationId: 1102, requestHash: ' original hash ',
        basis: ' { "queryId":102 } ', recordedAt: 't' }).run()
      old.exec(`INSERT INTO evidence_revision_113(id,source_kind,source_key,source_version,coverage_digest,fact_digest,coverage_changed,fact_changed,metadata,max_decision_id,created_at) VALUES(11,'platform','old','v','coverage','facts',1,1,' { "queryId":102 } ',101,' old time ');
        INSERT INTO evidence_impact_progress_113 VALUES(11,101,1);
        INSERT INTO explanation_impact_113(id,enterprise_id,title_code,direction,decision_id,latest_revision_id,pending_since_revision_id,classification) VALUES(12,1,'specialized_sme','missing_in_miit',101,11,11,'review');
        INSERT INTO evidence_review_receipt_114(id,idempotency_key,request_hash,kind,enterprise_id,title_code,direction,decision_id,source_decision_id,reviewed_revision_id,actor,basis,response,recorded_at)
        VALUES(13,'old759',' original hash ','review',1,'specialized_sme','missing_in_miit',101,101,11,' { "type":"agent" } ',' 原始 ',' { "queryId":102 } ',' time ');`)
      expect(commitRosterImport(oldDb, request('historical759'), [], { deferCandidateTasks: true })).toMatchObject({ status: 'committed', summary: { written: 1 } })
      for (const table of historyTables) expect((old.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, table).toBeGreaterThan(0)
      protectedHistory = tableBytes(old, historyTables)
      writeFileSync(join(root, 'corpus-original-driver.json'), JSON.stringify({ expected, protectedHistory }, null, 2))
    } finally { old.close() }
    baseline = complete(corpusSource, 'corpus').target
    chmodSync(baseline, 0o400)
  })
  function writable(name: string) {
    const t = new Database(copy(baseline, join(root, name + '.sqlite')))
    t.pragma('foreign_keys=ON')
    return t
  }
  it('preserves indexed TEXT BLOB NULL scalar whitespace UTF8 order and distinct observations sharing one version', () => {
    const t = new Database(baseline, { readonly: true })
    try {
      expect(t.pragma('user_version', { simple: true })).toBe(71613)
      expect(tableBytes(t, historyTables)).toEqual(protectedHistory)
      for (const original of expected) {
        const observation = t.prepare('SELECT id,input_fingerprint,projection_rule_version FROM platform_business_observation WHERE id=?').get(original.id)
        expect(observation).toEqual({ id: original.id, input_fingerprint: original.fingerprint, projection_rule_version: 'platform-observation-v1' })
        const basis = t.prepare('SELECT b.scheme,a.bytes,a.sha256 FROM platform_observation_fingerprint_basis b JOIN platform_archive_value a ON a.id=b.input_archive_id WHERE b.observation_id=?').get(original.id) as { scheme: string; bytes: Buffer; sha256: string }
        expect(basis.scheme).toBe('legacy-indexed-v1')
        expect(hash(basis.bytes)).toBe(original.fingerprint)
        expect(basis.sha256).toBe(original.fingerprint)
        const owner = { observationId: original.id, collectionId: original.queryId, relationAlias: original.id }
        expect(legacyFingerprintInput(t, owner).rawFields).toEqual(original.rawFields)
        expect(verifyFingerprint(t, owner)).toEqual({ scheme: 'legacy-indexed-v1', observationId: original.id })
        const archived = t.prepare("SELECT a.storage_class storage,hex(a.bytes) hex FROM platform_observation_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.owner_id=? AND r.field='rawFields'").get(original.id)
        expect(archived).toEqual({ storage: original.storage, hex: original.hex })
        expect(t.prepare('SELECT old_id,observation_id FROM platform_legacy_relation_alias WHERE old_id=?').get(original.id)).toEqual({ old_id: original.id, observation_id: original.id })
      }
      const shared = t.prepare('SELECT id,record_id,version_id,input_fingerprint FROM platform_business_observation WHERE id IN (1102,1103,1110) ORDER BY id').all() as { id: number; record_id: number; version_id: number; input_fingerprint: string }[]
      expect(new Set(shared.map(o => o.id)).size).toBe(3)
      expect(new Set(shared.map(o => o.record_id)).size).toBe(1)
      expect(new Set(shared.map(o => o.version_id)).size).toBe(1)
      expect(shared[0]!.version_id).not.toBeNull()
      expect(new Set(shared.map(o => o.input_fingerprint)).size).toBe(3)
      // Literal canonical input independently pins the original observation hash grammar.
      const literal = '{"interface":"business_list","invalidRaw":null,"queriedAt":"2026-11-13T10:00:00Z","queryId":102,"queryKey":"Q","rawFields":{"blank":"","id":"new756","qymc":" Alpha ","rdjb":"2","value":"🙂"},"rdjb":"2","relationKey":"new756","sequenceNo":1}'
      expect(expected[0]!.fingerprint).toBe(hash(literal))
      expect(t.pragma('foreign_key_check')).toEqual([])
      expect(t.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      writeFileSync(join(root, 'corpus-preserved.json'), JSON.stringify({ expected, shared, protectedHistory }, null, 2))
    } finally { t.close() }
  })
  it.each(['missing-raw', 'tampered-hash', 'snapshot-disagrees', 'missing-snapshot', 'malformed-json-blob', 'undecodable-blob', 'json-null-blob'] as const)(
    'refuses %s original material without changing fingerprints or histories', variant => {
      const t = writable(variant)
      try {
        const before = tableBytes(t, ['platform_business_observation', 'platform_observation_fingerprint_basis', ...historyTables])
        const tables = ['platform_archive_value', 'platform_observation_archive_ref']
        for (const table of tables) {
          const barriers = t.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(table) as { name: string }[]
          for (const { name } of barriers) t.exec(`DROP TRIGGER "${name}"`)
        }
        const archive = t.prepare("SELECT archive_id id FROM platform_observation_archive_ref WHERE owner_id=1103 AND field='rawFields'").get() as { id: number }
        if (variant === 'missing-raw') t.exec("DELETE FROM platform_observation_archive_ref WHERE owner_id=1103 AND field='rawFields'")
        if (variant === 'tampered-hash') t.prepare('UPDATE platform_archive_value SET sha256=? WHERE id=?').run('0'.repeat(64), archive.id)
        if (variant === 'missing-snapshot') t.exec("DELETE FROM platform_observation_archive_ref WHERE owner_id=1103 AND field='legacyRowSnapshot'")
        if (variant === 'snapshot-disagrees') {
          const bytes = Buffer.from('{"id":"changed"}')
          t.prepare('UPDATE platform_archive_value SET bytes=?,byte_length=?,sha256=? WHERE id=?').run(bytes, bytes.length, hash(bytes), archive.id)
        }
        if (variant === 'malformed-json-blob' || variant === 'undecodable-blob' || variant === 'json-null-blob') {
          const bytes = variant === 'malformed-json-blob' ? Buffer.from('{ malformed ')
            : variant === 'json-null-blob' ? Buffer.from(' null \n') : Buffer.from([0xff, 0xfe, 0x00])
          t.prepare('UPDATE platform_archive_value SET bytes=?,byte_length=?,sha256=? WHERE id=?').run(bytes, bytes.length, hash(bytes), archive.id)
          const snapshot = t.prepare("SELECT a.id,a.bytes FROM platform_observation_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.owner_id=1103 AND r.field='legacyRowSnapshot'").get() as { id: number; bytes: Buffer }
          const cells = JSON.parse(snapshot.bytes.toString()) as { fields: { name: string; hex: string }[] }
          cells.fields.find(c => c.name === 'raw_fields')!.hex = bytes.toString('hex')
          const snapshotBytes = Buffer.from(JSON.stringify(cells))
          t.prepare('UPDATE platform_archive_value SET bytes=?,byte_length=?,sha256=? WHERE id=?').run(snapshotBytes, snapshotBytes.length, hash(snapshotBytes), snapshot.id)
          // Authenticated matching cells still cannot invent an original fingerprint for a
          // value the old canonical serializer refuses.
          const driver = new Database(copy(corpusSource, join(root, variant + '-old.sqlite')))
          try {
            driver.prepare('UPDATE platform_relation SET raw_fields=? WHERE id=1103').run(bytes)
            expect(() => readPlatformObservationPlan(drizzle(driver, { schema }), 1103)).toThrow('platform_raw_not_json')
          } finally { driver.close() }
        }
        const owner = { observationId: 1103, collectionId: 103, relationAlias: 1103 }
        const reason = variant === 'missing-raw' ? 'Legacy archive owner inventory conflict'
          : variant === 'tampered-hash' ? 'Legacy archive source conflict'
            : variant === 'snapshot-disagrees' ? 'Legacy original bytes conflict'
              : variant === 'missing-snapshot' ? 'Legacy cells missing' : 'platform_raw_not_json'
        expect(() => legacyFingerprintInput(t, owner)).toThrow(reason)
        expect(() => verifyFingerprint(t, owner)).toThrow(reason)
        expect(tableBytes(t, ['platform_business_observation', 'platform_observation_fingerprint_basis', ...historyTables])).toEqual(before)
      } finally { t.close() }
    })
})
