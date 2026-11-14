import { businessStatusRule } from './business-status-catalog'
import { ensureProcessStoredReady } from './process-stored-catalog'
import { verifyProcessStored, PROCESS_STORED_KEYS } from './process-stored-verifier'
import { storedProcessProjection } from './process-stored-schema'
import { verifyRecognizedStored } from './recognized-stored'
import { verifyApplyStored, APPLY_STORED_KEYS } from './apply-stored-verifier'
import type { ApplyTargetInput } from './apply-target-writer'
/** Offline read-snapshot verifier, separately callable for planned and exact-original owners. */
import {legacyCustodyCells,type LegacyFingerprintCustody} from './legacy-fingerprint-custody'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { targetSchema as s } from './target-schema'
import { planPlatformObservation, PLATFORM_RAW_HASH_RULE, canonicalPlatformJson, PLATFORM_PROJECTION_RULE } from './observation-plan'
import { sourceValueKind, sourceFieldComparison } from './source-extraction'
import { parseApplyRecord } from './apply-record'
import { parseBusinessProcess } from './business-projection'
import { parseRecognizedRecord, parseRecognizedSourceFidelity } from './recognized-projection'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { verifyOriginalCommand } from './fingerprint-command-facts'
import { legacyFingerprintRaw } from './legacy-fingerprint-raw'
export type FingerprintOwner={observationId:number,collectionId:number,relationAlias:number}
export class FingerprintVerificationError extends Error {
  readonly kind='platform_relation'
  readonly field='relations'
  readonly ref:string
  constructor(readonly code:'projection_source_drift'|'projection_mapping_conflict'|'apply_stored_conflict'|'apply_stored_uncaptured'|'process_stored_conflict'|'process_stored_uncaptured',owner:FingerprintOwner,reason:string){super(reason);this.ref=`relation:${owner.relationAlias}`}
}
/** Empty model used only to recompute expected business fingerprints. */
export function emptyFingerprintTarget(t:Database.Database):Database.Database {
  const scratch=new Database(':memory:');scratch.pragma('foreign_keys=ON')
  try {
    const catalog=t.prepare("select sql from sqlite_schema where sql is not null and name not glob 'sqlite_*' order by case type when 'table' then 0 when 'index' then 1 else 2 end").all() as {sql:string}[]
    for(const row of catalog)scratch.exec(row.sql)
    scratch.pragma('user_version='+t.pragma('user_version',{simple:true}))
    scratch.exec("insert into platform_legacy_alias_sequence(namespace,high_water) values('query',0),('relation',0)")
    const runs=drizzle(t,{schema:s}).select().from(s.platformMigrationRun).all()
    if(runs.length)drizzle(scratch,{schema:s}).insert(s.platformMigrationRun).values(runs).run()
    if(t.prepare("SELECT 1 FROM sqlite_schema WHERE name='platform_runtime_capability'").get()) {
      const capabilities = t.prepare('SELECT transform_version FROM platform_runtime_capability').all() as {transform_version:string}[]
      for(const row of capabilities) scratch.prepare('INSERT INTO platform_runtime_capability VALUES(?)').run(row.transform_version)
    }
    return scratch
  }catch(error){scratch.close();throw error}
}

const hash=(v:Buffer)=>createHash('sha256').update(v).digest('hex')
export function verifyFingerprint(t:Database.Database,owner:FingerprintOwner, options: {allowMissingVersionProjection?:boolean, legacyCustody?:LegacyFingerprintCustody} = {}) {
 const recognized=drizzle(t).select({id:s.platformBusinessObservation.id}).from(s.platformBusinessObservation).innerJoin(s.platformCollection,eq(s.platformCollection.id,s.platformBusinessObservation.collectionId)).where(and(eq(s.platformBusinessObservation.id,owner.observationId),eq(s.platformCollection.interface,'recognized_list'))).get()
 if(recognized)try{verifyRecognizedStored(t,owner.observationId)}catch(error){throw new FingerprintVerificationError('projection_source_drift',owner,error instanceof Error?error.message:String(error))}
 if(Object.hasOwn(options,'offlineLegacyCells'))throw new Error('Untrusted plain-cell override rejected')
 ensureProcessStoredReady(t)
 if(![71607,71608,71609,71610,71611,71612,71613].includes(Number(t.pragma('user_version',{simple:true}))))throw new FingerprintVerificationError('projection_source_drift',owner,'Explicit 71607 verifier target required')
 return t.transaction(()=>{
  const db=drizzle(t,{schema:s}),o=db.select().from(s.platformBusinessObservation).where(eq(s.platformBusinessObservation.id,owner.observationId)).get()
  const alias=db.select().from(s.platformLegacyRelationAlias).where(eq(s.platformLegacyRelationAlias.oldId,owner.relationAlias)).get()
  if(!o||o.collectionId!==owner.collectionId||alias?.observationId!==o.id)throw new FingerprintVerificationError('projection_source_drift',owner,'Observation owner conflict')
  if(o.pageId!==null) {
   const page=db.select().from(s.platformCollectionPage).where(eq(s.platformCollectionPage.id,o.pageId)).get()
   if(!page||page.collectionId!==o.collectionId||(o.pageRowNo!==null&&(o.pageRowNo<1||page.sequenceStart===null||o.sequenceNo!==page.sequenceStart+o.pageRowNo-1||page.sequenceEnd===null||o.sequenceNo>page.sequenceEnd)))throw new FingerprintVerificationError('projection_source_drift',owner,'Page coordinate conflict')
  } else if(o.pageRowNo!==null)throw new FingerprintVerificationError('projection_source_drift',owner,'Page owner missing')
  const b=db.select().from(s.platformObservationFingerprintBasis).where(eq(s.platformObservationFingerprintBasis.observationId,o.id)).get()
  if(!b||b.scheme==='uncaptured'||b.inputArchiveId===null)throw new FingerprintVerificationError('projection_source_drift',owner,'Fingerprint input not captured')
  const a=db.select().from(s.platformArchiveValue).where(eq(s.platformArchiveValue.id,b.inputArchiveId)).get()
  if(!a||a.storageClass!=='blob'||!a.bytes||a.byteLength!==a.bytes.length||a.sha256!==hash(a.bytes)||o.inputFingerprint!==hash(a.bytes)||o.projectionRuleVersion!==PLATFORM_PROJECTION_RULE)throw new FingerprintVerificationError('projection_source_drift',owner,'Fingerprint archive/rule/hash conflict')
  for(const table of [s.platformCollectionArchiveRef,s.platformObservationArchiveRef,s.platformVersionArchiveRef])if(db.select().from(table).where(eq(table.archiveId,a.id)).get())throw new FingerprintVerificationError('projection_source_drift',owner,'Input archive has another owner')
  for(const table of [s.platformApplyProjection,s.platformBusinessProjection,s.platformRecognizedProjection])if(db.select().from(table).where(eq(table.sourceArchiveId,a.id)).get())throw new FingerprintVerificationError('projection_source_drift',owner,'Input archive used as source')
  if(db.select().from(s.platformBusinessRecordVersion).where(eq(s.platformBusinessRecordVersion.canonicalArchiveId,a.id)).get())throw new FingerprintVerificationError('projection_source_drift',owner,'Input archive used as canonical')
  try {
   const original:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(a.bytes))
   if(!Buffer.from(canonicalPlatformJson(original)).equals(a.bytes))throw new Error('Noncanonical input')
   if(b.scheme==='target-command-v1') {
    const scratch=emptyFingerprintTarget(t)
    try{
     // Canonical input sorts keys. Raw archive independently preserves JSON.stringify
     // insertion order; recover that order only after proving canonical equality.
     const shape=z.object({row:z.object({rawFields:z.unknown().optional()}).passthrough()}).passthrough()
     shape.parse(original)
     const command=original as {row:Record<string,unknown>}
     const ref=db.select({r:s.platformObservationArchiveRef,a:s.platformArchiveValue}).from(s.platformObservationArchiveRef).innerJoin(s.platformArchiveValue,eq(s.platformArchiveValue.id,s.platformObservationArchiveRef.archiveId)).where(and(eq(s.platformObservationArchiveRef.ownerId,o.id),eq(s.platformObservationArchiveRef.field,'rawFields'))).get()
     if(!ref||ref.r.sealed!==1)throw new Error('Command raw owner missing')
     const raw=ref.a.storageClass==='null'?null:ref.a.storageClass==='text'&&ref.a.bytes?JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(ref.a.bytes)):undefined
     if(canonicalPlatformJson(raw)!==canonicalPlatformJson(command.row.rawFields??null))throw new Error('Command raw source conflict')
     const restored=Object.hasOwn(command.row,'rawFields')?{...command,row:{...command.row,rawFields:raw}}:command
     if([71608,71609,71610,71611,71612,71613].includes(Number(t.pragma('user_version',{simple:true})))&&db.select().from(s.platformCollection).where(eq(s.platformCollection.id,o.collectionId)).get()?.interface==='apply_list')verifyApplyStored(t,o.id,{kind:'command',input:restored as ApplyTargetInput})
     if([71610,71611,71612,71613].includes(Number(t.pragma('user_version',{simple:true})))&&db.select().from(s.platformCollection).where(eq(s.platformCollection.id,o.collectionId)).get()?.interface==='business_list')verifyProcessStored(t,o.id,{kind:'command',input:restored as ApplyTargetInput})
     verifyOriginalCommand(t,scratch,{observationId:o.id,originalInput:restored},options)
    }finally{scratch.close()}
   } else if(b.scheme==='legacy-indexed-v1'||b.scheme==='legacy-bootstrap-v1') {
    verifyLegacyFacts(t,owner,a.bytes,false,options,options.legacyCustody)
   } else throw new Error('Unknown fingerprint scheme')
   return {scheme:b.scheme,observationId:o.id}
  } catch(error) {
   if(error instanceof FingerprintVerificationError)throw error
   const reason=error instanceof Error?error.message:String(error)
   throw new FingerprintVerificationError(reason.startsWith('process_stored_uncaptured')?'process_stored_uncaptured':reason.startsWith('process_stored_conflict')?'process_stored_conflict':reason.startsWith('apply_stored_uncaptured')?'apply_stored_uncaptured':reason.startsWith('apply_stored_conflict')?'apply_stored_conflict':/mapping|record conflict|version conflict|revision1/.test(reason)?'projection_mapping_conflict':'projection_source_drift',owner,reason)
  }
 })()
}

const cellsShape=z.object({encoding:z.literal('t05a-sqlite-cells-v1'),fields:z.array(z.object({name:z.string(),storageClass:z.enum(['null','text','integer','real','blob']),hex:z.string(),real64be:z.string().optional()}))})
export function legacyFingerprintInput(t:Database.Database,owner:FingerprintOwner,legacyCustody?:LegacyFingerprintCustody) {
 const db=drizzle(t,{schema:s}),o=db.select().from(s.platformBusinessObservation).where(eq(s.platformBusinessObservation.id,owner.observationId)).get()!
 const c=db.select().from(s.platformCollection).where(eq(s.platformCollection.id,o.collectionId)).get()!
 const q=db.select().from(s.platformLegacyQueryAlias).where(eq(s.platformLegacyQueryAlias.collectionId,c.id)).get()
 if(!q)throw new Error('Legacy query alias missing')
 const archive=(field:'rawFields'|'sourceText'|'legacyRowSnapshot')=>{
  const r=db.select().from(s.platformObservationArchiveRef).where(and(eq(s.platformObservationArchiveRef.ownerId,o.id),eq(s.platformObservationArchiveRef.field,field))).get()
  const a=r?db.select().from(s.platformArchiveValue).where(eq(s.platformArchiveValue.id,r.archiveId)).get():undefined
  if(!r||r.sealed!==1||!a||(a.storageClass==='null'?(a.bytes!==null||a.sha256!==null||a.byteLength!==null):(!a.bytes||a.byteLength!==a.bytes.length||a.sha256!==hash(a.bytes))))throw new Error('Legacy archive source conflict')
  return a
 }
 // Offline S may authenticate a missing snapshot against independently frozen source cells.
 // Never synthesize a ref or seal. Default runtime/replay still requires the original snapshot.
 const refs=db.select().from(s.platformObservationArchiveRef).where(eq(s.platformObservationArchiveRef.ownerId,o.id)).all()
 const hasSnapshot=refs.some(r=>r.field==='legacyRowSnapshot')
 if(refs.length!==(hasSnapshot?3:2))throw new Error('Legacy archive owner inventory conflict')
 const raw=archive('rawFields'),source=archive('sourceText'),snapshot=hasSnapshot?archive('legacyRowSnapshot'):null
 if(snapshot&&(snapshot.storageClass!=='blob'||!snapshot.bytes))throw new Error('Legacy cells missing')
 if(legacyCustody===undefined&&!snapshot)throw new Error('Legacy cells missing')
 const archived=snapshot?cellsShape.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(snapshot.bytes!))).fields:null
 const cells=legacyCustody===undefined?archived!:cellsShape.parse({encoding:'t05a-sqlite-cells-v1',fields:legacyCustodyCells(legacyCustody!,t,owner.relationAlias)}).fields
 if(archived&&legacyCustody!==undefined&&!isDeepStrictEqual(cells,archived))throw new Error('Legacy frozen source/snapshot conflict')
 if(new Set(cells.map(c=>c.name)).size!==cells.length)throw new Error('Duplicate legacy cell')
 const cell=(name:string)=>{const v=cells.find(c=>c.name===name);if(!v)throw new Error('Legacy cell missing '+name);return v}
 const text=(name:string)=>{const v=cell(name);if(v.storageClass==='null')return null;if(v.storageClass!=='text')throw new Error('Legacy text class conflict');return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(v.hex,'hex'))}
 const number=(name:string)=>{const v=cell(name);if(v.storageClass!=='integer')throw new Error('Legacy integer class conflict');return Number(Buffer.from(v.hex,'hex').toString())}
 if(number('id')!==owner.relationAlias||number('query_id')!==q.oldId||number('sequence_no')!==o.sequenceNo||text('relation_key')!==o.sourceRelationKey)throw new Error('Legacy coordinate conflict')
 for(const [name,a] of [['raw_fields',raw],['source_text',source]] as const)if(cell(name).storageClass!==a.storageClass||cell(name).hex.toUpperCase()!==(a.bytes?.toString('hex').toUpperCase()??''))throw new Error('Legacy original bytes conflict')
 const {rawFields,invalidRaw}=legacyFingerprintRaw(raw)
 const stored={province:text('province'),status:c.interface==='business_list'&&cell('status').storageClass==='blob'?Buffer.from(cell('status').hex,'hex'):text('status'),batch:text('batch'),declareKind:text('declare_kind'),appliedAt:text('applied_at'),awardBatchLabel:text('award_batch_label'),year:cell('year').storageClass==='null'?null:number('year')}
 const bytes=Buffer.from(canonicalPlatformJson({interface:c.interface,relationKey:o.sourceRelationKey,queryId:q.oldId,sequenceNo:o.sequenceNo,queryKey:c.queryKey,rdjb:c.rdjb,queriedAt:c.queriedAt,rawFields,invalidRaw}))
 return {db,o,c,raw,cells,rawFields,stored,bytes,createdAt:text('created_at')}
}
export function verifyLegacyFacts(t:Database.Database,owner:FingerprintOwner,bytes:Buffer,notIndexed=false,options: {allowMissingVersionProjection?:boolean} = {},legacyCustody?:LegacyFingerprintCustody) {
 const {db,o,c,raw,cells,rawFields,stored,createdAt,bytes:expected}=legacyFingerprintInput(t,owner,legacyCustody)
 if(c.interface==='apply_list'&&[71608,71609,71610,71611,71612,71613].includes(Number(t.pragma('user_version',{simple:true}))))verifyApplyStored(t,o.id,{kind:'legacy',cells})
 if(c.interface==='business_list'&&[71610,71611,71612,71613].includes(Number(t.pragma('user_version',{simple:true}))))verifyProcessStored(t,o.id,{kind:'legacy',cells})
 if(!expected.equals(bytes))throw new Error('Legacy source coordinates drift')
 const plan=planPlatformObservation({interface:c.interface,relationKey:o.sourceRelationKey,rawFields})
 if(!notIndexed&&(o.identityState!==plan.identityState||o.contentState!==plan.contentState||o.keySource!==plan.keySource||!o.indexedAt))throw new FingerprintVerificationError('projection_mapping_conflict',owner,'Legacy indexed mapping conflict')
 const r=o.recordId===null?undefined:db.select().from(s.platformBusinessRecord).where(eq(s.platformBusinessRecord.id,o.recordId)).get()
 if(r&&r.identityRuleVersion!==PLATFORM_PROJECTION_RULE)throw new Error('Legacy identity rule drift')
 if(!notIndexed&&(plan.platformKey?(r?.platformKey!==plan.platformKey||r.interface!==c.interface||r.identityRuleVersion!==PLATFORM_PROJECTION_RULE):o.recordId!==null))throw new FingerprintVerificationError('projection_mapping_conflict',owner,'Legacy record conflict')
 const v=o.versionId===null?undefined:db.select().from(s.platformBusinessRecordVersion).where(eq(s.platformBusinessRecordVersion.id,o.versionId)).get()
 if(plan.contentHash&&o.recordId!==null){const mapped=db.select().from(s.platformBusinessRecordVersion).where(and(eq(s.platformBusinessRecordVersion.recordId,o.recordId),eq(s.platformBusinessRecordVersion.hashAlgorithm,PLATFORM_RAW_HASH_RULE),eq(s.platformBusinessRecordVersion.contentHash,plan.contentHash))).get();if(mapped&&mapped.id!==o.versionId)throw new FingerprintVerificationError('projection_mapping_conflict',owner,'Legacy version mapping conflict')}
 if(v&&(v.contentHash!==plan.contentHash||v.hashAlgorithm!==PLATFORM_RAW_HASH_RULE||v.canonicalRawJson!==plan.canonicalRawJson))throw new Error('Legacy source hash/rule drift')
 if(!notIndexed&&(plan.canonicalRawJson?(v?.recordId!==o.recordId||v.contentHash!==plan.contentHash||v.hashAlgorithm!==PLATFORM_RAW_HASH_RULE||v.canonicalRawJson!==plan.canonicalRawJson):o.versionId!==null))throw new FingerprintVerificationError('projection_mapping_conflict',owner,'Legacy version conflict')
 if(v) {
  const refs=db.select({r:s.platformVersionArchiveRef,a:s.platformArchiveValue}).from(s.platformVersionArchiveRef).innerJoin(s.platformArchiveValue,eq(s.platformArchiveValue.id,s.platformVersionArchiveRef.archiveId)).where(eq(s.platformVersionArchiveRef.ownerId,v.id)).all(),a=refs[0]
  if(refs.length!==1||!a||a.r.sealed!==1||a.a.id!==v.canonicalArchiveId||a.a.storageClass!=='text'||!a.a.bytes?.equals(Buffer.from(plan.canonicalRawJson!))||a.a.byteLength!==a.a.bytes.length||a.a.sha256!==hash(a.a.bytes))throw new Error('Legacy canonical archive drift')
 }
 const row=rawFields&&typeof rawFields==='object'&&!Array.isArray(rawFields)?rawFields as Record<string,unknown>:null
 const state=raw.storageClass==='null'?'absent':row?'valid':'invalid',title=row?.rdjb
 for(const [table,source,fields,rule] of [[s.platformApplyProjection,'apply_list',parseApplyRecord(row),'platform-apply-v1'],[[71610,71611,71612,71613].includes(Number(t.pragma('user_version',{simple:true})))?storedProcessProjection:s.platformBusinessProjection,'business_list',parseBusinessProcess(row),'platform-business-v1'],[s.platformRecognizedProjection,'recognized_list',parseRecognizedRecord(row),'platform-recognized-v1']] as const) {
  const rows=db.select().from(table).where(eq(table.observationId,o.id)).all(),p=rows[0]
  const wanted={...fields,createdAt,observationId:o.id,versionId:null,recordId:null,ruleVersion:rule,sourceArchiveId:raw.id,basis:state==='valid'?'observation_reconciliation':'unavailable',parseState:state,sourceTitleKind:state==='valid'?sourceValueKind(title):state==='invalid'?'invalid':'absent',sourceTitleText:typeof title==='string'?title:null,sourceTitleNumberText:typeof title==='number'?String(title):null,sourceTitleBoolean:typeof title==='boolean'?Number(title):null,sourceTitleRuleVersion:c.interface==='business_list'?businessStatusRule(t):'t05b-source-projections-v1',...sourceFieldComparison(c.interface,stored,row,state)}
  if(source===c.interface?(rows.length!==1||!p||Object.entries(wanted).some(([k,v])=>!isDeepStrictEqual(Object.fromEntries(Object.entries(p))[k],v))):rows.length!==0)throw new Error('Legacy observation projection drift')
  if(p)for(const [k,v] of Object.entries(p))if(!Object.hasOwn(wanted,k)&&!['id','sourceValidityDate','sourceMaintenanceBatch','sourceMaintenanceYearAbsent',...(source==='apply_list'&&[71608,71609,71610,71611,71612,71613].includes(Number(t.pragma('user_version',{simple:true})))?APPLY_STORED_KEYS:[]),...(source==='business_list'&&[71610,71611,71612,71613].includes(Number(t.pragma('user_version',{simple:true})))?PROCESS_STORED_KEYS:[])].includes(k)&&v!==null)throw new Error('Legacy extra observation projection field drift: '+k)
  if(source==='recognized_list'&&p){const fidelity=parseRecognizedSourceFidelity(row??{});for(const [k,v] of Object.entries(fidelity)){const current=Object.fromEntries(Object.entries(p))[k];if(current!==null&&current!==v)throw new Error('Legacy source fidelity drift')}}
  const versions=o.versionId===null?[]:db.select().from(table).where(eq(table.versionId,o.versionId)).all()
  const vf=o.versionId!==null&&source===c.interface?source==='apply_list'?plan.applyRecord:source==='business_list'?plan.businessProjection:plan.recognizedProjection:null
  if(versions[0]){const current=versions[0];if(current.basis!=='verified_raw'||current.observationId!==null)throw new Error('Legacy version projection owner drift');for(const [k,v] of Object.entries(current))if(!Object.hasOwn(vf??{},k)&&!['id','createdAt','recordId','versionId','basis','ruleVersion','sourceValidityDate','sourceMaintenanceBatch','sourceMaintenanceYearAbsent'].includes(k)&&v!==null)throw new Error('Legacy extra version projection field drift: '+k)}
  if(source==='recognized_list'&&versions[0]){const fidelity=parseRecognizedSourceFidelity(row??{});for(const [k,v] of Object.entries(fidelity)){const current=Object.fromEntries(Object.entries(versions[0]))[k];if(current!==null&&current!==v)throw new Error('Legacy version source fidelity drift')}}
  if(vf?(!(options.allowMissingVersionProjection&&versions.length===0)&&(versions.length!==1||versions[0]!.recordId!==o.recordId||versions[0]!.ruleVersion!==rule||Object.entries(vf).some(([k,v])=>!isDeepStrictEqual(Object.fromEntries(Object.entries(versions[0]!))[k],v)))):versions.length!==0)throw new Error('Legacy version projection drift')
 }
}
