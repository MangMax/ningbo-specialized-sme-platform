import { upgradeIntegrityGate, upgradeForeignKeyFailures } from './integrity-policy'
/** #755 offline 71612 -> 71613; never imported by server/lib. */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync, statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { isDeepStrictEqual, TextDecoder } from 'node:util'
import { asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { targetSchema as schema } from './target-schema'
import { requireDifferenceReferencesReady } from './difference-reference-catalog'
import { LEGACY_PROVENANCE_VERSION, LEGACY_PROVENANCE_TRANSFORM, requireLegacyProvenanceReady } from '../lib/platform/legacy-provenance-catalog'
import { withFrozenSource, fileHash, assertFrozenSource } from './frozen-source'
import { schemaHash, rowSnapshot } from '../lib/platform/sqlite-row-cells'
import { projectionManifest } from './projections'
import { installLegacyProvenance, provenanceTable, requireProvenanceForeignKeys } from './legacy-provenance-schema'
import { hasReconcileSlotCapture, requireReconcileSlotSchema } from './reconcile-slot-schema'
import { RECONCILE_SLOT_T04 } from './frozen/reconcile-slot-capture'

const fields = ['query_id','source_identity','source_sha256','segment_index','collection','input_fingerprint','import_batch_id','created_at'] as const
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function fail(message: string): never { throw new Error(message) }
type Cell = { name: string; storageClass: string; hex: string }
/** Strict length framing; collection bytes are never decoded, normalized or serialized. */
function envelope(bytes: Buffer): Cell[] {
  let cursor = Buffer.byteLength('T04-PROVENANCE\n')
  if (!bytes.subarray(0,cursor).equals(Buffer.from('T04-PROVENANCE\n'))) fail('Invalid T04 provenance envelope')
  const cells: Cell[] = []
  for (const name of fields) {
    const end = bytes.indexOf(10,cursor)
    if (end < 0) fail(`Missing T04 cell ${name}`)
    const header = bytes.subarray(cursor,end).toString('utf8')
    const match = /^(\w+) (text|blob|integer|null|real) (0|[1-9]\d*)$/.exec(header)
    if (!match || match[1] !== name) fail(`Invalid T04 cell ${name}`)
    const size = Number(match[3]), begin = end + 1, tail = begin + size
    if (!Number.isSafeInteger(size) || tail >= bytes.length || bytes[tail] !== 10) fail(`Truncated T04 cell ${name}`)
    cells.push({ name, storageClass: match[2]!, hex: bytes.subarray(begin,tail).toString('hex').toUpperCase() })
    cursor = tail + 1
  }
  if (cursor !== bytes.length) fail('Trailing T04 provenance bytes')
  return cells
}
function text(cell: Cell | undefined) {
  if (!cell || cell.storageClass !== 'text') return fail('Unsupported original metadata storage class')
  try { return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(cell.hex,'hex')) }
  catch { return fail('Unsupported original metadata UTF-8') }
}
function integer(cell: Cell | undefined, min: number) {
  if (!cell || cell.storageClass !== 'integer') return fail('Unsupported original integer storage class')
  const raw = Buffer.from(cell.hex,'hex').toString()
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || String(value) !== raw) fail('Unsafe original metadata identity')
  return value
}
type Metadata = typeof schema.platformCollectionLegacyProvenance.$inferSelect
function health(t: Database.Database) {
  requireProvenanceForeignKeys(t)
  if ((upgradeForeignKeyFailures(t) as unknown[]).length || !upgradeIntegrityGate(t)) fail('Provenance database integrity failure')
}
/** Whole collection/ref/alias/provenance domains, including proven absence. */
function inventory(t: Database.Database): Metadata[] {
  health(t)
  // All other incoming archive FKs are constrained secondary pointers to a sealed
  // ref/basis. Preserve those existing barriers, rather than creating new owners.
  const expected = [
    'platform_collection_archive_ref.archive_id','platform_observation_archive_ref.archive_id','platform_version_archive_ref.archive_id',
    'platform_observation_fingerprint_basis.input_archive_id',
    'platform_apply_projection.source_archive_id','platform_business_projection.source_archive_id','platform_recognized_projection.source_archive_id',
    'platform_business_record_version.canonical_archive_id','platform_recognized_projection.exact_title_archive_id',
    'platform_collection.witness_archive_id','platform_business_observation.witness_archive_id','platform_business_observation.candidate_scope_archive_id',
  ]
  if (hasReconcileSlotCapture(t)) {
    requireReconcileSlotSchema(t)
    expected.push('platform_collection.reconcile_slot_raw_archive_id')
  }
  if (t.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(provenanceTable)) expected.push(`${provenanceTable}.archive_id`)
  const incoming = (t.prepare("SELECT m.name owner,f.[from] column_name,f.[to] destination FROM sqlite_schema m JOIN pragma_foreign_key_list(m.name) f WHERE m.type='table' AND f.[table]='platform_archive_value'").all() as {owner:string;column_name:string;destination:string}[]).map(r=>`${r.owner}.${r.column_name}${r.destination==='id'?'':`->${r.destination}`}`)
  if (!isDeepStrictEqual(incoming.sort(),expected.sort())) fail('Unknown archive FK owner inventory')
  const db = drizzle(t,{schema}), c = schema.platformCollection, q = schema.platformLegacyQueryAlias
  const collections = db.select().from(c).orderBy(asc(c.id)).all()
  const aliases = db.select().from(q).orderBy(asc(q.oldId)).all()
  if (aliases.length !== collections.length || collections.some(row => aliases.filter(a => a.collectionId === row.id).length !== 1)) fail('Whole collection alias set differs')
  const result: Metadata[] = [], keys = new Set<string>(), oldIds: number[] = []
  for (const collection of collections) {
    if (!Number.isSafeInteger(collection.id) || collection.id < 1) fail('Unsafe collection identity')
    const alias = aliases.find(a => a.collectionId === collection.id)!
    if (!Number.isSafeInteger(alias.oldId) || alias.oldId < 1) fail('Unsafe query alias')
    const refs = db.select().from(schema.platformCollectionArchiveRef).where(eq(schema.platformCollectionArchiveRef.ownerId,collection.id)).all()
    const legacy = refs.find(r => r.field === 'legacyProvenance')
    const offline = collection.ruleVersion === 't04-collection-v1' || (hasReconcileSlotCapture(t) && collection.ruleVersion === RECONCILE_SLOT_T04)
    const names = offline ? ['rawResponse','collectionEvidence',...(legacy ? ['legacyProvenance'] : [])] : collection.ruleVersion === 'w4a-new-collection-v1' ? ['request','rawResponse','collectionEvidence'] : fail('Unknown collection lifecycle')
    if (refs.length !== names.length || names.some(name => !refs.some(r => r.field === name)) || refs.some(r => r.sealed !== 1)) fail('Invalid sealed collection field set')
    for (const ref of refs) {
      const archive = db.select().from(schema.platformArchiveValue).where(eq(schema.platformArchiveValue.id,ref.archiveId)).get()
      if (!archive || (archive.storageClass === 'null' ? archive.bytes !== null || archive.byteLength !== null || archive.sha256 !== null : !Buffer.isBuffer(archive.bytes) || archive.bytes.length !== archive.byteLength || digest(archive.bytes) !== archive.sha256)) fail('Missing or drifted collection archive')
    }
    const expected = offline && ['legacy_supplement','conflict'].includes(collection.provenanceState)
    if (Boolean(legacy) !== expected) fail('Contradictory original provenance lifecycle')
    if (!legacy) continue
    const archive = db.select().from(schema.platformArchiveValue).where(eq(schema.platformArchiveValue.id,legacy.archiveId)).get()!
    if (archive.storageClass !== 'blob' || !archive.bytes) fail('Invalid T04 archive storage')
    for (const table of ['platform_observation_archive_ref','platform_version_archive_ref']) if (t.prepare(`SELECT 1 FROM ${table} WHERE archive_id=?`).get(legacy.archiveId)) fail('Cross-owner T04 archive')
    if (t.prepare('SELECT 1 FROM platform_collection_archive_ref WHERE archive_id=? AND (owner_id<>? OR field<>?)').get(legacy.archiveId,collection.id,'legacyProvenance') || t.prepare('SELECT 1 FROM platform_observation_fingerprint_basis WHERE input_archive_id=?').get(legacy.archiveId)) fail('Cross-owner T04 archive')
    const cells = envelope(archive.bytes)
    const queryId = integer(cells[0],1)
    if (queryId !== alias.oldId) fail('T04 original query alias mismatch')
    const original = rowSnapshot(t,'platform_query_legacy_provenance','query_id',queryId,[...fields])
    if (!isDeepStrictEqual(cells,original)) fail('Original T04 eight cells differ')
    // These columns are copied as literal original TEXT/INTEGER, never inferred from JSON.
    const sourceIdentity = text(cells[1]), sourceSha256 = text(cells[2]), segmentIndex = integer(cells[3],0), inputFingerprint = text(cells[5]), importBatchId = integer(cells[6],1), createdAt = text(cells[7])
    if (!sourceIdentity.length || sourceIdentity.length > 2000 || !/^[a-f0-9]{64}$/.test(sourceSha256) || !/^[a-f0-9]{64}$/.test(inputFingerprint) || !['text','blob'].includes(cells[4]?.storageClass ?? '')) fail('Unsupported original provenance metadata')
    const key = `${sourceSha256}:${segmentIndex}`
    if (keys.has(key)) fail('Duplicate provenance source identity')
    keys.add(key); oldIds.push(queryId)
    result.push({collectionId:collection.id,origin:'t04_envelope',sourceIdentity,sourceSha256,segmentIndex,inputFingerprint,importBatchId,createdAt,archiveId:legacy.archiveId})
  }
  const originalIds = (t.prepare('SELECT query_id FROM platform_query_legacy_provenance ORDER BY query_id').all() as {query_id:number}[]).map(r => r.query_id)
  if (!isDeepStrictEqual(oldIds.sort((a,b)=>a-b),originalIds)) fail('Whole provenance PK set differs')
  const relationAliases = t.prepare('SELECT a.old_id,o.id FROM platform_legacy_relation_alias a LEFT JOIN platform_business_observation o ON o.id=a.observation_id').all() as {old_id:number;id:number|null}[]
  const observations = t.prepare('SELECT id FROM platform_business_observation ORDER BY id').all() as {id:number}[]
  if (relationAliases.length !== observations.length || relationAliases.some(a => !Number.isSafeInteger(a.old_id) || a.old_id < 1 || a.id === null) || new Set(relationAliases.map(a=>a.id)).size !== observations.length) fail('Whole observation alias set differs')
  return result
}
/** Full existing facts and logs, excluding only this phase's new table/log entries. */
function originalDigest(t: Database.Database, runId: string) {
  const hash = createHash('sha256')
  projectionManifest(t,line => { if (JSON.parse(line).table !== provenanceTable) hash.update(line+'\n') })
  for (const name of ['platform_migration_run','platform_migration_checkpoint']) hash.update(JSON.stringify(t.prepare(`SELECT * FROM ${name} WHERE run_id<>? ORDER BY 1,2,3`).all(runId)))
  hash.update(JSON.stringify(t.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()))
  return hash.digest('hex')
}
export type LegacyProvenanceOptions = { source: string; target: string; runId: string; batchSize?: number; preflightOnly?: boolean; beforeCommit?: (stage: 'schema'|'batch'|'promotion') => void }
export function indexLegacyProvenance(options: LegacyProvenanceOptions) {
  const size = options.batchSize ?? 100
  if (!options.runId || !Number.isSafeInteger(size) || size < 1 || size > 1000) fail('Invalid provenance run/batch size')
  const source = realpathSync(options.source), target = realpathSync(options.target), ss = statSync(source), ts = statSync(target)
  if (source === target || (ss.dev === ts.dev && ss.ino === ts.ino)) fail('Distinct isolated source/target required')
  if (![ss,ts].every(s => s.isFile() && s.nlink === 1)) fail('Independent regular source/target required')
  for (const path of [source,target]) {
    for (const suffix of ['-wal','-journal']) if (existsSync(path+suffix) && statSync(path+suffix).size) fail('Standalone fixed snapshot required')
    const disk = statfsSync(dirname(path)); if (disk.bavail*disk.bsize < 8*1024**3) fail('Disk floor 8GiB')
  }
  return withFrozenSource(source, frozen => {
    const s = frozen.database
    requireDifferenceReferencesReady(s)
    const rows = inventory(s), snapshot = fileHash(frozen.fd), sourceSchema = schemaHash(s), manifest = originalDigest(s,options.runId)
    // Construct the exact expected successor catalog without touching either disk database.
    const model = new Database(':memory:')
    let expectedSchema: string
    try {
      for (const row of s.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name").all() as {sql:string}[]) model.exec(row.sql)
      installLegacyProvenance(model,hasReconcileSlotCapture(s)); expectedSchema = schemaHash(model)
    } finally { model.close() }
    const t = new Database(target,{fileMustExist:true,readonly:options.preflightOnly ?? false}), db = drizzle(t,{schema}), runs = schema.platformMigrationRun, cp = schema.platformMigrationCheckpoint, p = schema.platformCollectionLegacyProvenance
    const binding = {runId:options.runId,sourceSnapshotSha256:snapshot,sourceSchemaHash:sourceSchema,sourceManifestSha256:manifest,targetSchemaVersion:expectedSchema,transformVersion:LEGACY_PROVENANCE_TRANSFORM}
    const prefix = (count:number) => digest(JSON.stringify(rows.slice(0,count)))
    const checkpoint = (count:number) => ({runId:options.runId,phase:'collection-provenance',sourceTable:provenanceTable,lastOldId:rows[count-1]?.collectionId ?? 0,copiedCount:count,batchDigest:prefix(count)})
    const frozenCheck = () => { assertFrozenSource(frozen,source); if (fileHash(frozen.fd) !== snapshot) fail('Frozen predecessor drift') }
    try {
      health(t)
      let run = db.select().from(runs).where(eq(runs.runId,options.runId)).get()
      if (!run) {
        requireDifferenceReferencesReady(t)
        if (schemaHash(t) !== sourceSchema || originalDigest(t,options.runId) !== manifest || db.select().from(runs).where(eq(runs.runId,options.runId)).get()) fail('Target must be unchanged independent predecessor copy')
        if (options.preflightOnly) { frozenCheck(); return {state:'ready' as const,rows:rows.length,version:LEGACY_PROVENANCE_VERSION} }
        t.transaction(() => {
          installLegacyProvenance(t,hasReconcileSlotCapture(s))
          db.insert(runs).values({...binding,state:'running'}).run()
          db.insert(cp).values(checkpoint(0)).run()
          options.beforeCommit?.('schema')
          frozenCheck()
        }).immediate()
        run = db.select().from(runs).where(eq(runs.runId,options.runId)).get()!
      }
      const {state,...stored} = run
      if (!isDeepStrictEqual(stored,binding) || schemaHash(t) !== expectedSchema) fail('Provenance run/source/schema binding drift')
      const checkpoints = db.select().from(cp).where(eq(cp.runId,options.runId)).all()
      const saved = checkpoints[0]
      if (checkpoints.length !== 1 || !saved || saved.copiedCount > rows.length || !isDeepStrictEqual(saved,checkpoint(saved.copiedCount))) fail('Provenance checkpoint drift')
      const verifyRows = (count:number, complete:boolean) => {
        for (const row of rows.slice(0,count)) if (!isDeepStrictEqual(db.select().from(p).where(eq(p.collectionId,row.collectionId)).get(),row)) fail('Frozen historical metadata drift')
        if (!complete && db.select().from(p).all().length !== count) fail('Unexpected metadata during offline indexing')
      }
      verifyRows(saved.copiedCount,state === 'complete')
      if (state === 'complete') {
        requireLegacyProvenanceReady(t)
        if (saved.copiedCount !== rows.length) fail('Incomplete historical checkpoint')
        // Verify only frozen historical owners. New collections/supplements/receipts are lawful.
        for (const collection of s.prepare('SELECT id FROM platform_collection ORDER BY id').all() as {id:number}[]) {
          const id = collection.id
          if (!isDeepStrictEqual(rowSnapshot(s,'platform_collection','id',id),rowSnapshot(t,'platform_collection','id',id))) fail('Frozen historical collection bytes drift')
          const alias = s.prepare('SELECT old_id FROM platform_legacy_query_alias WHERE collection_id=?').get(id) as {old_id:number}
          if (!isDeepStrictEqual(rowSnapshot(s,'platform_legacy_query_alias','old_id',alias.old_id),rowSnapshot(t,'platform_legacy_query_alias','old_id',alias.old_id))) fail('Frozen historical alias drift')
          const readRefs = (db: Database.Database) => db.prepare('SELECT * FROM platform_collection_archive_ref WHERE owner_id=? ORDER BY field').all(id)
          if (!isDeepStrictEqual(readRefs(s),readRefs(t))) fail('Frozen historical ref drift')
          for (const ref of s.prepare('SELECT archive_id FROM platform_collection_archive_ref WHERE owner_id=?').all(id) as {archive_id:number}[]) {
            if (!isDeepStrictEqual(rowSnapshot(s,'platform_archive_value','id',ref.archive_id),rowSnapshot(t,'platform_archive_value','id',ref.archive_id))) fail('Frozen historical archive bytes drift')
          }
        }
        for (const row of rows) {
          const alias = s.prepare('SELECT old_id FROM platform_legacy_query_alias WHERE collection_id=?').get(row.collectionId) as {old_id:number}
          if (!isDeepStrictEqual(rowSnapshot(s,'platform_query_legacy_provenance','query_id',alias.old_id),rowSnapshot(t,'platform_query_legacy_provenance','query_id',alias.old_id))) fail('Frozen historical eight cells drift')
        }
        frozenCheck()
        return {state:'complete' as const,rows:rows.length,version:LEGACY_PROVENANCE_VERSION}
      }
      if (t.pragma('user_version',{simple:true}) !== 71612 || originalDigest(t,options.runId) !== manifest) fail('Running predecessor facts drift')
      if (options.preflightOnly) { frozenCheck(); return {state:'ready' as const,rows:rows.length,version:LEGACY_PROVENANCE_VERSION} }
      for (let offset=saved.copiedCount; offset<rows.length; offset+=size) t.transaction(() => {
        for (const row of rows.slice(offset,offset+size)) db.insert(p).values(row).run()
        db.update(cp).set(checkpoint(Math.min(offset+size,rows.length))).where(eq(cp.runId,options.runId)).run()
        options.beforeCommit?.('batch'); frozenCheck()
      }).immediate()
      t.transaction(() => {
        verifyRows(rows.length,false)
        if (!isDeepStrictEqual(inventory(t),rows) || originalDigest(t,options.runId) !== manifest || schemaHash(t) !== expectedSchema) fail('Final provenance PK/bytes/schema drift')
        health(t); frozenCheck()
        t.pragma(`user_version=${LEGACY_PROVENANCE_VERSION}`)
        db.update(runs).set({state:'complete'}).where(eq(runs.runId,options.runId)).run()
        options.beforeCommit?.('promotion')
      }).immediate()
      return {state:'complete' as const,rows:rows.length,version:LEGACY_PROVENANCE_VERSION}
    } finally { t.close() }
  })
}
