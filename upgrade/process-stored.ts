import { upgradeMemoizedDigest, upgradeIntegrityGate, upgradeForeignKeyFailures } from './integrity-policy'
/** #734 A1 only. Never registered as a startup migration or runtime writer. */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync, statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { TextDecoder, isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { withFrozenSource, assertFrozenSource, fileHash, type FrozenSource } from '../lib/platform/frozen-source'
import { schemaHash } from '../lib/platform/sqlite-row-cells'
import { projectionManifest } from './projections'
import { rowSnapshot } from './observations'
import { verifyFingerprint, verifyLegacyFacts, legacyFingerprintInput } from '../lib/platform/fingerprint-verifier'
import { normalizePlatformRelation } from '../lib/platform/normalization'
import { installProcessStoredSchema, installProcessStoredBarrier, processStoredColumns, processPairColumns, PROCESS_STORED_VERSION } from './process-stored-schema'
import {withLegacyFingerprintCustody,assertLegacyFingerprintCustody,type LegacyFingerprintCustody} from '../lib/platform/legacy-fingerprint-custody'
import { captureSqlFactTitle } from '../lib/platform/apply-stored-cells'
import { recognizedStoredInstalled } from '../lib/platform/recognized-stored-catalog'
import { witnessInstalled } from '../lib/platform/recognized-witness-catalog'
import { processStoredInstalled } from '../lib/platform/process-stored-catalog'
import { getTableColumns } from 'drizzle-orm'
import { platformRelation } from '../db/schema'
export const PROCESS_STORED_TRANSFORM='process-exact-stored-offline-v1'
const COMMAND_MATERIALIZATION_RULE='legacy-process-insert-v1' as const
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const decode=(bytes:Buffer)=>new TextDecoder('utf-8',{fatal:true}).decode(bytes)
// SQL sees the original TEXT, including a leading BOM; do not repair JSON here.
const decodeSqlText=(bytes:Buffer)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)
const cellShape=z.object({name:z.string(),storageClass:z.enum(['null','text','blob','integer','real']),hex:z.string().regex(/^(?:[0-9a-fA-F]{2})*$/),real64be:z.string().regex(/^[0-9a-fA-F]{16}$/).optional()})
type Cell=z.infer<typeof cellShape>
const fields=['status','declare_kind','applied_at','year','title_raw','batch','award_batch_label','province'] as const
const ownerShape=z.object({id:z.number().int().positive().safe(),collection_id:z.number().int().positive().safe(),sequence_no:z.number().int(),identity_state:z.string(),source_relation_key:z.string().nullable(),old_id:z.number().int().positive().safe(),query_id:z.number().int().positive().safe(),scheme:z.string().nullable()})
type Owner=z.infer<typeof ownerShape>
type Recovery={observationId:number,materializationRule:typeof COMMAND_MATERIALIZATION_RULE|null,exactState:'captured'|'uncaptured',titleState:'captured'|'uncaptured',origin:'legacy_source'|'sealed_snapshot'|'command_materialized'|null,reason:string|null,titleReason:string|null,cells:Cell[],title:string|null}
const archiveShape=z.object({storage_class:z.enum(['null','text','blob']),bytes:z.instanceof(Buffer).nullable(),byte_length:z.number().nullable(),sha256:z.string().nullable(),sealed:z.literal(1)})
function archive(t:Database.Database,owner:number,field:string) {
 const result=t.prepare('SELECT a.*,r.sealed FROM platform_observation_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.owner_id=? AND r.field=?').get(owner,field)
 if(!result)return null
 const a=archiveShape.parse(result)
 if(a.storage_class==='null'?(a.bytes!==null||a.byte_length!==null||a.sha256!==null):(!a.bytes||a.bytes.length!==a.byte_length||hash(a.bytes)!==a.sha256))throw new Error('Archive metadata/bytes conflict '+owner+':'+field)
 return a
}
function expression(c:Cell) {
 const b=Buffer.from(c.hex,'hex')
 switch(c.storageClass) {
  case 'null':return 'NULL'
  case 'blob':return `X'${c.hex}'`
  case 'text':decode(b);return `CAST(X'${c.hex}' AS TEXT)`
  case 'integer': {
   const text=decode(b);if(!/^-?\d+$/.test(text))throw new Error('Invalid integer cell')
   const n=BigInt(text);if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw new Error('unsafe-integer-cell')
   return `CAST(X'${c.hex}' AS INTEGER)`
  }
  case 'real': {
   if(!c.real64be)throw new Error('Missing REAL bits')
   const n=Buffer.from(c.real64be,'hex').readDoubleBE();if(!Number.isFinite(n))throw new Error('nonfinite-real-cell')
   return `CAST('${n}' AS REAL)`
  }
 }
}
function sameCell(a:Cell,b:Cell){return a.storageClass===b.storageClass&&a.hex.toUpperCase()===b.hex.toUpperCase()&&a.real64be===b.real64be}
function recover(t:Database.Database,o:Owner,legacy?:Database.Database,custody?:LegacyFingerprintCustody):Recovery {
 const r:Recovery={observationId:o.id,materializationRule:null,exactState:'uncaptured',titleState:'uncaptured',origin:null,reason:'missing-trusted-stored-cells',titleReason:'missing-trusted-raw-cell',cells:[],title:null}
 const raw=archive(t,o.id,'rawFields'),snapshot=archive(t,o.id,'legacyRowSnapshot')
 let cells:Cell[]|null=null
 if(snapshot?.storage_class==='blob'&&snapshot.bytes) {
  try {
   const parsed=z.object({encoding:z.literal('t05a-sqlite-cells-v1'),fields:z.array(cellShape)}).safeParse(JSON.parse(decode(snapshot.bytes)))
   const inventory=Object.values(getTableColumns(platformRelation)).map(c=>c.name)
   // ALTER-added legacy columns have a different ordinal order than the Drizzle declaration.
   // Validate the complete unique name inventory, retaining the sealed original ordinal order.
   if(parsed.success&&isDeepStrictEqual(parsed.data.fields.map(c=>c.name).sort(),inventory.sort()))cells=parsed.data.fields
   else r.reason='invalid-snapshot-encoding-or-field-inventory'
  }catch {r.reason='invalid-snapshot-encoding'}
 }
 const cell=(name:string)=>cells?.find(c=>c.name===name)
 if(legacy && o.scheme!=='target-command-v1') {
  const original=rowSnapshot(legacy,'platform_relation','id',o.old_id)
  if(cells&&(!isDeepStrictEqual(original.map(c=>c.name),cells.map(c=>c.name))||original.some((c,i)=>!sameCell(cellShape.parse(c),cells![i]!))))throw new Error('Frozen source/snapshot conflict '+o.id)
  cells=original.map(c=>cellShape.parse(c));r.origin='legacy_source'
  for(const column of ['interface','query_key','rdjb','queried_at']) {
   const before=rowSnapshot(legacy,'platform_query','id',o.query_id,[column])[0]!
   const after=rowSnapshot(t,'platform_collection','id',o.collection_id,[column])[0]!
   if(!sameCell(cellShape.parse(before),cellShape.parse(after)))throw new Error('Legacy collection coordinate conflict '+o.id+':'+column)
  }
 }
 if(cells) {
  const number=(name:string)=>{const c=cell(name);return c?.storageClass==='integer'?Number(decode(Buffer.from(c.hex,'hex'))):null}
  if(number('id')!==o.old_id||number('query_id')!==o.query_id||number('sequence_no')!==o.sequence_no)throw new Error('Legacy source/alias/sequence conflict '+o.id)
  for(const [source,table,key,column] of [['relation_key','platform_business_observation','id','source_relation_key'],['name_raw','platform_observation_assignment','observation_id','name_raw'],['uscc_raw','platform_observation_assignment','observation_id','uscc_raw']] as const) {
   const c=cell(source)
   const actual=table==='platform_observation_assignment'?t.prepare(`SELECT typeof(${column}) storageClass,hex(cast(${column} AS blob)) hex FROM ${table} WHERE observation_id=? AND revision=1`).get(o.id):rowSnapshot(t,table,key,o.id,[column])[0]
   if(!c||!actual)throw new Error('Legacy revision1/key missing '+o.id)
   const a=z.object({storageClass:z.string(),hex:z.string()}).parse(actual)
   if(c.storageClass!==a.storageClass||c.hex.toUpperCase()!==a.hex.toUpperCase())throw new Error('Legacy revision1/key conflict '+o.id)
  }
  const sourceText=archive(t,o.id,'sourceText')
  if(sourceText){const c=cell('source_text');if(!c||c.storageClass!==sourceText.storage_class||c.hex.toUpperCase()!==(sourceText.bytes?.toString('hex').toUpperCase()??''))throw new Error('Legacy source-text conflict '+o.id)}
  if(raw) {
   const c=cell('raw_fields')
   if(!c||c.storageClass!==raw.storage_class||c.hex.toUpperCase()!==(raw.bytes?.toString('hex').toUpperCase()??''))throw new Error('Legacy raw source conflict '+o.id)
  }
  const selected=fields.map(name=>cell(name))
  if(selected.every(c=>c!==undefined)) {
   try {selected.forEach(c=>expression(c!));r.cells=selected as Cell[];r.exactState='captured';r.reason=null;r.origin??='sealed_snapshot'}catch(error){r.origin=null;r.reason=String(error)}
  } else r.reason='missing-snapshot-fields'
 }
 // The predecessor authenticates original fingerprint and projections BEFORE adding any columns.
 if(!raw){r.exactState='uncaptured';r.cells=[];r.origin=null;r.reason='missing-predecessor-raw-archive'}
 if(o.identity_state!=='not_indexed'&&!o.scheme){r.exactState='uncaptured';r.cells=[];r.origin=null;r.reason='missing-predecessor-fingerprint-basis'}
 const verifierCells=cells?.filter(c=>['status','declare_kind','applied_at','province','batch','award_batch_label','year'].includes(c.name))
 const verifierRepresentable=(r.exactState==='captured'||o.scheme==='target-command-v1')&&(!verifierCells||verifierCells.every(c=>c.storageClass==='null'||(c.name==='year'?c.storageClass==='integer':c.storageClass==='text'||(c.name==='status'&&c.storageClass==='blob')))) && (!cells||cells.every(c=>{if(c.storageClass!=='text')return true;try{decode(Buffer.from(c.hex,'hex'));return true}catch{return false}}))
 if(!verifierRepresentable&&r.exactState==='captured'){r.exactState='uncaptured';r.cells=[];r.origin=null;r.reason='predecessor-verifier-cell-type-unrepresentable'}
 if(verifierRepresentable&&(cells||o.scheme==='target-command-v1')&&o.scheme&&o.scheme!=='uncaptured')verifyFingerprint(t,{observationId:o.id,collectionId:o.collection_id,relationAlias:o.old_id},legacy&&!snapshot?{legacyCustody:custody}:{})
 else if(verifierRepresentable&&o.identity_state==='not_indexed'&&cells) {
  const owner={observationId:o.id,collectionId:o.collection_id,relationAlias:o.old_id}
  const sourceCells=legacy&&!snapshot?custody:undefined
  verifyLegacyFacts(t,owner,legacyFingerprintInput(t,owner,sourceCells).bytes,true,{},sourceCells)
 }
 if(o.scheme==='target-command-v1') {
  const b=z.object({bytes:z.instanceof(Buffer)}).parse(t.prepare('SELECT a.bytes FROM platform_observation_fingerprint_basis b JOIN platform_archive_value a ON a.id=b.input_archive_id WHERE observation_id=?').get(o.id))
  const input=z.object({row:z.object({rawFields:z.record(z.string(),z.unknown()).nullable().optional()}).passthrough()}).passthrough().parse(JSON.parse(decode(b.bytes)))
  const row=normalizePlatformRelation('business_list',input.row)
  const text=(value:unknown)=>typeof value==='string'?value.trim()||null:null
  const assignment=z.object({name_raw:z.string().nullable(),uscc_raw:z.string().nullable()}).parse(t.prepare('SELECT name_raw,uscc_raw FROM platform_observation_assignment WHERE observation_id=? AND revision=1').get(o.id))
  if(assignment.name_raw!==text(row.nameRaw)||assignment.uscc_raw!==text(row.usccRaw)||o.source_relation_key!==text(row.relationKey))r.reason='command-materialization-revision1-or-key-incompatible'
  else {
   const values=[text(row.status),text(row.declareKind),text(row.appliedAt),typeof row.year==='number'&&Number.isFinite(row.year)?Math.trunc(row.year):null,captureSqlFactTitle(t,raw?.storage_class==='text'?decodeSqlText(raw.bytes!):null),text(row.batch),text(row.awardBatchLabel),text(row.province)]
   t.exec('CREATE TEMP TABLE s734_materialize(status TEXT,declare_kind TEXT,applied_at TEXT,year INTEGER,title_raw TEXT,batch TEXT,award_batch_label TEXT,province TEXT)')
   try {
    t.prepare('INSERT INTO s734_materialize VALUES(?,?,?,?,?,?,?,?)').run(...values)
    r.cells=rowSnapshot(t,'s734_materialize','rowid',1).map(c=>cellShape.parse(c));r.cells.forEach(expression)
    r.exactState='captured';r.reason=null;r.origin='command_materialized';r.materializationRule=COMMAND_MATERIALIZATION_RULE
   } finally{t.exec('DROP TABLE s734_materialize')}
  }
 }
 if(raw) {
  try {r.title=captureSqlFactTitle(t,raw.storage_class==='null'?null:raw.storage_class==='text'?decodeSqlText(raw.bytes!):raw.bytes!);r.titleState='captured';r.titleReason=null}catch(error){r.titleReason=String(error)}
 }
 if(o.scheme==='uncaptured'){r.exactState='uncaptured';r.cells=[];r.reason='original-command-input-not-captured'}
 if(r.exactState==='uncaptured')r.origin=null
 return r
}
function digest(t:Database.Database,runId:string,original=false) {
 return upgradeMemoizedDigest(t,JSON.stringify(['process-stored',runId,original]),()=>{
 const streamHash=createHash('sha256').update('{"lines":[');let firstLine=true
 projectionManifest(t,line=>{
  if(original){const row=JSON.parse(line) as {table:string,fields:{name:string}[]};if(row.table==='platform_business_projection')row.fields=row.fields.filter(c=>!processStoredColumns.some(n=>n===c.name));if(row.table==='platform_business_observation')row.fields=row.fields.filter(c=>!processPairColumns.some(n=>n===c.name));line=JSON.stringify(row)}
  if(!firstLine)streamHash.update(',');firstLine=false;streamHash.update(JSON.stringify(line))
 })
 streamHash.update('],');const metadata={sequences:t.prepare('SELECT name,typeof(seq) storageClass,hex(cast(seq AS blob)) bytes FROM sqlite_sequence ORDER BY name').all(),runs:t.prepare('SELECT * FROM platform_migration_run WHERE run_id<>? ORDER BY run_id').all(runId),checkpoints:t.prepare('SELECT * FROM platform_migration_checkpoint WHERE run_id<>? ORDER BY run_id,phase,source_table').all(runId)}
 streamHash.update(JSON.stringify(metadata).slice(1));return streamHash.digest('hex')
 })
}
/** Compare source-derived capture on first completion and replay; the receipt alone is not an oracle. */
function verifyRecovery(t:Database.Database,recovery:Recovery[]) {
 for(const r of recovery){
  const row=t.prepare(`SELECT exact_stored_state,exact_stored_rule,exact_stored_origin,exact_stored_reason,sql_fact_title,sql_fact_title_state,sql_fact_title_rule,sql_fact_title_reason FROM platform_business_projection WHERE observation_id=?`).get(r.observationId)
  const wanted={exact_stored_state:r.exactState,exact_stored_rule:r.exactState==='captured'?'process-stored-cells-v1':null,exact_stored_origin:r.origin,exact_stored_reason:r.reason,sql_fact_title:r.title,sql_fact_title_state:r.titleState,sql_fact_title_rule:r.titleState==='captured'?'process-legacy-sql-fact-title-v1':null,sql_fact_title_reason:r.titleReason}
  if(!isDeepStrictEqual(row,wanted))throw new Error('Process capture source/metadata drift '+r.observationId)
  const actual=rowSnapshot(t,'platform_business_projection','observation_id',r.observationId,fields.map(c=>'exact_'+c))
  if(r.exactState==='captured'?actual.some((c,i)=>!sameCell(cellShape.parse(c),r.cells[i]!)):actual.some(c=>c.storageClass!=='null'))throw new Error('Process capture source/cell drift '+r.observationId)
  if(!t.prepare('SELECT 1 FROM platform_business_observation WHERE id=? AND process_exact_owner_id=id AND process_exact_state=? AND process_sql_fact_title_state=?').get(r.observationId,r.exactState,r.titleState))throw new Error('Process capture pair drift '+r.observationId)
 }
}
export type ProcessStoredOptions={source:string,target:string,runId:string,predecessorRunId:string,legacySource?:string,beforeCommit?:(stage:string)=>void}
export function finalizeProcessStored(options:ProcessStoredOptions,frozen?:FrozenSource,legacy?:FrozenSource,custody?:LegacyFingerprintCustody):{state:'complete',queryReady:boolean,recovery:Recovery[],manifest:string} {
 if(!frozen)return withFrozenSource(options.source,f=>finalizeProcessStored(options,f))
 assertFrozenSource(frozen,options.source)
 if(options.legacySource){const l=statSync(options.legacySource),t=statSync(options.target);if(l.dev===t.dev&&l.ino===t.ino)throw new Error('Distinct legacy source required')}
 if(options.legacySource&&!legacy)return withLegacyFingerprintCustody(frozen,options.legacySource,(proof,l)=>finalizeProcessStored(options,frozen,l,proof))
 if(legacy){assertFrozenSource(legacy,options.legacySource!);assertLegacyFingerprintCustody(custody,frozen,legacy)}
 const source=realpathSync(options.source),target=realpathSync(options.target),ss=statSync(source),ts=statSync(target)
 if(source===target||(ss.dev===ts.dev&&ss.ino===ts.ino))throw new Error('Distinct isolated target required')
 if(legacy){const ls=statSync(options.legacySource!);if(ls.dev===ts.dev&&ls.ino===ts.ino)throw new Error('Distinct legacy source required')}
 if(!options.runId||!options.predecessorRunId||options.runId===options.predecessorRunId)throw new Error('Distinct run IDs required')
 for(const path of [source,target,...(options.legacySource?[options.legacySource]:[])]) {
  for(const suffix of ['-wal','-journal'])if(existsSync(path+suffix)&&statSync(path+suffix).size)throw new Error('Frozen offline files required')
  const fs=statfsSync(dirname(path));if(fs.bavail*fs.bsize<8*1024**3)throw new Error('Disk floor 8GiB')
 }
 const legacyHash=legacy?fileHash(legacy.fd):null
 const s=frozen.database,sourceHash=fileHash(frozen.fd),sourceSchema=schemaHash(s),sourceManifest=hash(digest(s,options.runId)+(legacy?fileHash(legacy.fd):''))
 const prior=z.object({state:z.literal('complete'),transform_version:z.literal('recognized-witness-offline-v1'),target_schema_version:z.string()}).parse(s.prepare('SELECT * FROM platform_migration_run WHERE run_id=?').get(options.predecessorRunId))
 if(s.pragma('user_version',{simple:true})!==71609||prior.target_schema_version!==sourceSchema)throw new Error('Unproven 71609 predecessor')
 if(!recognizedStoredInstalled(s)||!witnessInstalled(s))throw new Error('Completed recognized predecessor catalogs required')
 const recovery=s.transaction(()=>z.array(ownerShape).parse(s.prepare(`SELECT o.*,a.old_id,q.old_id query_id,b.scheme FROM platform_business_observation o JOIN platform_collection c ON c.id=o.collection_id LEFT JOIN platform_legacy_relation_alias a ON a.observation_id=o.id LEFT JOIN platform_legacy_query_alias q ON q.collection_id=c.id LEFT JOIN platform_observation_fingerprint_basis b ON b.observation_id=o.id WHERE c.interface='business_list' ORDER BY o.id`).all()).map(o=>recover(s,o,legacy?.database,custody)))()
 const materialized=recovery.filter(r=>r.materializationRule!==null)
 const checkpoints=(targetDb:Database.Database)=>[
  ...(materialized.length?[{run_id:options.runId,phase:'process-materialization',source_table:COMMAND_MATERIALIZATION_RULE,last_old_id:0,copied_count:materialized.length,batch_digest:hash(JSON.stringify(materialized))}]:[]),
  {run_id:options.runId,phase:'process-stored',source_table:'platform_business_projection',last_old_id:0,copied_count:recovery.length,batch_digest:digest(targetDb,options.runId)},
 ]
 const t=new Database(target,{fileMustExist:true})
 try {
  t.pragma('foreign_keys=ON')
  const existing=t.prepare('SELECT * FROM platform_migration_run WHERE run_id=?').get(options.runId)
  if(existing) {
   const receipt=z.object({state:z.literal('complete'),source_snapshot_sha256:z.literal(sourceHash),source_schema_hash:z.literal(sourceSchema),source_manifest_sha256:z.literal(sourceManifest),target_schema_version:z.literal(schemaHash(t)),transform_version:z.literal(PROCESS_STORED_TRANSFORM)}).parse(existing)
   void receipt
   if(!isDeepStrictEqual(t.prepare('SELECT * FROM platform_migration_checkpoint WHERE run_id=? ORDER BY phase,source_table').all(options.runId),checkpoints(t)))throw new Error('Successor checkpoint drift')
   if(t.pragma('user_version',{simple:true})!==PROCESS_STORED_VERSION)throw new Error('Successor phase drift')
  } else {
   if(t.pragma('user_version',{simple:true})!==71609||schemaHash(t)!==sourceSchema||digest(t,options.runId)!==digest(s,options.runId))throw new Error('Unproven target facts/catalog')
   t.transaction(()=>{
    if(t.pragma('foreign_keys',{simple:true})!==1)throw new Error('FK ON required')
    const before=digest(t,options.runId)
    const recovered=recovery;options.beforeCommit?.('authenticated')
    installProcessStoredSchema(t,options.beforeCommit)
    for(const r of recovered) {
     const assignments=r.exactState==='captured'?r.cells.map((c,i)=>`exact_${fields[i]}=${expression(c)}`).join(','):fields.map(c=>`exact_${c}=NULL`).join(',')
     const result=t.prepare(`UPDATE platform_business_projection SET ${assignments},exact_stored_state=?,exact_stored_rule=?,exact_stored_origin=?,exact_stored_reason=?,sql_fact_title=?,sql_fact_title_state=?,sql_fact_title_rule=?,sql_fact_title_reason=? WHERE observation_id=?`).run(r.exactState,r.exactState==='captured'?'process-stored-cells-v1':null,r.origin,r.reason,r.title,r.titleState,r.titleState==='captured'?'process-legacy-sql-fact-title-v1':null,r.titleReason,r.observationId)
     if(result.changes!==1)throw new Error('Missing or duplicate process projection '+r.observationId)
     if(r.exactState==='captured') {
      const actual=rowSnapshot(t,'platform_business_projection','observation_id',r.observationId,fields.map(c=>'exact_'+c)).map(c=>cellShape.parse(c))
      if(actual.some((c,i)=>!sameCell(c,r.cells[i]!)))throw new Error('Nonreversible SQLite cell binding '+r.observationId)
     }
     t.prepare('UPDATE platform_business_observation SET process_exact_owner_id=id,process_exact_state=?,process_sql_fact_title_state=? WHERE id=?').run(r.exactState,r.titleState,r.observationId)
    }
    verifyRecovery(t,recovered)
    options.beforeCommit?.('recovered');installProcessStoredBarrier(t);options.beforeCommit?.('barrier')
    if(before!==digest(t,options.runId,true))throw new Error('Original facts/sequences/receipt manifest drift')
    if(!isDeepStrictEqual(upgradeForeignKeyFailures(t),[])||!upgradeIntegrityGate(t))throw new Error('Successor integrity failure')
    if(sourceHash!==fileHash(frozen.fd)||(legacy&&legacyHash!==fileHash(legacy.fd)))throw new Error('Frozen source drift')
    assertFrozenSource(frozen,options.source);if(legacy){assertFrozenSource(legacy,options.legacySource!);assertLegacyFingerprintCustody(custody,frozen,legacy)}
    t.pragma(`user_version=${PROCESS_STORED_VERSION}`)
    t.prepare('INSERT INTO platform_migration_run(run_id,state,source_snapshot_sha256,source_schema_hash,source_manifest_sha256,target_schema_version,transform_version) VALUES(?,?,?,?,?,?,?)').run(options.runId,'complete',sourceHash,sourceSchema,sourceManifest,schemaHash(t),PROCESS_STORED_TRANSFORM)
    for(const checkpoint of checkpoints(t))t.prepare('INSERT INTO platform_migration_checkpoint(run_id,phase,source_table,last_old_id,copied_count,batch_digest) VALUES(@run_id,@phase,@source_table,@last_old_id,@copied_count,@batch_digest)').run(checkpoint)
    if(!processStoredInstalled(t))throw new Error('Process completion catalog invalid')
    options.beforeCommit?.('receipt')
    assertFrozenSource(frozen,options.source);if(legacy)assertLegacyFingerprintCustody(custody,frozen,legacy)
    if(sourceHash!==fileHash(frozen.fd))throw new Error('Frozen source drift')
   }).immediate()
  }
  verifyRecovery(t,recovery)
  if(!processStoredInstalled(t))throw new Error('Process catalog incomplete')
  // Returning the source-derived recovery inventory authenticates both branches on replay too.

  assertFrozenSource(frozen,options.source);if(legacy){assertFrozenSource(legacy,options.legacySource!);assertLegacyFingerprintCustody(custody,frozen,legacy)}
  if(sourceHash!==fileHash(frozen.fd)||(legacy&&legacyHash!==fileHash(legacy.fd)))throw new Error('Frozen source drift')
  return {state:'complete',queryReady:recovery.every(r=>r.exactState==='captured'&&r.titleState==='captured'),recovery,manifest:digest(t,options.runId)}
 }finally{t.close()}
}
