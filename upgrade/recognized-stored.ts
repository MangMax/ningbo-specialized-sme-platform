import { upgradeIntegrityGate, upgradeForeignKeyFailures } from './integrity-policy'
import { recognizedStoredTriggers } from '../lib/platform/recognized-stored-catalog'
/** #732 A only. Explicit additive offline 71609 upgrade; never a startup migration. */
import Database from 'better-sqlite3'
import { existsSync, realpathSync, statSync, statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { withFrozenSource, assertFrozenSource, fileHash, type FrozenSource } from '../lib/platform/frozen-source'
import { schemaHash } from '../lib/platform/sqlite-row-cells'
import { projectionManifest } from './projections'
import { recognizedStoredColumns } from '../lib/platform/recognized-stored-schema'
import { recognizedTitleEvidence, titleCellExpression, verifyRecognizedStored, RECOGNIZED_STORED_RULE } from '../lib/platform/recognized-stored'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
function digest(t:Database.Database,run:string,original=false) {
 const streamHash=createHash('sha256').update('{"lines":[');let firstLine=true
 projectionManifest(t,line=>{
  if(original){const row=z.object({table:z.string(),fields:z.array(z.object({name:z.string()}).passthrough())}).parse(JSON.parse(line));if(row.table==='platform_recognized_projection')row.fields=row.fields.filter(c=>!recognizedStoredColumns.some(n=>n===c.name));line=JSON.stringify(row)}
  if(!firstLine)streamHash.update(',');firstLine=false;streamHash.update(JSON.stringify(line))
 })
 streamHash.update('],');const metadata={runs:t.prepare('SELECT * FROM platform_migration_run WHERE run_id<>? ORDER BY run_id').all(run),checkpoints:t.prepare('SELECT * FROM platform_migration_checkpoint WHERE run_id<>? ORDER BY run_id,phase,source_table').all(run),sequences:t.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()}
 streamHash.update(JSON.stringify(metadata).slice(1));return streamHash.digest('hex')
}
export type RecognizedStoredOptions={source:string,target:string,runId:string,predecessorRunId:string,beforeCommit?:(stage:string)=>void}
export function finalizeRecognizedStored(options:RecognizedStoredOptions,frozen?:FrozenSource):{state:'complete',captured:number,uncaptured:number} {
 if(!frozen)return withFrozenSource(options.source,s=>finalizeRecognizedStored(options,s))
 assertFrozenSource(frozen,options.source)
 const source=realpathSync(options.source),target=realpathSync(options.target),ss=statSync(source),ts=statSync(target)
 if(ss.dev===ts.dev&&ss.ino===ts.ino)throw new Error('Distinct isolated source and target required')
 if(!options.runId||!options.predecessorRunId||options.runId===options.predecessorRunId)throw new Error('Distinct run IDs required')
 for(const p of [source,target]){for(const suffix of ['-wal','-journal'])if(existsSync(p+suffix)&&statSync(p+suffix).size)throw new Error('Standalone fixed offline files required');const d=statfsSync(dirname(p));if(d.bavail*d.bsize<8*1024**3)throw new Error('Disk floor 8GiB')}
 const s=frozen.database,sourceHash=fileHash(frozen.fd),sourceSchema=schemaHash(s),sourceManifest=digest(s,options.runId)
 z.object({state:z.literal('complete'),transform_version:z.literal('candidate-scope-offline-v1'),target_schema_version:z.literal(sourceSchema)}).parse(s.prepare('SELECT * FROM platform_migration_run WHERE run_id=?').get(options.predecessorRunId))
 if(s.pragma('user_version',{simple:true})!==71609)throw new Error('Completed 71609 predecessor required')
 const owners=z.array(z.object({id:z.number().int().positive().safe()})).parse(s.prepare("SELECT o.id FROM platform_business_observation o JOIN platform_collection c ON c.id=o.collection_id WHERE c.interface='recognized_list' ORDER BY o.id").all())
 const recovered=owners.map(o=>({id:o.id,evidence:recognizedTitleEvidence(s,o.id)}))
 const result={state:'complete' as const,captured:recovered.filter(r=>r.evidence).length,uncaptured:recovered.filter(r=>!r.evidence).length}
 const t=new Database(target,{fileMustExist:true});t.pragma('foreign_keys=ON')
 const checkpoint=()=>({run_id:options.runId,phase:'recognized-stored',source_table:'platform_recognized_projection',last_old_id:0,copied_count:owners.length,batch_digest:digest(t,options.runId)})
 try {
 const existing=t.prepare('SELECT * FROM platform_migration_run WHERE run_id=?').get(options.runId)
 if(existing){
 z.object({state:z.literal('complete'),source_snapshot_sha256:z.literal(sourceHash),source_schema_hash:z.literal(sourceSchema),source_manifest_sha256:z.literal(sourceManifest),target_schema_version:z.literal(schemaHash(t)),transform_version:z.literal(RECOGNIZED_STORED_RULE)}).parse(existing)
 if(!isDeepStrictEqual(t.prepare('SELECT * FROM platform_migration_checkpoint WHERE run_id=?').all(options.runId),[checkpoint()]))throw new Error('Recognized stored checkpoint drift')
 }else{
 if(t.pragma('user_version',{simple:true})!==71609||schemaHash(t)!==sourceSchema||digest(t,options.runId)!==sourceManifest)throw new Error('Unproven target facts/catalog')
 t.transaction(()=>{
 options.beforeCommit?.('authenticated')
 t.exec(`ALTER TABLE platform_recognized_projection ADD COLUMN exact_title_raw BLOB;
 ALTER TABLE platform_recognized_projection ADD COLUMN exact_title_state TEXT;
 ALTER TABLE platform_recognized_projection ADD COLUMN exact_title_origin TEXT;
 ALTER TABLE platform_recognized_projection ADD COLUMN exact_title_archive_id INTEGER REFERENCES platform_archive_value(id) ON DELETE RESTRICT;
 ALTER TABLE platform_recognized_projection ADD COLUMN exact_title_sha256 TEXT;`)
 for(const r of recovered){const e=r.evidence;const change=t.prepare(`UPDATE platform_recognized_projection SET exact_title_raw=${e?titleCellExpression(e.cell):'NULL'},exact_title_state=?,exact_title_origin=?,exact_title_archive_id=?,exact_title_sha256=? WHERE observation_id=?`).run(e?'captured':'uncaptured',e?.exactTitleOrigin??null,e?.exactTitleArchiveId??null,e?.exactTitleSha256??null,r.id);if(change.changes!==1)throw new Error('Missing recognized observation projection')}
 options.beforeCommit?.('recovered')
 // Immutable exact fields, while existing fidelity owners retain their update rights.
 t.exec(recognizedStoredTriggers)
 if(digest(t,options.runId,true)!==sourceManifest)throw new Error('Original facts/bytes/receipt drift')
 if(!isDeepStrictEqual(upgradeForeignKeyFailures(t),[])||!upgradeIntegrityGate(t))throw new Error('Recognized stored integrity failure')
 t.prepare('INSERT INTO platform_migration_run(run_id,state,source_snapshot_sha256,source_schema_hash,source_manifest_sha256,target_schema_version,transform_version) VALUES(?,?,?,?,?,?,?)').run(options.runId,'complete',sourceHash,sourceSchema,sourceManifest,schemaHash(t),RECOGNIZED_STORED_RULE)
 const c=checkpoint();t.prepare('INSERT INTO platform_migration_checkpoint(run_id,phase,source_table,last_old_id,copied_count,batch_digest) VALUES(@run_id,@phase,@source_table,@last_old_id,@copied_count,@batch_digest)').run(c)
 for(const r of recovered)if(r.evidence)verifyRecognizedStored(t,r.id)
 options.beforeCommit?.('receipt');assertFrozenSource(frozen,options.source);if(fileHash(frozen.fd)!==sourceHash)throw new Error('Frozen source drift')
 }).immediate()
 }
 assertFrozenSource(frozen,options.source);if(fileHash(frozen.fd)!==sourceHash)throw new Error('Frozen source drift')
 return result
 }finally{t.close()}
}
