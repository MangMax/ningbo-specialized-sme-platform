/** Source certification only. Business readers must not import this module. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { and,eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type Database from 'better-sqlite3'
import { targetSchema as s } from './target-schema'
import { captureWitnessInputs,captureWitnessPosition,WITNESS_RULE,witnessConditionNames } from './recognized-witness-capture'
import { witnessCollection as c,witnessCondition as k,witnessObservation as o } from './recognized-witness-schema'
import { witnessInstalled } from './recognized-witness-catalog'
import { assertH1cFingerprintSource } from './h1c-fingerprint-context'
function original(t:Database.Database,id:number) {
 const db=drizzle(t,{schema:s})
 const ref=db.select().from(s.platformCollectionArchiveRef).where(and(eq(s.platformCollectionArchiveRef.ownerId,id),eq(s.platformCollectionArchiveRef.field,'collectionEvidence'))).get()
 if(!ref)return null
 const a=db.select().from(s.platformArchiveValue).where(eq(s.platformArchiveValue.id,ref.archiveId)).get()
 if(!a||ref.sealed!==1||(a.storageClass==='null'?a.bytes!==null||a.sha256!==null||a.byteLength!==null:!a.bytes||a.bytes.length!==a.byteLength||createHash('sha256').update(a.bytes).digest('hex')!==a.sha256))throw new Error('witness_original_binding_conflict')
 return a
}
export function witnessCollectionValues(t:Database.Database,id:number) {
 const a=original(t,id)
 const binding={witness_rule:WITNESS_RULE,witness_archive_id:a?.id??null,witness_sha256:a?.sha256??null}
 if(!a)return {fields:{...binding,witness_state:'uncaptured',witness_gate:null,witness_error_name:null,witness_error:'missing_original_collection_evidence'},input:null}
 const input=captureWitnessInputs(t,a.storageClass==='null'?null:a.bytes,a.storageClass)
 return {fields:{...binding,witness_state:input.state,witness_gate:input.gate,witness_error_name:input.errorName,witness_error:input.error},input}
}
export function witnessPositionValues(t:Database.Database,id:number) {
 const db=drizzle(t,{schema:s}),row=db.select().from(s.platformBusinessObservation).where(eq(s.platformBusinessObservation.id,id)).get()
 if(!row)throw new Error('witness_observation_missing')
 const capture=witnessCollectionValues(t,row.collectionId),p=capture.input?captureWitnessPosition(capture.input,row.sequenceNo):null
 const matched=p?.state==='matched'
 return {witness_rule:WITNESS_RULE,witness_collection_id:row.collectionId,witness_sequence_no:row.sequenceNo,witness_archive_id:capture.fields.witness_archive_id,witness_sha256:capture.fields.witness_sha256,
 witness_state:p?.state??'uncaptured',witness_ordinal:matched?p.ordinal:null,witness_rdjb_kind:matched?p.rdjb.kind:null,witness_rdjb_value:matched?p.rdjb.value:null,witness_rdjb_key:matched&&p.rdjbKey!==null?Buffer.from(p.rdjbKey,'utf16le').toString('hex'):null,
 witness_page_kind:matched?p.page.kind:null,witness_page_value:matched?p.page.value:null,witness_error_name:p?.errorName??null,witness_error:p?.error??(p?null:'missing_original_collection_evidence')}
}
export function captureWitnessCollection(t:Database.Database,id:number) {
 const db=drizzle(t),r=witnessCollectionValues(t,id)
 // The original condition owner must already exist; never fabricate missing legacy rows.
 if(r.input)for(const name of witnessConditionNames){const v=r.input.conditions[name];const n=db.update(k).set({witness_kind:v.kind,witness_value:v.value}).where(and(eq(k.collectionId,id),eq(k.name,name))).run();if(n.changes!==1)throw new Error('witness_condition_owner_missing')}
 db.update(c).set(r.fields).where(eq(c.id,id)).run()
}
export function captureWitnessObservation(t:Database.Database,id:number) {drizzle(t).update(o).set(witnessPositionValues(t,id)).where(eq(o.id,id)).run()}
export function verifyWitnessCollection(t:Database.Database,id:number) {
 if(!witnessInstalled(t))return
 const db=drizzle(t),expected=witnessCollectionValues(t,id),actual=db.select().from(c).where(eq(c.id,id)).get()
 if(!actual||Object.entries(expected.fields).some(([key,value])=>!isDeepStrictEqual(Reflect.get(actual,key),value)))throw new Error('witness_collection_capture_conflict')
 if(expected.input)for(const name of witnessConditionNames){const row=db.select().from(k).where(and(eq(k.collectionId,id),eq(k.name,name))).get();const v=expected.input.conditions[name];if(!row||row.witness_kind!==v.kind||!isDeepStrictEqual(row.witness_value,v.value))throw new Error('witness_condition_capture_conflict')}
}
export function verifyWitnessObservation(t:Database.Database,id:number) {
 if(!witnessInstalled(t))return
 const db=drizzle(t),expected=witnessPositionValues(t,id),actual=db.select().from(o).where(eq(o.id,id)).get()
 if(!actual||Object.entries(expected).some(([key,value])=>!isDeepStrictEqual(Reflect.get(actual,key),value)))throw new Error('witness_position_capture_conflict')
 verifyWitnessCollection(t,expected.witness_collection_id)
}
/** Verifier's private empty in-memory reconstruction: copy authenticated original,
 * not derived witness values. No runtime reader or arbitrary catalog inheritance. */
export function reconstructWitnessCollectionSource(source:Database.Database,scratch:Database.Database,id:number) {
 if(source.pragma('user_version',{simple:true})===71611)return source.transaction(()=>{
  assertH1cFingerprintSource(source,scratch);reconstructInSnapshot(source,scratch,id)
 }).deferred()
 return reconstructInSnapshot(source,scratch,id)
}
function reconstructInSnapshot(source:Database.Database,scratch:Database.Database,id:number) {
 if(!witnessInstalled(source))return
 if(!scratch.memory||!witnessInstalled(scratch)||(scratch.prepare('SELECT count(*) n FROM platform_business_observation').get() as {n:number}).n!==0)throw new Error('witness_reconstruction_context')
 verifyWitnessCollection(source,id)
 const from=drizzle(source,{schema:s}),to=drizzle(scratch,{schema:s})
 const ref=from.select().from(s.platformCollectionArchiveRef).where(and(eq(s.platformCollectionArchiveRef.ownerId,id),eq(s.platformCollectionArchiveRef.field,'collectionEvidence'))).get()
 if(ref){
  const a=from.select().from(s.platformArchiveValue).where(eq(s.platformArchiveValue.id,ref.archiveId)).get()!
  const existing=to.select().from(s.platformArchiveValue).where(eq(s.platformArchiveValue.id,a.id)).get()
  if(existing&&!isDeepStrictEqual(existing,a))throw new Error('witness_reconstruction_archive_collision')
  if(!existing)to.insert(s.platformArchiveValue).values(a).run()
  to.insert(s.platformCollectionArchiveRef).values(ref).run()
 }
 for(const condition of from.select().from(s.platformCollectionCondition).where(eq(s.platformCollectionCondition.collectionId,id)).all())to.insert(s.platformCollectionCondition).values(condition).run()
 captureWitnessCollection(scratch,id)
}
