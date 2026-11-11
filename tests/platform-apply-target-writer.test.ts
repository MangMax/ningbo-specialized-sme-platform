import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { upgradeCollections } from '../upgrade/collections'
import { upgradeObservations } from '../upgrade/observations'
import { upgradeProjections } from '../upgrade/projections'
import { finalizeObservations } from '../upgrade/finalize-observations'
import { targetSchema } from '../lib/platform/target-schema'
import { writeApplyTarget, type ApplyTargetInput } from '../lib/platform/apply-target-writer'

function fixture() {
  const root = mkdtempSync(join(process.env.W1A_EVIDENCE_DIR ?? tmpdir(), 'w1a-'))
  const source = join(root, 'source.sqlite'), target = join(root, 'target.sqlite')
  const sourceDb = new Database(source)
  migrate(drizzle(sourceDb), { migrationsFolder: 'db/migrations' })
  sourceDb.exec("insert into platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) values(1,'apply_list','a','','t','success','c'),(2,'business_list','b','','t','success','c');")
  sourceDb.close(); copyFileSync(source, target)
  upgradeCollections({ source, target, runId: 'c', batchSize: 2 })
  upgradeObservations({ source, target, runId: 'o', collectionRunId: 'c', batchSize: 2 })
  upgradeProjections({ source, target, runId: 'p', observationRunId: 'o', collectionRunId: 'c', batchSize: 2 })
  finalizeObservations({ source, target, runId: 'f', projectionRunId: 'p', observationRunId: 'o', collectionRunId: 'c' })
  const statements: string[] = []
  const sqlite = new Database(target, { verbose: text => statements.push(String(text)) }); sqlite.pragma('foreign_keys=ON')
  const db = drizzle(sqlite, { schema: targetSchema })
  const input: ApplyTargetInput = { collectionId: 1, position: { sequenceNo: 1, positionState: 'unknown' }, row: { sequenceNo: 1, relationKey: ' A ', status: 'stored', rawFields: { year: ' 2028 ', id: 'A', cszt: 'source', rdjb: ' 2 ' }, sourceText: '原文\n\u0000' }, assignment: { enterpriseId: null, matchBasis: 'none', verificationStatus: 'pending', origin: 'command', actor: { type: 'agent', id: 'test' }, basis: 'explicit test observation', recordedAt: null } }
  return { sqlite, db, input, statements }
}
it('preserves literal bytes hash fields provenance and independent observations while replay is idempotent without legacy SQL', () => {
  const f = fixture(), { sqlite, db, input } = f
  const first = writeApplyTarget(db, input)
  const before = sqlite.serialize()
  expect(writeApplyTarget(db, input)).toEqual({ ...first, reused: true })
  expect(sqlite.serialize()).toEqual(before)
  const second = writeApplyTarget(db, { ...input, position: { ...input.position, sequenceNo: 2 }, row: { ...input.row, sequenceNo: 2, status: 'source' } })
  expect(second.versionId).toBe(first.versionId); expect(second.observationId).not.toBe(first.observationId)
  const literal = '{"cszt":"source","id":"A","rdjb":" 2 ","year":" 2028 "}'
  expect(sqlite.prepare('select canonical_raw_json,content_hash from platform_business_record_version').get()).toEqual({ canonical_raw_json: literal, content_hash: createHash('sha256').update('platform-row-json-v1\n' + literal).digest('hex') })
  expect(sqlite.prepare('select observation_id,declaration_year,source_title_kind,source_title_text,stored_status,parsed_status,reconciled_status,status_conflict from platform_apply_projection where observation_id is not null order by observation_id').all()).toEqual([
    { observation_id: first.observationId, declaration_year: 2028, source_title_kind: 'text', source_title_text: ' 2 ', stored_status: 'stored', parsed_status: 'source', reconciled_status: null, status_conflict: 1 },
    { observation_id: second.observationId, declaration_year: 2028, source_title_kind: 'text', source_title_text: ' 2 ', stored_status: 'source', parsed_status: 'source', reconciled_status: 'source', status_conflict: 0 },
  ])
  expect(sqlite.prepare("select cast(a.bytes as text) bytes,r.sealed from platform_archive_value a join platform_observation_archive_ref r on r.archive_id=a.id where r.owner_id=? and field='rawFields'").get(first.observationId)).toEqual({ bytes: '{"year":" 2028 ","id":"A","cszt":"source","rdjb":" 2 "}', sealed: 1 })
  expect(sqlite.prepare('select enterprise_id,origin,recorded_at,revision from platform_observation_assignment where observation_id=?').get(first.observationId)).toEqual({ enterprise_id: null, origin: 'command', recorded_at: null, revision: 1 })
  expect(f.statements.filter(sql => /\b(?:platform_query|platform_relation)\b/i.test(sql))).toEqual([])
  expect(sqlite.pragma('foreign_key_check')).toEqual([]); sqlite.close()
})
it.each([null, 'wrong'])('isolates missing or conflicting business identities %s', key => {
  const { db, sqlite, input } = fixture()
  const result = writeApplyTarget(db, { ...input, row: { sequenceNo: 1, relationKey: key, rawFields: key === null ? { year: true } : { id: 'A', year: [] } } })
  expect(result.recordId).toBeNull(); expect(result.versionId).toBeNull()
  expect(sqlite.prepare('select identity_state,content_state from platform_business_observation').get()).toEqual({ identity_state: key === null ? 'missing_key' : 'conflict', content_state: 'unverifiable' }); sqlite.close()
})
it.each([2028, ' ', true, [], '2.5', -1].map(year => ({ year })))('uses literal declaration year partitions $year', ({ year }) => {
  const { db, sqlite, input } = fixture()
  writeApplyTarget(db, { ...input, row: { ...input.row, rawFields: { id: 'A', year } } })
  expect(sqlite.prepare('select declaration_year from platform_apply_projection where version_id is not null').get()).toEqual({ declaration_year: year === 2028 ? 2028 : null }); sqlite.close()
})
it('refuses same position different payload and rolls back invalid owners and alias exhaustion', () => {
  const { db, sqlite, input } = fixture()
  writeApplyTarget(db, input)
  const before = sqlite.serialize()
  expect(() => writeApplyTarget(db, { ...input, row: { ...input.row, rawFields: { id: 'changed' } } })).toThrow('observation_payload_conflict')
  expect(sqlite.serialize()).toEqual(before)
  expect(() => writeApplyTarget(db, { ...input, collectionId: 2 })).toThrow('owner mismatch')
  expect(() => writeApplyTarget(db, { ...input, position: { ...input.position, pageId: 999 } })).toThrow('owner mismatch')
  sqlite.exec("update platform_legacy_alias_sequence set high_water=9007199254740991 where namespace='relation'")
  const exhausted = sqlite.serialize()
  expect(() => writeApplyTarget(db, { ...input, position: { ...input.position, sequenceNo: 2 }, row: { ...input.row, sequenceNo: 2, rawFields: { id: 'B' } } })).toThrow('Invalid archive identity')
  expect(sqlite.serialize()).toEqual(exhausted); sqlite.close()
})
it.each(['platform_observation_assignment', 'platform_observation_archive_ref', 'platform_apply_projection', 'platform_legacy_relation_alias'])('rolls back every write after an injected %s failure even when caller catches', table => {
  const { db, sqlite, input } = fixture()
  sqlite.exec(`create trigger inject before insert on ${table} begin select raise(abort,'injected'); end`)
  const before = sqlite.serialize()
  db.transaction(tx => { expect(() => writeApplyTarget(tx, input)).toThrow('injected') })
  // Committing the empty enclosing transaction advances SQLite header counters only.
  const after = sqlite.serialize()
  for (const offset of [24, 92]) { before.fill(0, offset, offset + 4); after.fill(0, offset, offset + 4) }
  expect(after).toEqual(before); sqlite.close()
})
it('requires explicit command provenance rather than silently accepting a fabricated migrated assignment', () => {
  const { db, sqlite, input } = fixture()
  const before = sqlite.serialize()
  expect(() => writeApplyTarget(db, { ...input, assignment: { enterpriseId: null, matchBasis: 'none', verificationStatus: 'pending', origin: 'migrated_current' } })).toThrow('Explicit command provenance required')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it('preserves confirmed ownership source bytes seals alias high water and catalog across new content versions', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("insert into enterprise(id,name,name_norm) values(100,'Owner','owner'); update platform_legacy_alias_sequence set high_water=500 where namespace='relation'; insert into platform_business_record(interface,platform_key,identity_rule_version,created_at) values('business_list','A','platform-observation-v1','c')")
  const catalog = sqlite.prepare('select type,name,tbl_name,sql from sqlite_schema order by type,name').all()
  const first = writeApplyTarget(db, { ...input, assignment: { ...input.assignment, enterpriseId: 100, matchBasis: 'manual', verificationStatus: 'confirmed', recordedAt: 'known-confirmation-text' } })
  expect(first.relationAlias).toBe(501)
  expect(sqlite.prepare('select enterprise_id,recorded_at,verification_status from platform_observation_assignment').get()).toEqual({ enterprise_id: 100, recorded_at: 'known-confirmation-text', verification_status: 'confirmed' })
  const second = writeApplyTarget(db, { ...input, position: { ...input.position, sequenceNo: 2 }, row: { sequenceNo: 2, relationKey: 'A', rawFields: { id: 'A', year: 2029 } } })
  expect(second.recordId).toBe(first.recordId); expect(second.versionId).not.toBe(first.versionId); expect(second.relationAlias).toBe(502)
  expect(sqlite.prepare('select interface,platform_key from platform_business_record order by interface').all()).toEqual([{ interface: 'apply_list', platform_key: 'A' }, { interface: 'business_list', platform_key: 'A' }])
  expect(sqlite.prepare("select cast(a.bytes as text) bytes from platform_observation_archive_ref r join platform_archive_value a on a.id=r.archive_id where owner_id=? and field='sourceText'").get(first.observationId)).toEqual({ bytes: '原文\n\u0000' })
  expect(() => sqlite.prepare("update platform_observation_archive_ref set sealed=0 where owner_id=?").run(first.observationId)).toThrow()
  expect(sqlite.prepare('select type,name,tbl_name,sql from sqlite_schema order by type,name').all()).toEqual(catalog)
  sqlite.close()
})
it('rejects canonical byte drift on a hash hit before creating another observation', () => {
  const { db, sqlite, input } = fixture()
  writeApplyTarget(db, input)
  sqlite.exec("update platform_business_record_version set canonical_raw_json='{}'")
  const before = sqlite.serialize()
  expect(() => writeApplyTarget(db, { ...input, position: { ...input.position, sequenceNo: 2 }, row: { ...input.row, sequenceNo: 2 } })).toThrow('platform_content_hash_conflict')
  expect(sqlite.serialize()).toEqual(before); sqlite.close()
})
it('accepts the last safe record ID and atomically rejects exhausted record IDs for distinct keys', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("insert into sqlite_sequence(name,seq) values('platform_business_record',9007199254740990)")
  const row = (key: string, sequenceNo: number): ApplyTargetInput => ({ ...input, position: { ...input.position, sequenceNo }, row: { sequenceNo, relationKey: key, rawFields: null } })
  const last = writeApplyTarget(db, row('LAST-SAFE', 1))
  expect(last.recordId).toBe(Number.MAX_SAFE_INTEGER)
  expect(writeApplyTarget(db, row('LAST-SAFE', 2)).recordId).toBe(last.recordId)
  const before = sqlite.serialize()
  for (const [index, key] of ['EXHAUST-1', 'EXHAUST-2'].entries()) {
    expect(() => writeApplyTarget(db, row(key, index + 3))).toThrow('Invalid target identity')
    expect(sqlite.serialize()).toEqual(before)
  }
  expect(sqlite.prepare('select cast(id as text) id,platform_key from platform_business_record').all()).toEqual([{ id: '9007199254740991', platform_key: 'LAST-SAFE' }])
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
  sqlite.close()
})
it('rejects an existing unsafe record ID before writing an observation', () => {
  const { db, sqlite, input } = fixture()
  sqlite.exec("insert into platform_business_record(id,interface,platform_key,identity_rule_version,created_at) values(9007199254740993,'apply_list','A','platform-observation-v1','fixture')")
  const before = sqlite.serialize()
  expect(() => writeApplyTarget(db, input)).toThrow('Invalid target identity')
  expect(sqlite.serialize()).toEqual(before)
  sqlite.close()
})
it('keeps absent raw content as an unavailable observation without fabricating a version', () => {
  const { db, sqlite, input } = fixture()
  const result = writeApplyTarget(db, { ...input, row: { sequenceNo: 1, relationKey: 'A', rawFields: null } })
  expect(result.recordId).not.toBeNull(); expect(result.versionId).toBeNull()
  expect(sqlite.prepare('select basis,parse_state,source_title_kind,declaration_year from platform_apply_projection').get()).toEqual({ basis: 'unavailable', parse_state: 'absent', source_title_kind: 'absent', declaration_year: null })
  expect(sqlite.prepare("select storage_class,bytes,byte_length,sha256 from platform_archive_value a join platform_observation_archive_ref r on r.archive_id=a.id where r.field='rawFields'").get()).toEqual({ storage_class: 'null', bytes: null, byte_length: null, sha256: null }); sqlite.close()
})
