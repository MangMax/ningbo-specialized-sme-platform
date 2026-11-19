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
import { targetSchema as s } from './target-schema'
import { parseRecognizedSourceFidelity } from '../layers/sme-roster/lib/platform/recognized-projection'
import { canonicalPlatformJson } from '../layers/sme-roster/lib/platform/observation-plan'
import { projectionManifest } from './projections'
import { fileHash, schemaHash, assertFrozenSource, type FrozenSource } from './collections'
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex')
const id=z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
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
    // The accepted recognized writer may additively capture these three fields on an
    // existing shared version. Permit only that original transition, proven by a new
    // observation event and its sealed raw bytes; every other old cell stays fixed.
    const additiveFidelityIds=new Set<number>()
    const projection=s.platformRecognizedProjection
    for(const old of original.select().from(projection).all()) {
      if(old.versionId===null||old.sourceMaintenanceYearAbsent!==null||old.sourceValidityDate!==null||old.sourceMaintenanceBatch!==null)continue
      const current=captured.select().from(projection).where(eq(projection.id,old.id)).get()
      if(!current||current.sourceMaintenanceYearAbsent===null)continue
      const proven=proof.events.some(event=>{
        const observation=captured.select().from(s.platformBusinessObservation).where(eq(s.platformBusinessObservation.id,event.observationId)).get()
        if(observation?.versionId!==old.versionId)return false
        const ref=s.platformObservationArchiveRef,a=s.platformArchiveValue
        const raw=captured.select({ref,value:a}).from(ref).innerJoin(a,eq(a.id,ref.archiveId)).where(and(eq(ref.ownerId,observation.id),eq(ref.field,'rawFields'))).get()
        if(!raw||raw.ref.sealed!==1||raw.value.storageClass!=='text'||!raw.value.bytes||raw.value.byteLength!==raw.value.bytes.length||raw.value.sha256!==hash(raw.value.bytes))return false
        const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw.value.bytes))
        if(!value||typeof value!=='object'||Array.isArray(value))return false
        const version=captured.select().from(s.platformBusinessRecordVersion).where(eq(s.platformBusinessRecordVersion.id,old.versionId!)).get()
        if(version?.canonicalRawJson!==canonicalPlatformJson(value))return false
        const fidelity=parseRecognizedSourceFidelity(value as Record<string,unknown>)
        return isDeepStrictEqual({...old,...fidelity},current)
      })
      if(proven)additiveFidelityIds.add(old.id)
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
      if(row.table==='platform_recognized_projection'&&additiveFidelityIds.has(owner))continue
      if(!afterRows.has(line))throw new Error('Event source changes predecessor facts: '+row.table)
    }
    return {events:proof.events,manifest:projectionManifest(f.database),snapshot:f.database.serialize(),snapshotSha256:proof.targetSha256,binding:source.sha256}
  }
}
export { verifyOriginalCommand } from './frozen/fingerprint-command-facts'
