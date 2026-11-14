import { upgradeIntegrityGate } from './integrity-policy'
/** Explicit offline finalization only. Never imported by runtime initialization. */
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  assertFinalPlatformRuntime, assertNoRetiredPlatformSchema,
  PLATFORM_RETIREMENT_RULE, PLATFORM_RUNTIME_VERSION, RETIRED_PLATFORM_TABLES,
} from '../db/schema-phase'
import { requireLegacyProvenanceReady } from '../lib/platform/legacy-provenance-catalog'
import { migrationFinished } from '../lib/platform/migration-readiness'
import { rowSnapshot } from '../lib/platform/sqlite-row-cells'
import { upgradeEnterpriseMergeIdentity } from './enterprise-merge'
import { z } from 'zod'
import { installPlatformArchiveLookupIndexes } from './platform-archive-indexes'
import { captureCollectionPageShape } from './collection-page-shape'

const requiredTransforms = [
  't05a-observation-v3', 't05c-independent-observation-v1',
  'w4a-pre-collection-scopes-v1', 'observation-fingerprint-basis-v1',
  'apply-exact-stored-offline-v1', 'candidate-scope-offline-v1',
  'recognized-stored-title-v1', 'recognized-witness-offline-v1',
  'process-exact-stored-offline-v1', 'h1c-correspondence-observation-v1',
  'difference-evidence-reference-v1', 'collection-legacy-provenance-v1',
  'reconcile-slot-capture-v1',
] as const
const hasTable = (db: Database.Database, table: string) => !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const archiveValueShape = z.object({
  id:z.number().int().positive(), storage_class:z.enum(['null','text','blob']),
  bytes:z.instanceof(Buffer).nullable(), byte_length:z.number().int().nonnegative().nullable(),
  sha256:z.string().nullable(), sqlite_kind:z.string(),
})
/** One bounded pass over every payload, including fingerprint and version inputs. */
function auditArchiveValues(db:Database.Database) {
  for(const row of db.prepare('SELECT id,storage_class,bytes,byte_length,sha256,typeof(bytes) sqlite_kind FROM platform_archive_value ORDER BY id').iterate()) {
    const value=archiveValueShape.parse(row)
    if(value.storage_class==='null') {
      if(value.sqlite_kind!=='null'||value.bytes!==null||value.byte_length!==null||value.sha256!==null)throw new Error(`Invalid null archive: ${value.id}`)
    } else if(value.sqlite_kind!=='blob'||!value.bytes||value.byte_length!==value.bytes.length||value.sha256!==hash(value.bytes)) {
      throw new Error(`Archive content digest mismatch: ${value.id}`)
    }
  }
}
type ArchiveCell = { storage_class: string; bytes: Buffer | null; sealed: number }

function archiveCell(db: Database.Database, kind: 'query' | 'relation' | 'version', oldId: number, field: string) {
  const definition = kind === 'query'
    ? { ref: 'platform_collection_archive_ref', alias: 'platform_legacy_query_alias', key: 'collection_id' }
    : kind === 'relation'
      ? { ref: 'platform_observation_archive_ref', alias: 'platform_legacy_relation_alias', key: 'observation_id' }
      : { ref: 'platform_version_archive_ref', alias: undefined, key: undefined }
  const owner = definition.alias
    ? `(SELECT ${definition.key} FROM ${definition.alias} WHERE old_id=?)` : '?'
  const result = db.prepare(`SELECT a.storage_class,a.bytes,r.sealed FROM ${definition.ref} r
    JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.owner_id=${owner} AND r.field=?`).get(oldId, field) as ArchiveCell | undefined
  if (!result || result.sealed !== 1) throw new Error(`Untransferred legacy archive: ${kind}:${oldId}:${field}`)
  return result
}
function equalArchive(db: Database.Database, kind: 'query' | 'relation' | 'version', oldId: number, field: string, bytes: Buffer | null, storageClass?: string) {
  const target = archiveCell(db, kind, oldId, field)
  if ((storageClass !== undefined && target.storage_class !== storageClass) || (bytes === null ? target.bytes !== null : !Buffer.isBuffer(target.bytes) || !bytes.equals(target.bytes))) {
    throw new Error(`Legacy archive bytes differ: ${kind}:${oldId}:${field}`)
  }
}

/** The old target tables are usually empty: T04/T05 read a separate frozen source.
 * If rows remain, prove their original cells are already represented before DROP. */
function auditLegacyRows(db: Database.Database) {
  for (const [table, kind, fields] of [
    ['platform_query', 'query', [['raw_response', 'rawResponse'], ['collection_evidence', 'collectionEvidence']]],
    ['platform_relation', 'relation', [['raw_fields', 'rawFields'], ['source_text', 'sourceText']]],
  ] as const) {
    if (!hasTable(db, table)) continue
    for (const { id } of db.prepare(`SELECT id FROM ${table} ORDER BY id`).iterate() as Iterable<{ id: number }>) {
      for (const [column, field] of fields) {
        const original = db.prepare(`SELECT typeof(${column}) storage_class,cast(${column} AS blob) bytes FROM ${table} WHERE id=?`).get(id) as { storage_class: string; bytes: Buffer | null }
        equalArchive(db, kind, id, field, original.bytes, original.storage_class)
      }
      if (kind === 'relation') equalArchive(db, kind, id, 'legacyRowSnapshot', Buffer.from(JSON.stringify({
        encoding: 't05a-sqlite-cells-v1', fields: rowSnapshot(db, table, 'id', id),
      })), 'blob')
      else {
        const alias = db.prepare('SELECT collection_id FROM platform_legacy_query_alias WHERE old_id=?').get(id) as { collection_id: number } | undefined
        if (!alias) throw new Error(`Untransferred legacy query: ${id}`)
        const fields = ['interface', 'query_key', 'rdjb', 'title_code', 'queried_at', 'created_at', 'last_collected_at', 'status', 'failure_reason']
        if (JSON.stringify(rowSnapshot(db, table, 'id', id, fields)) !== JSON.stringify(rowSnapshot(db, 'platform_collection', 'id', alias.collection_id, fields))) {
          throw new Error(`Legacy query metadata differs: ${id}`)
        }
      }
    }
  }
  if (!hasTable(db, 'platform_query_legacy_provenance')) return
  for (const { query_id: id } of db.prepare('SELECT query_id FROM platform_query_legacy_provenance').iterate() as Iterable<{ query_id: number }>) {
    const chunks: Buffer[] = [Buffer.from('T04-PROVENANCE\n')]
    for (const field of ['query_id', 'source_identity', 'source_sha256', 'segment_index', 'collection', 'input_fingerprint', 'import_batch_id', 'created_at']) {
      const cell = db.prepare(`SELECT typeof(${field}) kind,cast(${field} AS blob) bytes FROM platform_query_legacy_provenance WHERE query_id=?`).get(id) as { kind: string; bytes: Buffer | null }
      const bytes = cell.bytes ?? Buffer.alloc(0)
      chunks.push(Buffer.from(`${field} ${cell.kind} ${bytes.length}\n`), bytes, Buffer.from('\n'))
    }
    equalArchive(db, 'query', id, 'legacyProvenance', Buffer.concat(chunks), 'blob')
  }
}

/** Retire the stopped sharing experiment only after every referenced logical body
 * equals its sealed owner archive. Orphans are evidence, so remain blocking. */
function auditHistoricalBodies(db: Database.Database) {
  const roots = new Map<number, Buffer>(), leaves = new Set<number>(), referenced = new Set<number>()
  if (hasTable(db, 'platform_body_root')) {
    for (const root of db.prepare('SELECT id,byte_length,digest,sealed,encoding FROM platform_body_root').iterate() as Iterable<{ id: number; byte_length: number; digest: string; sealed: number; encoding: string }>) {
      if (root.sealed !== 1 || root.encoding !== 'utf8-v1') throw new Error(`Untransferred historical body root: ${root.id}`)
      const chunks: Buffer[] = []
      let offset = 0
      for (const part of db.prepare(`SELECT p.logical_start,p.leaf_id,p.byte_length,l.bytes,l.digest,l.encoding,l.byte_length leaf_length
        FROM platform_body_part p JOIN platform_body_leaf l ON l.id=p.leaf_id WHERE p.root_id=? ORDER BY p.logical_start`).iterate(root.id) as Iterable<{ logical_start: number; leaf_id: number; byte_length: number; bytes: Buffer; digest: string; encoding: string; leaf_length: number }>) {
        if (part.logical_start !== offset || !Buffer.isBuffer(part.bytes) || part.bytes.length !== part.byte_length || part.byte_length !== part.leaf_length || part.encoding !== 'utf8-v1' || hash(part.bytes) !== part.digest) throw new Error(`Invalid historical body part: ${root.id}`)
        chunks.push(part.bytes); leaves.add(part.leaf_id); offset += part.byte_length
      }
      const bytes = Buffer.concat(chunks)
      if (!chunks.length || offset !== root.byte_length || hash(bytes) !== root.digest) throw new Error(`Invalid historical body root: ${root.id}`)
      roots.set(root.id, bytes)
    }
  }
  for (const [table, kind] of [
    ['platform_query_body_ref', 'query'], ['platform_relation_body_ref', 'relation'], ['platform_version_body_ref', 'version'],
  ] as const) {
    if (!hasTable(db, table)) continue
    for (const row of db.prepare(`SELECT owner_id,field,root_id FROM ${table}`).iterate() as Iterable<{ owner_id: number; field: string; root_id: number }>) {
      const bytes = roots.get(row.root_id)
      if (!bytes) throw new Error(`Missing historical body root: ${row.root_id}`)
      equalArchive(db, kind, row.owner_id, row.field, bytes)
      referenced.add(row.root_id)
    }
  }
  if (referenced.size !== roots.size) throw new Error('Untransferred orphan historical body root')
  if (hasTable(db, 'platform_body_leaf') && (db.prepare('SELECT count(*) n FROM platform_body_leaf').get() as { n: number }).n !== leaves.size) throw new Error('Untransferred orphan historical body leaf')
}

/** Caller owns the isolated, drained target. FK enforcement is never disabled.
 * Completion and all drops commit atomically; failure leaves every old table. */
export function retirePlatformModel(sqlite: Database.Database) {
  if (sqlite.inTransaction) throw new Error('Platform retirement requires its own offline transaction')
  if (sqlite.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('Platform retirement requires foreign_keys=ON')
  if (hasTable(sqlite, 'platform_runtime_completion')) {
    return sqlite.transaction(() => {
      captureCollectionPageShape(sqlite)
      assertFinalPlatformRuntime(sqlite)
      installPlatformArchiveLookupIndexes(sqlite)
      auditArchiveValues(sqlite)
      if (sqlite.prepare('PRAGMA foreign_key_check').all().length || !upgradeIntegrityGate(sqlite, true)) throw new Error('Retired target integrity validation failed')
      return { state: 'complete' as const, version: PLATFORM_RUNTIME_VERSION }
    }).immediate()
  }
  return sqlite.transaction(() => {
    requireLegacyProvenanceReady(sqlite)
    for (const transform of requiredTransforms) if (!migrationFinished(sqlite, transform)) throw new Error(`Platform retirement prerequisite incomplete: ${transform}`)
    if (!['t04-collection-v1', 't04-collection-reconcile-slot-v2'].some(t => migrationFinished(sqlite, t))
      || !['t05b-source-projections-v1', 't05b-source-projections-v2-status-blob'].some(t => migrationFinished(sqlite, t))) throw new Error('Platform retirement collection/projection migration incomplete')
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Platform retirement starts with foreign key violations')
    auditArchiveValues(sqlite)
    auditLegacyRows(sqlite)
    auditHistoricalBodies(sqlite)
    upgradeEnterpriseMergeIdentity(sqlite)
    captureCollectionPageShape(sqlite)
    const triggers = sqlite.prepare("SELECT name,tbl_name,sql FROM sqlite_schema WHERE type='trigger'").all() as { name: string; tbl_name: string; sql: string }[]
    const oldNames = new RegExp(`\\b(?:${RETIRED_PLATFORM_TABLES.join('|')})\\b`, 'i')
    for (const trigger of triggers) if (oldNames.test(trigger.tbl_name) || oldNames.test(trigger.sql)) {
      sqlite.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`)
    }
    for (const table of RETIRED_PLATFORM_TABLES) if (hasTable(sqlite, table)) sqlite.exec(`DROP TABLE "${table}"`)
    assertNoRetiredPlatformSchema(sqlite)
    installPlatformArchiveLookupIndexes(sqlite)
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length || !upgradeIntegrityGate(sqlite, true)) throw new Error('Platform retirement integrity validation failed')
    sqlite.exec(`CREATE TABLE platform_runtime_completion(
      id INTEGER PRIMARY KEY CHECK(id=1),
      rule TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      completed_at TEXT NOT NULL
    );
    CREATE TRIGGER platform_runtime_completion_no_update BEFORE UPDATE ON platform_runtime_completion
      BEGIN SELECT RAISE(ABORT,'immutable platform runtime completion'); END;
    CREATE TRIGGER platform_runtime_completion_no_delete BEFORE DELETE ON platform_runtime_completion
      BEGIN SELECT RAISE(ABORT,'immutable platform runtime completion'); END;`)
    sqlite.prepare('INSERT INTO platform_runtime_completion(id,rule,schema_version,completed_at) VALUES(1,?,?,?)').run(PLATFORM_RETIREMENT_RULE, PLATFORM_RUNTIME_VERSION, new Date().toISOString())
    assertFinalPlatformRuntime(sqlite)
    return { state: 'complete' as const, version: PLATFORM_RUNTIME_VERSION }
  }).immediate()
}
