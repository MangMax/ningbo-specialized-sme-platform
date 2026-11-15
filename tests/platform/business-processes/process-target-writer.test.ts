import { createRuntimeSchema } from '../../../db/create-runtime'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { targetSchema } from '../../../lib/platform/target-schema'
import { writeProcessTarget, type ProcessTargetInput } from '../../../lib/platform/process-target-writer'

function fixture() {
  const root = mkdtempSync(join(process.env.W2A_EVIDENCE_DIR ?? tmpdir(), 'w2a-'))
  const target = join(root, 'target.sqlite')
  const statements: string[] = []
  const sqlite = new Database(target, { verbose: text => statements.push(String(text)) }); sqlite.pragma('foreign_keys=ON')
  createRuntimeSchema(sqlite)
  sqlite.exec("INSERT INTO platform_collection(id,interface,query_key,rdjb,queried_at,created_at,status,completeness,provenance_state,parse_state,rule_version) VALUES(1,'apply_list','a','','t','c','success','unknown','unknown','absent','fixture'),(2,'business_list','b','','t','c','success','unknown','unknown','absent','fixture')")
  sqlite.exec("INSERT INTO platform_legacy_query_alias(old_id,collection_id) VALUES(1,1),(2,2); UPDATE platform_legacy_alias_sequence SET high_water=2 WHERE namespace='query'")
  statements.length=0
  const db = drizzle(sqlite, { schema: targetSchema })
  const input: ProcessTargetInput = { collectionId: 2, position: { sequenceNo: 1, positionState: 'unknown' }, row: { sequenceNo: 1, relationKey: ' A ', status: '退回', rawFields: { year: ' 2028 ', id: 'A', cszt: '终审通过', rdjb: ' 2 ', personuuid: ' 第四批 ', whpc: ' 2026-2 ', sblx: ' 复核 ' }, sourceText: '原文\n\u0000' }, assignment: { enterpriseId: null, matchBasis: 'none', verificationStatus: 'pending', origin: 'command', actor: { type: 'agent', id: 'test' }, basis: 'explicit test observation', recordedAt: null } }
  return { sqlite, db, input, statements }
}
it('keeps business year whitespace unknown while preserving process fields and observation reconciliation', () => {
  const { db, sqlite, input } = fixture()
  const result = writeProcessTarget(db, input)
  expect(sqlite.prepare('select business_year,declare_kind,award_batch_label,batch,status from platform_business_projection where version_id=?').get(result.versionId)).toEqual({ business_year: null, declare_kind: 'review', award_batch_label: '第四批', batch: '2026-2', status: '终审通过' })
  expect(sqlite.prepare('select parsed_year,reconciled_year,stored_status,parsed_status,status_conflict,reconciled_status,source_title_text from platform_business_projection where observation_id=?').get(result.observationId)).toEqual({ parsed_year: 2028, reconciled_year: 2028, stored_status: null, parsed_status: '终审通过', status_conflict: 0, reconciled_status: '终审通过', source_title_text: ' 2 ' })
  sqlite.close()
})
it('rejects unsafe existing record identity without partial writes', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("insert into platform_business_record(id,interface,platform_key,identity_rule_version,created_at) values(9007199254740993,'business_list','A','platform-observation-v1','fixture')")
  const before = sqlite.serialize()
  expect(() => writeProcessTarget(db, input)).toThrow('Invalid target identity')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it('rejects unsafe page identity before a rounded lookup can select another page', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("insert into platform_collection_page(id,collection_id,ordinal,position_state) values(9007199254740992,2,1,'unknown')")
  const before = sqlite.serialize()
  expect(() => writeProcessTarget(db, { ...input, position: { ...input.position, pageId: 9007199254740992 } })).toThrow('Invalid target identity')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it.each(['identical replay', 'source drift', 'assignment drift'] as const)('handles %s at an existing observation position atomically', scenario => {
  const { db, sqlite, input } = fixture()
  const first = writeProcessTarget(db, input), before = sqlite.serialize()
  if (scenario === 'identical replay') expect(writeProcessTarget(db, input)).toEqual({ ...first, reused: true })
  else {
    const changed = scenario === 'source drift'
      ? { ...input, row: { ...input.row, sourceText: 'changed' } }
      : { ...input, assignment: { ...input.assignment, basis: 'changed' } }
    expect(() => writeProcessTarget(db, changed)).toThrow('observation_payload_conflict')
  }
  expect(sqlite.serialize()).toEqual(before)
  expect(sqlite.pragma('foreign_key_check')).toEqual([]); sqlite.close()
})
it('reuses a version across independent observations', () => {
  const { db, sqlite, input, statements } = fixture()
  const first = writeProcessTarget(db, input)
  const second = writeProcessTarget(db, { ...input, position: { sequenceNo: 2, positionState: 'unknown' }, row: { ...input.row, sequenceNo: 2, status: '终审通过' } })
  expect(second.recordId).toBe(first.recordId); expect(second.versionId).toBe(first.versionId); expect(second.observationId).not.toBe(first.observationId)
  expect(sqlite.prepare('select status_conflict,reconciled_status from platform_business_projection where observation_id is not null order by observation_id').all()).toEqual([{ status_conflict: 0, reconciled_status: '终审通过' }, { status_conflict: 0, reconciled_status: '终审通过' }])
  expect(statements.filter(sql => /\b(?:platform_query|platform_relation)\b/i.test(sql))).toEqual([])
  expect(sqlite.pragma('foreign_key_check')).toEqual([]); sqlite.close()
})
it('isolates equal keys across interfaces and keeps new content versions with explicit confirmed ownership', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("insert into enterprise(id,name,name_norm) values(100,'Owner','owner'); insert into platform_business_record(interface,platform_key,identity_rule_version,created_at) values('apply_list','A','platform-observation-v1','c'); update platform_legacy_alias_sequence set high_water=500 where namespace='relation'")
  const catalog = sqlite.prepare('select type,name,tbl_name,sql from sqlite_schema order by type,name').all()
  const first = writeProcessTarget(db, { ...input, assignment: { ...input.assignment, enterpriseId: 100, matchBasis: 'manual', verificationStatus: 'confirmed', recordedAt: 'explicit-time' } })
  const second = writeProcessTarget(db, { ...input, position: { sequenceNo: 2, positionState: 'unknown' }, row: { ...input.row, sequenceNo: 2, rawFields: { id: 'A', year: 2029 } } })
  expect(first.relationAlias).toBe(501); expect(second.relationAlias).toBe(502)
  expect(second.recordId).toBe(first.recordId); expect(second.versionId).not.toBe(first.versionId)
  expect(sqlite.prepare('select interface,platform_key from platform_business_record order by interface').all()).toEqual([{ interface: 'apply_list', platform_key: 'A' }, { interface: 'business_list', platform_key: 'A' }])
  expect(sqlite.prepare('select enterprise_id,verification_status,recorded_at,origin,revision from platform_observation_assignment where observation_id=?').get(first.observationId)).toEqual({ enterprise_id: 100, verification_status: 'confirmed', recorded_at: 'explicit-time', origin: 'command', revision: 1 })
  expect(sqlite.prepare('select enterprise_id,recorded_at from platform_observation_assignment where observation_id=?').get(second.observationId)).toEqual({ enterprise_id: null, recorded_at: null })
  expect(sqlite.prepare('select type,name,tbl_name,sql from sqlite_schema order by type,name').all()).toEqual(catalog); sqlite.close()
})
it.each([
  { name: 'missing', relationKey: null, raw: { year: true }, identity: 'missing_key', keySource: 'none' },
  { name: 'conflicting', relationKey: ' A ', raw: { id: 'B', year: true }, identity: 'conflict', keySource: 'both' },
])('keeps $name identity as an independent raw-only observation', ({ relationKey, raw, identity, keySource }) => {
  const { db, sqlite, input } = fixture()
  const r = writeProcessTarget(db, { ...input, row: { sequenceNo: 1, relationKey, rawFields: raw } })
  expect(r.recordId).toBeNull(); expect(r.versionId).toBeNull()
  expect(sqlite.prepare('select identity_state,content_state,key_source,source_relation_key from platform_business_observation').get()).toEqual({ identity_state: identity, content_state: 'unverifiable', key_source: keySource, source_relation_key: relationKey?.trim() ?? null })
  expect(sqlite.prepare('select business_year,parsed_year_kind,basis from platform_business_projection').get()).toEqual({ business_year: null, parsed_year_kind: 'boolean', basis: 'observation_reconciliation' }); sqlite.close()
})
it.each([
  { name: 'number', year: 2028, expected: 2028 }, { name: 'digits', year: '2028', expected: 2028 },
  { name: 'blank', year: ' ', expected: null }, { name: 'boolean', year: false, expected: null },
  { name: 'array', year: [], expected: null }, { name: 'object', year: {}, expected: null },
  { name: 'fraction', year: 2028.5, expected: null }, { name: 'negative', year: -1, expected: null },
  { name: 'decimal-text', year: '2028.0', expected: null }, { name: 'exponent-text', year: '2e3', expected: null },
  { name: 'null', year: null, expected: null }, { name: 'unsafe', year: 9007199254740992, expected: null },
])('preserves literal business year partition $name', ({ name, year, expected }) => {
  const { db, sqlite, input } = fixture()
  // Legacy process reconciliation cannot represent unsafe integer years; fail without normalization.
  const before = sqlite.serialize()
  if (name === 'unsafe') {
    expect(() => writeProcessTarget(db, { ...input, row: { sequenceNo: 1, relationKey: 'A', rawFields: { id: 'A', year } } })).toThrow('Unrepresentable reconcile integer')
    expect(sqlite.serialize()).toEqual(before)
  } else {
    writeProcessTarget(db, { ...input, row: { sequenceNo: 1, relationKey: 'A', rawFields: { id: 'A', year } } })
    expect(sqlite.prepare('select business_year from platform_business_projection order by id').all()).toEqual([{ business_year: expected }, { business_year: expected }])
  }
  sqlite.close()
})
it('keeps absent raw content unavailable and missing source fields unknown', () => {
  const { db, sqlite, input } = fixture()
  const r = writeProcessTarget(db, { ...input, row: { sequenceNo: 1, relationKey: 'A', rawFields: null } })
  expect(r.recordId).not.toBeNull(); expect(r.versionId).toBeNull()
  expect(sqlite.prepare('select basis,parse_state,business_year,source_title_kind,parsed_year_kind from platform_business_projection').get()).toEqual({ basis: 'unavailable', parse_state: 'absent', business_year: null, source_title_kind: 'absent', parsed_year_kind: 'absent' })
  expect(sqlite.prepare("select storage_class,bytes,byte_length,sha256 from platform_archive_value a join platform_observation_archive_ref r on r.archive_id=a.id where r.field='rawFields'").get()).toEqual({ storage_class: 'null', bytes: null, byte_length: null, sha256: null }); sqlite.close()
})
it('archives literal raw and canonical bytes hashes refs and source text immutably', () => {
  const { db, sqlite, input } = fixture()
  const r = writeProcessTarget(db, { ...input, row: { sequenceNo: 1, relationKey: 'A', rawFields: { year: ' 2028 ', id: 'A', personuuid: false, whpc: ' ' }, sourceText: '原文\n\u0000' } })
  const canonical = '{"id":"A","personuuid":false,"whpc":" ","year":" 2028 "}'
  expect(sqlite.prepare('select canonical_raw_json,content_hash,hash_algorithm from platform_business_record_version').get()).toEqual({ canonical_raw_json: canonical, content_hash: createHash('sha256').update('platform-row-json-v1\n'+canonical).digest('hex'), hash_algorithm: 'platform-row-json-v1' })
  const raw = '{"year":" 2028 ","id":"A","personuuid":false,"whpc":" "}'
  expect(sqlite.prepare('select a.bytes,a.byte_length,a.sha256,r.sealed from platform_archive_value a join platform_observation_archive_ref r on r.archive_id=a.id where r.owner_id=? and r.field=\'rawFields\'').get(r.observationId)).toEqual({ bytes: Buffer.from(raw), byte_length: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex'), sealed: 1 })
  expect(sqlite.prepare("select a.bytes,r.sealed from platform_archive_value a join platform_version_archive_ref r on r.archive_id=a.id join platform_business_record_version v on v.canonical_archive_id=a.id where v.id=?").get(r.versionId)).toEqual({ bytes: Buffer.from(canonical), sealed: 1 })
  expect(sqlite.prepare("select a.bytes from platform_archive_value a join platform_observation_archive_ref r on r.archive_id=a.id where r.field='sourceText'").get()).toEqual({ bytes: Buffer.from('原文\n\u0000') })
  expect(() => sqlite.exec('update platform_archive_value set bytes=x\'00\'')).toThrow()
  expect(() => sqlite.exec('update platform_observation_archive_ref set sealed=0')).toThrow(); sqlite.close()
})
it('rejects canonical byte drift on a hash hit without appending an observation', () => {
  const { db, sqlite, input } = fixture()
  writeProcessTarget(db, input)
  sqlite.exec("update platform_business_record_version set canonical_raw_json='{}'")
  const before = sqlite.serialize()
  expect(() => writeProcessTarget(db, { ...input, position: { sequenceNo: 2, positionState: 'unknown' }, row: { ...input.row, sequenceNo: 2 } })).toThrow('platform_content_hash_conflict')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it.each(['platform_business_record_version', 'platform_version_archive_ref', 'platform_observation_assignment', 'platform_observation_archive_ref', 'platform_business_projection', 'platform_legacy_relation_alias'])('rolls back all effects after injected %s failure caught by the outer transaction', table => {
  const { db, sqlite, input } = fixture()
  sqlite.exec(`create trigger inject before insert on ${table} ${table === 'platform_business_projection' ? 'when new.observation_id is not null' : ''} begin select raise(abort,'injected'); end`)
  const before = sqlite.serialize()
  db.transaction(tx => { expect(() => writeProcessTarget(tx, input)).toThrow('injected') })
  const after = sqlite.serialize()
  for (const offset of [24, 92]) { before.fill(0, offset, offset + 4); after.fill(0, offset, offset + 4) }
  expect(after).toEqual(before); sqlite.close()
})
it('requires explicit provenance and rejects contradictory owner assertions', () => {
  const { db, sqlite, input } = fixture(), before = sqlite.serialize()
  expect(() => writeProcessTarget(db, { ...input, assignment: { enterpriseId: null, matchBasis: 'none', verificationStatus: 'pending', origin: 'migrated_current' } })).toThrow('Explicit command provenance required')
  expect(() => writeProcessTarget(db, { ...input, row: { ...input.row, enterpriseId: 100 } })).toThrow('Assignment payload conflict')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it('requires the source collection page owner and matching position without creating collections', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("insert into platform_collection_page(id,collection_id,ordinal,position_state) values(10,1,1,'unknown'),(11,2,1,'verified')")
  const before = sqlite.serialize()
  expect(() => writeProcessTarget(db, { ...input, collectionId: 1 })).toThrow('Process collection owner mismatch')
  expect(() => writeProcessTarget(db, { ...input, collectionId: 999 })).toThrow('Process collection owner mismatch')
  expect(() => writeProcessTarget(db, { ...input, position: { ...input.position, pageId: 10 } })).toThrow('Page collection owner mismatch')
  expect(() => writeProcessTarget(db, { ...input, position: { ...input.position, pageRowNo: 1 } })).toThrow('Page row requires page')
  expect(() => writeProcessTarget(db, { ...input, position: { ...input.position, sequenceNo: 2 } })).toThrow('Observation position mismatch')
  expect(sqlite.serialize()).toEqual(before)
  const r = writeProcessTarget(db, { ...input, position: { sequenceNo: 1, pageId: 11, pageRowNo: 1, positionState: 'verified' } })
  expect(sqlite.prepare('select page_id,page_row_no,position_state from platform_business_observation where id=?').get(r.observationId)).toEqual({ page_id: 11, page_row_no: 1, position_state: 'verified' }); sqlite.close()
})
it.each(['platform_business_record', 'platform_business_record_version', 'platform_archive_value', 'platform_business_projection'])('rejects exhausted generated IDs in %s atomically', table => {
  const { db, sqlite, input } = fixture()
  sqlite.prepare('update sqlite_sequence set seq=9007199254740991 where name=?').run(table)
  sqlite.prepare('insert into sqlite_sequence(name,seq) select ?,9007199254740991 where not exists(select 1 from sqlite_sequence where name=?)').run(table, table)
  const before = sqlite.serialize()
  expect(() => writeProcessTarget(db, input)).toThrow()
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it('allocates the last safe record ID and reuses it for the same key', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("insert into sqlite_sequence(name,seq) values('platform_business_record',9007199254740990)")
  const row = (key: string, sequenceNo: number): ProcessTargetInput => ({ ...input, position: { sequenceNo, positionState: 'unknown' }, row: { sequenceNo, relationKey: key, rawFields: null } })
  const last = writeProcessTarget(db, row('LAST', 1))
  expect(last.recordId).toBe(Number.MAX_SAFE_INTEGER)
  expect(writeProcessTarget(db, row('LAST', 2)).recordId).toBe(last.recordId)
  sqlite.close()
})
it('atomically rejects a distinct key when record IDs are exhausted', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("insert into platform_business_record(id,interface,platform_key,identity_rule_version,created_at) values(9007199254740991,'business_list','LAST','platform-observation-v1','fixture')")
  const before = sqlite.serialize()
  expect(() => writeProcessTarget(db, { ...input, row: { ...input.row, relationKey: 'EXHAUST', rawFields: null } })).toThrow('Invalid target identity')
  expect(sqlite.serialize()).toEqual(before)
  expect(sqlite.prepare('select cast(id as text) id,platform_key from platform_business_record').all()).toEqual([{ id: '9007199254740991', platform_key: 'LAST' }]); sqlite.close()
})
it('allocates the last safe alias and completely rolls back alias exhaustion', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("update platform_legacy_alias_sequence set high_water=9007199254740990 where namespace='relation'")
  const r = writeProcessTarget(db, input)
  expect(r.relationAlias).toBe(Number.MAX_SAFE_INTEGER)
  expect(writeProcessTarget(db, input)).toEqual({ ...r, reused: true })
  const before = sqlite.serialize()
  expect(() => writeProcessTarget(db, { ...input, position: { sequenceNo: 2, positionState: 'unknown' }, row: { ...input.row, sequenceNo: 2 } })).toThrow('Invalid archive identity')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it.each([
  { name: 'collection', patch: { collectionId: 9007199254740992 } },
  { name: 'sequence', patch: { position: { sequenceNo: 9007199254740992, positionState: 'unknown' as const } } },
  { name: 'page-row', patch: { position: { sequenceNo: 1, pageRowNo: 0, positionState: 'unknown' as const } } },
])('rejects invalid input identity $name before writes', ({ patch }) => {
  const { db, sqlite, input } = fixture(), before = sqlite.serialize()
  expect(() => writeProcessTarget(db, { ...input, ...patch })).toThrow('Invalid target identity')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})

it('refuses different canonical bytes even when a stored hash is forged to match the incoming payload', () => {
  const { db, sqlite, input } = fixture()
  writeProcessTarget(db, input)
  const other = '{"id":"A","year":2029}'
  sqlite.prepare('update platform_business_record_version set content_hash=?').run(createHash('sha256').update('platform-row-json-v1\n'+other).digest('hex'))
  const before = sqlite.serialize()
  expect(() => writeProcessTarget(db, { ...input, position: { sequenceNo: 2, positionState: 'unknown' }, row: { sequenceNo: 2, relationKey: 'A', rawFields: { id: 'A', year: 2029 } } })).toThrow('platform_content_hash_conflict')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it('accepts the last safe observation ID and atomically rejects observation exhaustion', () => {
  const { db, sqlite, input } = fixture()
  // Seed the allocation boundary through an unrelated native source writer.
  sqlite.exec("INSERT INTO platform_collection(id,interface,query_key,rdjb,queried_at,created_at,status,completeness,provenance_state,parse_state,rule_version) VALUES(3,'recognized_list','boundary','','t','c','success','unknown','unknown','absent','fixture')")
  // This deliberately preexisting unindexed boundary row only controls the next PK allocation.
  const guards = sqlite.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='platform_business_observation' AND sql LIKE '%BEFORE INSERT%'").all() as {name:string;sql:string}[]
  for(const guard of guards)sqlite.exec('DROP TRIGGER "'+guard.name+'"')
  sqlite.exec("insert into platform_business_observation(id,collection_id,sequence_no,position_state,identity_state,content_state,indexed_at) values(9007199254740990,3,100,'unknown','not_indexed','not_indexed',NULL)")
  for(const guard of guards)sqlite.exec(guard.sql)
  const r = writeProcessTarget(db, input)
  expect(r.observationId).toBe(Number.MAX_SAFE_INTEGER)
  const before = sqlite.serialize()
  expect(() => writeProcessTarget(db, { ...input, position: { sequenceNo: 2, positionState: 'unknown' }, row: { ...input.row, sequenceNo: 2 } })).toThrow()
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it('rejects unsafe existing version identity before binding a new observation', () => {
  const { db, sqlite, input } = fixture()
  const raw = '{"id":"A"}', hash = createHash('sha256').update('platform-row-json-v1\n'+raw).digest('hex')
  sqlite.exec("insert into platform_business_record(id,interface,platform_key,identity_rule_version,created_at) values(10,'business_list','A','platform-observation-v1','fixture')")
  sqlite.prepare("insert into platform_business_record_version(id,record_id,hash_algorithm,content_hash,canonical_raw_json,created_at) values(9007199254740993,10,'platform-row-json-v1',?,?,'fixture')").run(hash, raw)
  const before = sqlite.serialize()
  expect(() => writeProcessTarget(db, { ...input, row: { sequenceNo: 1, relationKey: 'A', rawFields: { id: 'A' } } })).toThrow('Invalid target identity')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it.each(['enterpriseId', 'commandReceiptId'] as const)('rejects unsafe explicit assignment %s without writes', field => {
  const { db, sqlite, input } = fixture(), before = sqlite.serialize()
  expect(() => writeProcessTarget(db, { ...input, assignment: { ...input.assignment, [field]: 9007199254740992 } })).toThrow('Invalid target identity')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})

it('uses a raw-only key without inventing the source relation key and retains numeric title type', () => {
  const { db, sqlite, input } = fixture()
  const r = writeProcessTarget(db, { ...input, row: { sequenceNo: 1, rawFields: { id: ' RAW ', rdjb: 2 } } })
  expect(sqlite.prepare('select platform_key from platform_business_record where id=?').get(r.recordId)).toEqual({ platform_key: 'RAW' })
  expect(sqlite.prepare('select source_relation_key,key_source from platform_business_observation').get()).toEqual({ source_relation_key: null, key_source: 'raw_id' })
  expect(sqlite.prepare('select source_title_kind,source_title_number_text,title_raw from platform_business_projection where observation_id=?').get(r.observationId)).toEqual({ source_title_kind: 'number', source_title_number_text: '2', title_raw: null }); sqlite.close()
})
it('retains boolean source title and unknown process text types without coercion', () => {
  const { db, sqlite, input } = fixture()
  const r = writeProcessTarget(db, { ...input, row: { sequenceNo: 1, relationKey: 'A', rawFields: { id: 'A', rdjb: true, personuuid: 4, whpc: false, sblx: ' 未知事项 ', cszt: '  ', sqsj: null } } })
  expect(sqlite.prepare('select source_title_kind,source_title_boolean,award_batch_label,batch,declare_kind,status,applied_at from platform_business_projection where observation_id=?').get(r.observationId)).toEqual({ source_title_kind: 'boolean', source_title_boolean: 1, award_batch_label: null, batch: null, declare_kind: '未知事项', status: null, applied_at: null }); sqlite.close()
})
