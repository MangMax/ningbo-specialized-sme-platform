import { createRuntimeSchema } from '../../../db/create-runtime'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { resolveLegacyReference } from '../../../layers/sme-roster/lib/platform/target-archive'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { targetSchema } from '../../../layers/sme-roster/lib/platform/target-schema'
import { writeNewCollectionTarget, type NewCollectionTargetCommand } from '../../../layers/sme-roster/lib/platform/collection-target-command'
import { platformResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult, PlatformQuerySource } from '../../../layers/sme-roster/lib/platform/live-query'

const owned: {root:string; sqlite:Database.Database}[]=[]
afterEach(()=>{for(const f of owned.splice(0)){if(f.sqlite.open)f.sqlite.close();rmSync(f.root,{recursive:true,force:true})}})
// Copy only a closed schema template; connections and command facts remain per case.
const templateRoot = mkdtempSync(join(tmpdir(), 'collection-command-schema-'))
const templatePath = join(templateRoot, 'native.sqlite')
beforeAll(() => {
  const db = new Database(templatePath)
  try { db.pragma('foreign_keys=ON'); createRuntimeSchema(db) } finally { db.close() }
})
afterAll(() => rmSync(templateRoot, { recursive: true, force: true }))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'w4a-fixture-'))
  const target = join(root, 'target.sqlite')
  copyFileSync(templatePath, target)
  const statements: string[] = []
  const sqlite = new Database(target, { verbose: text => statements.push(String(text)) }); sqlite.pragma('foreign_keys=ON')
  owned.push({root,sqlite});statements.length=0
  return { sqlite, db: drizzle(sqlite, { schema: targetSchema }), statements }
}
function evidence(source: PlatformQuerySource): PlatformLiveQueryResult {
  return { source, status: 'success', effectiveConditions: { name: 'Example', combination: 'and', ...(source === 'businessList' ? { name: undefined, uscc: '91330200712345678A' } : {}) }, titleScope: { mode: source === 'queryList' ? 'source_default' : 'selected', rdjb: source === 'queryList' ? [] : ['2'] }, queriedAt: '2026-11-11T00:00:00Z', completedAt: '2026-11-11T00:01:00Z', rows: [{ id: 'A', qymc: 'Example', rdjb: '2', year: ' 2028 ', whpcyear: 'false' }], dataRows: [{ id: 'A', qymc: 'Example', rdjb: '2', year: ' 2028 ', whpcyear: false }], pages: [{ source, rdjb: source === 'queryList' ? null : '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 } }
}
function command(e: PlatformLiveQueryResult): NewCollectionTargetCommand {
  const query = platformResultToImport(e)
  return { queryText: JSON.stringify(query, null, 2), evidenceText: JSON.stringify(e, null, 1), createdAt: 'creation text', assignments: (query.relations ?? []).map(row => ({ enterpriseId: null, matchBasis: 'none' as const, verificationStatus: 'pending' as const, nameRaw: row.nameRaw ?? null, origin: 'command' as const, actor: { type: 'agent' as const, id: 'w4a' }, basis: 'explicit input', recordedAt: null })) }
}
it.each(['queryList', 'businessList', 'queryBusList'] as const)('executes a complete new %s collection through its accepted source writer', source => {
  const { sqlite, db, statements } = fixture()
  const input = command(evidence(source))
  const result = writeNewCollectionTarget(db, input)
  expect(result.observations).toHaveLength(1)
  expect(sqlite.prepare('select source,evidence_status,completeness,full_range,provenance_state,parse_state from platform_collection').get()).toEqual({ source, evidence_status: 'success', completeness: 'complete', full_range: 1, provenance_state: 'captured', parse_state: 'valid' })
  expect(sqlite.prepare('select sequence_no,page_row_no,position_state from platform_business_observation').all()).toEqual([{ sequence_no: 1, page_row_no: 1, position_state: 'verified' }])
  expect(statements.filter(text => /\b(platform_query|platform_relation)\b/i.test(text))).toEqual([])
  expect(sqlite.pragma('user_version', { simple: true })).toBe(71613)
  expect(sqlite.pragma('foreign_key_check')).toEqual([]); sqlite.close()
})

function changed(input: ReturnType<typeof command>, mutate: (q: import('../../../lib/roster-import-client').RosterImportPlatformQuery) => void) {
  const q = JSON.parse(input.queryText)
  mutate(q)
  return { ...input, queryText: JSON.stringify(q), evidenceText: q.collectionEvidence == null ? null : JSON.stringify(q.collectionEvidence) }
}
function normalizedBytes(sqlite: Database.Database) {
  const bytes = sqlite.serialize()
  for (const offset of [24, 92]) bytes.fill(0, offset, offset + 4)
  return bytes
}
it('preserves complete PK metadata byte archives hashes seals and independent legacy scope SQL', () => {
  const { sqlite, db } = fixture(), input = command(evidence('businessList'))
  const r = writeNewCollectionTarget(db, input)
  expect(sqlite.prepare('select * from platform_collection').get()).toEqual({ id: r.collectionId, interface: 'business_list', query_key: '91330200712345678A', rdjb: '2', title_code: 'specialized_sme', queried_at: '2026-11-11T00:00:00Z', created_at: 'creation text', last_collected_at: null, status: 'success', failure_reason: null, source: 'businessList', evidence_status: 'success', completed_at: '2026-11-11T00:01:00Z', completeness: 'complete', full_range: 1, fetched_count: 1, declared_total: 1, scope_mode: 'selected', provenance_state: 'captured', parse_state: 'valid', rule_version: 'w4a-new-collection-v1', error_code: null, error_message: null, max_requests: 100, max_rows: 5000, max_duration_ms: 60000, page_size: 50, reconcile_slot_state:'miss',reconcile_slot_rule:'legacy-reconcile-slot-v1',reconcile_slot_reason:'legacy_slot_not_complete',reconcile_slot_raw_archive_id:2,reconcile_slot_row_count:1,reconcile_slot_input_sha256:'84108a0279c3d843c8389e34a4a4c88b503d21652d53b41965f972d0f492131f',witness_state:'uncaptured',witness_rule:null,witness_gate:null,witness_archive_id:null,witness_sha256:null,witness_error:null,witness_error_name:null })
  expect(sqlite.prepare('select * from platform_collection_page').all()).toEqual([{ id: 1, collection_id: r.collectionId, ordinal: 0, source: 'businessList', rdjb: '2', page_no: 1, max_page: 1, max_page_present: 1, fetched_count: 1, declared_total: 1, status: 'success', error_code: null, error_message: null, sequence_start: 1, sequence_end: 1, position_state: 'verified' }])
  expect(sqlite.prepare('select * from platform_query_title_scope').all()).toEqual([{ collection_id: r.collectionId, rdjb: '2' }])
  const old = new Database(':memory:')
  migrate(drizzle(old), { migrationsFolder: 'db/migrations' })
  old.prepare("insert into platform_query(interface,query_key,rdjb,queried_at,status,collection_evidence,created_at) values('business_list','91330200712345678A','2','2026-11-11T00:00:00Z','success',?,'creation text')").run(input.evidenceText)
  expect(old.prepare('select rdjb from platform_query_title_scope order by rdjb').all()).toEqual(sqlite.prepare('select rdjb from platform_query_title_scope order by rdjb').all())
  expect(old.prepare('select * from platform_query_title_scope_error').all()).toEqual([])
  old.close()
  const refs = db.select().from(targetSchema.platformCollectionArchiveRef).all()
  expect(refs.map(x => [x.field,x.sealed]).sort()).toEqual([['collectionEvidence',1],['rawResponse',1],['request',1]])
  for (const ref of refs) {
    const a = db.select().from(targetSchema.platformArchiveValue).all().find(x => x.id === ref.archiveId)!
    const expected = ref.field === 'request' ? input.queryText : ref.field === 'collectionEvidence' ? input.evidenceText : null
    expect(a.storageClass).toBe(expected === null ? 'null' : 'text')
    expect(a.bytes).toEqual(expected === null ? null : Buffer.from(expected))
    expect(a.byteLength).toBe(expected === null ? null : Buffer.byteLength(expected))
    expect(a.sha256).toBe(expected === null ? null : createHash('sha256').update(expected).digest('hex'))
  }
  expect(() => sqlite.exec('update platform_collection_archive_ref set sealed=0')).toThrow()
  sqlite.close()
})
it('keeps new collection times and paired aliases while sharing a source version', () => {
  const { sqlite, db } = fixture(), input = command(evidence('queryBusList'))
  const first = writeNewCollectionTarget(db, input)
  const secondInput = changed(input, q => { q.queriedAt = '2026-11-11T00:00:30Z'; q.collectionEvidence!.queriedAt = q.queriedAt })
  const second = writeNewCollectionTarget(db, secondInput)
  expect(first.observations[0]!.versionId).toBe(second.observations[0]!.versionId)
  expect(first.observations[0]!.observationId).not.toBe(second.observations[0]!.observationId)
  expect(resolveLegacyReference(db, { version: 1, kind: 'relation', queryId: first.queryAlias, relationId: second.observations[0]!.relationAlias })).toBeNull()
  expect(resolveLegacyReference(db, { version: 1, kind: 'relation', queryId: second.queryAlias, relationId: second.observations[0]!.relationAlias })).toEqual({ version: 2, kind: 'observation', collectionId: second.collectionId, observationId: second.observations[0]!.observationId })
  const before = normalizedBytes(sqlite)
  expect(() => writeNewCollectionTarget(db, input)).toThrow('collection_already_exists')
  expect(normalizedBytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true)
  sqlite.close()
})
it.each(['no_record','failed','auth_failed','not_queried'] as const)('retains %s collection without observations and separates evidence status from query status', status => {
  const { sqlite, db } = fixture(), e = evidence('queryBusList')
  e.rows = []; e.dataRows = []; e.fetchedCount = 0; e.declaredTotal = status === 'no_record' ? 0 : null; e.status = status
  e.completeness = status === 'no_record' ? 'complete' : status === 'not_queried' ? 'not_queried' : 'partial'
  e.unfinished = status === 'no_record' ? [] : [{ source: e.source, rdjb: '2', page: 1 }]
  e.error = status === 'failed' || status === 'auth_failed' ? { code: 'upstream_failed', message: '原错误\n' } : null
  e.pages = status === 'not_queried' ? [] : [{ source: e.source, rdjb: '2', page: 1, fetchedCount: 0, declaredTotal: e.declaredTotal, status: status === 'no_record' ? 'success' : status, error: e.error }]
  const r = writeNewCollectionTarget(db, command(e))
  expect(r.observations).toEqual([])
  expect(sqlite.prepare('select status,evidence_status,completeness,error_message from platform_collection').get()).toEqual({ status: status === 'auth_failed' ? 'failed' : status, evidence_status: status, completeness: e.completeness, error_message: e.error?.message ?? null })
  expect(sqlite.prepare('select ordinal,rdjb,page_no from platform_collection_unfinished').all()).toEqual(status === 'no_record' ? [] : [{ ordinal: 0, rdjb: '2', page_no: 1 }])
  expect(sqlite.prepare('select sequence_start,sequence_end from platform_collection_page').all()).toEqual(status === 'not_queried' ? [] : [{ sequence_start: null, sequence_end: null }]); sqlite.close()
})
it('keeps multi title page ordinals zero pages and missing maxPage separately', () => {
  const { sqlite, db } = fixture(), e = evidence('queryBusList')
  e.titleScope.rdjb = ['3','2']; e.pages = [{ source: e.source, rdjb: '3', page: 1, fetchedCount: 0, declaredTotal: 0, status: 'success', error: null }, { ...e.pages[0]!, rdjb: '2' }]
  const r = writeNewCollectionTarget(db, command(e))
  expect(sqlite.prepare('select ordinal,rdjb,max_page,sequence_start,sequence_end from platform_collection_page order by ordinal').all()).toEqual([{ ordinal: 0, rdjb: '3', max_page: null, sequence_start: null, sequence_end: null }, { ordinal: 1, rdjb: '2', max_page: 1, sequence_start: 1, sequence_end: 1 }])
  expect(sqlite.prepare('select page_id from platform_business_observation').get()).toEqual({ page_id: 2 })
  expect(r.observations).toHaveLength(1); sqlite.close()
})
it('preserves absent metadata as unknown and rawResponse bytes without inventing positions limits or completeness', () => {
  const { sqlite, db } = fixture()
  const r = writeNewCollectionTarget(db, { queryText: '{"interface":"apply_list","queryKey":"legacy","queriedAt":"time","status":"success","rawResponse":"原文\\n ","relations":[{"sequenceNo":1,"rawFields":null}]}', evidenceText: null, createdAt: 'c', assignments: command(evidence('queryList')).assignments.map(a=>({...a,nameRaw:null})) })
  expect(r.observations).toHaveLength(1)
  expect(sqlite.prepare('select source,completeness,provenance_state,parse_state,full_range,page_size,fetched_count from platform_collection').get()).toEqual({ source: null, completeness: 'unknown', provenance_state: 'unknown', parse_state: 'absent', full_range: null, page_size: null, fetched_count: null })
  expect(sqlite.prepare('select page_id,page_row_no,position_state from platform_business_observation').get()).toEqual({ page_id: null, page_row_no: null, position_state: 'unknown' })
  expect(sqlite.prepare('select distinct value_kind,text_value,integer_value from platform_collection_condition').all()).toEqual([{ value_kind: 'absent', text_value: null, integer_value: null }])
  expect(sqlite.prepare("select cast(a.bytes as text) bytes from platform_archive_value a join platform_collection_archive_ref r on r.archive_id=a.id where field='rawResponse'").get()).toEqual({ bytes: '原文\n ' }); sqlite.close()
})
it.each([{ label: 'null', value: null }, { label: 'integer', value: 4 }, { label: 'real', value: 1.5 }, { label: 'boolean', value: true }, { label: 'array', value: [] }, { label: 'object', value: {} }, { label: 'invalid-text', value: 'bad' }])('rejects invalid original condition partition $label without normalization or writes', ({ value }) => {
  const { sqlite, db } = fixture(), input = command(evidence('queryBusList'))
  const q = JSON.parse(input.queryText); q.collectionEvidence.effectiveConditions.whpcyear = value
  const before = normalizedBytes(sqlite)
  expect(() => writeNewCollectionTarget(db, { ...input, queryText: JSON.stringify(q), evidenceText: JSON.stringify(q.collectionEvidence) })).toThrow()
  expect(normalizedBytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true); sqlite.close()
})
it.each(['duplicate-page','wrong-source','wrong-position','missing-row','reordered-raw','bad-metadata','missing-evidence','reference','unsafe-sequence','assignment-conflict','evidence-bytes'] as const)('rejects %s before any collection fact survives', kind => {
  const { sqlite, db } = fixture(), input = command(evidence('queryBusList'))
  const q = JSON.parse(input.queryText)
  if (kind === 'duplicate-page') q.collectionEvidence.pages.push(q.collectionEvidence.pages[0])
  if (kind === 'wrong-source') q.collectionEvidence.pages[0].source = 'businessList'
  if (kind === 'wrong-position') q.collectionEvidence.pages[0].page = 2
  if (kind === 'missing-row') q.relations = []
  if (kind === 'reordered-raw') q.relations[0].rawFields = { id: 'B' }
  if (kind === 'bad-metadata') delete q.collectionEvidence.completedAt
  if (kind === 'missing-evidence') delete q.collectionEvidence
  if (kind === 'reference') q.reuseExisting = true
  if (kind === 'unsafe-sequence') q.relations[0].sequenceNo = Number.MAX_SAFE_INTEGER + 1
  if (kind === 'assignment-conflict') q.relations[0].enterpriseId = 100
  const before = normalizedBytes(sqlite)
  expect(() => writeNewCollectionTarget(db, { ...input, queryText: JSON.stringify(q), evidenceText: kind === 'evidence-bytes' ? '{}' : q.collectionEvidence ? JSON.stringify(q.collectionEvidence) : null })).toThrow()
  expect(normalizedBytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true); sqlite.close()
})
it.each(['platform_collection','platform_collection_page','platform_collection_condition','platform_collection_archive_ref','platform_query_title_scope','platform_legacy_query_alias','platform_legacy_relation_alias'])('rolls back the complete command after %s failure even when outer caller catches', table => {
  const { sqlite, db } = fixture()
  sqlite.exec(`create trigger inject before insert on ${table} begin select raise(abort,'injected'); end`)
  const before = normalizedBytes(sqlite)
  db.transaction(tx => { expect(() => writeNewCollectionTarget(tx, command(evidence('queryBusList')))).toThrow('injected') })
  expect(normalizedBytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true); sqlite.close()
})
it.each(['query','relation'] as const)('rejects exhausted %s namespace without partial collection or other namespace advancement', namespace => {
  const { sqlite, db } = fixture()
  sqlite.prepare('update platform_legacy_alias_sequence set high_water=9007199254740991 where namespace=?').run(namespace)
  const before = normalizedBytes(sqlite)
  expect(() => writeNewCollectionTarget(db, command(evidence('queryList')))).toThrow()
  expect(normalizedBytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true); sqlite.close()
})
it.each(['platform_collection','platform_collection_page','platform_archive_value','platform_business_observation','platform_business_record_version'] as const)('rejects exhausted generated %s ID atomically', table => {
  const { sqlite, db } = fixture()
  if (table === 'platform_business_observation') {
    const guards=sqlite.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='platform_business_observation' AND sql LIKE '%BEFORE INSERT%'").all() as {name:string;sql:string}[]
    for(const guard of guards)sqlite.exec('DROP TRIGGER "'+guard.name+'"')
    sqlite.exec("insert into platform_collection(interface,query_key,rdjb,queried_at,created_at,status,completeness,provenance_state,parse_state,rule_version) values('apply_list','occupied','','t','c','success','unknown','unknown','absent','fixture'); insert into platform_business_observation(id,collection_id,sequence_no,identity_state,content_state,position_state) values(9007199254740991,1,1,'not_indexed','not_indexed','unknown')")
    for(const guard of guards)sqlite.exec(guard.sql)
  }
  else sqlite.prepare('insert into sqlite_sequence(name,seq) values(?,9007199254740991)').run(table)
  const before = normalizedBytes(sqlite)
  expect(() => writeNewCollectionTarget(db, command(evidence('queryList')))).toThrow()
  expect(normalizedBytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true); sqlite.close()
})
it.each([0,71605])('refuses non-native phase %s and preserves the target', phase => {
  const { sqlite, db } = fixture(); sqlite.pragma(`user_version=${phase}`)
  const before = normalizedBytes(sqlite)
  expect(() => writeNewCollectionTarget(db, command(evidence('queryList')))).toThrow('Final native platform schema required')
  expect(normalizedBytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true); sqlite.close()
})
it('rejects unsafe source projection IDs at command boundary after source writer insertion', () => {
  const { sqlite, db } = fixture()
  writeNewCollectionTarget(db, command(evidence('queryBusList')))
  sqlite.exec("update platform_recognized_projection set id=9007199254740991 where version_id is not null")
  const facts = () => sqlite.prepare("select name from sqlite_schema where type='table' order by name").all().map(row => {
    const { name } = row as { name: string }
    return { name, rows: sqlite.prepare(`select * from "${name}"`).all() }
  })
  const before = facts()
  const input = changed(command(evidence('queryBusList')), q => { q.queriedAt = '2026-11-11T00:00:30Z'; q.collectionEvidence!.queriedAt = q.queriedAt })
  expect(() => writeNewCollectionTarget(db, input)).toThrow('platform_recognized_projection_id_ck')
  expect(facts()).toEqual(before); sqlite.close()
})
it('uses current import USCC normalization for explicit ownership while preserving observed whitespace', () => {
  const { sqlite, db } = fixture(), e = evidence('queryBusList')
  e.rows[0]!.tyshxydm = '91330200\u200b712345678A'; e.dataRows![0]!.tyshxydm = e.rows[0]!.tyshxydm
  sqlite.exec("insert into enterprise(id,name,name_norm,uscc_norm) values(100,'Example','example','91330200712345678A')")
  const input = command(e)
  input.assignments[0] = { ...input.assignments[0]!, enterpriseId: 100, matchBasis: 'uscc', verificationStatus: 'confirmed' }
  const result = writeNewCollectionTarget(db, input)
  expect(sqlite.prepare('select enterprise_id,revision from platform_observation_assignment').all()).toEqual([{ enterprise_id: 100, revision: 1 }])
  expect(result.observations).toHaveLength(1); sqlite.close()
})
it('stores all permitted condition names as exact text and absent names distinctly', () => {
  const { sqlite, db } = fixture(), e = evidence('queryBusList')
  e.effectiveConditions = { name: 'Example', uscc: '91330200712345678A', combination: 'and', sqsj: '2026/01/01 - 2026/11/11', rddqrq: '2028', whpcyear: '2026', whpc: '2', szq: '12345678', orderField: 'qymc', orderDirection: 'asc' }
  writeNewCollectionTarget(db, command(e))
  expect(sqlite.prepare('select name,value_kind,text_value,integer_value from platform_collection_condition order by name').all()).toEqual([
    ['combination','and'],['name','Example'],['orderDirection','asc'],['orderField','qymc'],['rddqrq','2028'],['sqsj','2026/01/01 - 2026/11/11'],['szq','12345678'],['uscc','91330200712345678A'],['whpc','2'],['whpcyear','2026'],
  ].map(([name,text_value]) => ({ name, value_kind: 'text', text_value, integer_value: null })))
  sqlite.close()
})
it('retains two original rows and catches reordering identity drift against independent original row order', () => {
  const { sqlite, db } = fixture(), e = evidence('queryList')
  e.rows.push({ id: 'B', qymc: 'Second', rdjb: '3', year: '', whpcyear: '' }); e.dataRows!.push({ id: 'B', qymc: 'Second', rdjb: '3', year: null, whpcyear: null })
  e.fetchedCount = 2; e.declaredTotal = 2; e.pages[0]!.fetchedCount = 2; e.pages[0]!.declaredTotal = 2
  const input = command(e), r = writeNewCollectionTarget(db, input)
  expect(sqlite.prepare('select sequence_no,page_row_no,source_relation_key from platform_business_observation order by sequence_no').all()).toEqual([{ sequence_no: 1, page_row_no: 1, source_relation_key: 'A' }, { sequence_no: 2, page_row_no: 2, source_relation_key: 'B' }])
  const bad = changed(input, q => { q.relations!.reverse() })
  expect(() => writeNewCollectionTarget(db, bad)).toThrow('Relation sequence/raw fields/identity mismatch')
  expect(r.observations[0]!.recordId).not.toBe(r.observations[1]!.recordId); sqlite.close()
})
it.each(['apply_list','business_list'] as const)('rejects legacy null-raw reference sentinel for %s instead of fabricating a new collection', interfaceName => {
  const { sqlite, db } = fixture()
  const before = normalizedBytes(sqlite)
  expect(() => writeNewCollectionTarget(db, { queryText: JSON.stringify({ interface: interfaceName, queryKey: 'reference', queriedAt: 'time', relations: [] }), evidenceText: null, assignments: [], createdAt: 'c' })).toThrow('reference reuse is deferred')
  expect(normalizedBytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true); sqlite.close()
})
it('accepts rawData response evidence without rewriting source body types array order NULL or whitespace', () => {
  const { sqlite, db } = fixture(), e = evidence('queryBusList')
  const body = ' {"zrarData":{"grid":{"businessGrid":{"page":1,"pageSize":50,"maxCount":1,"maxPage":1,"pageSet":[{"id":"A","qymc":"Example","rdjb":"2","year":" 2028 ","whpcyear":false,"extra":[null," ",2]}]}}}}\n'
  e.rows[0]!.extra = '[null," ",2]'
  e.rawData = { version: 1, rows: [{ ...e.dataRows![0]!, extra: [null,' ',2] }], pages: [{ source: e.source, rdjb: '2', page: 1, format: 'json', body }] }
  delete e.dataRows
  const input = command(e)
  writeNewCollectionTarget(db, input)
  const archived = sqlite.prepare("select cast(a.bytes as text) bytes from platform_archive_value a join platform_collection_archive_ref r on r.archive_id=a.id where field='collectionEvidence'").get() as { bytes: string }
  expect(archived.bytes).toBe(input.evidenceText)
  expect(JSON.parse(archived.bytes).rawData.pages[0].body).toBe(body)
  expect(sqlite.prepare('select source_maintenance_year_absent from platform_recognized_projection where observation_id is not null').get()).toEqual({ source_maintenance_year_absent: 0 })
  sqlite.close()
})
it.each(['queryList','businessList','queryBusList'] as const)('rolls back collection and alias after %s source writer terminal failure', source => {
  const { sqlite, db } = fixture()
  sqlite.exec("create trigger inject_source before insert on platform_legacy_relation_alias begin select raise(abort,'source-terminal'); end")
  const before = normalizedBytes(sqlite)
  db.transaction(tx => { expect(() => writeNewCollectionTarget(tx, command(evidence(source)))).toThrow('source-terminal') })
  expect(normalizedBytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true); sqlite.close()
})
it('keeps query failure reason independent of top-level collection error and preserves unfinished title order', () => {
  const { sqlite, db } = fixture(), e = evidence('businessList')
  e.titleScope.rdjb = ['1','2','3']; e.status = 'partial'; e.completeness = 'partial'; e.declaredTotal = null
  e.pages[0]!.rdjb = '1'; e.unfinished = [{ source: e.source, rdjb: '3', page: 1 }, { source: e.source, rdjb: '2', page: 1 }]
  e.error = { code: 'safety_limit', message: 'source error' }
  const input = changed(command(e), q => { q.failureReason = 'query reason' })
  writeNewCollectionTarget(db, input)
  expect(sqlite.prepare('select status,evidence_status,failure_reason,error_code,error_message from platform_collection').get()).toEqual({ status: 'partial', evidence_status: 'partial', failure_reason: 'query reason', error_code: 'safety_limit', error_message: 'source error' })
  expect(sqlite.prepare('select ordinal,rdjb,page_no from platform_collection_unfinished order by ordinal').all()).toEqual([{ ordinal: 0, rdjb: '3', page_no: 1 }, { ordinal: 1, rdjb: '2', page_no: 1 }])
  expect(sqlite.prepare('select source_title_text from platform_business_projection where observation_id is not null').get()).toEqual({ source_title_text: '2' })
  sqlite.close()
})

it('accepts original title-wide custom query keys without typed rows or a subject', () => {
  const { sqlite, db } = fixture()
  const e = evidence('queryBusList')
  e.effectiveConditions = { combination: 'and' }
  delete e.dataRows
  const input = changed(command(e), q => { q.queryKey = 'synthetic-title-wide-archive' })
  writeNewCollectionTarget(db, input)
  expect(sqlite.prepare('select query_key from platform_collection').get()).toEqual({ query_key: 'synthetic-title-wide-archive' })
  sqlite.close()
})
it.each(['queryList', 'businessList'] as const)('rejects fresh %s stored raw conflicts with complete rollback', source => {
  const { sqlite, db } = fixture()
  const e = evidence(source)
  e.rows[0]!.cszt = '终审通过'
  e.dataRows![0]!.cszt = '终审通过'
  const input = changed(command(e), q => { q.relations![0]!.status = '退回' })
  const before = normalizedBytes(sqlite)
  db.transaction(tx => { expect(() => writeNewCollectionTarget(tx, input)).toThrow('platform_field_conflict') })
  expect(normalizedBytes(sqlite).equals(before), 'database bytes remain unchanged').toBe(true)
  sqlite.close()
})
