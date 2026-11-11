/** Offline, caller-supplied frozen execution evidence. Never emitted from a target manifest.
 * The caller vouches for the independent capture/checkpoint; digests bind its exact bytes.
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { TextDecoder, isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { targetSchema as s } from '../lib/platform/target-schema'
import { canonicalPlatformJson, PLATFORM_PROJECTION_RULE } from '../lib/platform/observation-plan'
import { writeApplyTarget, type ApplyTargetInput } from '../lib/platform/apply-target-writer'
import { writeProcessTarget } from '../lib/platform/process-target-writer'
import { writeRecognizedTarget } from '../lib/platform/recognized-target-writer'
import { projectionManifest } from './projections'
import { fileHash, schemaHash, assertFrozenSource, type FrozenSource } from './collections'
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex')
const id=z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
// passthrough retains extra original own keys. Parsing validates, but never replaces original input.
const inputShape=z.object({
  collectionId:id,
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
const eventShape=z.discriminatedUnion('lifecycle',[
  z.object({observationId:id,lifecycle:z.literal('command'),originalInput:z.unknown().optional()}).strict(),
  z.object({observationId:id,lifecycle:z.literal('legacy-bootstrap')}).strict(),
])
const proofShape=z.object({
  predecessorSha256:z.string(), targetSha256:z.string(), events:z.array(eventShape),
}).strict()
export type FingerprintEventSource={path:string,sha256:string,snapshot:string}
export type IndexEvent=z.infer<typeof eventShape>
export function readFingerprintEvents(source:FingerprintEventSource,predecessorHash:string,predecessor:Database.Database,frozen:FrozenSource) {
  assertFrozenSource(frozen,source.snapshot)
  const bytes=readFileSync(source.path)
  if(hash(bytes)!==source.sha256)throw new Error('Event source byte conflict')
  const proof=proofShape.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)))
  if(proof.predecessorSha256!==predecessorHash||new Set(proof.events.map(e=>e.observationId)).size!==proof.events.length)throw new Error('Event predecessor or duplicate owner conflict')
  const f=frozen
  {
    if(fileHash(f.fd)!==proof.targetSha256||schemaHash(f.database)!==schemaHash(predecessor)||f.database.pragma('user_version',{simple:true})!==71606)throw new Error('Event snapshot binding conflict')
    const original=drizzle(predecessor,{schema:s}),captured=drizzle(f.database,{schema:s})
    for(const table of [s.platformMigrationRun,s.platformMigrationCheckpoint]) {
      if(!isDeepStrictEqual(original.select().from(table).all(),captured.select().from(table).all()))throw new Error('Event source changes predecessor receipts')
    }
    for(const sequence of original.select().from(s.platformLegacyAliasSequence).all()) {
      const after=captured.select().from(s.platformLegacyAliasSequence).where(eq(s.platformLegacyAliasSequence.namespace,sequence.namespace)).get()
      if(!after||after.highWater<sequence.highWater)throw new Error('Event allocation highwater rewind')
    }
    const before:string[]=[],after:string[]=[]
    projectionManifest(predecessor,line=>before.push(line));projectionManifest(f.database,line=>after.push(line))
    const bootstrapIds=new Set(proof.events.filter(e=>e.lifecycle==='legacy-bootstrap').map(e=>e.observationId))
    const afterRows=new Set(after)
    for(const line of before) {
      const row=JSON.parse(line) as {table:string,fields:{name:string,hex:string}[]}
      if(row.table==='platform_legacy_alias_sequence')continue
      const owner=Number(Buffer.from(row.fields.find(f=>f.name==='id')?.hex??'','hex').toString())
      if(row.table==='platform_business_observation'&&bootstrapIds.has(owner))continue
      if(!afterRows.has(line))throw new Error('Event source changes predecessor facts: '+row.table)
    }
    return {events:proof.events,manifest:projectionManifest(f.database),snapshot:f.database.serialize(),snapshotSha256:proof.targetSha256,binding:source.sha256}
  }
}
/** Materialize an independent expected writer result, then compare every persisted field,
 * including observation-owned projection and revision1. Actual owner IDs are remapped;
 * generated timestamps come from the independently frozen event snapshot.
 */
export function verifyOriginalCommand(target:Database.Database,predecessor:Database.Database,event:Extract<IndexEvent,{lifecycle:'command'}>):Buffer {
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
  const bytes=Buffer.from(canonicalPlatformJson({collectionId:input.collectionId,position:input.position,row:input.row,assignment:input.assignment}))
  if(hash(bytes)!==observation.inputFingerprint)throw new Error('Command fingerprint conflict')
  const scratch=new Database(predecessor.serialize());scratch.pragma('foreign_keys=ON')
  try {
    const expected=drizzle(scratch,{schema:s})
    const collection=actual.select().from(s.platformCollection).where(eq(s.platformCollection.id,input.collectionId)).get()
    if(!collection)throw new Error('Command collection missing')
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
    // The independently bound snapshot also covers collections created after predecessor.
    if(!expected.select().from(s.platformCollection).where(eq(s.platformCollection.id,collection.id)).get()) {
      expected.insert(s.platformCollection).values(collection).run()
      for(const alias of actual.select().from(s.platformLegacyQueryAlias).where(eq(s.platformLegacyQueryAlias.collectionId,collection.id)).all())expected.insert(s.platformLegacyQueryAlias).values(alias).run()
    }
    if(input.position.pageId!=null&&!expected.select().from(s.platformCollectionPage).where(eq(s.platformCollectionPage.id,input.position.pageId)).get()) {
      const page=actual.select().from(s.platformCollectionPage).where(eq(s.platformCollectionPage.id,input.position.pageId)).get()
      if(!page)throw new Error('Command page missing')
      expected.insert(s.platformCollectionPage).values(page).run()
    }
    const writer=collection.interface==='apply_list'?writeApplyTarget:collection.interface==='business_list'?writeProcessTarget:writeRecognizedTarget
    const result=writer(expected,input)
    if(result.reused)throw new Error('Command event overlaps predecessor indexed observation')
    const planned=expected.select().from(o).where(eq(o.id,result.observationId)).get()!
    const expectedObservation={...planned,id:observation.id,recordId:observation.recordId,versionId:observation.versionId,indexedAt:observation.indexedAt}
    if(!isDeepStrictEqual(expectedObservation,observation))throw new Error('Command observation fact conflict')
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
      if(!v||v.ref.sealed!==1||v.value.storageClass!==w.value.storageClass||!isDeepStrictEqual(v.value.bytes,w.value.bytes)||v.value.sha256!==w.value.sha256||v.value.byteLength!==w.value.byteLength)throw new Error('Command raw/source bytes conflict')
    }
    if((planned.recordId===null)!==(observation.recordId===null)||(planned.versionId===null)!==(observation.versionId===null))throw new Error('Command mapping conflict')
    if(planned.recordId!==null) {
      const r=s.platformBusinessRecord
      const e=expected.select().from(r).where(eq(r.id,planned.recordId)).get()!,v=actual.select().from(r).where(eq(r.id,observation.recordId!)).get()
      if(!v||!isDeepStrictEqual({...e,id:v.id,createdAt:v.createdAt},v))throw new Error('Command record conflict')
    }
    if(planned.versionId!==null) {
      const v=s.platformBusinessRecordVersion
      const e=expected.select().from(v).where(eq(v.id,planned.versionId)).get()!,f=actual.select().from(v).where(eq(v.id,observation.versionId!)).get()
      if(!f||!isDeepStrictEqual({...e,id:f.id,recordId:observation.recordId,canonicalArchiveId:f.canonicalArchiveId,createdAt:f.createdAt},f))throw new Error('Command version conflict')
      const vr=s.platformVersionArchiveRef
      const archive=actual.select({ref:vr,value:a}).from(vr).innerJoin(a,eq(a.id,vr.archiveId)).where(eq(vr.ownerId,f.id)).all()
      if(archive.length!==1||archive[0]!.ref.sealed!==1||archive[0]!.value.id!==f.canonicalArchiveId||archive[0]!.value.storageClass!=='text'||!archive[0]!.value.bytes?.equals(Buffer.from(f.canonicalRawJson!))||archive[0]!.value.sha256!==hash(archive[0]!.value.bytes!)||archive[0]!.value.byteLength!==archive[0]!.value.bytes!.length)throw new Error('Command canonical archive conflict')
    }
    for(const table of [s.platformApplyProjection,s.platformBusinessProjection,s.platformRecognizedProjection]) {
      const ep=expected.select().from(table).where(eq(table.observationId,planned.id)).all(),ap=actual.select().from(table).where(eq(table.observationId,observation.id)).all()
      if(ep.length!==ap.length)throw new Error('Command projection owner inventory conflict')
      for(let i=0;i<ep.length;i++) {
        const e=ep[i]!,v=ap[i]!,raw=found.find(f=>f.ref.field==='rawFields')!
        if(!isDeepStrictEqual({...e,id:v.id,observationId:observation.id,sourceArchiveId:raw.value.id,createdAt:v.createdAt},v))throw new Error('Command observation projection conflict')
      }
      if(planned.versionId!==null) {
        const ep=expected.select().from(table).where(eq(table.versionId,planned.versionId)).all(),ap=actual.select().from(table).where(eq(table.versionId,observation.versionId!)).all()
        if(ep.length!==ap.length)throw new Error('Command version projection inventory conflict')
        for(let i=0;i<ep.length;i++){const e=ep[i]!,v=ap[i]!;if(!isDeepStrictEqual({...e,id:v.id,versionId:observation.versionId,recordId:observation.recordId,createdAt:v.createdAt},v))throw new Error('Command version projection conflict')}
      }
    }
    return bytes
  } finally {scratch.close()}
}
