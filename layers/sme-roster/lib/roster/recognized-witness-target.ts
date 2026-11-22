import { and,eq,inArray,max } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { targetSchema as s } from '../platform/target-schema'
import { witnessCollection,witnessObservation,witnessCondition } from '../platform/recognized-witness-schema'
import { witnessInstalled } from '../platform/recognized-witness-catalog'
import { sqliteConnection } from '../platform/target-connection'
import type { RecognizedWitnessReader } from './recognized-witness-reader'
import { projectRecognizedWitnesses, TargetRecognizedWitnessGap } from './recognized-witness-projection'

export { projectRecognizedWitnesses, TargetRecognizedWitnessGap, witnessPropertyKey } from './recognized-witness-projection'

const wc=alias(witnessCollection,'witness_collection_capture'),wo=alias(witnessObservation,'witness_position_capture')
const newer=alias(s.platformObservationAssignment,'witness_newer_assignment')
const valid=alias(witnessCondition,'witness_valid_condition'),year=alias(witnessCondition,'witness_year_condition'),batch=alias(witnessCondition,'witness_batch_condition')
function selectWitnessRows(db: BetterSQLite3Database<typeof s>, ids: number[]) {
 return db.select({
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
}

export type RecognizedWitnessRow = ReturnType<ReturnType<typeof selectWitnessRows>['all']>[number]
export function createTargetRecognizedWitnessReader(db:BetterSQLite3Database<typeof s>):RecognizedWitnessReader {
 const connection=sqliteConnection(db)
 const gate=()=>{if(!witnessInstalled(connection))throw new TargetRecognizedWitnessGap(null,'completed_A_required')}
 gate()
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
  const rows: RecognizedWitnessRow[] = []
  for (let start=0;start<ids.length;start+=256) rows.push(...selectWitnessRows(db, ids.slice(start,start+256)).all())
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
   const ids=[...new Set(input.relationIds)]
   const rows = batchRows ? ids.flatMap(id => { const row = batchRows!.get(id); return row ? [row] : [] }) : readRows(ids)
   return projectRecognizedWitnesses(input, rows)
  }
  return withinSnapshot(read)
 }}
}
