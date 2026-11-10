import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
import * as schema from '../db/schema'
import { insertArchiveValue, readArchiveValue } from '../lib/platform/immutable-archive'

it('retains SQLite null text malformed unicode and blob bytes without JSON conversion', () => {
  const s = new Database(':memory:')
  try {
    s.pragma('foreign_keys = ON')
    const db = drizzle(s, { schema }); migrate(db, { migrationsFolder: 'db/migrations' })
    for (const value of [null, '', 'null', '{bad', ' \n{"x":"宁波😀"} ', Buffer.from([0, 255, 128])]) {
      const oracle = s.prepare('select typeof(?) kind, cast(? as blob) bytes').get(value, value) as { kind: 'null' | 'text' | 'blob', bytes: Buffer | null }
      const id = insertArchiveValue(db, oracle.kind === 'null' ? { storageClass: 'null', bytes: null, createdAt: 'original' } : { storageClass: oracle.kind, bytes: oracle.bytes!, createdAt: 'original' })
      const read = readArchiveValue(db, { archiveId: id })!
      expect(read.storageClass).toBe(oracle.kind)
      expect(read.isNull).toBe(value === null)
      expect(Buffer.from(read.data, 'base64')).toEqual(oracle.bytes ?? Buffer.alloc(0))
      expect(read.totalBytes).toBe(oracle.bytes?.length ?? 0)
    }
  } finally { s.close() }
})

it('rejects update delete replace and conflict update even with recursive triggers disabled', () => {
  const s = new Database(':memory:')
  try {
    const db = drizzle(s, { schema }); migrate(db, { migrationsFolder: 'db/migrations' })
    const id = insertArchiveValue(db, { storageClass: 'blob', bytes: Buffer.from([255]), createdAt: null })
    for (const recursive of [0, 1]) {
      s.pragma(`recursive_triggers = ${recursive}`)
      for (const statement of [
        `update platform_archive_value set created_at='changed' where id=${id}`,
        `delete from platform_archive_value where id=${id}`,
        `insert or replace into platform_archive_value select * from platform_archive_value where id=${id}`,
        `insert into platform_archive_value select * from platform_archive_value where id=${id} on conflict(id) do update set created_at='changed'`,
      ]) expect(() => s.exec(statement)).toThrow()
    }
    expect(readArchiveValue(db, { archiveId: id })?.data).toBe('/w==')
  } finally { s.close() }
})

import { bindArchive, sealArchiveOwner, writeOwnerArchive, readOwnerArchive, reserveLegacyIds, bindLegacyAlias, allocateLegacyAlias, resolveLegacyReference } from '../lib/platform/immutable-archive'
const collection = { interface: 'recognized_list', queryKey: 'fixture', rdjb: '2', queriedAt: 'original', createdAt: 'original', status: 'partial', completeness: 'unknown', provenanceState: 'unknown', parseState: 'absent', ruleVersion: 't02-fixture' } as const
function fixture() {
  const s = new Database(':memory:'); s.pragma('foreign_keys = ON')
  const db = drizzle(s, { schema }); migrate(db, { migrationsFolder: 'db/migrations' })
  const c = db.insert(schema.platformCollection).values(collection).returning().get()
  const q = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: 'fixture', rdjb: '2', queriedAt: 'original', status: 'success' }).returning().get()
  const r = db.insert(schema.platformRelation).values({ queryId: q.id, sequenceNo: 1 }).returning().get()
  db.insert(schema.platformBusinessObservation).values({ relationId: r.id, identityState: 'missing_key', contentState: 'unverifiable', keySource: 'none', projectionRuleVersion: 'fixture', inputFingerprint: 'original' }).run()
  const record = db.insert(schema.platformBusinessRecord).values({ interface: 'recognized_list', platformKey: 'K', identityRuleVersion: 'original' }).returning().get()
  const v = db.insert(schema.platformBusinessRecordVersion).values({ recordId: record.id, hashAlgorithm: 'historical-algorithm', contentHash: 'historical-hash', canonicalRawJson: '{"id":"K"}' }).returning().get()
  return { s, db, c, q, r, v }
}
it('binds typed owners seals the complete field set and rolls back failed archive transactions', () => {
  const { s, db, c, r, v } = fixture()
  try {
    const input = { storageClass: 'text', bytes: Buffer.from('{bad'), createdAt: null } as const
    const id = insertArchiveValue(db, input)
    bindArchive(db, { kind: 'collection', ownerId: c.id, field: 'rawResponse', archiveId: id })
    expect(readOwnerArchive(db, { kind: 'collection', ownerId: c.id, field: 'request' })).toBeNull()
    expect(() => bindArchive(db, { kind: 'observation', ownerId: 999, field: 'rawFields', archiveId: insertArchiveValue(db, input) })).toThrow()
    expect(() => s.prepare('insert into platform_collection_archive_ref(owner_id,field,archive_id) values(?,?,?)').run(c.id, 'rawFields', id)).toThrow()
    sealArchiveOwner(db, { kind: 'collection', ownerId: c.id })
    expect(() => writeOwnerArchive(db, { kind: 'collection', ownerId: c.id, field: 'request' }, input)).toThrow()
    expect(db.select().from(schema.platformArchiveValue).all()).toHaveLength(2)
    for (const recursive of [0, 1]) {
      s.pragma(`recursive_triggers=${recursive}`)
      for (const statement of [
        'update platform_collection_archive_ref set sealed=0',
        'delete from platform_collection_archive_ref',
        'insert or replace into platform_collection_archive_ref select * from platform_collection_archive_ref',
        'insert into platform_collection_archive_ref select * from platform_collection_archive_ref where true on conflict(owner_id,field) do update set sealed=0',
      ]) expect(() => s.exec(statement)).toThrow()
    }
    writeOwnerArchive(db, { kind: 'observation', ownerId: r.id, field: 'rawFields' }, input)
    writeOwnerArchive(db, { kind: 'version', ownerId: v.id, field: 'canonicalRawJson' }, input)
    expect(readOwnerArchive(db, { kind: 'version', ownerId: v.id, field: 'canonicalRawJson' })?.data).toBe('e2JhZA==')
    expect(db.select().from(schema.platformBusinessRecordVersion).get()?.contentHash).toBe('historical-hash')
    const before = db.select().from(schema.platformArchiveValue).all()
    expect(() => db.transaction(tx => {
      writeOwnerArchive(tx, { kind: 'observation', ownerId: r.id, field: 'sourceText' }, input)
      sealArchiveOwner(tx, { kind: 'observation', ownerId: r.id })
      writeOwnerArchive(tx, { kind: 'version', ownerId: 999, field: 'canonicalRawJson' }, input)
    })).toThrow()
    expect(db.select().from(schema.platformArchiveValue).all()).toEqual(before)
    expect(readOwnerArchive(db, { kind: 'observation', ownerId: r.id, field: 'sourceText' })).toBeNull()
    expect(db.select().from(schema.platformObservationArchiveRef).get()?.sealed).toBe(0)
    expect(s.pragma('foreign_key_check')).toEqual([])
  } finally { s.close() }
})
it('resolves namespace pairs validates transitional ownership and allocates above reserved old maxima', () => {
  const { s, db, c, q, r } = fixture()
  try {
    expect(resolveLegacyReference(db, { version: 1, kind: 'query', queryId: 1 })).toBeNull()
    expect(() => allocateLegacyAlias(db, { kind: 'query', collectionId: c.id })).toThrow()
    reserveLegacyIds(db, { query: 1000, relation: 2000 })
    bindLegacyAlias(db, { kind: 'query', oldId: q.id, collectionId: c.id })
    bindLegacyAlias(db, { kind: 'relation', oldId: r.id, observationId: r.id })
    expect(resolveLegacyReference(db, { version: 1, kind: 'relation', queryId: q.id, relationId: r.id })).toEqual({ version: 2, kind: 'observation', observationId: r.id, collectionId: c.id })
    expect(resolveLegacyReference(db, { version: 1, kind: 'relation', queryId: 999, relationId: r.id })).toBeNull()
    expect(() => bindLegacyAlias(db, { kind: 'query', oldId: 3, collectionId: c.id })).toThrow()
    expect(() => bindLegacyAlias(db, { kind: 'relation', oldId: 3, observationId: 999 })).toThrow()
    const c2 = db.insert(schema.platformCollection).values({ ...collection, queryKey: 'second' }).returning().get()
    const next = allocateLegacyAlias(db, { kind: 'query', collectionId: c2.id })
    expect(next).toBe(1001)
    expect(resolveLegacyReference(db, { version: 1, kind: 'relation', queryId: next, relationId: r.id })).toBeNull()
    const before = db.select().from(schema.platformLegacyAliasSequence).all()
    expect(() => allocateLegacyAlias(db, { kind: 'relation', observationId: r.id })).toThrow()
    expect(db.select().from(schema.platformLegacyAliasSequence).all()).toEqual(before)
    expect(() => reserveLegacyIds(db, { query: 0, relation: 0 })).toThrow()
    for (const table of ['platform_legacy_query_alias', 'platform_legacy_relation_alias']) {
      for (const statement of [`delete from ${table}`, `update ${table} set old_id=99`, `insert or replace into ${table} select * from ${table}`]) expect(() => s.exec(statement)).toThrow()
    }
    expect(s.pragma('foreign_key_check')).toEqual([])
  } finally { s.close() }
})

it('bounds byte reads at 64 KiB including split UTF8 zero end and invalid ranges', () => {
  const s = new Database(':memory:')
  try {
    const queries: string[] = []
    const db = drizzle(s, { schema, logger: { logQuery(query) { queries.push(query) } } }); migrate(db, { migrationsFolder: 'db/migrations' })
    const bytes = Buffer.concat([Buffer.alloc(65535, 97), Buffer.from('😀'), Buffer.from([0, 255])])
    const id = insertArchiveValue(db, { storageClass: 'text', bytes, createdAt: null })
    queries.length = 0
    const first = readArchiveValue(db, { archiveId: id })!
    expect(first.byteLength).toBe(65536); expect(first.hasMore).toBe(true)
    expect(Buffer.from(first.data, 'base64')).toEqual(bytes.subarray(0, 65536))
    const rest = readArchiveValue(db, { archiveId: id, offset: 65536 })!
    expect(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(rest.data, 'base64')])).toEqual(bytes)
    expect(rest.hasMore).toBe(false)
    expect(readArchiveValue(db, { archiveId: id, offset: bytes.length })).toMatchObject({ data: '', hasMore: false, byteLength: 0, totalBytes: bytes.length })
    expect(readArchiveValue(db, { archiveId: id, offset: bytes.length + 1 })?.data).toBe('')
    expect(readArchiveValue(db, { archiveId: id, length: 1 })?.data).toBe('YQ==')
    for (const range of [{ length: 0 }, { length: 65537 }, { offset: -1 }, { offset: 0.1 }, { offset: Number.MAX_SAFE_INTEGER }, { length: NaN }]) expect(() => readArchiveValue(db, { archiveId: id, ...range })).toThrow()
    expect(queries).toHaveLength(5)
    for (const query of queries) {
      expect(query).toContain('substr(')
      expect(query).not.toContain('select "bytes"')
    }
    expect(readArchiveValue(db, { archiveId: 999 })).toBeNull()
  } finally { s.close() }
})
it('validates byte length storage types and independently known SHA256 before binding', () => {
  const { s, db, c } = fixture()
  try {
    const id = insertArchiveValue(db, { storageClass: 'text', bytes: Buffer.from('abc'), createdAt: null }, { byteLength: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' })
    expect(readArchiveValue(db, { archiveId: id })?.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(() => insertArchiveValue(db, { storageClass: 'text', bytes: Buffer.from('abc'), createdAt: null }, { byteLength: 4 })).toThrow()
    expect(() => insertArchiveValue(db, { storageClass: 'blob', bytes: Buffer.from('abc'), createdAt: null }, { sha256: '0'.repeat(64) })).toThrow()
    const insert = s.prepare('insert into platform_archive_value(storage_class,bytes,byte_length,sha256) values(?,?,?,?)')
    for (const row of [['text', 'abc', 3, '0'.repeat(64)], ['blob', Buffer.from('abc'), 2, '0'.repeat(64)], ['null', Buffer.alloc(0), 0, null], ['null', null, null, '0'.repeat(64)], ['json', null, null, null], ['text', null, 0, '0'.repeat(64)], ['blob', Buffer.alloc(0), 0, 'INVALID']]) expect(() => insert.run(...row)).toThrow()
    expect(() => bindArchive(db, { kind: 'collection', ownerId: c.id, field: 'request', archiveId: 999 })).toThrow()
    expect(() => sealArchiveOwner(db, { kind: 'collection', ownerId: c.id })).toThrow()
    expect(s.pragma('foreign_key_check')).toEqual([])
  } finally { s.close() }
})

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readPlatformQueryEvidence } from '../lib/platform/evidence-read'
function migrationPrefix(root: string, max: number) {
  mkdirSync(join(root, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync('db/migrations/meta/_journal.json', 'utf8'))
  const entries = journal.entries.filter((e: { idx: number }) => e.idx <= max)
  writeFileSync(join(root, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
  for (const entry of entries) copyFileSync(`db/migrations/${entry.tag}.sql`, join(root, `${entry.tag}.sql`))
}
function catalog(s: Database.Database) {
  return s.prepare("select type,name,tbl_name,sql from sqlite_schema where name not like 'sqlite_%' order by type,name").all()
}
it('upgrades 0047 and fresh SQLite identically while retaining the independent old DTO and error oracle', () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-upgrade-')), s = new Database(':memory:'), fresh = new Database(':memory:')
  try {
    s.pragma('foreign_keys=ON'); fresh.pragma('foreign_keys=ON')
    migrationPrefix(root, 47)
    const db = drizzle(s, { schema }); migrate(db, { migrationsFolder: root })
    s.exec("insert into platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) values(7,'recognized_list','old','2','original','success','original')")
    s.prepare('insert into platform_relation(id,query_id,sequence_no,raw_fields,source_text,created_at) values(9,7,1,?,?,?)').run(' {"x":"宁波😀","rdjb":"2"} ', '', 'original')
    // Frozen old SQLite DTO column order and json(raw_fields) semantics, independent of schema introspection/new serializer.
    const dtoSql = `select cast(json_object('id',id,'queryId',query_id,'sequenceNo',sequence_no,'relationKey',relation_key,'enterpriseId',enterprise_id,'rawFields',json(raw_fields),'titleRaw',title_raw,'sourceText',source_text,'usccRaw',uscc_raw,'nameRaw',name_raw,'aliasNameRaw',alias_name_raw,'province',province,'status',status,'batch',batch,'declareKind',declare_kind,'appliedAt',applied_at,'awardBatchLabel',award_batch_label,'year',year,'matchBasis',match_basis,'verificationStatus',verification_status,'createdAt',created_at) as blob) bytes from platform_relation where id=9`
    const oracle = s.prepare(dtoSql).get() as { bytes: Buffer }
    const original = s.prepare('select * from platform_relation').all()
    migrate(db, { migrationsFolder: resolve('db/migrations') }); migrate(drizzle(fresh), { migrationsFolder: resolve('db/migrations') })
    expect(catalog(s)).toEqual(catalog(fresh))
    expect(s.prepare('select * from platform_relation').all()).toEqual(original)
    const evidence = readPlatformQueryEvidence(db, { queryId: 7, field: 'relation', relationId: 9 })
    expect('data' in evidence && Buffer.from(evidence.data, 'base64')).toEqual(oracle.bytes)
    const id = insertArchiveValue(db, { storageClass: 'text', bytes: oracle.bytes, createdAt: null })
    expect(Buffer.from(readArchiveValue(db, { archiveId: id })!.data, 'base64')).toEqual(oracle.bytes)
    s.prepare('update platform_relation set raw_fields=? where id=9').run('{bad')
    expect(() => s.prepare(dtoSql).get()).toThrow(/malformed JSON/)
    expect(() => readPlatformQueryEvidence(db, { queryId: 7, field: 'relation', relationId: 9 })).toThrow(/malformed JSON/)
    s.prepare('update platform_relation set raw_fields=NULL where id=9').run()
    expect(JSON.parse((s.prepare(dtoSql).get() as { bytes: Buffer }).bytes.toString()).rawFields).toBeNull()
    expect(s.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]); expect(s.pragma('foreign_key_check')).toEqual([])
    for (const table of ['platform_collection_archive_ref', 'platform_observation_archive_ref', 'platform_version_archive_ref', 'platform_legacy_query_alias', 'platform_legacy_relation_alias']) {
      const fks = s.pragma(`foreign_key_list(${table})`) as { on_delete: string }[]
      expect(fks.length).toBeGreaterThan(0); expect(fks.every(fk => fk.on_delete === 'RESTRICT')).toBe(true)
    }
  } finally { s.close(); fresh.close(); rmSync(root, { recursive: true, force: true }) }
})
it('rolls back archive DDL and migration journal on upgrade failure then retries cleanly', () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-rollback-')), s = new Database(':memory:')
  try {
    const old = join(root, 'old'), broken = join(root, 'broken')
    migrationPrefix(old, 47); migrationPrefix(broken, 48)
    const db = drizzle(s, { schema }); migrate(db, { migrationsFolder: old })
    const before = catalog(s), journal = s.prepare('select * from __drizzle_migrations').all()
    const j = JSON.parse(readFileSync(join(broken, 'meta/_journal.json'), 'utf8'))
    const path = join(broken, `${j.entries.at(-1).tag}.sql`)
    writeFileSync(path, readFileSync(path, 'utf8') + '\n--> statement-breakpoint\nINSERT INTO absent_fixture_table VALUES(1);')
    expect(() => migrate(db, { migrationsFolder: broken })).toThrow()
    expect(catalog(s)).toEqual(before); expect(s.prepare('select * from __drizzle_migrations').all()).toEqual(journal)
    migrate(db, { migrationsFolder: resolve('db/migrations') })
    expect(db.select().from(schema.platformArchiveValue).all()).toEqual([])
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

it('enforces each owner field namespace unique target and seal against every SQL mutation path', () => {
  const { s, db, c, r, v } = fixture()
  try {
    for (const [table, ownerId, field, nextField] of [
      ['platform_collection_archive_ref', c.id, 'rawResponse', 'request'],
      ['platform_observation_archive_ref', r.id, 'rawFields', 'sourceText'],
      ['platform_version_archive_ref', v.id, 'canonicalRawJson', 'wrong'],
    ] as const) {
      const id = insertArchiveValue(db, { storageClass: 'null', bytes: null, createdAt: null })
      const next = insertArchiveValue(db, { storageClass: 'blob', bytes: Buffer.alloc(0), createdAt: null })
      s.prepare(`insert into ${table}(owner_id,field,archive_id) values(?,?,?)`).run(ownerId, field, id)
      for (const recursive of [0, 1]) {
        s.pragma(`recursive_triggers=${recursive}`)
        expect(() => s.prepare(`insert or replace into ${table}(owner_id,field,archive_id) values(?,?,?)`).run(ownerId, field, next)).toThrow()
        expect(() => s.prepare(`update ${table} set archive_id=? where owner_id=?`).run(next, ownerId)).toThrow()
        expect(() => s.prepare(`insert into ${table}(owner_id,field,archive_id) values(?,?,?)`).run(ownerId, 'wrong', next)).toThrow()
      }
      s.prepare(`update ${table} set sealed=1 where owner_id=?`).run(ownerId)
      expect(() => s.prepare(`insert into ${table}(owner_id,field,archive_id) values(?,?,?)`).run(ownerId, nextField, next)).toThrow()
      expect(() => s.exec(`delete from ${table}`)).toThrow()
      expect(() => s.exec(`insert into ${table} select * from ${table} where true on conflict(owner_id,field) do update set archive_id=excluded.archive_id`)).toThrow()
      expect(() => s.prepare(`insert or replace into ${table}(owner_id,field,archive_id) values(?,?,?)`).run(ownerId + 999, field, id)).toThrow()
    }
    const archive = db.select().from(schema.platformCollectionArchiveRef).get()!
    expect(() => db.insert(schema.platformVersionArchiveRef).values({ ownerId: v.id, field: 'canonicalRawJson', archiveId: archive.archiveId }).run()).toThrow()
    expect(() => s.prepare('delete from platform_collection where id=?').run(c.id)).toThrow()
    expect(() => s.prepare('delete from platform_business_observation where relation_id=?').run(r.id)).toThrow()
    expect(() => s.prepare('delete from platform_business_record_version where id=?').run(v.id)).toThrow()
    expect(s.pragma('foreign_key_check')).toEqual([])
  } finally { s.close() }
})

import { getTableName } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
it('matches every new Drizzle column index and foreign key to actual SQLite', () => {
  const { s } = fixture()
  try {
    for (const table of [schema.platformArchiveValue, schema.platformCollectionArchiveRef, schema.platformObservationArchiveRef, schema.platformVersionArchiveRef, schema.platformLegacyQueryAlias, schema.platformLegacyRelationAlias, schema.platformLegacyAliasSequence]) {
      const config = getTableConfig(table)
      const columns = s.pragma(`table_info(${config.name})`)
      expect(columns).toHaveLength(config.columns.length)
      for (const c of config.columns) expect(columns).toContainEqual(expect.objectContaining({ name: c.name, type: c.getSQLType().toUpperCase() }))
      const fks = s.pragma(`foreign_key_list(${config.name})`)
      expect(fks).toHaveLength(config.foreignKeys.length)
      for (const fk of config.foreignKeys) {
        const ref = fk.reference()
        expect(fks).toContainEqual(expect.objectContaining({ table: getTableName(ref.foreignTable), from: ref.columns[0]!.name, to: ref.foreignColumns[0]!.name, on_delete: 'RESTRICT' }))
      }
      const indexes = s.pragma(`index_list(${config.name})`)
      for (const index of config.indexes) expect(indexes).toContainEqual(expect.objectContaining({ name: index.config.name, unique: Number(index.config.unique) }))
    }
  } finally { s.close() }
})
it('rejects orphan transitional aliases reserves distinct namespaces and rolls back exhausted IDs', () => {
  const { s, db, c, q, r } = fixture()
  try {
    expect(() => bindLegacyAlias(db, { kind: 'relation', oldId: 700, observationId: r.id })).toThrow(/unmapped transitional observation collection/)
    reserveLegacyIds(db, { query: 100, relation: 500 })
    bindLegacyAlias(db, { kind: 'query', oldId: q.id, collectionId: c.id })
    expect(allocateLegacyAlias(db, { kind: 'relation', observationId: r.id })).toBe(501)
    expect(resolveLegacyReference(db, { version: 1, kind: 'relation', queryId: q.id, relationId: 501 })).toEqual({ version: 2, kind: 'observation', collectionId: c.id, observationId: r.id })
    expect(resolveLegacyReference(db, { version: 1, kind: 'query', queryId: 501 })).toBeNull()
    for (const oldId of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) expect(() => bindLegacyAlias(db, { kind: 'query', oldId, collectionId: c.id })).toThrow()
    reserveLegacyIds(db, { query: Number.MAX_SAFE_INTEGER, relation: 501 })
    const before = db.select().from(schema.platformLegacyAliasSequence).all()
    expect(() => allocateLegacyAlias(db, { kind: 'query', collectionId: c.id })).toThrow(/Invalid archive identity/)
    expect(db.select().from(schema.platformLegacyAliasSequence).all()).toEqual(before)
    expect(() => s.exec("insert or replace into platform_legacy_alias_sequence(namespace,high_water) values('query',0)")).toThrow()
    expect(() => s.exec('delete from platform_legacy_alias_sequence')).toThrow()
    expect(() => s.exec("update platform_legacy_alias_sequence set high_water=0 where namespace='relation'")).toThrow()
    // No aliases/archives are silently created by failed owner resolution.
    expect(db.select().from(schema.platformLegacyRelationAlias).all()).toEqual([{ oldId: 501, observationId: r.id }])
  } finally { s.close() }
})
