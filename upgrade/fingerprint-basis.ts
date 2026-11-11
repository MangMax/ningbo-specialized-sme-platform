/** #724 partial offline candidate, not accepted for migration use.
 * Supports proven legacy-indexed and paired not_indexed only; after-predecessor
 * command/bootstrap recovery is still unsupported and fails closed.
 * Deliberately absent from startup migrations and public routing.
 */
import type Database from 'better-sqlite3'

export function requireFingerprintForeignKeys(t: Database.Database) {
  if(t.pragma('foreign_keys',{simple:true})!==1)throw new Error('fingerprint writes require foreign_keys=ON before entry')
}
const refs=['platform_collection_archive_ref','platform_observation_archive_ref','platform_version_archive_ref'] as const
const expected=[...refs.map(table=>`${table}.archive_id`),'platform_apply_projection.source_archive_id','platform_business_projection.source_archive_id','platform_recognized_projection.source_archive_id','platform_business_record_version.canonical_archive_id'].sort()
export function fingerprintArchiveInventory(t:Database.Database) {
  const tables=t.prepare("select name from sqlite_schema where type='table'").all() as {name:string}[]
  const incoming=tables.flatMap(({name})=>(t.pragma(`foreign_key_list("${name.replaceAll('"','""')}")`) as {table:string,from:string,to:string}[]).filter(f=>f.table==='platform_archive_value').map(f=>`${name}.${f.from}${f.to==='id'?'':`->${f.to}`}`)).sort()
  const allowed=t.prepare("select 1 from sqlite_schema where name='platform_observation_fingerprint_basis'").get()?[...expected,'platform_observation_fingerprint_basis.input_archive_id'].sort():expected
  if(JSON.stringify(incoming)!==JSON.stringify(allowed))throw new Error('Unexpected archive FK owner inventory: '+JSON.stringify(incoming))
  return incoming
}
export function installFingerprintBasis(t:Database.Database) {
  requireFingerprintForeignKeys(t)
  fingerprintArchiveInventory(t)
  t.exec(`CREATE TABLE platform_observation_fingerprint_basis(
    observation_id INTEGER PRIMARY KEY NOT NULL CONSTRAINT platform_fingerprint_basis_safe_id CHECK(typeof(observation_id)='integer' AND observation_id BETWEEN 1 AND 9007199254740991),
    scheme TEXT NOT NULL CONSTRAINT platform_fingerprint_basis_scheme CHECK(scheme IN ('legacy-indexed-v1','legacy-bootstrap-v1','target-command-v1','uncaptured')),
    input_archive_id INTEGER UNIQUE REFERENCES platform_archive_value(id) ON DELETE RESTRICT,
    FOREIGN KEY(observation_id) REFERENCES platform_business_observation(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT platform_fingerprint_basis_input CHECK((scheme='uncaptured' AND input_archive_id IS NULL) OR (scheme<>'uncaptured' AND input_archive_id IS NOT NULL))
  );
  CREATE TRIGGER platform_fingerprint_basis_no_update BEFORE UPDATE ON platform_observation_fingerprint_basis BEGIN SELECT RAISE(ABORT,'immutable fingerprint basis'); END;
  CREATE TRIGGER platform_fingerprint_basis_no_delete BEFORE DELETE ON platform_observation_fingerprint_basis BEGIN SELECT RAISE(ABORT,'immutable fingerprint basis'); END;
  CREATE TRIGGER platform_fingerprint_basis_insert BEFORE INSERT ON platform_observation_fingerprint_basis WHEN
    EXISTS(SELECT 1 FROM platform_observation_fingerprint_basis WHERE observation_id=NEW.observation_id OR input_archive_id=NEW.input_archive_id)
    OR (NEW.input_archive_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM platform_archive_value WHERE id=NEW.input_archive_id AND storage_class='blob' AND typeof(bytes)='blob')
      ${refs.map(r=>`OR EXISTS(SELECT 1 FROM ${r} WHERE archive_id=NEW.input_archive_id)`).join('\n')}))
    BEGIN SELECT RAISE(ABORT,'fingerprint archive collision or invalid BLOB'); END;`)
  for(const ref of refs)t.exec(`CREATE TRIGGER ${ref}_fingerprint_exclusive BEFORE INSERT ON ${ref} WHEN EXISTS(SELECT 1 FROM platform_observation_fingerprint_basis WHERE input_archive_id=NEW.archive_id) BEGIN SELECT RAISE(ABORT,'fingerprint archive exclusive'); END;`)
  fingerprintArchiveInventory(t)
}
/** Installed only after historical recovery, in the same immediate transaction. */
export function installFingerprintBarrier(t:Database.Database) {
  requireFingerprintForeignKeys(t)
  t.exec(`CREATE TRIGGER platform_observation_fingerprint_insert BEFORE INSERT ON platform_business_observation
    WHEN NEW.identity_state<>'not_indexed' AND NOT EXISTS(SELECT 1 FROM platform_observation_fingerprint_basis WHERE observation_id=NEW.id AND scheme='target-command-v1')
    BEGIN SELECT RAISE(ABORT,'captured target-command basis required'); END;
  CREATE TRIGGER platform_observation_fingerprint_bootstrap BEFORE UPDATE ON platform_business_observation
    WHEN OLD.identity_state='not_indexed' AND NEW.identity_state<>'not_indexed' AND NOT EXISTS(SELECT 1 FROM platform_observation_fingerprint_basis WHERE observation_id=NEW.id AND scheme='legacy-bootstrap-v1')
    BEGIN SELECT RAISE(ABORT,'captured legacy-bootstrap basis required'); END;`)
}

import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync, statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import SQLite from 'better-sqlite3'
import { and, asc, count, eq, ne } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { targetSchema as s } from '../lib/platform/target-schema'
import { withFrozenSource, assertFrozenSource, fileHash, schemaHash, type FrozenSource } from './collections'
import { projectionManifest } from './projections'
import * as expand from '../db/schema'
import { canonicalPlatformJson, PLATFORM_PROJECTION_RULE } from '../lib/platform/observation-plan'
import { insertArchiveValue } from '../lib/platform/immutable-archive'
import { rowSnapshot } from './observations'
import { TextDecoder } from 'node:util'
export { FINGERPRINT_BASIS_VERSION } from '../db/schema-phase'
import { FINGERPRINT_BASIS_VERSION } from '../db/schema-phase'
export const FINGERPRINT_BASIS_TRANSFORM='observation-fingerprint-basis-v1'
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
function phaseDigest(t:Database.Database,runId:string) {
  const db=drizzle(t,{schema:s}),r=s.platformMigrationRun,c=s.platformMigrationCheckpoint
  return hash(JSON.stringify({manifest:projectionManifest(t),runs:db.select().from(r).where(ne(r.runId,runId)).orderBy(asc(r.runId)).all(),checkpoints:db.select().from(c).where(ne(c.runId,runId)).orderBy(asc(c.runId),asc(c.phase),asc(c.sourceTable)).all()}))
}
function fullDigest(t:Database.Database,runId:string) {
  // SQLite allocation highwaters are part of the successor binding too.
  return hash(JSON.stringify({facts:phaseDigest(t,runId),sequences:t.prepare('select name,seq from sqlite_sequence order by name').all()}))
}
type RecoveryRow={observationId:number,scheme:string,reason:string|null,sourcePointer:string}
export type FingerprintBasisOptions={source:string,target:string,runId:string,predecessorRunId:string,legacySource?:string,beforeCommit?:(stage:string)=>void}
/** Source is a complete frozen 71606 predecessor snapshot, including the original legacy cells.
 * An after-predecessor target requires separate event proof; this entry fails closed on differences.
 */
export function finalizeFingerprintBasis(options:FingerprintBasisOptions,frozen?:FrozenSource,legacyFrozen?:FrozenSource):{state:'complete',targetManifest:string,schemaHash:string,recoveryManifest:RecoveryRow[]} {
  if(!frozen)return withFrozenSource(options.source,f=>finalizeFingerprintBasis(options,f))
  assertFrozenSource(frozen,options.source)
  if(options.legacySource&&!legacyFrozen)return withFrozenSource(options.legacySource,l=>finalizeFingerprintBasis(options,frozen,l))
  if(legacyFrozen)assertFrozenSource(legacyFrozen,options.legacySource!)
  if(!options.runId||!options.predecessorRunId||options.runId===options.predecessorRunId)throw new Error('Distinct successor run IDs required')
  const source=realpathSync(options.source),target=realpathSync(options.target),ss=statSync(source),ts=statSync(target)
  if(source===target||(ss.ino===ts.ino&&ss.dev===ts.dev))throw new Error('Distinct isolated target required')
  for(const path of [source,target]) {
    for(const suffix of ['-wal','-journal'])if(existsSync(path+suffix)&&statSync(path+suffix).size)throw new Error('Frozen offline files required')
    const space=statfsSync(dirname(path));if(space.bavail*space.bsize<8*1024**3)throw new Error('Disk floor 8GiB')
  }
  const src=drizzle(frozen.database,{schema:s}),r=s.platformMigrationRun,cp=s.platformMigrationCheckpoint
  const prior=src.select().from(r).where(eq(r.runId,options.predecessorRunId)).get()
  const checkpoints=src.select().from(cp).where(eq(cp.runId,options.predecessorRunId)).all()
  if(frozen.database.pragma('user_version',{simple:true})!==71606||prior?.state!=='complete'||prior.transformVersion!=='w4a-pre-collection-scopes-v1'||prior.targetSchemaVersion!==schemaHash(frozen.database)||!isDeepStrictEqual(checkpoints,[{runId:options.predecessorRunId,phase:'w4a-pre-scopes',sourceTable:'scope/error',lastOldId:0,copiedCount:0,batchDigest:phaseDigest(frozen.database,options.predecessorRunId)}]))throw new Error('Unproven 71606 predecessor/checkpoint or after-predecessor events')
  fingerprintArchiveInventory(frozen.database)
  const sourceHash=fileHash(frozen.fd),legacyHash=legacyFrozen?fileHash(legacyFrozen.fd):null
  const sourceManifest=hash(JSON.stringify({predecessor:fullDigest(frozen.database,options.runId),legacy:legacyHash}))
  const t=new SQLite(target,{fileMustExist:true})
  try {
    t.pragma('foreign_keys=ON');requireFingerprintForeignKeys(t)
    const db=drizzle(t,{schema:s}),existing=db.select().from(r).where(eq(r.runId,options.runId)).get()
    const checkpoint=()=>({runId:options.runId,phase:'fingerprint-basis',sourceTable:'platform_business_observation',lastOldId:0,copiedCount:0,batchDigest:fullDigest(t,options.runId)})
    if(existing) {
      if(existing.state!=='complete'||existing.sourceSnapshotSha256!==sourceHash||existing.sourceSchemaHash!==schemaHash(frozen.database)||existing.sourceManifestSha256!==sourceManifest||existing.targetSchemaVersion!==schemaHash(t)||existing.transformVersion!==FINGERPRINT_BASIS_TRANSFORM||t.pragma('user_version',{simple:true})!==FINGERPRINT_BASIS_VERSION||!isDeepStrictEqual(db.select().from(cp).where(eq(cp.runId,options.runId)).all(),[checkpoint()]))throw new Error('Fingerprint successor binding drift')
    } else {
      if(t.pragma('user_version',{simple:true})!==71606||schemaHash(t)!==schemaHash(frozen.database)||fullDigest(t,options.runId)!==fullDigest(frozen.database,options.runId))throw new Error('Unproven target or after-predecessor events')
      db.transaction(tx=>{
        requireFingerprintForeignKeys(t)
        const oldLines:string[]=[];projectionManifest(t,line=>oldLines.push(line))
        const oldArchiveCount=tx.select({value:count()}).from(s.platformArchiveValue).get()!.value
        installFingerprintBasis(t);options.beforeCommit?.('created')
        const o=s.platformBusinessObservation,q=s.platformLegacyQueryAlias,a=s.platformLegacyRelationAlias
        for(const observation of tx.select().from(o).orderBy(asc(o.id)).all()) {
          if(observation.identityState==='not_indexed') {
            continue
          }
          const alias=tx.select().from(a).where(eq(a.observationId,observation.id)).get()
          if(!legacyFrozen||prior.sourceSnapshotSha256!==legacyHash)throw new Error(`Unproven index lifecycle ${observation.id}: frozen original index event required`)
          const legacyDb=drizzle(legacyFrozen.database,{schema:expand})
          const original=alias?legacyDb.select().from(expand.platformRelation).where(eq(expand.platformRelation.id,alias.oldId)).get():undefined
          const event=alias?legacyDb.select().from(expand.platformBusinessObservation).where(eq(expand.platformBusinessObservation.relationId,alias.oldId)).get():undefined
          if(!original||!event||event.identityState==='not_indexed')throw new Error(`Unknown lifecycle observation ${observation.id}`)
          const collection=tx.select().from(s.platformCollection).where(eq(s.platformCollection.id,observation.collectionId)).get()
          const queryAlias=tx.select().from(q).where(eq(q.collectionId,observation.collectionId)).get()
          if(!collection||!queryAlias||queryAlias.oldId!==original.queryId||observation.sequenceNo!==original.sequenceNo||observation.sourceRelationKey!==original.relationKey)throw new Error(`Legacy coordinate conflict ${observation.id}`)
          for(const field of ['recordId','versionId','identityState','contentState','keySource','projectionRuleVersion','inputFingerprint','indexedAt','batchId'] as const)if(observation[field]!==event[field])throw new Error(`Legacy index fact conflict ${observation.id}:${field}`)
          const ownerArchive=(field:'rawFields'|'sourceText'|'legacyRowSnapshot')=>{
            const ref=tx.select().from(s.platformObservationArchiveRef).where(and(eq(s.platformObservationArchiveRef.ownerId,observation.id),eq(s.platformObservationArchiveRef.field,field))).get()
            const value=ref?tx.select().from(s.platformArchiveValue).where(eq(s.platformArchiveValue.id,ref.archiveId)).get():undefined
            if(!ref||ref.sealed!==1||!value||(value.storageClass==='null'?(value.bytes!==null||value.sha256!==null||value.byteLength!==null):(!value.bytes||value.bytes.length!==value.byteLength||hash(value.bytes)!==value.sha256)))throw new Error(`Legacy sealed archive conflict ${observation.id}:${field}`)
            return value
          }
          for(const [field,column] of [['rawFields','raw_fields'],['sourceText','source_text']] as const) {
            const cell=rowSnapshot(legacyFrozen.database,'platform_relation','id',original.id,[column])[0]!,value=ownerArchive(field)
            if(cell.storageClass!==value.storageClass||cell.hex!==(value.bytes?.toString('hex').toUpperCase()??''))throw new Error(`Legacy source byte conflict ${observation.id}:${field}`)
          }
          const snapshot=ownerArchive('legacyRowSnapshot')
          if(snapshot.storageClass!=='blob'||!snapshot.bytes?.equals(Buffer.from(JSON.stringify({encoding:'t05a-sqlite-cells-v1',fields:rowSnapshot(legacyFrozen.database,'platform_relation','id',original.id)}))))throw new Error(`Legacy cells conflict ${observation.id}`)
          const raw=ownerArchive('rawFields')
          if(raw.storageClass!=='text'&&raw.storageClass!=='null')throw new Error(`Unverifiable legacy BLOB ${observation.id}`)
          const rawText=raw.storageClass==='null'?null:new TextDecoder('utf-8',{fatal:true}).decode(raw.bytes!)
          let rawFields:unknown=null
          try {rawFields=rawText===null?null:JSON.parse(rawText)}catch {/* Original public oracle keeps invalid raw text. */}
          const bytes=Buffer.from(canonicalPlatformJson({interface:collection.interface,relationKey:observation.sourceRelationKey,queryId:queryAlias.oldId,sequenceNo:observation.sequenceNo,queryKey:collection.queryKey,rdjb:collection.rdjb,queriedAt:collection.queriedAt,rawFields,invalidRaw:rawFields===null?rawText:null}))
          if(observation.projectionRuleVersion!==PLATFORM_PROJECTION_RULE||hash(bytes)!==observation.inputFingerprint)throw new Error(`Legacy fingerprint/rule conflict ${observation.id}`)
          const archiveId=insertArchiveValue(tx,{storageClass:'blob',bytes,createdAt:null})
          tx.insert(s.platformObservationFingerprintBasis).values({observationId:observation.id,scheme:'legacy-indexed-v1',inputArchiveId:archiveId}).run()
        }
        options.beforeCommit?.('recovered')
        installFingerprintBarrier(t);options.beforeCommit?.('barrier')
        let archiveIndex=0;const afterLines:string[]=[]
        projectionManifest(t,line=>{const row=JSON.parse(line) as {table:string};if(row.table==='platform_observation_fingerprint_basis')return;if(row.table==='platform_archive_value'&&archiveIndex++>=oldArchiveCount)return;afterLines.push(line)})
        if(!isDeepStrictEqual(oldLines,afterLines))throw new Error('Original cell/byte manifest drift')
        if(!isDeepStrictEqual(t.pragma('foreign_key_check'),[])||!isDeepStrictEqual(t.pragma('integrity_check'),[{integrity_check:'ok'}]))throw new Error('Fingerprint target integrity failure')
        if(sourceHash!==fileHash(frozen.fd)||(legacyFrozen&&legacyHash!==fileHash(legacyFrozen.fd)))throw new Error('Frozen source drift')
        t.pragma(`user_version=${FINGERPRINT_BASIS_VERSION}`)
        tx.insert(r).values({runId:options.runId,state:'complete',sourceSnapshotSha256:sourceHash,sourceSchemaHash:schemaHash(frozen.database),sourceManifestSha256:sourceManifest,targetSchemaVersion:schemaHash(t),transformVersion:FINGERPRINT_BASIS_TRANSFORM}).run()
        tx.insert(cp).values(checkpoint()).run();options.beforeCommit?.('receipt')
      },{behavior:'immediate'})
    }
    const basis=s.platformObservationFingerprintBasis,o=s.platformBusinessObservation
    const recoveryManifest:RecoveryRow[]=db.select({observationId:o.id,scheme:basis.scheme}).from(o).leftJoin(basis,eq(basis.observationId,o.id)).orderBy(asc(o.id)).all().map(row=>({observationId:row.observationId,scheme:row.scheme??'not_indexed',reason:null,sourcePointer:`${sourceHash}#observation:${row.observationId}`}))
    return {state:'complete',targetManifest:projectionManifest(t),schemaHash:schemaHash(t),recoveryManifest}
  } finally {t.close()}
}
