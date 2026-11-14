import { completeUpgradeActive, upgradeIntegrityGate, upgradeForeignKeyFailures, upgradeSnapshotHash } from './integrity-policy'
/** T04 offline upgrade boundary. Never import this module from runtime code. */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync, statfsSync, openSync, readSync, closeSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { and, asc, eq, gt, lte, max, sql, getTableColumns } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { bindArchive, bindLegacyAlias, insertArchiveValue, reserveLegacyIds, sealArchiveOwner } from '../lib/platform/immutable-archive'
import { RECONCILE_SLOT_T04 } from '../lib/platform/reconcile-slot-capture'
import { hasReconcileSlotCapture, requireReconcileSlotSchema } from './reconcile-slot-schema'
import { captureSourceSlot, storeSlotCapture, readSlotCapture } from './reconcile-slot-capture'

export const TRANSFORM_VERSION = 't04-collection-v1'
const phase = 'collections', sourceTable = 'platform_query'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function id(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Unsafe source identity')
  return value
}
/** Read-only rollback-journal shared lock; never change the source journal mode. */
export function beginFrozenSource(s: Database.Database) {
  s.exec('BEGIN')
  s.prepare('select count(*) from sqlite_schema').get()
  const mode = s.pragma('journal_mode', { simple: true })
  if (mode !== 'delete' && mode !== 'truncate' && mode !== 'persist') throw new Error('Frozen rollback-journal source required; WAL is unsupported')
  const db = drizzle(s, { schema })
  for (const table of [schema.platformQuery, schema.platformRelation]) {
    const invalid = db.select({ id: table.id }).from(table).where(sql`typeof(${table.id}) <> 'integer' OR ${table.id} <= 0 OR ${table.id} > ${Number.MAX_SAFE_INTEGER}`).limit(1).get()
    if (invalid) throw new Error('Unsafe source identity')
  }
}
export type FrozenSource = { path: string, database: Database.Database, fd: number }
const activeSources = new WeakSet<FrozenSource>()
/** Keep every source descriptor open: POSIX close on the inode releases process locks. */
export function withFrozenSource<T>(path: string, action: (source: FrozenSource) => T): T {
  const resolved = realpathSync(path), fd = openSync(resolved, 'r')
  let database: Database.Database | undefined
  try {
    database = new Database(resolved, { readonly: true, fileMustExist: true })
    beginFrozenSource(database)
    const source = { path: resolved, database, fd }
    activeSources.add(source)
    try { return action(source) } finally { activeSources.delete(source) }
  } finally { try { database?.close() } finally { closeSync(fd) } }
}
export function fileHash(fd: number, force = false) {
  return upgradeSnapshotHash(fd, () => {
  const h = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024)
  let size: number, offset = 0
  while ((size = readSync(fd, chunk, 0, chunk.length, offset)) > 0) {
    h.update(chunk.subarray(0, size)); offset += size
  }
  return h.digest('hex')
  }, force)
}
export function schemaHash(s: Database.Database) {
  return hash(JSON.stringify(s.prepare("select type,name,tbl_name,sql from sqlite_schema where name not like 'sqlite_%' order by type,name").all()))
}
const legacyTables = ['platform_query', 'platform_query_legacy_provenance', 'platform_query_title_scope', 'platform_query_title_scope_error'] as const
/** SQLite byte/storage infrastructure exception. No JSON serialization of original values. */
export function manifest(s: Database.Database, emit?: (record: string) => void, capture = false) {
  const h = createHash('sha256'), counts: Record<string, number> = {}
  for (const table of [...legacyTables,...(capture ? ['platform_relation'] as const : [])]) {
    const columns = s.prepare(`pragma table_info(${table})`).all() as { name: string }[]
    const fields = columns.map(c => c.name).filter(c => c !== 'collection_id')
    const key = table === 'platform_query' || table === 'platform_relation' ? 'id' : 'query_id'
    const projection = fields.flatMap((c, i) => [`typeof("${c}") k${i}`, `hex(cast("${c}" as blob)) b${i}`]).join(',')
    let count = 0
    for (const row of s.prepare(`select ${projection} from ${table} order by ${key}${table === 'platform_query_title_scope' ? ',rdjb' : ''}`).iterate()) {
      const cells = row as Record<string, string>
      const line = JSON.stringify({ table, fields: fields.map((name,i) => ({ name, storageClass: cells[`k${i}`], hex: cells[`b${i}`], byteLength: cells[`k${i}`] === 'null' ? null : cells[`b${i}`]!.length / 2, sha256: cells[`k${i}`] === 'null' ? null : hash(Buffer.from(cells[`b${i}`]!, 'hex')) })) })
      h.update(line + '\n'); emit?.(line); count++
    }
    counts[table] = count
  }
  return { digest: h.digest('hex'), counts }
}
type Db = BetterSQLite3Database<typeof schema>
function targetRow(db: Db, collectionId: number, capture?: unknown) {
  const collection = db.select().from(schema.platformCollection).where(eq(schema.platformCollection.id, collectionId)).get()
  const pages = db.select().from(schema.platformCollectionPage).where(eq(schema.platformCollectionPage.collectionId, collectionId)).orderBy(asc(schema.platformCollectionPage.ordinal)).all()
  const conditions = db.select().from(schema.platformCollectionCondition).where(eq(schema.platformCollectionCondition.collectionId, collectionId)).orderBy(asc(schema.platformCollectionCondition.name)).all()
  const unfinished = db.select().from(schema.platformCollectionUnfinished).where(eq(schema.platformCollectionUnfinished.collectionId, collectionId)).orderBy(asc(schema.platformCollectionUnfinished.ordinal)).all()
  const refs = db.select().from(schema.platformCollectionArchiveRef).innerJoin(schema.platformArchiveValue, eq(schema.platformArchiveValue.id, schema.platformCollectionArchiveRef.archiveId)).where(eq(schema.platformCollectionArchiveRef.ownerId, collectionId)).orderBy(asc(schema.platformCollectionArchiveRef.field)).all()
  const alias = db.select().from(schema.platformLegacyQueryAlias).where(eq(schema.platformLegacyQueryAlias.oldId, collectionId)).get()
  const scope = db.select().from(schema.platformQueryTitleScope).where(eq(schema.platformQueryTitleScope.queryId, collectionId)).orderBy(asc(schema.platformQueryTitleScope.rdjb)).all()
  const error = db.select().from(schema.platformQueryTitleScopeError).where(eq(schema.platformQueryTitleScopeError.queryId, collectionId)).get()
  const coreBytes = db.select({ value: sql<string>`json_array(${sql.join(Object.values(getTableColumns(schema.platformCollection)).flatMap(c => [sql`typeof(${c})`, sql`hex(cast(${c} as blob))`]), sql`,`)})` }).from(schema.platformCollection).where(eq(schema.platformCollection.id, collectionId)).get()
  const row = { collection, coreBytes, pages, conditions, unfinished, refs, alias, scope, error }
  return capture === undefined ? row : {...row,capture}
}
const chain = (previous: string, value: unknown) => hash(previous + '\n' + JSON.stringify(value))
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
const text = (value: unknown) => typeof value === 'string' ? value : null
const integer = (value: unknown, min = 0) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : null
function parsed(s: Database.Database, bytes: Buffer | null): { state: 'absent' | 'invalid' | 'valid', value: Record<string, unknown> } {
  if (bytes !== null && !Buffer.from(bytes.toString('utf8')).equals(bytes)) return { state: 'invalid', value: {} }
  if (bytes === null) return { state: 'absent' as const, value: {} }
  const valid = s.prepare('select json_valid(?,2) valid').get(bytes) as { valid: number }
  if (!valid.valid) return { state: 'invalid' as const, value: {} }
  const normalized = s.prepare('select json(?) value').get(bytes) as { value: string }
  const value: unknown = JSON.parse(normalized.value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'invalid' as const, value: {} }
  return { state: 'valid' as const, value: object(value) }
}
function raw(s: Database.Database, table: 'platform_query' | 'platform_query_legacy_provenance', column: string, oldId: number) {
  const key = table === 'platform_query' ? 'id' : 'query_id'
  const row = s.prepare(`select typeof("${column}") kind,cast("${column}" as blob) bytes from ${table} where ${key}=?`).get(oldId) as { kind: string, bytes: Buffer | null } | undefined
  if (!row) return null
  if (row.kind !== 'null' && row.kind !== 'text' && row.kind !== 'blob') throw new Error('Unsupported archived storage class')
  return row.kind === 'null' ? { storageClass: 'null' as const, bytes: null, createdAt: null } : { storageClass: row.kind, bytes: row.bytes!, createdAt: null } as { storageClass: 'text' | 'blob', bytes: Buffer, createdAt: null }
}
function exactText(s: Database.Database, column: string, oldId: number) {
  const input = raw(s, 'platform_query', column, oldId)!
  return input.storageClass === 'null' ? sql`NULL` : input.storageClass === 'text' ? sql`cast(${input.bytes} as text)` : sql`${input.bytes}`
}
/** Fixed provenance row envelope: original per-column storage class and bytes, not reconstructed JSON. */
function provenanceArchive(s: Database.Database, oldId: number) {
  const fields = ['query_id','source_identity','source_sha256','segment_index','collection','input_fingerprint','import_batch_id','created_at']
  const chunks: Buffer[] = [Buffer.from('T04-PROVENANCE\n')]
  for (const name of fields) {
    const row = s.prepare(`select typeof("${name}") kind,cast("${name}" as blob) bytes from platform_query_legacy_provenance where query_id=?`).get(oldId) as {kind:string,bytes:Buffer|null} | undefined
    if (!row) return null
    const bytes = row.bytes ?? Buffer.alloc(0)
    chunks.push(Buffer.from(`${name} ${row.kind} ${bytes.length}\n`), bytes, Buffer.from('\n'))
  }
  return { storageClass: 'blob' as const, bytes: Buffer.concat(chunks), createdAt: null }
}
function transfer(s: Database.Database, db: Db, q: Omit<typeof schema.platformQuery.$inferSelect, 'collectionEvidence'>, transform: string) {
  id(q.id)
  const evidenceRaw = raw(s, 'platform_query', 'collection_evidence', q.id)!
  const supplementRaw = raw(s, 'platform_query_legacy_provenance', 'collection', q.id)
  const evidence = parsed(s, evidenceRaw.bytes), supplement = parsed(s, supplementRaw?.bytes ?? null)
  const both = evidence.state !== 'absent' && supplement.state !== 'absent'
  const v = evidence.state !== 'absent' ? evidence.value : supplement.value
  const scope = object(v.titleScope), error = object(v.error), limits = object(v.limits)
  const completeness = v.completeness === 'complete' || v.completeness === 'partial' || v.completeness === 'not_queried' ? v.completeness : 'unknown'
  db.insert(schema.platformCollection).values({
    id: q.id,
    interface: exactText(s,'interface',q.id), queryKey: exactText(s,'query_key',q.id), rdjb: exactText(s,'rdjb',q.id),
    titleCode: exactText(s,'title_code',q.id), queriedAt: exactText(s,'queried_at',q.id), createdAt: exactText(s,'created_at',q.id),
    lastCollectedAt: exactText(s,'last_collected_at',q.id), status: exactText(s,'status',q.id), failureReason: exactText(s,'failure_reason',q.id),
    source: text(v.source), evidenceStatus: text(v.status), completedAt: text(v.completedAt), completeness,
    fullRange: typeof v.fullRange === 'boolean' ? Number(v.fullRange) : null, fetchedCount: integer(v.fetchedCount), declaredTotal: integer(v.declaredTotal), scopeMode: text(scope.mode),
    provenanceState: both ? 'conflict' : evidence.state !== 'absent' ? 'captured' : supplement.state !== 'absent' ? 'legacy_supplement' : 'unknown',
    parseState: evidence.state !== 'absent' ? evidence.state : supplement.state,
    ruleVersion: transform, errorCode: text(error.code), errorMessage: text(error.message),
    maxRequests: integer(limits.maxRequests, 1), maxRows: integer(limits.maxRows, 1), maxDurationMs: integer(limits.maxDurationMs, 1), pageSize: integer(limits.pageSize, 1),
  }).run()
  let successful = 0, known = true
  if (Array.isArray(v.pages)) for (const [ordinal, value] of v.pages.entries()) {
    const p = object(value), count = integer(p.fetchedCount), e = object(p.error)
    const valid = integer(p.page, 1) !== null && count !== null && (p.status === 'success' || ((p.status === 'failed' || p.status === 'auth_failed') && count === 0))
    const next = count === null ? null : integer(successful + count)
    const verified = known && valid && next !== null
    db.insert(schema.platformCollectionPage).values({ collectionId: q.id, ordinal, source: text(p.source), rdjb: text(p.rdjb), pageNo: integer(p.page, 1), maxPage: integer(p.maxPage, 1), maxPagePresent:Object.hasOwn(p,'maxPage')?1:0, fetchedCount: count, declaredTotal: integer(p.declaredTotal), status: text(p.status), errorCode: text(e.code), errorMessage: text(e.message), sequenceStart: verified && p.status === 'success' && count! > 0 ? successful + 1 : null, sequenceEnd: verified && p.status === 'success' && count! > 0 ? next : null, positionState: verified ? 'verified' : 'unknown' }).run()
    if (!verified) known = false
    if (p.status === 'success' && next !== null) successful = next
  }
  if (Array.isArray(v.unfinished)) for (const [ordinal, value] of v.unfinished.entries()) {
    const u = object(value)
    db.insert(schema.platformCollectionUnfinished).values({ collectionId: q.id, ordinal, source: text(u.source), rdjb: text(u.rdjb), pageNo: integer(u.page, 1) }).run()
  }
  const conditions = object(v.effectiveConditions)
  const names = ['name','uscc','combination','sqsj','rddqrq','whpcyear','whpc','szq','orderField','orderDirection'] as const
  for (const name of names) {
    const c = conditions[name]
    const valueKind = !Object.hasOwn(conditions, name) ? 'absent' : c === null ? 'null' : typeof c === 'string' ? 'text' : typeof c === 'boolean' ? 'boolean' : typeof c === 'number' ? Number.isSafeInteger(c) ? 'integer' : 'real' : Array.isArray(c) ? 'array' : 'object'
    db.insert(schema.platformCollectionCondition).values({ collectionId: q.id, name, valueKind, textValue: text(c), integerValue: typeof c === 'boolean' ? Number(c) : valueKind === 'integer' ? integer(c, -Number.MAX_SAFE_INTEGER) : null }).run()
  }
  // T01 transition: only bind existing rows; never change query PK, membership, errors, triggers.
  db.update(schema.platformQueryTitleScope).set({ collectionId: q.id }).where(eq(schema.platformQueryTitleScope.queryId, q.id)).run()
  db.update(schema.platformQueryTitleScopeError).set({ collectionId: q.id }).where(eq(schema.platformQueryTitleScopeError.queryId, q.id)).run()
  for (const [field, input] of [['collectionEvidence', evidenceRaw], ['rawResponse', raw(s, 'platform_query', 'raw_response', q.id)!], ['legacyProvenance', provenanceArchive(s, q.id)]] as const) {
    if (input) bindArchive(db, { kind: 'collection', ownerId: q.id, field, archiveId: insertArchiveValue(db, input) })
  }
  sealArchiveOwner(db, { kind: 'collection', ownerId: q.id })
  bindLegacyAlias(db, { kind: 'query', oldId: q.id, collectionId: q.id })
}

export type UpgradeOptions = { source: string, target: string, runId: string, batchSize: number, transformVersion?: string, beforeCapture?: (oldId:number) => void, beforeCheckpoint?: (lastOldId: number) => void }
/** Caller supplies frozen offline source and a separate isolated copy at current schema. */
export function upgradeCollections(options: UpgradeOptions, frozenSource?: FrozenSource): {
  lastOldId: number, copiedCount: number, batchDigest: string,
  sourceManifest: ReturnType<typeof manifest>, inheritedForeignKeys: unknown,
  unresolved: { kind: string, oldQueryId: number, reason: string }[],
} {
  const transform = options.transformVersion ?? TRANSFORM_VERSION
  if (transform !== TRANSFORM_VERSION && transform !== RECONCILE_SLOT_T04) throw new Error('Source/schema/transform binding changed; resume refused')
  const capture = transform === RECONCILE_SLOT_T04
  const source = realpathSync(options.source), target = realpathSync(options.target)
  const a = statSync(source), b = statSync(target)
  if (source === target || (a.dev === b.dev && a.ino === b.ino)) throw new Error('Source and target must be distinct isolated files')
  if (!options.runId || !Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1000) throw new Error('Invalid run or batch size')
  for (const path of [source, target]) {
    if (['-wal','-journal'].some(suffix => existsSync(path + suffix) && statSync(path + suffix).size > 0)) throw new Error('Offline frozen files required: WAL present')
    const disk = statfsSync(resolve(path, '..'))
    if (disk.bavail * disk.bsize < 8 * 1024 ** 3) throw new Error('Disk floor 8GiB')
  }
  if (!frozenSource) return withFrozenSource(source, frozen => upgradeCollections(options, frozen))
  if (!activeSources.has(frozenSource) || frozenSource.path !== source || !frozenSource.database.inTransaction) throw new Error('Inactive frozen source')
  const s = frozenSource.database, t = new Database(target, { fileMustExist: true })
  try {
    if (existsSync(source + '-wal') && statSync(source + '-wal').size > 0) throw new Error('Source WAL appeared')
    const initialSnapshotHash = fileHash(frozenSource.fd)
    t.pragma('foreign_keys=ON')
    if (capture) requireReconcileSlotSchema(t)
    else if (hasReconcileSlotCapture(t)) throw new Error('Explicit reconcile capture transform required')
    const db = drizzle(t, { schema }), sourceDb = drizzle(s, { schema })
    const inheritedForeignKeys = upgradeForeignKeyFailures(s)
    const orphan = sourceDb.select({ oldQueryId: schema.platformQueryLegacyProvenance.queryId }).from(schema.platformQueryLegacyProvenance).leftJoin(schema.platformQuery, eq(schema.platformQuery.id, schema.platformQueryLegacyProvenance.queryId)).where(sql`${schema.platformQuery.id} IS NULL`).orderBy(asc(schema.platformQueryLegacyProvenance.queryId)).all()
    const unresolved = orphan.map(row => ({ kind: 'orphan_provenance', oldQueryId: row.oldQueryId, reason: 'Original query owner missing; retained in isolated legacy copy and source manifest' }))
    const frozen = manifest(s,undefined,capture), sourceSchemaHash = schemaHash(s), targetSchemaVersion = schemaHash(t)
    // The transitional scope FK requires the untouched old owners in the isolated target copy.
    if (manifest(t,undefined,capture).digest !== frozen.digest) throw new Error('Target legacy copy differs from frozen source')
    if (fileHash(frozenSource.fd) !== initialSnapshotHash) throw new Error('Source snapshot drift during binding')
    const binding = { runId: options.runId, sourceSnapshotSha256: initialSnapshotHash, sourceSchemaHash, sourceManifestSha256: frozen.digest, targetSchemaVersion, transformVersion: transform }
    const run = db.select().from(schema.platformMigrationRun).where(eq(schema.platformMigrationRun.runId, options.runId)).get()
    if (run) {
      const { state: _state, ...stored } = run
      if (!isDeepStrictEqual(stored, binding)) throw new Error('Source/schema/transform binding changed; resume refused')
    } else {
      if (db.select().from(schema.platformMigrationRun).get() || db.select().from(schema.platformCollection).get() || db.select().from(schema.platformLegacyQueryAlias).get()) throw new Error('Unbound target is not empty')
      db.transaction(tx => {
        tx.insert(schema.platformMigrationRun).values({ ...binding, state: 'running' }).run()
        reserveLegacyIds(tx, { query: sourceDb.select({ id: max(schema.platformQuery.id) }).from(schema.platformQuery).get()?.id ?? 0, relation: sourceDb.select({ id: max(schema.platformRelation.id) }).from(schema.platformRelation).get()?.id ?? 0 })
      })
    }
    const key = and(eq(schema.platformMigrationCheckpoint.runId, options.runId), eq(schema.platformMigrationCheckpoint.phase, phase), eq(schema.platformMigrationCheckpoint.sourceTable, sourceTable))
    const cp = db.select().from(schema.platformMigrationCheckpoint).where(key).get()
    if (run?.state === 'complete' && completeUpgradeActive()) {
      const count = cp?.copiedCount ?? 0
      if (count !== frozen.counts.platform_query || db.select({ n: sql<number>`count(*)` }).from(schema.platformCollection).get()?.n !== count
        || db.select({ n: sql<number>`count(*)` }).from(schema.platformLegacyQueryAlias).get()?.n !== count) throw new Error('Completed collection checkpoint count drift')
      return { lastOldId: cp?.lastOldId ?? 0, copiedCount: count, batchDigest: cp?.batchDigest ?? '', sourceManifest: frozen, inheritedForeignKeys, unresolved }
    }
    let lastOldId = cp?.lastOldId ?? 0, copiedCount = 0, digest = ''
    // Replay validation covers every migrated row, including archive bytes and child sets.
    let validatedId = 0
    while (validatedId < lastOldId) {
      const rows = sourceDb.select({ id: schema.platformQuery.id }).from(schema.platformQuery).where(and(gt(schema.platformQuery.id, validatedId), lte(schema.platformQuery.id, lastOldId))).orderBy(asc(schema.platformQuery.id)).limit(options.batchSize).all()
      if (!rows.length) throw new Error('Checkpoint source cursor missing')
      for (const q of rows) {
        id(q.id)
        if (capture && !isDeepStrictEqual(readSlotCapture(t,q.id),captureSourceSlot(s,t,q.id))) throw new Error('Reconcile capture input drift')
        digest = chain(digest, targetRow(db, q.id,capture ? readSlotCapture(t,q.id) : undefined)); copiedCount++
      }
      validatedId = rows.at(-1)!.id
    }
    if (cp && (cp.copiedCount !== copiedCount || cp.batchDigest !== digest)) throw new Error('Target/checkpoint drift; resume refused')
    if (db.select({ n: sql<number>`count(*)` }).from(schema.platformCollection).get()?.n !== copiedCount) throw new Error('Unexpected target collection set')
    // Explicit selection avoids Drizzle JSON mode decoding before the upgrade boundary.
    const queryColumns = { id: schema.platformQuery.id, interface: schema.platformQuery.interface, queryKey: schema.platformQuery.queryKey, rdjb: schema.platformQuery.rdjb, titleCode: schema.platformQuery.titleCode, queriedAt: schema.platformQuery.queriedAt, lastCollectedAt: schema.platformQuery.lastCollectedAt, status: schema.platformQuery.status, failureReason: schema.platformQuery.failureReason, rawResponse: schema.platformQuery.rawResponse, createdAt: schema.platformQuery.createdAt }
    while (true) {
      const rows = sourceDb.select(queryColumns).from(schema.platformQuery).where(gt(schema.platformQuery.id, lastOldId)).orderBy(asc(schema.platformQuery.id)).limit(options.batchSize).all()
      if (!rows.length) break
      const result = db.transaction(tx => {
        let nextDigest = digest
        for (const q of rows) {
          transfer(s, tx, q,transform)
          if (capture) {
            options.beforeCapture?.(q.id)
            storeSlotCapture(t,q.id,captureSourceSlot(s,t,q.id))
          }
          nextDigest = chain(nextDigest, targetRow(tx, q.id,capture ? readSlotCapture(t,q.id) : undefined))
        }
        const nextId = rows.at(-1)!.id
        options.beforeCheckpoint?.(nextId)
        if (fileHash(frozenSource.fd) !== binding.sourceSnapshotSha256) throw new Error('Source snapshot drift before checkpoint')
        const values = { runId: options.runId, phase, sourceTable, lastOldId: nextId, copiedCount: copiedCount + rows.length, batchDigest: nextDigest }
        if (tx.select().from(schema.platformMigrationCheckpoint).where(key).get()) tx.update(schema.platformMigrationCheckpoint).set(values).where(key).run()
        else tx.insert(schema.platformMigrationCheckpoint).values(values).run()
        return { nextId, nextDigest }
      }, { behavior: 'immediate' })
      lastOldId = result.nextId; digest = result.nextDigest; copiedCount += rows.length
    }
    if (fileHash(frozenSource.fd) !== binding.sourceSnapshotSha256 || manifest(s,undefined,capture).digest !== frozen.digest || schemaHash(s) !== sourceSchemaHash) throw new Error('Source drift')
    if (!isDeepStrictEqual(upgradeForeignKeyFailures(t), inheritedForeignKeys) || !upgradeIntegrityGate(t)) throw new Error('Target integrity failure')
    const query = schema.platformQuery, alias = schema.platformLegacyQueryAlias, collection = schema.platformCollection
    const missing = db.select({ id: query.id }).from(query)
      .leftJoin(alias, eq(alias.oldId, query.id)).leftJoin(collection, eq(collection.id, alias.collectionId))
      .where(sql`${alias.oldId} IS NULL OR ${collection.id} IS NULL OR ${alias.collectionId} <> ${query.id}`).limit(1).get()
    const aliasCount = db.select({ n: sql<number>`count(*)` }).from(alias).get()!.n
    const collectionCount = db.select({ n: sql<number>`count(*)` }).from(collection).get()!.n
    if (missing || copiedCount !== frozen.counts.platform_query || aliasCount !== copiedCount || collectionCount !== copiedCount) throw new Error('Incomplete source PK coverage')
    db.update(schema.platformMigrationRun).set({ state: 'complete' }).where(eq(schema.platformMigrationRun.runId, options.runId)).run()
    return { lastOldId, copiedCount, batchDigest: digest, sourceManifest: frozen, inheritedForeignKeys, unresolved }
  } finally { t.close() }
}

/** Guard validation shared only by offline upgrade phases. */
export function assertFrozenSource(source: FrozenSource, path: string) {
  if (!activeSources.has(source) || source.path !== realpathSync(path) || !source.database.inTransaction) throw new Error('Inactive frozen source')
}
