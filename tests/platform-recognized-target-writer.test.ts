import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { upgradeCollections } from '../upgrade/collections'
import { upgradeObservations } from '../upgrade/observations'
import { upgradeProjections } from '../upgrade/projections'
import { finalizeObservations } from '../upgrade/finalize-observations'
import { targetSchema } from '../lib/platform/target-schema'
import { writeRecognizedTarget, type RecognizedTargetInput } from '../lib/platform/recognized-target-writer'

function fixture() {
  const root = mkdtempSync(join(process.env.W3A_EVIDENCE_DIR ?? tmpdir(), 'w3a-'))
  const source = join(root, 'source.sqlite'), target = join(root, 'target.sqlite')
  const sourceDb = new Database(source)
  migrate(drizzle(sourceDb), { migrationsFolder: 'db/migrations' })
  sourceDb.exec("insert into platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) values(1,'apply_list','a','','t','success','c'),(2,'recognized_list','b','','t','success','c');")
  sourceDb.close(); copyFileSync(source, target)
  upgradeCollections({ source, target, runId: 'c', batchSize: 2 })
  upgradeObservations({ source, target, runId: 'o', collectionRunId: 'c', batchSize: 2 })
  upgradeProjections({ source, target, runId: 'p', observationRunId: 'o', collectionRunId: 'c', batchSize: 2 })
  finalizeObservations({ source, target, runId: 'f', projectionRunId: 'p', observationRunId: 'o', collectionRunId: 'c' })
  const statements: string[] = []
  const sqlite = new Database(target, { verbose: text => statements.push(String(text)) }); sqlite.pragma('foreign_keys=ON')
  const db = drizzle(sqlite, { schema: targetSchema })
  const input: RecognizedTargetInput = { collectionId: 2, position: { sequenceNo: 1, positionState: 'unknown' }, row: { sequenceNo: 1, relationKey: ' A ', year: 2017, status: '旧状态', rawFields: { year: 2020, id: 'A', rddqrq: ' 2028-01 ', whpcyear: false, rdjb: ' 2 ', whpc: ' 2026-2 ', szq: ' 鄞州 ', rdxx: ' 原说明 ', qymc: ' 企业 ', tyshxydm: ' CODE ' }, sourceText: '原文\n\u0000' }, assignment: { enterpriseId: null, matchBasis: 'none', verificationStatus: 'pending', origin: 'command', actor: { type: 'agent', id: 'test' }, basis: 'explicit test observation', recordedAt: null } }
  return { sqlite, db, input, statements }
}
it('preserves recognized fidelity separately from normalized fields and legacy year', () => {
  const { db, sqlite, input } = fixture()
  const r = writeRecognizedTarget(db, input)
  expect(sqlite.prepare('select validity_date_raw,maintenance_year,maintenance_batch,district,award_note,title_raw,name_raw,uscc_raw,source_validity_date,source_maintenance_batch,source_maintenance_year_absent from platform_recognized_projection where version_id=?').get(r.versionId)).toEqual({ validity_date_raw: '2028-01', maintenance_year: null, maintenance_batch: '2026-2', district: '鄞州', award_note: '原说明', title_raw: '2', name_raw: '企业', uscc_raw: 'CODE', source_validity_date: ' 2028-01 ', source_maintenance_batch: ' 2026-2 ', source_maintenance_year_absent: 0 })
  expect(sqlite.prepare('select stored_year,parsed_year_kind,parsed_year,reconciled_year,stored_status,parsed_status,status_conflict,reconciled_status from platform_recognized_projection where observation_id=?').get(r.observationId)).toEqual({ stored_year: 2017, parsed_year_kind: 'absent', parsed_year: null, reconciled_year: 2017, stored_status: '旧状态', parsed_status: null, status_conflict: 0, reconciled_status: '旧状态' })
  sqlite.close()
})
it('completes wholly uncaptured verified fidelity without changing version identity hash or normalized fields', () => {
  const { db, sqlite, input } = fixture()
  const first = writeRecognizedTarget(db, input)
  sqlite.exec('update platform_recognized_projection set source_validity_date=NULL,source_maintenance_batch=NULL,source_maintenance_year_absent=NULL where version_id is not null')
  const versions = sqlite.prepare('select * from platform_business_record_version').all()
  const next = writeRecognizedTarget(db, { ...input, position: { sequenceNo: 2, positionState: 'unknown' }, row: { ...input.row, sequenceNo: 2 } })
  expect(next.versionId).toBe(first.versionId)
  expect(sqlite.prepare('select * from platform_business_record_version').all()).toEqual(versions)
  expect(sqlite.prepare('select source_validity_date,source_maintenance_batch,source_maintenance_year_absent from platform_recognized_projection order by id').all()).toEqual([
    { source_validity_date: ' 2028-01 ', source_maintenance_batch: ' 2026-2 ', source_maintenance_year_absent: 0 },
    { source_validity_date: ' 2028-01 ', source_maintenance_batch: ' 2026-2 ', source_maintenance_year_absent: 0 },
    { source_validity_date: ' 2028-01 ', source_maintenance_batch: ' 2026-2 ', source_maintenance_year_absent: 0 },
  ])
  sqlite.close()
})

it('rejects unsafe existing record identity without partial writes', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("insert into platform_business_record(id,interface,platform_key,identity_rule_version,created_at) values(9007199254740993,'recognized_list','A','platform-observation-v1','fixture')")
  const before = sqlite.serialize()
  expect(() => writeRecognizedTarget(db, input)).toThrow('Invalid target identity')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it('rejects unsafe page identity before a rounded lookup can select another page', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("insert into platform_collection_page(id,collection_id,ordinal,position_state) values(9007199254740992,2,1,'unknown')")
  const before = sqlite.serialize()
  expect(() => writeRecognizedTarget(db, { ...input, position: { ...input.position, pageId: 9007199254740992 } })).toThrow('Invalid target identity')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it('isolates equal keys across interfaces and keeps new content versions with explicit confirmed ownership', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("insert into enterprise(id,name,name_norm) values(100,'Owner','owner'); insert into platform_business_record(interface,platform_key,identity_rule_version,created_at) values('apply_list','A','platform-observation-v1','c'); update platform_legacy_alias_sequence set high_water=500 where namespace='relation'")
  const catalog = sqlite.prepare('select type,name,tbl_name,sql from sqlite_schema order by type,name').all()
  const first = writeRecognizedTarget(db, { ...input, assignment: { ...input.assignment, enterpriseId: 100, matchBasis: 'manual', verificationStatus: 'confirmed', recordedAt: 'explicit-time' } })
  const second = writeRecognizedTarget(db, { ...input, position: { sequenceNo: 2, positionState: 'unknown' }, row: { ...input.row, sequenceNo: 2, rawFields: { id: 'A', year: 2029 } } })
  expect(first.relationAlias).toBe(501); expect(second.relationAlias).toBe(502)
  expect(second.recordId).toBe(first.recordId); expect(second.versionId).not.toBe(first.versionId)
  expect(sqlite.prepare('select interface,platform_key from platform_business_record order by interface').all()).toEqual([{ interface: 'apply_list', platform_key: 'A' }, { interface: 'recognized_list', platform_key: 'A' }])
  expect(sqlite.prepare('select enterprise_id,verification_status,recorded_at,origin,revision from platform_observation_assignment where observation_id=?').get(first.observationId)).toEqual({ enterprise_id: 100, verification_status: 'confirmed', recorded_at: 'explicit-time', origin: 'command', revision: 1 })
  expect(sqlite.prepare('select enterprise_id,recorded_at from platform_observation_assignment where observation_id=?').get(second.observationId)).toEqual({ enterprise_id: null, recorded_at: null })
  expect(sqlite.prepare('select type,name,tbl_name,sql from sqlite_schema order by type,name').all()).toEqual(catalog); sqlite.close()
})
it('rejects canonical byte drift on a hash hit without appending an observation', () => {
  const { db, sqlite, input } = fixture()
  writeRecognizedTarget(db, input)
  sqlite.exec("update platform_business_record_version set canonical_raw_json='{}'")
  const before = sqlite.serialize()
  expect(() => writeRecognizedTarget(db, { ...input, position: { sequenceNo: 2, positionState: 'unknown' }, row: { ...input.row, sequenceNo: 2 } })).toThrow('platform_content_hash_conflict')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it.each(['platform_business_record_version', 'platform_version_archive_ref', 'platform_observation_assignment', 'platform_observation_archive_ref', 'platform_recognized_projection', 'platform_legacy_relation_alias'])('rolls back all effects after injected %s failure caught by the outer transaction', table => {
  const { db, sqlite, input } = fixture()
  sqlite.exec(`create trigger inject before insert on ${table} ${table === 'platform_recognized_projection' ? 'when new.observation_id is not null' : ''} begin select raise(abort,'injected'); end`)
  const before = sqlite.serialize()
  db.transaction(tx => { expect(() => writeRecognizedTarget(tx, input)).toThrow('injected') })
  const after = sqlite.serialize()
  for (const offset of [24, 92]) { before.fill(0, offset, offset + 4); after.fill(0, offset, offset + 4) }
  expect(after).toEqual(before); sqlite.close()
})
it('requires explicit provenance and rejects contradictory owner assertions', () => {
  const { db, sqlite, input } = fixture(), before = sqlite.serialize()
  expect(() => writeRecognizedTarget(db, { ...input, assignment: { enterpriseId: null, matchBasis: 'none', verificationStatus: 'pending', origin: 'migrated_current' } })).toThrow('Explicit command provenance required')
  expect(() => writeRecognizedTarget(db, { ...input, row: { ...input.row, enterpriseId: 100 } })).toThrow('Assignment payload conflict')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it('requires the source collection page owner and matching position without creating collections', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("insert into platform_collection_page(id,collection_id,ordinal,position_state) values(10,1,1,'unknown'),(11,2,1,'verified')")
  const before = sqlite.serialize()
  expect(() => writeRecognizedTarget(db, { ...input, collectionId: 1 })).toThrow('Recognized collection owner mismatch')
  expect(() => writeRecognizedTarget(db, { ...input, collectionId: 999 })).toThrow('Recognized collection owner mismatch')
  expect(() => writeRecognizedTarget(db, { ...input, position: { ...input.position, pageId: 10 } })).toThrow('Page collection owner mismatch')
  expect(() => writeRecognizedTarget(db, { ...input, position: { ...input.position, pageRowNo: 1 } })).toThrow('Page row requires page')
  expect(() => writeRecognizedTarget(db, { ...input, position: { ...input.position, sequenceNo: 2 } })).toThrow('Observation position mismatch')
  expect(sqlite.serialize()).toEqual(before)
  const r = writeRecognizedTarget(db, { ...input, position: { sequenceNo: 1, pageId: 11, pageRowNo: 1, positionState: 'verified' } })
  expect(sqlite.prepare('select page_id,page_row_no,position_state from platform_business_observation where id=?').get(r.observationId)).toEqual({ page_id: 11, page_row_no: 1, position_state: 'verified' }); sqlite.close()
})
it.each(['platform_business_record', 'platform_business_record_version', 'platform_archive_value', 'platform_recognized_projection'])('rejects exhausted generated IDs in %s atomically', table => {
  const { db, sqlite, input } = fixture()
  sqlite.prepare('update sqlite_sequence set seq=9007199254740991 where name=?').run(table)
  sqlite.prepare('insert into sqlite_sequence(name,seq) select ?,9007199254740991 where not exists(select 1 from sqlite_sequence where name=?)').run(table, table)
  const before = sqlite.serialize()
  expect(() => writeRecognizedTarget(db, input)).toThrow()
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it('accepts the last safe record ID and rejects distinct keys after exhaustion without identity aliasing', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("insert into sqlite_sequence(name,seq) values('platform_business_record',9007199254740990)")
  const row = (key: string, sequenceNo: number): RecognizedTargetInput => ({ ...input, position: { sequenceNo, positionState: 'unknown' }, row: { sequenceNo, relationKey: key, rawFields: null } })
  const last = writeRecognizedTarget(db, row('LAST', 1))
  expect(last.recordId).toBe(Number.MAX_SAFE_INTEGER)
  expect(writeRecognizedTarget(db, row('LAST', 2)).recordId).toBe(last.recordId)
  const before = sqlite.serialize()
  for (const [index, key] of ['EXHAUST-1', 'EXHAUST-2'].entries()) {
    expect(() => writeRecognizedTarget(db, row(key, index + 3))).toThrow('Invalid target identity')
    expect(sqlite.serialize()).toEqual(before)
  }
  expect(sqlite.prepare('select cast(id as text) id,platform_key from platform_business_record').all()).toEqual([{ id: '9007199254740991', platform_key: 'LAST' }]); sqlite.close()
})
it('allocates the last safe alias and completely rolls back alias exhaustion', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("update platform_legacy_alias_sequence set high_water=9007199254740990 where namespace='relation'")
  const r = writeRecognizedTarget(db, input)
  expect(r.relationAlias).toBe(Number.MAX_SAFE_INTEGER)
  expect(writeRecognizedTarget(db, input)).toEqual({ ...r, reused: true })
  const before = sqlite.serialize()
  expect(() => writeRecognizedTarget(db, { ...input, position: { sequenceNo: 2, positionState: 'unknown' }, row: { ...input.row, sequenceNo: 2 } })).toThrow('Invalid archive identity')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it.each([
  { name: 'collection', patch: { collectionId: 9007199254740992 } },
  { name: 'sequence', patch: { position: { sequenceNo: 9007199254740992, positionState: 'unknown' as const } } },
  { name: 'page-row', patch: { position: { sequenceNo: 1, pageRowNo: 0, positionState: 'unknown' as const } } },
])('rejects invalid input identity $name before writes', ({ patch }) => {
  const { db, sqlite, input } = fixture(), before = sqlite.serialize()
  expect(() => writeRecognizedTarget(db, { ...input, ...patch })).toThrow('Invalid target identity')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})

it('refuses different canonical bytes even when a stored hash is forged to match the incoming payload', () => {
  const { db, sqlite, input } = fixture()
  writeRecognizedTarget(db, input)
  const other = '{"id":"A","year":2029}'
  sqlite.prepare('update platform_business_record_version set content_hash=?').run(createHash('sha256').update('platform-row-json-v1\n'+other).digest('hex'))
  const before = sqlite.serialize()
  expect(() => writeRecognizedTarget(db, { ...input, position: { sequenceNo: 2, positionState: 'unknown' }, row: { sequenceNo: 2, relationKey: 'A', rawFields: { id: 'A', year: 2029 } } })).toThrow('platform_content_hash_conflict')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it('accepts the last safe observation ID and atomically rejects observation exhaustion', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("insert into platform_business_observation(id,collection_id,sequence_no,position_state,identity_state,content_state,indexed_at) values(9007199254740990,2,100,'unknown','not_indexed','not_indexed',NULL)")
  const r = writeRecognizedTarget(db, input)
  expect(r.observationId).toBe(Number.MAX_SAFE_INTEGER)
  const before = sqlite.serialize()
  expect(() => writeRecognizedTarget(db, { ...input, position: { sequenceNo: 2, positionState: 'unknown' }, row: { ...input.row, sequenceNo: 2 } })).toThrow()
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it('rejects unsafe existing version identity before binding a new observation', () => {
  const { db, sqlite, input } = fixture()
  const raw = '{"id":"A"}', hash = createHash('sha256').update('platform-row-json-v1\n'+raw).digest('hex')
  sqlite.exec("insert into platform_business_record(id,interface,platform_key,identity_rule_version,created_at) values(10,'recognized_list','A','platform-observation-v1','fixture')")
  sqlite.prepare("insert into platform_business_record_version(id,record_id,hash_algorithm,content_hash,canonical_raw_json,created_at) values(9007199254740993,10,'platform-row-json-v1',?,?,'fixture')").run(hash, raw)
  const before = sqlite.serialize()
  expect(() => writeRecognizedTarget(db, { ...input, row: { sequenceNo: 1, relationKey: 'A', rawFields: { id: 'A' } } })).toThrow('Invalid target identity')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it.each(['enterpriseId', 'commandReceiptId'] as const)('rejects unsafe explicit assignment %s without writes', field => {
  const { db, sqlite, input } = fixture(), before = sqlite.serialize()
  expect(() => writeRecognizedTarget(db, { ...input, assignment: { ...input.assignment, [field]: 9007199254740992 } })).toThrow('Invalid target identity')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})

it.each([
  { name: 'missing', raw: {}, absent: 1, year: null },
  { name: 'NULL', raw: { whpcyear: null }, absent: 1, year: null },
  { name: 'false', raw: { whpcyear: false }, absent: 0, year: null },
  { name: 'true', raw: { whpcyear: true }, absent: 0, year: null },
  { name: 'empty', raw: { whpcyear: '' }, absent: 1, year: null },
  { name: 'whitespace', raw: { whpcyear: ' ' }, absent: 0, year: null },
  { name: 'padded', raw: { whpcyear: ' 2028 ' }, absent: 0, year: null },
  { name: 'digits', raw: { whpcyear: '2028' }, absent: 0, year: 2028 },
  { name: 'number', raw: { whpcyear: 2028 }, absent: 0, year: 2028 },
  { name: 'zero', raw: { whpcyear: 0 }, absent: 0, year: null },
  { name: 'negative', raw: { whpcyear: -1 }, absent: 0, year: null },
  { name: 'fraction', raw: { whpcyear: 2028.5 }, absent: 0, year: null },
  { name: 'unsafe', raw: { whpcyear: 9007199254740992 }, absent: 0, year: null },
  { name: 'decimal', raw: { whpcyear: '2028.0' }, absent: 0, year: null },
  { name: 'array', raw: { whpcyear: [] }, absent: 0, year: null },
  { name: 'object', raw: { whpcyear: {} }, absent: 0, year: null },
])('retains literal maintenance-year partition $name independently of legacy year', ({ raw, absent, year }) => {
  const { db, sqlite, input } = fixture()
  writeRecognizedTarget(db, { ...input, row: { sequenceNo: 1, year: 2011, relationKey: 'A', rawFields: { id: 'A', year: 2005, ...raw } } })
  expect(sqlite.prepare('select maintenance_year,source_maintenance_year_absent from platform_recognized_projection order by id').all()).toEqual([{ maintenance_year: year, source_maintenance_year_absent: absent }, { maintenance_year: year, source_maintenance_year_absent: absent }])
  expect(sqlite.prepare('select stored_year,parsed_year_kind,parsed_year,reconciled_year,year_conflict from platform_recognized_projection where observation_id is not null').get()).toEqual({ stored_year: 2011, parsed_year_kind: 'absent', parsed_year: null, reconciled_year: 2011, year_conflict: 0 })
  sqlite.close()
})
it.each([
  { name: 'missing', raw: {}, source: null, display: null },
  { name: 'NULL', raw: { rddqrq: null, whpc: null }, source: null, display: null },
  { name: 'false', raw: { rddqrq: false, whpc: false }, source: null, display: null },
  { name: 'empty', raw: { rddqrq: '', whpc: '' }, source: '', display: null },
  { name: 'whitespace', raw: { rddqrq: ' \t', whpc: ' \t' }, source: ' \t', display: null },
  { name: 'padded', raw: { rddqrq: ' 2028 ', whpc: ' 2028 ' }, source: ' 2028 ', display: '2028' },
  { name: 'number', raw: { rddqrq: 2028, whpc: 2028 }, source: null, display: null },
])('retains literal validity and maintenance-batch partition $name without display overwrite', ({ raw, source, display }) => {
  const { db, sqlite, input } = fixture()
  writeRecognizedTarget(db, { ...input, row: { sequenceNo: 1, relationKey: 'A', rawFields: { id: 'A', ...raw } } })
  expect(sqlite.prepare('select validity_date_raw,maintenance_batch,source_validity_date,source_maintenance_batch from platform_recognized_projection order by id').all()).toEqual([
    { validity_date_raw: display, maintenance_batch: display, source_validity_date: source, source_maintenance_batch: source },
    { validity_date_raw: display, maintenance_batch: display, source_validity_date: source, source_maintenance_batch: source },
  ]); sqlite.close()
})
it('keeps uncaptured raw unavailable rather than marking maintenance year absent', () => {
  const { db, sqlite, input } = fixture()
  const r = writeRecognizedTarget(db, { ...input, row: { sequenceNo: 1, relationKey: 'A', rawFields: null } })
  expect(r.versionId).toBeNull()
  expect(sqlite.prepare('select basis,parse_state,source_validity_date,source_maintenance_batch,source_maintenance_year_absent,source_title_kind from platform_recognized_projection').get()).toEqual({ basis: 'unavailable', parse_state: 'absent', source_validity_date: null, source_maintenance_batch: null, source_maintenance_year_absent: null, source_title_kind: 'absent' })
  expect(sqlite.prepare("select storage_class,bytes,byte_length,sha256 from platform_archive_value a join platform_observation_archive_ref r on r.archive_id=a.id where r.field='rawFields'").get()).toEqual({ storage_class: 'null', bytes: null, byte_length: null, sha256: null }); sqlite.close()
})
it.each([
  { name: 'missing', key: null, raw: { whpcyear: false }, state: 'missing_key', keySource: 'none', yearAbsent: 0 },
  { name: 'conflict', key: ' A ', raw: { id: 'B', whpcyear: null }, state: 'conflict', keySource: 'both', yearAbsent: 1 },
  { name: 'empty-key', key: '', raw: { whpcyear: '' }, state: 'missing_key', keySource: 'none', yearAbsent: 1 },
  { name: 'blank-key', key: '  ', raw: { whpcyear: ' ' }, state: 'missing_key', keySource: 'none', yearAbsent: 0 },
])('keeps $name identity raw-only with its own source fidelity', ({ key, raw, state, keySource, yearAbsent }) => {
  const { db, sqlite, input } = fixture()
  const r = writeRecognizedTarget(db, { ...input, row: { sequenceNo: 1, relationKey: key, rawFields: raw } })
  expect(r.recordId).toBeNull(); expect(r.versionId).toBeNull()
  expect(sqlite.prepare('select identity_state,key_source,source_relation_key from platform_business_observation').get()).toEqual({ identity_state: state, key_source: keySource, source_relation_key: key })
  expect(sqlite.prepare('select basis,source_maintenance_year_absent from platform_recognized_projection').get()).toEqual({ basis: 'observation_reconciliation', source_maintenance_year_absent: yearAbsent }); sqlite.close()
})
it('separates every observation stored comparison from shared verified source facts and replays without writes', () => {
  const { db, sqlite, input, statements } = fixture()
  const first = writeRecognizedTarget(db, input), before = sqlite.serialize()
  expect(writeRecognizedTarget(db, input)).toEqual({ ...first, reused: true })
  expect(sqlite.serialize()).toEqual(before)
  for (const changed of [{ ...input, row: { ...input.row, sourceText: 'changed' } }, { ...input, assignment: { ...input.assignment, basis: 'changed' } }, { ...input, row: { ...input.row, year: 2020 } }]) {
    expect(() => writeRecognizedTarget(db, changed)).toThrow('observation_payload_conflict')
    expect(sqlite.serialize()).toEqual(before)
  }
  const next = writeRecognizedTarget(db, { ...input, position: { sequenceNo: 2, positionState: 'unknown' }, row: { ...input.row, sequenceNo: 2, year: 2023, status: '另一次存值' } })
  expect(next.versionId).toBe(first.versionId); expect(next.observationId).not.toBe(first.observationId)
  expect(sqlite.prepare('select stored_status,parsed_status,reconciled_status,status_conflict,stored_year,reconciled_year from platform_recognized_projection where observation_id is not null order by id').all()).toEqual([
    { stored_status: '旧状态', parsed_status: null, reconciled_status: '旧状态', status_conflict: 0, stored_year: 2017, reconciled_year: 2017 },
    { stored_status: '另一次存值', parsed_status: null, reconciled_status: '另一次存值', status_conflict: 0, stored_year: 2023, reconciled_year: 2023 },
  ])
  if (process.env.W3A_EVIDENCE_DIR) writeFileSync(join(process.env.W3A_EVIDENCE_DIR, 'writer-executed-sql.log'), statements.join('\n'))
  expect(statements.filter(sql => /\b(?:platform_query|platform_relation)\b/i.test(sql))).toEqual([])
  expect(sqlite.pragma('foreign_key_check')).toEqual([]); sqlite.close()
})
it.each([
  "source_validity_date='changed'", "source_maintenance_batch='changed'", 'source_maintenance_year_absent=1',
  "source_validity_date='partial',source_maintenance_year_absent=NULL", "source_maintenance_batch='partial',source_maintenance_year_absent=NULL",
  "validity_date_raw='drift'", "maintenance_year=2001", "rule_version='drift'",
])('rejects verified source projection drift %s atomically', mutation => {
  const { db, sqlite, input } = fixture()
  writeRecognizedTarget(db, input)
  sqlite.exec(`update platform_recognized_projection set ${mutation} where version_id is not null`)
  const before = sqlite.serialize()
  expect(() => writeRecognizedTarget(db, { ...input, position: { sequenceNo: 2, positionState: 'unknown' }, row: { ...input.row, sequenceNo: 2 } })).toThrow('recognized_projection_conflict')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it('archives independent literal raw and canonical bytes with unchanged legacy hash and immutable refs', () => {
  const { db, sqlite, input } = fixture()
  const r = writeRecognizedTarget(db, { ...input, row: { sequenceNo: 1, relationKey: 'A', rawFields: { whpcyear: false, id: 'A', rddqrq: ' ', whpc: '' }, sourceText: '原文\n\u0000' } })
  const canonical = '{"id":"A","rddqrq":" ","whpc":"","whpcyear":false}'
  const raw = '{"whpcyear":false,"id":"A","rddqrq":" ","whpc":""}'
  expect(sqlite.prepare('select canonical_raw_json,content_hash,hash_algorithm from platform_business_record_version').get()).toEqual({ canonical_raw_json: canonical, content_hash: createHash('sha256').update('platform-row-json-v1\n'+canonical).digest('hex'), hash_algorithm: 'platform-row-json-v1' })
  expect(sqlite.prepare("select a.bytes,a.byte_length,a.sha256,r.sealed from platform_archive_value a join platform_observation_archive_ref r on r.archive_id=a.id where r.owner_id=? and r.field='rawFields'").get(r.observationId)).toEqual({ bytes: Buffer.from(raw), byte_length: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex'), sealed: 1 })
  expect(sqlite.prepare('select a.bytes,r.sealed from platform_archive_value a join platform_version_archive_ref r on r.archive_id=a.id join platform_business_record_version v on v.canonical_archive_id=a.id where v.id=?').get(r.versionId)).toEqual({ bytes: Buffer.from(canonical), sealed: 1 })
  expect(sqlite.prepare("select a.bytes from platform_archive_value a join platform_observation_archive_ref r on r.archive_id=a.id where r.field='sourceText'").get()).toEqual({ bytes: Buffer.from('原文\n\u0000') })
  expect(() => sqlite.exec("update platform_archive_value set bytes=x'00'")).toThrow()
  expect(() => sqlite.exec('update platform_observation_archive_ref set sealed=0')).toThrow(); sqlite.close()
})
it.each([
  { name: 'number', raw: { rdjb: 2 }, kind: 'number', text: null, number: '2', bool: null, sql: 2, js: '2', display: null },
  { name: 'padded-text', raw: { rdjb: ' 2 ' }, kind: 'text', text: ' 2 ', number: null, bool: null, sql: ' 2 ', js: '', display: '2' },
  { name: 'true', raw: { rdjb: true }, kind: 'boolean', text: null, number: null, bool: 1, sql: 1, js: '', display: null },
  { name: 'false', raw: { rdjb: false }, kind: 'boolean', text: null, number: null, bool: 0, sql: 0, js: '', display: null },
  { name: 'NULL', raw: { rdjb: null }, kind: 'null', text: null, number: null, bool: null, sql: null, js: '', display: null },
  { name: 'missing', raw: {}, kind: 'absent', text: null, number: null, bool: null, sql: null, js: '', display: null },
  { name: 'array', raw: { rdjb: [2] }, kind: 'array', text: null, number: null, bool: null, sql: '[2]', js: '', display: null },
  { name: 'object', raw: { rdjb: {} }, kind: 'object', text: null, number: null, bool: null, sql: '{}', js: '', display: null },
])('retains source title partition $name and independent legacy SQL versus JS inputs', async ({ raw, kind, text, number, bool, sql, js, display }) => {
  const { platformRowTitle } = await import('../lib/platform/row-title')
  const { db, sqlite, input } = fixture()
  const r = writeRecognizedTarget(db, { ...input, row: { sequenceNo: 1, rawFields: { id: 'RAW', ...raw } } })
  expect(sqlite.prepare('select source_title_kind,source_title_text,source_title_number_text,source_title_boolean,title_raw from platform_recognized_projection where observation_id=?').get(r.observationId)).toEqual({ source_title_kind: kind, source_title_text: text, source_title_number_text: number, source_title_boolean: bool, title_raw: display })
  expect(sqlite.prepare("select json_extract(?, '$.rdjb') value").get(JSON.stringify(raw))).toEqual({ value: sql })
  expect(platformRowTitle('1,2', raw)).toBe(js)
  expect(platformRowTitle('3', raw)).toBe('3')
  expect(sqlite.prepare('select source_relation_key,key_source from platform_business_observation').get()).toEqual({ source_relation_key: null, key_source: 'raw_id' }); sqlite.close()
})
it('does not borrow process parsing for any of the seven recognized comparison fields', () => {
  const { db, sqlite, input } = fixture()
  writeRecognizedTarget(db, { ...input, row: { sequenceNo: 1, relationKey: 'A', province: ' stored province ', status: ' stored status ', batch: ' stored batch ', declareKind: ' 未知事项 ', appliedAt: ' stored time ', awardBatchLabel: ' stored label ', year: 2018, rawFields: { id: 'A', szsfmc: 'raw province', cszt: 'raw status', whpc: 'raw batch', sblx: '复核', sqsj: 'raw time', personuuid: 'raw label', year: 2025, whpcyear: 2028 } } })
  const p = sqlite.prepare('select * from platform_recognized_projection where observation_id is not null').get() as Record<string, unknown>
  for (const [field, value] of [['province','stored province'], ['status','stored status'], ['batch','stored batch'], ['declare_kind','未知事项'], ['applied_at','stored time'], ['award_batch_label','stored label'], ['year',2018]]) {
    expect([p[`stored_${field}`],p[`parsed_${field}_kind`],p[`parsed_${field}`],p[`reconciled_${field}`],p[`${field}_conflict`]]).toEqual([value,'absent',null,value,0])
  }
  expect(p.maintenance_year).toBe(2028); expect(p.maintenance_batch).toBe('raw batch'); sqlite.close()
})
it('keeps alias namespaces independent above frozen high water and binds explicit original names', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("update platform_legacy_alias_sequence set high_water=700 where namespace='relation'; update platform_legacy_alias_sequence set high_water=900 where namespace='query'")
  const r = writeRecognizedTarget(db, { ...input, assignment: { ...input.assignment, usccRaw: ' RAW CODE ', nameRaw: ' RAW NAME ', aliasNameRaw: ' OLD NAME ' } })
  expect(r.relationAlias).toBe(701)
  expect(sqlite.prepare('select namespace,high_water from platform_legacy_alias_sequence order by namespace').all()).toEqual([{ namespace: 'query', high_water: 900 }, { namespace: 'relation', high_water: 701 }])
  expect(sqlite.prepare('select uscc_raw,name_raw,alias_name_raw,actor,basis,recorded_at,command_receipt_id from platform_observation_assignment').get()).toEqual({ uscc_raw: ' RAW CODE ', name_raw: ' RAW NAME ', alias_name_raw: ' OLD NAME ', actor: '{"type":"agent","id":"test"}', basis: 'explicit test observation', recorded_at: null, command_receipt_id: null }); sqlite.close()
})
it('rolls back additive fidelity completion when a late observation projection fails', () => {
  const { db, sqlite, input } = fixture()
  writeRecognizedTarget(db, input)
  sqlite.exec("update platform_recognized_projection set source_validity_date=NULL,source_maintenance_batch=NULL,source_maintenance_year_absent=NULL where version_id is not null; create trigger inject before insert on platform_recognized_projection when new.observation_id is not null begin select raise(abort,'late-fidelity'); end")
  const before = sqlite.serialize()
  db.transaction(tx => { expect(() => writeRecognizedTarget(tx, { ...input, position: { sequenceNo: 2, positionState: 'unknown' }, row: { ...input.row, sequenceNo: 2 } })).toThrow('late-fidelity') })
  const after = sqlite.serialize()
  for (const offset of [24, 92]) { before.fill(0, offset, offset + 4); after.fill(0, offset, offset + 4) }
  expect(after).toEqual(before)
  expect(sqlite.prepare('select source_maintenance_year_absent from platform_recognized_projection where version_id is not null').get()).toEqual({ source_maintenance_year_absent: null }); sqlite.close()
})
