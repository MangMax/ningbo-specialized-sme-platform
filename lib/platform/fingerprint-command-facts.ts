import { storedProcessProjection } from './process-stored-schema'
import { reconstructWitnessCollectionSource } from './recognized-witness-write'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { targetSchema as s } from './target-schema'
import { canonicalPlatformJson, PLATFORM_PROJECTION_RULE } from './observation-plan'
import { writeApplyTarget, type ApplyTargetInput } from './apply-target-writer'
import { writeProcessTarget } from './process-target-writer'
import { writeRecognizedTarget } from './recognized-target-writer'
import { verifyProcessStored } from './process-stored-verifier'
import { verifyRecognizedStored } from './recognized-stored'
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex')
const id=z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
// passthrough retains extra original own keys. Parsing validates, but never replaces original input.
const inputShape=z.object({
  collectionId:id, batchId:id.optional(),
  position:z.object({
    sequenceNo:id, positionState:z.enum(['unknown','verified','conflict']),
    pageId:id.nullable().optional(), pageRowNo:id.nullable().optional(),
  }).passthrough(),
  row:z.object({sequenceNo:id}).passthrough(),
  assignment:z.object({
    enterpriseId:id.nullable().optional(),
    matchBasis:z.enum(['none','uscc','alias','manual']),
    verificationStatus:z.enum(['pending','confirmed']), origin:z.literal('command'),
    actor:z.object({type:z.enum(['user','agent']),id:z.string()}).passthrough(),
    basis:z.string().min(1), recordedAt:z.string().nullable().optional(),
    commandReceiptId:id.nullable().optional(),
  }).passthrough(),
}).passthrough()
/** Materialize an independent expected writer result, then compare every persisted field,
 * including observation-owned projection and revision1. Actual owner IDs are remapped;
 * generated timestamps come from the independently frozen event snapshot.
 */
type CommandEvent={observationId:number, originalInput?:unknown}
type CommandOptions={allowMissingVersionProjection?:boolean}
export function verifyOriginalCommand(target:Database.Database,predecessor:Database.Database,event:CommandEvent,options:CommandOptions = {}):Buffer {
  return target.transaction(()=>verifyCommandInSnapshot(target,predecessor,event,options)).deferred()
}
function verifyCommandInSnapshot(target:Database.Database,predecessor:Database.Database,event:CommandEvent,options:CommandOptions):Buffer {
  const original=event.originalInput
  inputShape.parse(original)
  // Validated above; retain the original, not Zod's cloned DTO (own keys/order matter).
  const input=original as ApplyTargetInput
  const actual=drizzle(target,{schema:s}),o=s.platformBusinessObservation
  const observation=actual.select().from(o).where(eq(o.id,event.observationId)).get()
  if(!observation||observation.collectionId!==input.collectionId||observation.sequenceNo!==input.position.sequenceNo||observation.projectionRuleVersion!==PLATFORM_PROJECTION_RULE)throw new Error('Command owner/rule conflict')
  const alias=actual.select().from(s.platformLegacyRelationAlias).where(eq(s.platformLegacyRelationAlias.observationId,observation.id)).get()
  const queryAlias=actual.select().from(s.platformLegacyQueryAlias).where(eq(s.platformLegacyQueryAlias.collectionId,input.collectionId)).get()
  if(!alias||!queryAlias)throw new Error('Command alias owner missing')
  const bytes=Buffer.from(canonicalPlatformJson({collectionId:input.collectionId,position:input.position,row:input.row,assignment:input.assignment,...(input.batchId===undefined?{}:{batchId:input.batchId})}))
  if(hash(bytes)!==observation.inputFingerprint)throw new Error('Command fingerprint conflict')
  const scratch=new Database(predecessor.serialize());scratch.pragma('foreign_keys=ON')
  try {
    const expected=drizzle(scratch,{schema:s})
    const collection=actual.select().from(s.platformCollection).where(eq(s.platformCollection.id,input.collectionId)).get()
    if(!collection)throw new Error('Command collection missing')
    if([71611,71612,71613].includes(Number(target.pragma('user_version',{simple:true})))){
      if(collection.interface==='business_list')verifyProcessStored(target,observation.id,{kind:'command',input})
      if(collection.interface==='recognized_list')verifyRecognizedStored(target,observation.id)
    }
    if(collection.titleCode!==null&&!expected.select().from(s.title).where(eq(s.title.code,collection.titleCode)).get()) {
      const title=actual.select().from(s.title).where(eq(s.title.code,collection.titleCode)).get()
      if(!title)throw new Error('Command title context missing')
      expected.insert(s.title).values(title).run()
    }
    if(input.assignment.enterpriseId!=null&&!expected.select().from(s.enterprise).where(eq(s.enterprise.id,input.assignment.enterpriseId)).get()) {
      const enterprise=actual.select().from(s.enterprise).where(eq(s.enterprise.id,input.assignment.enterpriseId)).get()
      if(!enterprise)throw new Error('Command enterprise context missing')
      expected.insert(s.enterprise).values(enterprise).run()
    }
    if(input.batchId!=null&&!expected.select().from(s.importBatch).where(eq(s.importBatch.id,input.batchId)).get()) {
      const batch=actual.select().from(s.importBatch).where(eq(s.importBatch.id,input.batchId)).get()
      if(!batch)throw new Error('Command import batch context missing')
      expected.insert(s.importBatch).values(batch).run()
    }
    // The independently bound snapshot also covers collections created after predecessor.
    if(!expected.select().from(s.platformCollection).where(eq(s.platformCollection.id,collection.id)).get()) {
      expected.insert(s.platformCollection).values(collection).run()
      for(const alias of actual.select().from(s.platformLegacyQueryAlias).where(eq(s.platformLegacyQueryAlias.collectionId,collection.id)).all())expected.insert(s.platformLegacyQueryAlias).values(alias).run()
    }
    if(collection.interface==='recognized_list')reconstructWitnessCollectionSource(target,scratch,collection.id)
    if(input.position.pageId!=null&&!expected.select().from(s.platformCollectionPage).where(eq(s.platformCollectionPage.id,input.position.pageId)).get()) {
      const page=actual.select().from(s.platformCollectionPage).where(eq(s.platformCollectionPage.id,input.position.pageId)).get()
      if(!page)throw new Error('Command page missing')
      expected.insert(s.platformCollectionPage).values(page).run()
    }
    const writer=collection.interface==='apply_list'?writeApplyTarget:collection.interface==='business_list'?writeProcessTarget:writeRecognizedTarget
    const result=writer(expected,input)
    if(result.reused)throw new Error('Command event overlaps predecessor indexed observation')
    const planned=expected.select().from(o).where(eq(o.id,result.observationId)).get()!
    for(const field of ['recordId','versionId','identityState','contentState','keySource'] as const) {
      if(field==='recordId'||field==='versionId')continue
      if(planned[field]!==observation[field])throw new Error('Command mapping conflict: '+field)
    }
    const expectedObservation={...planned,id:observation.id,recordId:observation.recordId,versionId:observation.versionId,indexedAt:observation.indexedAt}
    if(!isDeepStrictEqual(expectedObservation,observation))throw new Error('Command source coordinate conflict')
    const assignment=s.platformObservationAssignment
    const revision1=actual.select().from(assignment).where(and(eq(assignment.observationId,observation.id),eq(assignment.revision,1))).get()
    const plannedAssignment=expected.select().from(assignment).where(and(eq(assignment.observationId,planned.id),eq(assignment.revision,1))).get()!
    if(!isDeepStrictEqual({...plannedAssignment,observationId:observation.id},revision1))throw new Error('Command revision1 conflict')
    const ref=s.platformObservationArchiveRef,a=s.platformArchiveValue
    const archives=(db:typeof actual,owner:number)=>db.select({ref,value:a}).from(ref).innerJoin(a,eq(a.id,ref.archiveId)).where(eq(ref.ownerId,owner)).all()
    const wanted=archives(expected,planned.id),found=archives(actual,observation.id)
    if(wanted.length!==found.length)throw new Error('Command archive owner inventory conflict')
    for(const w of wanted) {
      const v=found.find(f=>f.ref.field===w.ref.field)
      let expectedBytes=w.value.bytes
      if(w.ref.field==='legacyRowSnapshot' && expectedBytes) {
        // Reconstruction generates a new alias/time, just as planned.id/indexedAt above.
        // Map only those immutable observation coordinates; all original payload cells still compare byte-for-byte.
        const alias=actual.select().from(s.platformLegacyRelationAlias).where(eq(s.platformLegacyRelationAlias.observationId,observation.id)).get()
        if(!alias||!observation.indexedAt)throw new Error('Command snapshot coordinates missing')
        const snapshot=z.object({encoding:z.literal('t05a-sqlite-cells-v1'),fields:z.array(z.object({name:z.string(),storageClass:z.string(),hex:z.string()}))}).parse(JSON.parse(expectedBytes.toString('utf8')))
        for(const cell of snapshot.fields) {
          if(cell.name==='id')cell.hex=Buffer.from(String(alias.oldId)).toString('hex').toUpperCase()
          if(cell.name==='created_at')cell.hex=Buffer.from(observation.indexedAt).toString('hex').toUpperCase()
        }
        expectedBytes=Buffer.from(JSON.stringify(snapshot))
      }
      if(!v||v.ref.sealed!==1||v.value.storageClass!==w.value.storageClass||!isDeepStrictEqual(v.value.bytes,expectedBytes)||v.value.sha256!==(expectedBytes===null?null:hash(expectedBytes))||v.value.byteLength!==(expectedBytes===null?null:expectedBytes.length))throw new Error('Command raw/source bytes conflict')
    }
    if((planned.recordId===null)!==(observation.recordId===null)||(planned.versionId===null)!==(observation.versionId===null))throw new Error('Command mapping conflict')
    if(planned.recordId!==null) {
      const r=s.platformBusinessRecord
      const e=expected.select().from(r).where(eq(r.id,planned.recordId)).get()!,v=actual.select().from(r).where(eq(r.id,observation.recordId!)).get()
      if(v&&v.identityRuleVersion!==e.identityRuleVersion)throw new Error('Command identity rule drift')
      if(!v||!isDeepStrictEqual({...e,id:v.id,createdAt:v.createdAt},v))throw new Error('Command record conflict')
    }
    if(planned.versionId!==null) {
      const v=s.platformBusinessRecordVersion
      const e=expected.select().from(v).where(eq(v.id,planned.versionId)).get()!,f=actual.select().from(v).where(eq(v.id,observation.versionId!)).get()
      const mapped=actual.select().from(v).where(and(eq(v.recordId,observation.recordId!),eq(v.hashAlgorithm,e.hashAlgorithm),eq(v.contentHash,e.contentHash))).get()
      if(mapped&&mapped.id!==observation.versionId)throw new Error('Command version mapping conflict')
      if(f&&(f.hashAlgorithm!==e.hashAlgorithm||f.contentHash!==e.contentHash||f.canonicalRawJson!==e.canonicalRawJson))throw new Error('Command content hash/rule/source drift')
      if(!f||!isDeepStrictEqual({...e,id:f.id,recordId:observation.recordId,canonicalArchiveId:f.canonicalArchiveId,createdAt:f.createdAt},f))throw new Error('Command version conflict')
      const vr=s.platformVersionArchiveRef
      const archive=actual.select({ref:vr,value:a}).from(vr).innerJoin(a,eq(a.id,vr.archiveId)).where(eq(vr.ownerId,f.id)).all()
      if(archive.length!==1||archive[0]!.ref.sealed!==1||archive[0]!.value.id!==f.canonicalArchiveId||archive[0]!.value.storageClass!=='text'||!archive[0]!.value.bytes?.equals(Buffer.from(f.canonicalRawJson!))||archive[0]!.value.sha256!==hash(archive[0]!.value.bytes!)||archive[0]!.value.byteLength!==archive[0]!.value.bytes!.length)throw new Error('Command canonical archive conflict')
    }
    for(const table of [s.platformApplyProjection,[71610,71611,71612,71613].includes(Number(target.pragma('user_version',{simple:true})))?storedProcessProjection:s.platformBusinessProjection,s.platformRecognizedProjection]) {
      const ep=expected.select().from(table).where(eq(table.observationId,planned.id)).all(),ap=actual.select().from(table).where(eq(table.observationId,observation.id)).all()
      if(ep.length!==ap.length)throw new Error('Command projection owner inventory conflict')
      for(let i=0;i<ep.length;i++) {
        const e=ep[i]!,v=ap[i]!,raw=found.find(f=>f.ref.field==='rawFields')!
        if(!isDeepStrictEqual({...e,id:v.id,observationId:observation.id,sourceArchiveId:raw.value.id,createdAt:v.createdAt},v))throw new Error('Command observation projection conflict')
      }
      if(planned.versionId!==null) {
        const ep=expected.select().from(table).where(eq(table.versionId,planned.versionId)).all(),ap=actual.select().from(table).where(eq(table.versionId,observation.versionId!)).all()
        if(ep.length!==ap.length&&!(options.allowMissingVersionProjection&&ap.length===0))throw new Error('Command version projection inventory conflict')
        for(let i=0;i<ap.length;i++){const e=ep[i]!,v=ap[i]!;if(!isDeepStrictEqual({...e,id:v.id,versionId:observation.versionId,recordId:observation.recordId,createdAt:v.createdAt},v))throw new Error('Command version projection conflict')}
      }
    }
    return bytes
  } finally {scratch.close()}
}
