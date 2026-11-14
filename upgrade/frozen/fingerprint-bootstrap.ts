/** Historical offline command fixture from ab503081dae3e24680afc9b07395a7e3ff21fc9f. */
import { verifyRecognizedStored } from './recognized-stored'
/** Ordinary first indexing only. Reference consumers never create an index or basis. */
import type Database from 'better-sqlite3'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { targetSchema as s } from '../target-schema'
import { capturePhase, captureFingerprintBasis } from './fingerprint-capture'
import { legacyFingerprintInput, verifyFingerprint, verifyLegacyFacts, emptyFingerprintTarget, type FingerprintOwner, FingerprintVerificationError } from './fingerprint-verifier'
import { writeApplyTarget } from './apply-target-writer'
import { writeProcessTarget } from './process-target-writer'
import { writeRecognizedTarget } from './recognized-target-writer'
import { insertArchiveValue, bindArchive, sealArchiveOwner } from './target-archive'
import { PLATFORM_PROJECTION_RULE } from '../../lib/platform/observation-plan'
import { reconstructWitnessCollectionSource } from './recognized-witness-write'
export function bootstrapFingerprint(t:Database.Database,owner:FingerprintOwner,mode:'ordinary'|'reference') {
 const db=drizzle(t,{schema:s})
 if(!capturePhase(db,true))throw new Error('Explicit 71607 bootstrap target required')
 try {return db.transaction(tx=>{
  const o=tx.select().from(s.platformBusinessObservation).where(eq(s.platformBusinessObservation.id,owner.observationId)).get()
  const alias=tx.select().from(s.platformLegacyRelationAlias).where(eq(s.platformLegacyRelationAlias.oldId,owner.relationAlias)).get()
  if(!o||o.collectionId!==owner.collectionId||alias?.observationId!==o.id)throw new FingerprintVerificationError('projection_source_drift',owner,'Bootstrap owner conflict')
  if(o.identityState!=='not_indexed')return verifyFingerprint(t,owner)
  if(o.contentState!=='not_indexed'||[o.recordId,o.versionId,o.keySource,o.projectionRuleVersion,o.inputFingerprint,o.indexedAt,o.batchId].some(v=>v!==null))throw new FingerprintVerificationError('projection_mapping_conflict',owner,'Invalid paired not_indexed')
  const collection=tx.select({interface:s.platformCollection.interface}).from(s.platformCollection).where(eq(s.platformCollection.id,owner.collectionId)).get()
  if(collection?.interface==='recognized_list')verifyRecognizedStored(t,owner.observationId)
  if(mode==='reference'){
   if([71608,71609,71610,71611,71612,71613].includes(Number(t.pragma('user_version',{simple:true})))){const {bytes}=legacyFingerprintInput(t,owner);verifyLegacyFacts(t,owner,bytes,true)}
   return null
  }
  const {c,rawFields,stored,bytes}=legacyFingerprintInput(t,owner)
  verifyLegacyFacts(t,owner,bytes,true)
  // Ordinary source staging retains its former TEXT-only admission. Reference reads
  // and the offline status recovery do not enter this command writer path.
  if(Buffer.isBuffer(stored.status))throw new Error('Legacy text class conflict')
  const scratch=emptyFingerprintTarget(t)
  try {
   const expected=drizzle(scratch,{schema:s})
   // Source-only staging uses the original source writer and parser, never a second parser.
   expected.insert(s.platformCollection).values({...c,titleCode:null}).run()
   expected.insert(s.platformLegacyQueryAlias).values({oldId:1,collectionId:c.id}).run()
   if(c.interface==='recognized_list')reconstructWitnessCollectionSource(t,scratch,c.id)
   const writer=c.interface==='apply_list'?writeApplyTarget:c.interface==='business_list'?writeProcessTarget:writeRecognizedTarget
   const result=writer(expected,{collectionId:c.id,position:{sequenceNo:o.sequenceNo,positionState:'unknown'},row:{sequenceNo:o.sequenceNo,relationKey:o.sourceRelationKey,rawFields:rawFields as Record<string,unknown>|null,...stored,status:stored.status},assignment:{matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'bootstrap-staging'},basis:'source staging'}})
   let recordId:number|null=null,versionId:number|null=null
   if(result.recordId!==null) {
    const planned=expected.select().from(s.platformBusinessRecord).where(eq(s.platformBusinessRecord.id,result.recordId)).get()!
    let record=tx.select().from(s.platformBusinessRecord).where(and(eq(s.platformBusinessRecord.interface,c.interface),eq(s.platformBusinessRecord.platformKey,planned.platformKey))).get()
    if(!record)record=tx.insert(s.platformBusinessRecord).values({interface:c.interface,platformKey:planned.platformKey,identityRuleVersion:planned.identityRuleVersion}).returning().get()
    if(record.identityRuleVersion!==planned.identityRuleVersion)throw new Error('Bootstrap record rule conflict')
    recordId=record.id
   }
   if(result.versionId!==null) {
    const planned=expected.select().from(s.platformBusinessRecordVersion).where(eq(s.platformBusinessRecordVersion.id,result.versionId)).get()!
    let version=tx.select().from(s.platformBusinessRecordVersion).where(and(eq(s.platformBusinessRecordVersion.recordId,recordId!),eq(s.platformBusinessRecordVersion.hashAlgorithm,planned.hashAlgorithm),eq(s.platformBusinessRecordVersion.contentHash,planned.contentHash))).get()
    if(!version) {
     const a=insertArchiveValue(tx,{storageClass:'text',bytes:Buffer.from(planned.canonicalRawJson!),createdAt:null})
     version=tx.insert(s.platformBusinessRecordVersion).values({recordId:recordId!,hashAlgorithm:planned.hashAlgorithm,contentHash:planned.contentHash,canonicalRawJson:planned.canonicalRawJson}).returning().get()
     bindArchive(tx,{kind:'version',ownerId:version.id,field:'canonicalRawJson',archiveId:a});sealArchiveOwner(tx,{kind:'version',ownerId:version.id})
     tx.update(s.platformBusinessRecordVersion).set({canonicalArchiveId:a}).where(eq(s.platformBusinessRecordVersion.id,version.id)).run()
     for(const table of [s.platformApplyProjection,s.platformBusinessProjection,s.platformRecognizedProjection]) {
      const p=expected.select().from(table).where(eq(table.versionId,planned.id)).get()
      if(p) { const {id:_,...values}=p;tx.insert(table).values({...values,versionId:version.id,recordId}).run() }
     }
    }
    versionId=version.id
   }
   const fingerprint=captureFingerprintBasis(tx,o.id,'legacy-bootstrap-v1',bytes)
   tx.update(s.platformBusinessObservation).set({recordId,versionId,...expected.select({identityState:s.platformBusinessObservation.identityState,contentState:s.platformBusinessObservation.contentState,keySource:s.platformBusinessObservation.keySource}).from(s.platformBusinessObservation).where(eq(s.platformBusinessObservation.id,result.observationId)).get()!,projectionRuleVersion:PLATFORM_PROJECTION_RULE,inputFingerprint:fingerprint,indexedAt:new Date().toISOString()}).where(eq(s.platformBusinessObservation.id,o.id)).run()
   return verifyFingerprint(t,owner)
  } finally {scratch.close()}
 })}catch(error){
  if(error instanceof FingerprintVerificationError)throw error
  throw new FingerprintVerificationError('projection_source_drift',owner,error instanceof Error?error.message:String(error))
 }
}
