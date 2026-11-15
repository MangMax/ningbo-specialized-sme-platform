import { sql } from 'drizzle-orm'
import { bindLegacyAlias, resolveLegacyReference, writeOwnerArchive, readOwnerArchive } from '../../../upgrade/frozen/immutable-archive'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import * as schema from '../../../upgrade/legacy-schema'

const folder = resolve('db/migrations')
function setup(upgrade = false) {
  const root = mkdtempSync(join(tmpdir(), 't03a-'))
  const s = new Database(':memory:'); s.pragma('foreign_keys=ON')
  const db = drizzle(s, { schema })
  if (upgrade) {
    const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'))
    const entries = journal.entries.filter((e: { idx: number }) => e.idx <= 48)
    mkdirSync(join(root, 'meta'))
    writeFileSync(join(root, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
    for (const e of entries) copyFileSync(join(folder, e.tag + '.sql'), join(root, e.tag + '.sql'))
  }
  migrate(db, { migrationsFolder: upgrade ? root : folder })
  s.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'business_list','fixture','2','original','success','original');
    INSERT INTO platform_business_record(id,interface,platform_key,identity_rule_version,created_at) VALUES(1,'business_list','K','old','original');
    INSERT INTO platform_business_record_version(id,record_id,hash_algorithm,content_hash,canonical_raw_json,created_at) VALUES(1,1,'old-algorithm','old-hash','{"id":"K"}','original');`)
  const relation = s.prepare('INSERT INTO platform_relation(id,query_id,sequence_no,relation_key,raw_fields,created_at) VALUES(?,1,?,?,?,\'original\')')
  const obs = s.prepare('INSERT INTO platform_business_observation(relation_id,record_id,version_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at) VALUES(?,?,?,?,?,?,?,?,?)')
  const keys = [null, '', '   ', 'A', 'A', 'K', 'K']
  keys.forEach((key, i) => {
    relation.run(i + 1, i + 1, key, JSON.stringify({ id: i === 3 ? 'B' : i === 4 ? 'C' : 'K' }))
    const resolved = i >= 5
    obs.run(i + 1, resolved ? 1 : null, resolved && i === 6 ? 1 : null, resolved ? 'resolved' : i < 3 ? 'missing_key' : 'conflict', resolved && i === 6 ? 'verified' : 'unverifiable', resolved ? 'both' : 'none', 'old-rule', 'old-input', 'original')
  })
  // A second observation of exactly the same content version.
  relation.run(8, 8, 'K', '{"id":"K"}')
  obs.run(8, 1, 1, 'resolved', 'verified', 'both', 'old-rule', 'old-input', 'original')
  return { s, db, close() { s.close(); rmSync(root, { recursive: true, force: true }) } }
}
function catalog(s: Database.Database) { return s.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() }

it('upgrades populated 0048 without inventing identity collection assignment or rewriting legacy facts', () => {
  const f = setup(true), fresh = setup()
  try {
    const before = f.s.prepare('SELECT * FROM platform_business_observation ORDER BY relation_id').all()
    const facts = () => ['platform_query', 'platform_relation', 'platform_business_record', 'platform_business_record_version'].map(t => f.s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())
    const original = facts()
    migrate(f.db, { migrationsFolder: folder })
    expect(catalog(f.s)).toEqual(catalog(fresh.s))
    expect(facts()).toEqual(original.map((rows,i) => i === 3 ? rows.map(row => ({...row as object,canonical_archive_id:null})) : rows))
    const rows = f.s.prepare('SELECT * FROM platform_business_observation ORDER BY relation_id').all()
    expect(rows).toEqual(before.map(row => ({ ...row as object, id: null, collection_id: null, sequence_no: null, page_id: null, page_row_no: null, position_state: null, source_relation_key: null })))
    expect(f.s.prepare('SELECT * FROM platform_observation_assignment').all()).toEqual([])
    expect(f.s.prepare('SELECT * FROM platform_collection').all()).toEqual([])
    expect(f.s.pragma('foreign_key_check')).toEqual([])
    expect(f.s.pragma('integrity_check', { simple: true })).toBe('ok')
  } finally { f.close(); fresh.close() }
})

function mapped(f: ReturnType<typeof setup>) {
  const c = f.db.insert(schema.platformCollection).values({ interface: 'business_list', queryKey: 'fixture', rdjb: '2', queriedAt: 'original', createdAt: 'original', status: 'success', completeness: 'unknown', provenanceState: 'unknown', parseState: 'absent', ruleVersion: 'test' }).returning().get()
  const page = f.s.prepare("INSERT INTO platform_collection_page(collection_id,ordinal,position_state) VALUES(?,0,'verified') RETURNING id").get(c.id) as { id: number }
  return { c, page }
}
it('stores original null empty space and conflicting keys with repeated verified versions at distinct positions', () => {
  const f = setup()
  try {
    const { c, page } = mapped(f)
    const keys = [null, '', '   ', 'A', 'A', 'K', 'K', 'K']
    keys.forEach((sourceRelationKey, i) => f.db.update(schema.platformBusinessObservation).set({ id: i + 1, collectionId: c.id, sequenceNo: i + 1, pageId: page.id, pageRowNo: i + 1, positionState: i === 3 ? 'conflict' : 'verified', sourceRelationKey }).where(sql`relation_id=${i + 1}`).run())
    expect(f.s.prepare('SELECT source_relation_key FROM platform_business_observation ORDER BY sequence_no').all()).toEqual(keys.map(source_relation_key => ({ source_relation_key })))
    expect(f.s.prepare('SELECT id,version_id FROM platform_business_observation WHERE version_id=1 ORDER BY id').all()).toEqual([{ id: 7, version_id: 1 }, { id: 8, version_id: 1 }])
    expect(f.s.prepare('SELECT relation_key,raw_fields FROM platform_relation WHERE id IN (4,5) ORDER BY id').all()).toEqual([{ relation_key: 'A', raw_fields: '{"id":"B"}' }, { relation_key: 'A', raw_fields: '{"id":"C"}' }])
  } finally { f.close() }
})
it('rejects partial mappings invalid positions duplicate identities and pages belonging to another collection', () => {
  const f = setup()
  try {
    const { c, page } = mapped(f)
    const c2 = f.db.insert(schema.platformCollection).values({ ...c, id: undefined, queryKey: 'other' }).returning().get()
    const set = (patch: Partial<typeof schema.platformBusinessObservation.$inferInsert>) => f.db.update(schema.platformBusinessObservation).set(patch).where(sql`relation_id=1`).run()
    const valid = { id: 1, collectionId: c.id, sequenceNo: 1, positionState: 'unknown' as const }
    for (const patch of [{ id: 1 }, { ...valid, pageRowNo: 1 }, { ...valid, pageId: 999 }, { ...valid, pageId: page.id, collectionId: c2.id }, { ...valid, collectionId: 999 }, ...[0, -1, 1.5, 9007199254740992].flatMap(n => ['id', 'collectionId', 'sequenceNo', 'pageId', 'pageRowNo'].map(key => ({ ...valid, pageId: page.id, [key]: n })))]) expect(() => set(patch)).toThrow()
    set({ ...valid, pageId: page.id, pageRowNo: 1 })
    expect(() => f.db.update(schema.platformBusinessObservation).set({ ...valid, id: 2 }).where(sql`relation_id=2`).run()).toThrow()
    expect(() => f.db.update(schema.platformBusinessObservation).set({ ...valid, sequenceNo: 2 }).where(sql`relation_id=2`).run()).toThrow()
    expect(() => f.db.update(schema.platformCollectionPage).set({ collectionId: c2.id }).where(sql`id=${page.id}`).run()).toThrow()
    for (const statement of ["UPDATE platform_business_observation SET sequence_no='bad' WHERE relation_id=1", "UPDATE platform_business_observation SET position_state='bad' WHERE relation_id=1", "UPDATE platform_business_observation SET source_relation_key=x'ff' WHERE relation_id=1"]) expect(() => f.s.exec(statement)).toThrow()
  } finally { f.close() }
})
it('appends nullable owner revisions without inventing actor or time and prevents replace update delete or revision gaps', () => {
  const f = setup()
  try {
    const first = { observationId: 1, revision: 1, enterpriseId: null, matchBasis: 'none', verificationStatus: 'pending', nameRaw: ' 原名 ', usccRaw: '', aliasNameRaw: '   ', origin: 'migrated_current' } as const
    f.db.insert(schema.platformObservationAssignment).values(first).run()
    expect(f.db.select().from(schema.platformObservationAssignment).all()[0]).toMatchObject({ ...first, actor: null, recordedAt: null, commandReceiptId: null, basis: null })
    const owner = f.db.insert(schema.enterprise).values({ name: '合成归属', nameNorm: '合成归属' }).returning().get()
    f.db.insert(schema.platformObservationAssignment).values({ ...first, revision: 2, enterpriseId: owner.id, matchBasis: 'manual', verificationStatus: 'confirmed', origin: 'command', actor: { type: 'agent', id: 'explicit' }, recordedAt: 'original text' }).run()
    expect(f.db.select().from(schema.platformObservationAssignment).all().map(r => r.enterpriseId)).toEqual([null, owner.id])
    for (const recursive of [0, 1]) {
      f.s.pragma(`recursive_triggers=${recursive}`)
      for (const statement of ['DELETE FROM platform_observation_assignment', "UPDATE platform_observation_assignment SET name_raw='changed'", 'INSERT OR REPLACE INTO platform_observation_assignment SELECT * FROM platform_observation_assignment', "INSERT INTO platform_observation_assignment SELECT * FROM platform_observation_assignment WHERE true ON CONFLICT(observation_id,revision) DO UPDATE SET basis='changed'"]) expect(() => f.s.exec(statement)).toThrow()
    }
    for (const patch of [{ observationId: 999 }, { enterpriseId: 999 }, { revision: 4, origin: 'command' as const }, { actor: { type: 'user' as const, id: 'invented' } }, { recordedAt: 'invented' }, { revision: 0 }, { revision: 1.5 }, { revision: 9007199254740992 }]) expect(() => f.db.insert(schema.platformObservationAssignment).values({ ...first, ...patch }).run()).toThrow()
    expect(() => f.db.transaction(tx => { tx.insert(schema.platformObservationAssignment).values({ ...first, revision: 3, origin: 'command' }).run(); throw Error('rollback') })).toThrow('rollback')
    expect(f.db.select().from(schema.platformObservationAssignment).all().map(r => r.revision)).toEqual([1, 2])
    expect(() => f.s.exec('DELETE FROM platform_business_observation WHERE relation_id=1')).toThrow()
  } finally { f.close() }
})

it('preserves populated T02 owner bindings and alias pairs across upgrade and permits the legacy writer after expansion', () => {
  const f = setup(true)
  try {
    // These T02 APIs operate against actual 0048; no target collection mapping on observation.
    const { c } = mapped(f)
    bindLegacyAlias(f.db, { kind: 'query', oldId: 1, collectionId: c.id })
    bindLegacyAlias(f.db, { kind: 'relation', oldId: 4, observationId: 4 })
    writeOwnerArchive(f.db, { kind: 'observation', ownerId: 4, field: 'rawFields' }, { storageClass: 'text', bytes: Buffer.from(' {"id":"B"} '), createdAt: null })
    const original = readOwnerArchive(f.db, { kind: 'observation', ownerId: 4, field: 'rawFields' })
    migrate(f.db, { migrationsFolder: folder })
    expect(readOwnerArchive(f.db, { kind: 'observation', ownerId: 4, field: 'rawFields' })).toEqual(original)
    expect(resolveLegacyReference(f.db, { version: 1, kind: 'relation', queryId: 1, relationId: 4 })).toEqual({ version: 2, kind: 'observation', observationId: 4, collectionId: c.id })
    const r = f.db.insert(schema.platformRelation).values({ queryId: 1, sequenceNo: 9, relationKey: 'unchanged' }).returning().get()
    f.db.insert(schema.platformBusinessObservation).values({ relationId: r.id, identityState: 'missing_key', contentState: 'unverifiable', keySource: 'none', projectionRuleVersion: 'old', inputFingerprint: 'new' }).run()
    expect(f.db.select().from(schema.platformBusinessObservation).where(sql`relation_id=${r.id}`).get()).toMatchObject({ relationId: r.id, id: null, collectionId: null })
    expect(f.s.pragma('foreign_key_check')).toEqual([])
  } finally { f.close() }
})
it('rolls back failed expansion DDL atomically on a populated 0048 database', () => {
  const f = setup(true)
  try {
    const before = catalog(f.s)
    const sqlFile = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')).entries.find((e: { idx: number }) => e.idx === 49).tag + '.sql'
    expect(() => f.s.transaction(() => { f.s.exec(readFileSync(join(folder, sqlFile), 'utf8')); f.s.exec('INSERT INTO platform_observation_assignment(observation_id,revision,match_basis,verification_status,origin) VALUES(999,1,\'none\',\'pending\',\'command\')') })()).toThrow()
    expect(catalog(f.s)).toEqual(before)
    expect(f.s.prepare('SELECT COUNT(*) n FROM platform_business_observation').get()).toEqual({ n: 8 })
    migrate(f.db, { migrationsFolder: folder })
    expect(f.s.pragma('foreign_key_check')).toEqual([])
  } finally { f.close() }
})
it('prevents page replacement from changing the owner of an already mapped observation', () => {
  const f = setup()
  try {
    const { c, page } = mapped(f)
    const c2 = f.db.insert(schema.platformCollection).values({ ...c, id: undefined, queryKey: 'other' }).returning().get()
    f.db.update(schema.platformBusinessObservation).set({ id: 1, collectionId: c.id, sequenceNo: 1, pageId: page.id, positionState: 'verified' }).where(sql`relation_id=1`).run()
    for (const recursive of [0, 1]) {
      f.s.pragma(`recursive_triggers=${recursive}`)
      expect(() => f.s.prepare('INSERT OR REPLACE INTO platform_collection_page(id,collection_id,ordinal,position_state) VALUES(?,?,0,\'unknown\')').run(page.id, c2.id)).toThrow()
    }
    expect(f.db.select().from(schema.platformCollectionPage).get()?.collectionId).toBe(c.id)
  } finally { f.close() }
})
it('enforces assignment discriminators raw text storage and safe revision boundaries', () => {
  const f = setup()
  try {
    const insert = (extra: Partial<typeof schema.platformObservationAssignment.$inferInsert>) => f.db.insert(schema.platformObservationAssignment).values({ observationId: 1, revision: 1, matchBasis: 'none', verificationStatus: 'pending', origin: 'command', ...extra }).run()
    for (const extra of [{ enterpriseId: 0 }, { enterpriseId: 1.5 }, { commandReceiptId: 0 }, { commandReceiptId: 1.5 }, { commandReceiptId: 9007199254740992 }]) expect(() => insert(extra)).toThrow()
    for (const column of ['uscc_raw', 'name_raw', 'alias_name_raw', 'actor', 'basis', 'recorded_at']) expect(() => f.s.exec(`INSERT INTO platform_observation_assignment(observation_id,revision,match_basis,verification_status,origin,${column}) VALUES(1,1,'none','pending','command',x'ff')`)).toThrow()
    for (const [column, value] of [['match_basis', 'invented'], ['verification_status', 'invented'], ['origin', 'invented']]) expect(() => f.s.prepare(`INSERT INTO platform_observation_assignment(observation_id,revision,match_basis,verification_status,origin) VALUES(1,1,?,?,?)`).run(column === 'match_basis' ? value : 'none', column === 'verification_status' ? value : 'pending', column === 'origin' ? value : 'command')).toThrow()
    insert({ commandReceiptId: Number.MAX_SAFE_INTEGER })
    expect(f.db.select().from(schema.platformObservationAssignment).get()?.commandReceiptId).toBe(9007199254740991)
  } finally { f.close() }
})
