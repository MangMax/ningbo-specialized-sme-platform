/** B1 offline owner: source authentication, T05 mapping, historical completion. */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { realpathSync, statSync, statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './legacy-schema'
import { platformReconcileCapture } from './target-schema'
import { captureReconcileSlot, RECONCILE_SLOT_T04, RECONCILE_SLOT_COMPLETION, slotFallbackColumns, type SlotInput, type SlotBytes, type ReconcileSlotCapture } from './frozen/reconcile-slot-capture'
import { sourceFieldComparison } from './frozen/source-extraction'
import { rowSnapshot, schemaHash } from '../lib/platform/sqlite-row-cells'
import { requireLegacyProvenanceReady } from './legacy-provenance-catalog'
import { manifest, withFrozenSource, fileHash } from './collections'
import { hasReconcileSlotCapture, requireReconcileSlotSchema } from './reconcile-slot-schema'

const hash = (v:string|Buffer) => createHash('sha256').update(v).digest('hex')
function cellBytes(s:Database.Database, table:string, column:string, id:number) {
  const cell = s.prepare(`SELECT typeof("${column}") storageClass,cast("${column}" AS blob) bytes FROM "${table}" WHERE id=?`).get(id) as {storageClass:string;bytes:Buffer|null}
  return {...cell,byteLength:cell.bytes?.length??null,sha256:cell.bytes===null?null:hash(cell.bytes)}
}
function archive(t:Database.Database, owner:number, field:string, kind:'collection'|'observation') {
  const a = t.prepare(`SELECT a.*,r.sealed FROM platform_${kind}_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.owner_id=? AND r.field=?`).get(owner,field) as {id:number;storage_class:string;bytes:Buffer|null;byte_length:number|null;sha256:string|null;sealed:number}|undefined
  if (!a || a.sealed!==1) throw new Error('Missing sealed reconcile input: '+kind+':'+owner+':'+field)
  if (a.storage_class==='null' ? a.bytes!==null || a.byte_length!==null || a.sha256!==null
    : !Buffer.isBuffer(a.bytes) || a.bytes.length!==a.byte_length || hash(a.bytes)!==a.sha256) throw new Error('Reconcile archive bytes drift')
  return a
}
export function sourceSlotInput(s:Database.Database, oldId:number): SlotInput {
  const db = drizzle(s,{schema}), q = schema.platformQuery
  const query = db.select({id:q.id,interface:q.interface,rdjb:q.rdjb,queryKey:q.queryKey,queriedAt:q.queriedAt,status:q.status}).from(q).where(eq(q.id,oldId)).get()
  if (!query) throw new Error('Missing reconcile source query')
  const {storageClass,byteLength,sha256} = cellBytes(s,'platform_query','raw_response',oldId)
  const relations = (s.prepare('SELECT id,sequence_no FROM platform_relation WHERE query_id=? ORDER BY sequence_no').all(oldId) as {id:number;sequence_no:number}[]).map(r=>{
    const {storageClass,byteLength,sha256} = cellBytes(s,'platform_relation','raw_fields',r.id)
    return {id:r.id,sequenceNo:r.sequence_no,rawFields:{storageClass,byteLength,sha256},fallbackCells:rowSnapshot(s,'platform_relation','id',r.id,[...slotFallbackColumns]).map(({name,storageClass,hex})=>({name,storageClass,hex}))}
  })
  return {query,rawResponse:{storageClass,byteLength,sha256},relations}
}
export function captureSourceSlot(s:Database.Database,t:Database.Database,oldId:number): ReconcileSlotCapture {
  const input = sourceSlotInput(s,oldId)
  const alias = t.prepare('SELECT collection_id FROM platform_legacy_query_alias WHERE old_id=?').get(oldId) as {collection_id:number}|undefined
  if (!alias) throw new Error('Missing reconcile query alias')
  const a = archive(t,alias.collection_id,'rawResponse','collection')
  const original = cellBytes(s,'platform_query','raw_response',oldId)
  if (a.storage_class!==original.storageClass || !isDeepStrictEqual(a.bytes,original.bytes)) throw new Error('Reconcile original raw bytes differ')
  const db = drizzle(s,{schema}), r = schema.platformRelation
  let decoded: Parameters<typeof captureReconcileSlot>[3]
  try {
    decoded = {rows:input.query.interface==='recognized_list' || !['success','no_record'].includes(input.query.status) ? []
      : db.select().from(r).where(eq(r.queryId,oldId)).orderBy(asc(r.sequenceNo)).all()}
  } catch (error) {
    if (!(error instanceof Error)) throw error
    decoded = {error:error.name+': '+error.message}
  }
  const raw = s.prepare('SELECT raw_response FROM platform_query WHERE id=?').get(oldId) as {raw_response:string|null}
  return captureReconcileSlot(input,a.id,raw.raw_response,decoded)
}
export function readSlotCapture(t:Database.Database,id:number) {
  const c = platformReconcileCapture
  const row = drizzle(t).select({state:c.state,rule:c.rule,rawArchiveId:c.rawArchiveId,rowCount:c.rowCount,inputSha256:c.inputSha256,reason:c.reason}).from(c).where(eq(c.id,id)).get()
  if (!row) throw new Error('Missing reconcile collection')
  return row
}
export function storeSlotCapture(t:Database.Database,id:number,result:ReconcileSlotCapture) {
  const c = platformReconcileCapture
  drizzle(t).update(c).set(result).where(eq(c.id,id)).run()
}

/** Historical aliases only; later lawful collections/assignments/receipts are outside this set. */
export function verifyReconcileHistory(s:Database.Database,t:Database.Database,projections=false) {
  if (!hasReconcileSlotCapture(t)) return
  requireReconcileSlotSchema(t)
  const db = drizzle(s,{schema}), q = schema.platformQuery, r = schema.platformRelation
  for (const {id:oldId} of db.select({id:q.id}).from(q).orderBy(asc(q.id)).all()) {
    const alias = t.prepare('SELECT collection_id FROM platform_legacy_query_alias WHERE old_id=?').get(oldId) as {collection_id:number}|undefined
    if (!alias) throw new Error('Missing historical query alias')
    const id = alias.collection_id
    const expected = captureSourceSlot(s,t,oldId)
    if (!isDeepStrictEqual(readSlotCapture(t,id),expected)) throw new Error('Historical reconcile capture drift')
    for (const [source,target] of [['interface','interface'],['rdjb','rdjb'],['query_key','query_key'],['queried_at','queried_at'],['status','status']] as const) {
      const a = rowSnapshot(s,'platform_query','id',oldId,[source])[0]!
      const b = rowSnapshot(t,'platform_collection','id',id,[target])[0]!
      if (!isDeepStrictEqual(a,b)) throw new Error('Reconcile query context drift')
    }
    const originals = s.prepare('SELECT id,sequence_no FROM platform_relation WHERE query_id=? ORDER BY sequence_no').all(oldId) as {id:number;sequence_no:number}[]
    const mapped = t.prepare('SELECT a.old_id id,o.sequence_no FROM platform_business_observation o JOIN platform_legacy_relation_alias a ON a.observation_id=o.id WHERE o.collection_id=? ORDER BY o.sequence_no').all(id)
    const total = t.prepare('SELECT count(*) n FROM platform_business_observation WHERE collection_id=?').get(id) as {n:number}
    if (!isDeepStrictEqual(mapped,originals) || total.n!==originals.length) throw new Error('Reconcile whole observation mapping differs')
    for (const original of originals) {
      const alias = t.prepare('SELECT observation_id FROM platform_legacy_relation_alias WHERE old_id=?').get(original.id) as {observation_id:number}
      const oid = alias.observation_id
      const snapshot = archive(t,oid,'legacyRowSnapshot','observation')
      const bytes = Buffer.from(JSON.stringify({encoding:'t05a-sqlite-cells-v1',fields:rowSnapshot(s,'platform_relation','id',original.id)}))
      if (!snapshot.bytes?.equals(bytes)) throw new Error('Reconcile historical cells differ')
      for (const [column,field] of [['raw_fields','rawFields'],['source_text','sourceText']] as const) {
        const a = archive(t,oid,field,'observation'), b = cellBytes(s,'platform_relation',column,original.id)
        if (a.storage_class!==b.storageClass || !isDeepStrictEqual(a.bytes,b.bytes)) throw new Error('Reconcile historical relation archive differs')
      }
      if (!projections || inputIsRecognized(s,oldId)) continue
      const stored = db.select({province:r.province,status:r.status,batch:r.batch,declareKind:r.declareKind,appliedAt:r.appliedAt,awardBatchLabel:r.awardBatchLabel,year:r.year}).from(r).where(eq(r.id,original.id)).get()!
      const a = archive(t,oid,'rawFields','observation')
      let parsed: Record<string,unknown>|null = null, state:'valid'|'invalid'|'absent' = a.storage_class==='null'?'absent':'invalid'
      try {
        const value:unknown = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(a.bytes!))
        if (value && typeof value==='object' && !Array.isArray(value)) { parsed=value as Record<string,unknown>;state='valid' }
      } catch { /* Same unavailable raw partition as T05b; capture error remains separate. */ }
      const source = sourceSlotInput(s,oldId).query.interface
      const facts = sourceFieldComparison(source,stored,parsed,state)
      const table = source==='business_list'?'platform_business_projection':'platform_apply_projection'
      const actual = t.prepare(`SELECT * FROM ${table} WHERE observation_id=?`).get(oid) as Record<string,unknown>|undefined
      if (!actual) throw new Error('Reconcile observation projection missing')
      for (const [key,value] of Object.entries(facts)) {
        const column = key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())
        if (!isDeepStrictEqual(actual[column],value)) throw new Error('Reconcile per-observation fact drift: '+oid+':'+column)
      }
    }
  }
}
function inputIsRecognized(s:Database.Database,id:number) {
  return (s.prepare('SELECT interface FROM platform_query WHERE id=?').get(id) as {interface:string}).interface==='recognized_list'
}
export function completeReconcileSlotCapture(options:{source:string;target:string;runId:string;collectionRunId:string;beforeCommit?:()=>void}) {
  const source=realpathSync(options.source),target=realpathSync(options.target),a=statSync(source),b=statSync(target),disk=statfsSync(dirname(target))
  if (source===target || a.dev===b.dev && a.ino===b.ino || a.nlink!==1 || b.nlink!==1 || !options.runId || options.runId===options.collectionRunId) throw new Error('Independent source/target and unique completion run required')
  if (disk.bavail*disk.bsize<8*1024**3) throw new Error('Disk floor 8GiB')
  return withFrozenSource(source,frozen=>{
    const s=frozen.database,t=new Database(target,{fileMustExist:true})
    try {
      t.pragma('foreign_keys=ON')
      return t.transaction(()=>{
        requireLegacyProvenanceReady(t);requireReconcileSlotSchema(t)
        const provenance=t.prepare("SELECT target_schema_version FROM platform_migration_run WHERE transform_version='collection-legacy-provenance-v1' AND state='complete'").all() as {target_schema_version:string}[]
        if (provenance.length!==1 || provenance[0]!.target_schema_version!==schemaHash(t)) throw new Error('Capture predecessor schema drift')
        const binding = {source_snapshot_sha256:fileHash(frozen.fd),source_schema_hash:schemaHash(s),source_manifest_sha256:manifest(s,undefined,true).digest,target_schema_version:schemaHash(t),transform_version:RECONCILE_SLOT_COMPLETION}
        if (t.prepare('SELECT 1 FROM platform_migration_run WHERE transform_version=? AND run_id<>?').get(RECONCILE_SLOT_COMPLETION,options.runId)) throw new Error('Capture completion run conflict')
        const prior=t.prepare('SELECT * FROM platform_migration_run WHERE run_id=?').get(options.collectionRunId) as Record<string,unknown>|undefined
        if (!prior || prior.state!=='complete' || prior.transform_version!==RECONCILE_SLOT_T04 || prior.source_snapshot_sha256!==binding.source_snapshot_sha256 || prior.source_schema_hash!==binding.source_schema_hash || prior.source_manifest_sha256!==binding.source_manifest_sha256) throw new Error('Capture completion T04 binding drift')
        for (const transform of ['t05a-observation-v3','t05c-independent-observation-v1','w4a-pre-collection-scopes-v1']) {
          const rows=t.prepare('SELECT * FROM platform_migration_run WHERE transform_version=?').all(transform) as Record<string,unknown>[]
          if (rows.length!==1 || rows[0]!.state!=='complete' || rows[0]!.source_snapshot_sha256!==binding.source_snapshot_sha256) throw new Error('Capture prerequisite chain incomplete')
        }
        verifyReconcileHistory(s,t,true)
        const ids=(s.prepare('SELECT id FROM platform_query ORDER BY id').all() as {id:number}[]).map(q=>q.id)
        const digest=hash(JSON.stringify(ids.map(id=>({id,capture:readSlotCapture(t,id)}))))
        const checkpoint={phase:'reconcile-slot-capture',source_table:'platform_query',last_old_id:ids.at(-1)??0,copied_count:ids.length,batch_digest:digest}
        const existing=t.prepare('SELECT * FROM platform_migration_run WHERE run_id=?').get(options.runId) as Record<string,unknown>|undefined
        if (existing) {
          const {run_id:_,state,...stored}=existing
          const cps=t.prepare('SELECT phase,source_table,last_old_id,copied_count,batch_digest FROM platform_migration_checkpoint WHERE run_id=?').all(options.runId)
          if (state!=='complete' || !isDeepStrictEqual(stored,binding) || !isDeepStrictEqual(cps,[checkpoint])) throw new Error('Capture completion binding/checkpoint drift')
        } else {
          t.prepare('INSERT INTO platform_migration_run(run_id,state,source_snapshot_sha256,source_schema_hash,source_manifest_sha256,target_schema_version,transform_version) VALUES(?,?,?,?,?,?,?)').run(options.runId,'complete',...Object.values(binding))
          t.prepare('INSERT INTO platform_migration_checkpoint(run_id,phase,source_table,last_old_id,copied_count,batch_digest) VALUES(?,?,?,?,?,?)').run(options.runId,...Object.values(checkpoint))
          options.beforeCommit?.()
        }
        if (fileHash(frozen.fd)!==binding.source_snapshot_sha256 || (t.pragma('foreign_key_check') as unknown[]).length) throw new Error('Capture completion source/integrity drift')
        return {state:'complete' as const,...binding,...checkpoint}
      }).immediate()
    } finally {t.close()}
  })
}
