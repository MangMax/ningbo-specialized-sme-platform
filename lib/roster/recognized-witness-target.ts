import Database from 'better-sqlite3'
/** Explicit accepted-71609 R5 reader. Never captures, parses archives, or selects legacy. */
import { and,eq,inArray,max,sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { targetSchema as s } from '../platform/target-schema'
import { witnessCollection,witnessObservation,witnessCondition } from '../platform/recognized-witness-schema'
import { witnessInstalled } from '../platform/recognized-witness-catalog'
import { sqliteConnection } from '../platform/target-connection'
import { normalizeUscc } from '../domain'
import type { RecognizedWitnessReader,RecognizedWitnessResult } from './recognized-witness-reader'
const SUPPORTED_RULE='recognized-witness-input-v1'
const wc=alias(witnessCollection,'witness_collection_capture'),wo=alias(witnessObservation,'witness_position_capture')
const newer=alias(s.platformObservationAssignment,'witness_newer_assignment')
const valid=alias(witnessCondition,'witness_valid_condition'),year=alias(witnessCondition,'witness_year_condition'),batch=alias(witnessCondition,'witness_batch_condition')
export class TargetRecognizedWitnessGap extends Error {
 constructor(readonly relationId:number|null,readonly reason:string){super(`Recognized witness gap ${relationId??'catalog'}: ${reason}`)}
}
/** Fixed UTF16LE code-unit decoder: does not perform Unicode replacement or v8/JSON decoding. */
export function witnessPropertyKey(hex:string):string {
 if(hex.length%4!==0||/[^0-9a-f]/.test(hex))throw new TargetRecognizedWitnessGap(null,'invalid_property_key')
 const units:string[]=[]
 for(let i=0;i<hex.length;i+=4)units.push(String.fromCharCode(Number.parseInt(hex.slice(i+2,i+4)+hex.slice(i,i+2),16)))
 return units.join('')
}
function sourceError(name:string|null,message:string|null):Error {
 const text=message??'Witness source error'
 if(name==='TypeError')return new TypeError(text)
 if(name==='RangeError')return new RangeError(text)
 if(name==='SqliteError')return new Database.SqliteError(text,'SQLITE_ERROR')
 const error=new Error(text);error.name=name??'Error';return error
}
function condition(id:number,kind:string|null,value:unknown):unknown {
 const ok=kind==='absent'||kind==='null'?value===null
  :kind==='text'||kind==='array'||kind==='object'?typeof value==='string'
  :kind==='integer'||kind==='real'?typeof value==='number'
  :kind==='true'?value===1:kind==='false'?value===0:false
 if(!ok)throw new TargetRecognizedWitnessGap(id,'condition_capture')
 return value
}
export function createTargetRecognizedWitnessReader(db:BetterSQLite3Database<typeof s>):RecognizedWitnessReader {
 const connection=sqliteConnection(db)
 const gate=()=>{if(!witnessInstalled(connection))throw new TargetRecognizedWitnessGap(null,'completed_A_required')}
 gate()
 const select=(ids:number[])=>db.select({
  relationId:s.platformLegacyRelationAlias.oldId,observationId:s.platformBusinessObservation.id,
  collectionId:s.platformCollection.id,queryId:s.platformLegacyQueryAlias.oldId,titleCode:s.platformCollection.titleCode,rdjb:s.platformCollection.rdjb,
  interface:s.platformCollection.interface,status:s.platformCollection.status,sequenceNo:s.platformBusinessObservation.sequenceNo,
  identity:s.platformBusinessObservation.identityState,content:s.platformBusinessObservation.contentState,recordInterface:s.platformBusinessRecord.interface,
  assignmentId:s.platformObservationAssignment.observationId,enterpriseId:s.platformObservationAssignment.enterpriseId,uscc:s.platformObservationAssignment.usccRaw,verification:s.platformObservationAssignment.verificationStatus,
  projectionId:s.platformRecognizedProjection.id,rawValid:s.platformRecognizedProjection.sourceValidityDate,
  rawMaintenanceBatch:s.platformRecognizedProjection.sourceMaintenanceBatch,yearAbsent:s.platformRecognizedProjection.sourceMaintenanceYearAbsent,
  state:wc.witness_state,rule:wc.witness_rule,gate:wc.witness_gate,archiveId:wc.witness_archive_id,sha:wc.witness_sha256,errorName:wc.witness_error_name,error:wc.witness_error,
  refId:s.platformCollectionArchiveRef.archiveId,sealed:s.platformCollectionArchiveRef.sealed,archiveOwner:s.platformArchiveValue.id,archiveSha:s.platformArchiveValue.sha256,
  positionState:wo.witness_state,positionRule:wo.witness_rule,positionCollection:wo.witness_collection_id,positionSequence:wo.witness_sequence_no,positionArchive:wo.witness_archive_id,positionSha:wo.witness_sha256,
  ordinal:wo.witness_ordinal,key:wo.witness_rdjb_key,pageKind:wo.witness_page_kind,positionErrorName:wo.witness_error_name,positionError:wo.witness_error,
  validKind:valid.witness_kind,valid:valid.witness_value,yearKind:year.witness_kind,year:year.witness_value,batchKind:batch.witness_kind,batch:batch.witness_value,
 }).from(s.platformLegacyRelationAlias)
 .innerJoin(s.platformBusinessObservation,eq(s.platformBusinessObservation.id,s.platformLegacyRelationAlias.observationId))
 .innerJoin(s.platformCollection,eq(s.platformCollection.id,s.platformBusinessObservation.collectionId))
 .leftJoin(s.platformLegacyQueryAlias,eq(s.platformLegacyQueryAlias.collectionId,s.platformCollection.id))
 .innerJoin(wc,eq(wc.id,s.platformCollection.id)).innerJoin(wo,eq(wo.id,s.platformBusinessObservation.id))
 .leftJoin(s.platformObservationAssignment,and(eq(s.platformObservationAssignment.observationId,s.platformBusinessObservation.id),eq(s.platformObservationAssignment.revision,db.select({revision:max(newer.revision)}).from(newer).where(eq(newer.observationId,s.platformBusinessObservation.id)))))
 .leftJoin(s.platformBusinessRecord,eq(s.platformBusinessRecord.id,s.platformBusinessObservation.recordId))
 .leftJoin(s.platformRecognizedProjection,and(eq(s.platformRecognizedProjection.versionId,s.platformBusinessObservation.versionId),eq(s.platformRecognizedProjection.recordId,s.platformBusinessObservation.recordId)))
 .leftJoin(s.platformCollectionArchiveRef,and(eq(s.platformCollectionArchiveRef.ownerId,s.platformCollection.id),eq(s.platformCollectionArchiveRef.field,'collectionEvidence')))
 .leftJoin(s.platformArchiveValue,eq(s.platformArchiveValue.id,s.platformCollectionArchiveRef.archiveId))
 .leftJoin(valid,and(eq(valid.collectionId,s.platformCollection.id),eq(valid.name,'rddqrq')))
 .leftJoin(year,and(eq(year.collectionId,s.platformCollection.id),eq(year.name,'whpcyear')))
 .leftJoin(batch,and(eq(batch.collectionId,s.platformCollection.id),eq(batch.name,'whpc')))
 .where(inArray(s.platformLegacyRelationAlias.oldId,ids))
 const unavailable=(reason:Extract<RecognizedWitnessResult,{kind:'unavailable'}>['reason']):RecognizedWitnessResult=>({kind:'unavailable',reason})
 let active=0
 function withinSnapshot<T>(read:()=>T):T {
  if(active){if(!connection.inTransaction)throw new TargetRecognizedWitnessGap(null,'snapshot_scope');return read()}
  const run=()=>{
   gate();active++
   try{return read()}finally{active--}
  }
  return connection.inTransaction?run():db.transaction(run)
 }
 const readRows = (ids: readonly number[]) => {
  const rows: ReturnType<ReturnType<typeof select>['all']> = []
  for (let start=0;start<ids.length;start+=256) rows.push(...select(ids.slice(start,start+256)).all())
  return rows
 }
 let batchRows: Map<number, ReturnType<typeof readRows>[number]> | undefined
 return {connection,withinSnapshot,
 withinBatch<T>(relationIds: readonly number[], read: () => T): T {
  return withinSnapshot(() => {
   const previous = batchRows
   batchRows = new Map(readRows([...new Set(relationIds)]).map(row => [row.relationId, row]))
   try { return read() } finally { batchRows = previous }
  })
 },readMany(input){
  if(!Number.isSafeInteger(input.enterpriseId)||input.enterpriseId<1||input.relationIds.some(id=>!Number.isSafeInteger(id)||id<1))throw new Error('Invalid witness identity')
  const read=()=>{
   const ids=[...new Set(input.relationIds)],found=new Map<number,RecognizedWitnessResult|Error>()
   const rows = batchRows ? ids.flatMap(id => { const row = batchRows!.get(id); return row ? [row] : [] }) : readRows(ids)
   for(const row of rows) {
    try {
    const id=row.relationId
    let result:RecognizedWitnessResult
    if(row.assignmentId===null)throw new TargetRecognizedWitnessGap(id,'assignment_missing')
    if(row.enterpriseId!==input.enterpriseId&&!(row.enterpriseId===null&&input.uscc!==null&&(normalizeUscc(row.uscc)||null)===input.uscc))result=unavailable('owner')
    else if(row.verification!=='confirmed')result=unavailable('unconfirmed')
    else if(row.interface!=='recognized_list'||row.status!=='success')result=unavailable('not_applicable')
    else if(row.rule!==SUPPORTED_RULE)throw new TargetRecognizedWitnessGap(id,'unsupported_capture_rule')
    else if(row.state==='uncaptured')result=unavailable('evidence_uncaptured')
    else {
     if(row.archiveId===null||row.refId!==row.archiveId||row.sealed!==1||row.archiveOwner!==row.archiveId||row.sha!==row.archiveSha)throw new TargetRecognizedWitnessGap(id,'collection_binding')
     if(row.state==='error')throw sourceError(row.errorName,row.error)
     if(row.state!=='captured'||(row.gate!==0&&row.gate!==1))throw new TargetRecognizedWitnessGap(id,'collection_state')
     if(row.gate!==1)result=unavailable('not_applicable')
     else if(row.identity!=='resolved'||row.content!=='verified'||row.recordInterface!=='recognized_list'||row.projectionId===null)result=unavailable('unverified')
     else if(row.yearAbsent===null)result=unavailable('fidelity_uncaptured')
     else {
      if(row.positionRule!==SUPPORTED_RULE||row.positionCollection!==row.collectionId||row.positionSequence!==row.sequenceNo||row.positionArchive!==row.archiveId||row.positionSha!==row.sha)throw new TargetRecognizedWitnessGap(id,'position_binding')
      if(row.positionState==='error')throw sourceError(row.positionErrorName,row.positionError)
      if(row.positionState==='rejected')result=unavailable('position_rejected')
      else {
       if(row.queryId===null)throw new TargetRecognizedWitnessGap(id,'query_alias_missing')
       if(row.positionState!=='matched'&&row.positionState!=='unmatched')throw new TargetRecognizedWitnessGap(id,'position_state')
       if(row.positionState==='matched'&&(row.ordinal===null||row.pageKind===null))throw new TargetRecognizedWitnessGap(id,'position_metadata')
       result={kind:'available',source:{queryId:row.queryId,titleCode:row.titleCode,rdjb:row.rdjb,sequenceNo:row.sequenceNo,
        conditionValidYear:condition(id,row.validKind,row.valid),conditionMaintenanceYear:condition(id,row.yearKind,row.year),conditionMaintenanceBatch:condition(id,row.batchKind,row.batch),
        rawValid:row.rawValid,rawMaintenanceYear:row.yearAbsent?null:0,rawMaintenanceBatch:row.rawMaintenanceBatch,
        position:row.positionState==='unmatched'?{state:'unmatched'}:{state:'matched',ordinal:row.ordinal!,pageKind:row.pageKind!,rdjbKey:row.key===null?null:witnessPropertyKey(row.key)}}}
      }
     }
    }
    found.set(id,result)
    }catch(error){if(!(error instanceof Error))throw error;found.set(row.relationId,error)}
   }
   const ordered=new Map<number,RecognizedWitnessResult>()
   for(const id of ids){const result=found.get(id);if(result instanceof Error)throw result;ordered.set(id,result??unavailable('missing'))}
   return ordered
  }
  return withinSnapshot(read)
 }}
}
