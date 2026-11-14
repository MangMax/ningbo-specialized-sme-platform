import { completeUpgradeActive, upgradeIntegrityGate, upgradeForeignKeyFailures } from './integrity-policy'
/** T05a offline identity/assignment transfer. No business JSON parsing or runtime imports. */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync, statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { bindArchive, bindLegacyAlias, insertArchiveValue, type ArchiveInput } from '../lib/platform/immutable-archive'
import { assertFrozenSource, fileHash, schemaHash, withFrozenSource, upgradeCollections, type FrozenSource } from './collections'
import { RECONCILE_SLOT_T04 } from '../lib/platform/reconcile-slot-capture'
import { verifyReconcileHistory } from './reconcile-slot-capture'

export const OBSERVATION_TRANSFORM = 't05a-observation-v3'
const phase = 'observations', sourceTable = 'platform_relation'
const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
const mapped = ['id','collection_id','sequence_no','page_id','page_row_no','position_state','source_relation_key']
// Complete source identity/assignment/reference domains, not just T04's query manifest.
const archiveDomains = ['platform_observation_archive_ref','platform_archive_value']
const domains = [...archiveDomains,'platform_query','platform_query_legacy_provenance','platform_query_title_scope','platform_query_title_scope_error','platform_relation','platform_business_observation','platform_business_record','platform_business_record_version','platform_observation_assignment','platform_apply_projection','platform_business_projection','platform_recognized_projection','enterprise','enterprise_alias','import_batch']
type Db = BetterSQLite3Database<typeof schema>
function columns(s: Database.Database, table: string) {
  return (s.prepare(`pragma table_info("${table}")`).all() as {name:string}[]).map(c => c.name)
}
/** Fixed schema ordinal order, per-cell storage class + SQLite CAST bytes. Evidence-only. */
export function rowSnapshot(s: Database.Database, table: string, key: string, value: number, fields = columns(s,table)) {
  const row = s.prepare(`select ${fields.flatMap((c,i) => [`typeof("${c}") k${i}`,`hex(cast("${c}" as blob)) b${i}`]).join(',')} from "${table}" where "${key}"=?`).get(value) as Record<string,string> | undefined
  if (!row) throw new Error(`Missing source row ${table}:${value}`)
  return fields.map((name,i) => {
    const storageClass=row[`k${i}`]!,hex=row[`b${i}`]!
    if(storageClass!=='real') return {name,storageClass,hex}
    const numeric=s.prepare(`select "${name}" value from "${table}" where "${key}"=?`).get(value) as {value:number}
    const bits=Buffer.alloc(8);bits.writeDoubleBE(numeric.value)
    return {name,storageClass,hex,real64be:bits.toString('hex')}
  })
}
export function observationManifest(s: Database.Database, emit?: (line:string) => void) {
  const h = createHash('sha256'), counts: Record<string,number> = {}
  for (const table of domains) {
    const info = s.prepare(`pragma table_info("${table}")`).all() as {name:string,pk:number}[]
    if (!info.length) throw new Error(`Required source domain absent: ${table}`)
    const fields = info.map(c=>c.name)
    const order = info.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>`"${c.name}"`).join(',')
    if (!order) throw new Error(`No source PK: ${table}`)
    let count = 0
    for (const row of s.prepare(`select ${fields.flatMap((c,i)=>[`typeof("${c}") k${i}`,`hex(cast("${c}" as blob)) b${i}`,`case when typeof("${c}")='real' then "${c}" end n${i}`]).join(',')} from "${table}" ${table==='platform_archive_value'?'where exists (select 1 from platform_observation_archive_ref where archive_id=platform_archive_value.id)':''} order by ${order}`).iterate()) {
      const cells = row as Record<string,string>
      const line = JSON.stringify({table,fields:fields.map((name,i)=>{
        const storageClass=cells[`k${i}`]!,hex=cells[`b${i}`]!,bytes=Buffer.from(hex,'hex')
        const metadata={name,storageClass,hex,byteLength:storageClass==='null'?null:bytes.length,sha256:storageClass==='null'?null:digest(bytes)}
        if(storageClass!=='real') return metadata
        const numeric=(row as Record<string,unknown>)[`n${i}`]
        if(typeof numeric!=='number') throw new Error('Invalid REAL storage')
        const bits=Buffer.alloc(8);bits.writeDoubleBE(numeric)
        return {...metadata,real64be:bits.toString('hex')}
      })})
      h.update(line+'\n'); emit?.(line); count++
    }
    counts[table]=count
  }
  return {digest:h.digest('hex'),counts}
}
function raw(s: Database.Database, id:number, column:string): ArchiveInput {
  const r = s.prepare(`select typeof("${column}") kind,cast("${column}" as blob) bytes from platform_relation where id=?`).get(id) as {kind:string,bytes:Buffer|null}
  if (r.kind==='null') return {storageClass:'null',bytes:null,createdAt:null}
  if (r.kind!=='text' && r.kind!=='blob') throw new Error(`Unsupported archive storage class ${id}:${column}`)
  return {storageClass:r.kind,bytes:r.bytes!,createdAt:null}
}
function exact(s:Database.Database,id:number,column:string) {
  const value = raw(s,id,column)
  return value.storageClass==='null' ? sql`NULL` : value.storageClass==='text' ? sql`cast(${value.bytes} as text)` : sql`${value.bytes}`
}
function targetRow(t:Database.Database,db:Db,id:number) {
  const a=schema.platformObservationAssignment,r=schema.platformObservationArchiveRef,v=schema.platformArchiveValue,l=schema.platformLegacyRelationAlias
  return {
    observation:rowSnapshot(t,'platform_business_observation','relation_id',id),
    assignments:db.select().from(a).where(eq(a.observationId,id)).orderBy(asc(a.revision)).all(),
    assignmentBytes: t.prepare('select revision,hex(cast(name_raw as blob)) n,hex(cast(uscc_raw as blob)) u,hex(cast(alias_name_raw as blob)) a from platform_observation_assignment where observation_id=? order by revision').all(id),
    refs:db.select().from(r).innerJoin(v,eq(v.id,r.archiveId)).where(eq(r.ownerId,id)).orderBy(asc(r.field)).all(),
    alias:db.select().from(l).where(eq(l.oldId,id)).get(),
  }
}
function validateArchive(value: typeof schema.platformArchiveValue.$inferSelect) {
  if (value.storageClass==='null') {
    if(value.bytes!==null || value.byteLength!==null || value.sha256!==null) throw new Error('Invalid archive null metadata')
  } else if(!Buffer.isBuffer(value.bytes) || value.byteLength!==value.bytes.length || value.sha256!==digest(value.bytes)) throw new Error('Invalid archive length or digest')
}
function reconcileSourceArchives(s:Database.Database,t:Database.Database,sd:Db,db:Db,last:number) {
  const ref=schema.platformObservationArchiveRef, archive=schema.platformArchiveValue
  for(const sourceRef of sd.select().from(ref).orderBy(asc(ref.ownerId),asc(ref.field)).all()) {
    const targetRef=db.select().from(ref).where(and(eq(ref.ownerId,sourceRef.ownerId),eq(ref.field,sourceRef.field))).get()
    // Only a checkpointed transfer may have sealed a previously unsealed source binding.
    const expected={...sourceRef,sealed:sourceRef.ownerId<=last?1:sourceRef.sealed}
    if(!isDeepStrictEqual(targetRef,expected)) throw new Error('Original archive reference drift')
    const sourceValue=sd.select().from(archive).where(eq(archive.id,sourceRef.archiveId)).get()
    const targetValue=db.select().from(archive).where(eq(archive.id,sourceRef.archiveId)).get()
    if(!sourceValue || !targetValue) throw new Error('Missing original archive value')
    validateArchive(sourceValue);validateArchive(targetValue)
    if(!isDeepStrictEqual(rowSnapshot(s,'platform_archive_value','id',sourceRef.archiveId),rowSnapshot(t,'platform_archive_value','id',sourceRef.archiveId))) throw new Error('Original archive metadata drift')
  }
}
function transfer(s:Database.Database,t:Database.Database,db:Db,r:Pick<typeof schema.platformRelation.$inferSelect,'id'|'queryId'|'sequenceNo'|'enterpriseId'|'matchBasis'|'verificationStatus'>) {
  const o=schema.platformBusinessObservation,a=schema.platformObservationAssignment,p=schema.platformCollectionPage
  const pages=db.select().from(p).where(and(eq(p.collectionId,r.queryId),sql`${p.sequenceStart} <= ${r.sequenceNo} AND ${p.sequenceEnd} >= ${r.sequenceNo}`)).all()
  const verified=pages.length===1 && pages[0]!.positionState==='verified'
  const mapping={id:r.id,collectionId:r.queryId,sequenceNo:r.sequenceNo,pageId:verified?pages[0]!.id:null,pageRowNo:verified?r.sequenceNo-pages[0]!.sequenceStart!+1:null,positionState:pages.length>1?'conflict' as const:verified?'verified' as const:'unknown' as const,sourceRelationKey:exact(s,r.id,'relation_key')}
  let old=db.select().from(o).where(eq(o.relationId,r.id)).get()
  if (!old) {
    // Accepted #714 branch: omission would invoke the indexed writer's ORM timestamp default.
    db.insert(o).values({relationId:r.id,recordId:null,versionId:null,identityState:'not_indexed',contentState:'not_indexed',keySource:null,projectionRuleVersion:null,inputFingerprint:null,indexedAt:null,batchId:null,...mapping}).run()
    old=db.select().from(o).where(eq(o.relationId,r.id)).get()!
  }
  if (old.id!==null) {
    const actual=rowSnapshot(t,'platform_business_observation','relation_id',r.id,mapped)
    // Existing mappings must match independently derived expected bytes below; update only an unmapped row.
    const sourceKey=raw(s,r.id,'relation_key')
    const expectedKey=actual.find(c=>c.name==='source_relation_key')!
    if (old.id!==mapping.id || old.collectionId!==mapping.collectionId || old.sequenceNo!==mapping.sequenceNo || old.pageId!==mapping.pageId || old.pageRowNo!==mapping.pageRowNo || old.positionState!==mapping.positionState || expectedKey.storageClass!==sourceKey.storageClass || expectedKey.hex!==(sourceKey.bytes?.toString('hex').toUpperCase()??'')) throw new Error(`Existing observation binding conflict ${r.id}`)
  } else db.update(o).set(mapping).where(eq(o.relationId,r.id)).run()
  const assignment={observationId:r.id,revision:1,enterpriseId:r.enterpriseId,matchBasis:r.matchBasis,verificationStatus:r.verificationStatus,usccRaw:exact(s,r.id,'uscc_raw'),nameRaw:exact(s,r.id,'name_raw'),aliasNameRaw:exact(s,r.id,'alias_name_raw'),actor:null,basis:null,recordedAt:null,commandReceiptId:null,origin:'migrated_current' as const}
  const assignments=db.select().from(a).where(eq(a.observationId,r.id)).all()
  if(assignments.length) {
    const current=assignments[0]!
    if(assignments.length!==1 || current.revision!==1 || current.enterpriseId!==r.enterpriseId || current.matchBasis!==r.matchBasis || current.verificationStatus!==r.verificationStatus || current.actor!==null || current.basis!==null || current.recordedAt!==null || current.commandReceiptId!==null || current.origin!=='migrated_current') throw new Error(`Existing assignment binding conflict ${r.id}`)
    for(const [targetColumn,sourceColumn] of [['uscc_raw','uscc_raw'],['name_raw','name_raw'],['alias_name_raw','alias_name_raw']]) {
      const cell=rowSnapshot(t,'platform_observation_assignment','observation_id',r.id,[targetColumn!])[0]!,input=raw(s,r.id,sourceColumn!)
      if(cell.storageClass!==input.storageClass || cell.hex!==(input.bytes?.toString('hex').toUpperCase()??'')) throw new Error(`Existing assignment binding conflict ${r.id}`)
    }
  } else db.insert(a).values(assignment).run()
  for (const [field,input] of [['rawFields',raw(s,r.id,'raw_fields')],['sourceText',raw(s,r.id,'source_text')],['legacyRowSnapshot',{storageClass:'blob',bytes:Buffer.from(JSON.stringify({encoding:'t05a-sqlite-cells-v1',fields:rowSnapshot(s,'platform_relation','id',r.id)})),createdAt:null}]] as const) {
    const ref=db.select().from(schema.platformObservationArchiveRef).innerJoin(schema.platformArchiveValue,eq(schema.platformArchiveValue.id,schema.platformObservationArchiveRef.archiveId)).where(and(eq(schema.platformObservationArchiveRef.ownerId,r.id),eq(schema.platformObservationArchiveRef.field,field))).get()
    if (ref) {
      const value=ref.platform_archive_value
      validateArchive(value)
      if (value.storageClass!==input.storageClass || !isDeepStrictEqual(value.bytes,input.bytes)) throw new Error(`Existing archive binding conflict ${r.id}:${field}`)
    } else bindArchive(db,{kind:'observation',ownerId:r.id,field,archiveId:insertArchiveValue(db,input)})
  }
  db.update(schema.platformObservationArchiveRef).set({sealed:1}).where(and(eq(schema.platformObservationArchiveRef.ownerId,r.id),eq(schema.platformObservationArchiveRef.sealed,0))).run()
  const alias=db.select().from(schema.platformLegacyRelationAlias).where(eq(schema.platformLegacyRelationAlias.oldId,r.id)).get()
  if (alias && alias.observationId!==r.id) throw new Error(`Existing alias conflict ${r.id}`)
  if (!alias) bindLegacyAlias(db,{kind:'relation',oldId:r.id,observationId:r.id})
}
export type ObservationUpgradeOptions = {source:string,target:string,runId:string,collectionRunId:string,batchSize:number,transformVersion?:string,beforeCheckpoint?:(id:number)=>void}
type UpgradeResult = {state:'blocked'|'complete',copiedCount:number,unresolved:{kind:string,oldId:number,reason:string}[],sourceManifest:ReturnType<typeof observationManifest>,inheritedForeignKeys:unknown,lastOldId?:number,batchDigest?:string}
export function upgradeObservations(options:ObservationUpgradeOptions,frozen?:FrozenSource):UpgradeResult {
  if (!frozen) return withFrozenSource(options.source,source=>upgradeObservations(options,source))
  assertFrozenSource(frozen,options.source)
  if (options.transformVersion!==undefined && options.transformVersion!==OBSERVATION_TRANSFORM) throw new Error('Source/schema/transform binding changed')
  const source=realpathSync(options.source),target=realpathSync(options.target),ss=statSync(source),ts=statSync(target)
  if (source===target || (ss.dev===ts.dev && ss.ino===ts.ino)) throw new Error('Source and target must be distinct isolated files')
  if (!options.runId || options.runId===options.collectionRunId || !Number.isSafeInteger(options.batchSize) || options.batchSize<1 || options.batchSize>1000) throw new Error('Invalid run or batch size')
  for (const path of [source,target]) {
    for (const suffix of ['-wal','-journal']) if (existsSync(path+suffix) && statSync(path+suffix).size>0) throw new Error('Offline frozen files required')
    const disk=statfsSync(dirname(path)); if(disk.bavail*disk.bsize<8*1024**3) throw new Error('Disk floor 8GiB')
  }
  const s=frozen.database,t=new Database(target,{fileMustExist:true})
  try {
    t.pragma('foreign_keys=ON')
    const db=drizzle(t,{schema}),sd=drizzle(s,{schema}),r=schema.platformRelation,o=schema.platformBusinessObservation
    const inheritedForeignKeys=upgradeForeignKeyFailures(s)
    const snapshot=fileHash(frozen.fd),sm=observationManifest(s)
    const unresolved: {kind:string,oldId:number,reason:string}[]=[]
    for(const table of domains) {
      const keys=(s.prepare(`pragma table_info("${table}")`).all() as {name:string,type:string,pk:number}[]).filter(c=>c.pk && c.type.toLowerCase()==='integer')
      for(const key of keys) if(s.prepare(`select 1 from "${table}" where typeof("${key.name}") <> 'integer' or "${key.name}" <= 0 or "${key.name}" > 9007199254740991 limit 1`).get()) throw new Error(`Unsafe source identity: ${table}.${key.name}`)
    }
    const invalid=sd.select({id:r.id}).from(r).where(sql`${r.sequenceNo} <= 0 OR typeof(${r.sequenceNo}) <> 'integer' OR ${r.sequenceNo} > ${Number.MAX_SAFE_INTEGER}`).all()
    for(const row of invalid) unresolved.push({kind:'invalid_sequence',oldId:row.id,reason:'Positive safe source sequence required'})
    // Report every inherited FK fault; block rather than discard or fabricate an owner.
    for(const fault of inheritedForeignKeys as {table:string,rowid:number,parent:string}[]) unresolved.push({kind:'source_foreign_key',oldId:fault.rowid,reason:`${fault.table} -> ${fault.parent}`})
    if(unresolved.length) return {state:'blocked' as const,copiedCount:0,unresolved,sourceManifest:sm,inheritedForeignKeys}
    const prior=db.select().from(schema.platformMigrationRun).where(eq(schema.platformMigrationRun.runId,options.collectionRunId)).get()
    if(prior?.state!=='complete') throw new Error('Completed T04 run required')
    upgradeCollections({source,target,runId:options.collectionRunId,batchSize:options.batchSize,transformVersion:prior.transformVersion},frozen)
    // Compare immutable legacy/source domains; mapped observation columns and newly appended assignments excluded on target.
    const binding={runId:options.runId,sourceSnapshotSha256:snapshot,sourceSchemaHash:schemaHash(s),sourceManifestSha256:sm.digest,targetSchemaVersion:schemaHash(t),transformVersion:OBSERVATION_TRANSFORM}
    const run=db.select().from(schema.platformMigrationRun).where(eq(schema.platformMigrationRun.runId,options.runId)).get()
    if(run) { const {state:_,...stored}=run; if(!isDeepStrictEqual(stored,binding)) throw new Error('Source/schema/transform binding changed') }

    const c=schema.platformMigrationCheckpoint,key=and(eq(c.runId,options.runId),eq(c.phase,phase),eq(c.sourceTable,sourceTable)),cp=db.select().from(c).where(key).get()
    if (run?.state === 'complete' && completeUpgradeActive()) {
      const count = cp?.copiedCount ?? 0
      if (count !== sm.counts.platform_relation || db.select({ n:sql<number>`count(*)` }).from(o).get()?.n !== count
        || db.select({ n:sql<number>`count(*)` }).from(schema.platformLegacyRelationAlias).get()?.n !== count) throw new Error('Completed observation checkpoint count drift')
      return { state:'complete', copiedCount:count, lastOldId:cp?.lastOldId ?? 0, batchDigest:cp?.batchDigest ?? '', unresolved, sourceManifest:sm, inheritedForeignKeys }
    }
    let last=cp?.lastOldId??0,count=0,chain='',validatedLast=0
    reconcileSourceArchives(s,t,sd,db,last)
    const advance=(value:unknown)=>{chain=digest(chain+'\n'+JSON.stringify(value))}
    for(const row of sd.select({id:r.id}).from(r).where(lte(r.id,last)).orderBy(asc(r.id)).all()) {advance(targetRow(t,db,row.id));count++;validatedLast=row.id}
    if(cp && (cp.copiedCount!==count || cp.batchDigest!==chain || validatedLast!==last)) throw new Error('Target checkpoint drift or lost PK')
    // Source domains in the copied target must remain byte-identical, including original observation fields.
    for(const table of domains.filter(x=>x!=='platform_observation_assignment'&&!archiveDomains.includes(x))) {
      const fields=columns(s,table).filter(x=>!(table==='platform_business_observation'&&mapped.includes(x))&&x!=='collection_id')
      const pk=(s.prepare(`pragma table_info("${table}")`).all() as {name:string,pk:number}[]).filter(x=>x.pk).sort((a,b)=>a.pk-b.pk).map(x=>`"${x.name}"`).join(',')
      const projection=fields.flatMap(x=>[`typeof("${x}")`,`hex(cast("${x}" as blob))`,`case when typeof("${x}")='real' then "${x}" end`]).join(',')
      if (table !== 'platform_business_observation') {
        const sourceRows = s.prepare(`select ${projection} from "${table}" order by ${pk}`).iterate()
        const targetRows = t.prepare(`select ${projection} from "${table}" order by ${pk}`).iterate()
        try {
          for (const row of sourceRows) {
            const counterpart = targetRows.next()
            if (counterpart.done || !isDeepStrictEqual(row, counterpart.value)) throw new Error(`Target source domain drift: ${table}`)
          }
          if (!targetRows.next().done) throw new Error(`Target source domain drift: ${table}`)
        } finally { sourceRows.return?.(); targetRows.return?.() }
        continue
      }
      const sourceRows=s.prepare(`select ${projection} from "${table}" order by ${pk}`).all()
      let targetRows=t.prepare(`select ${projection} from "${table}" order by ${pk}`).all()
      if(table==='platform_business_observation') {
        const originalIds=new Set(sd.select({id:o.relationId}).from(o).all().map(x=>x.id))
        const targetObservations=db.select().from(o).orderBy(asc(o.relationId)).all()
        const extra=targetObservations.filter(x=>!originalIds.has(x.relationId))
        for(const row of extra) {
          if(row.relationId>last || row.id!==row.relationId || row.identityState!=='not_indexed' || row.contentState!=='not_indexed' || [row.recordId,row.versionId,row.keySource,row.projectionRuleVersion,row.inputFingerprint,row.indexedAt,row.batchId].some(x=>x!==null)) throw new Error(`Target generated observation drift: ${row.relationId}`)
        }
        // The only new original-field rows allowed are checkpointed uncaptured observations.
        // Source-indexed observations still compare byte-for-byte in their original PK order.
        targetRows=targetRows.filter((_,i)=>originalIds.has(targetObservations[i]!.relationId))
      }
      if(!isDeepStrictEqual(sourceRows,targetRows)) throw new Error(`Target source domain drift: ${table}`)
    }
    if(!run) db.insert(schema.platformMigrationRun).values({...binding,state:'running'}).run()
    while(true) {
      // Exclude JSON-mode rawFields: malformed original bytes must never be decoded by ORM.
      const rows=sd.select({id:r.id,queryId:r.queryId,sequenceNo:r.sequenceNo,enterpriseId:r.enterpriseId,matchBasis:r.matchBasis,verificationStatus:r.verificationStatus}).from(r).where(gt(r.id,last)).orderBy(asc(r.id)).limit(options.batchSize).all()
      if(!rows.length) break
      const oldChain=chain
      try {db.transaction(tx=>{
        for(const row of rows) {transfer(s,t,tx,row);advance(targetRow(t,tx,row.id))}
        options.beforeCheckpoint?.(rows.at(-1)!.id)
        if(fileHash(frozen.fd)!==snapshot) throw new Error('Source snapshot drift')
        const values={runId:options.runId,phase,sourceTable,lastOldId:rows.at(-1)!.id,copiedCount:count+rows.length,batchDigest:chain}
        if(tx.select().from(c).where(key).get()) tx.update(c).set(values).where(key).run(); else tx.insert(c).values(values).run()
      },{behavior:'immediate'})}catch(error){chain=oldChain;throw error}
      last=rows.at(-1)!.id;count+=rows.length
    }
    const ids=sd.select({id:r.id}).from(r).orderBy(asc(r.id)).all().map(x=>x.id)
    const actual=db.select({id:o.id}).from(o).where(sql`${o.id} IS NOT NULL`).orderBy(asc(o.id)).all().map(x=>x.id)
    if(!isDeepStrictEqual(ids,actual) || count!==ids.length || db.select().from(schema.platformLegacyRelationAlias).all().length!==count || db.select().from(schema.platformObservationAssignment).all().length!==count) throw new Error('Incomplete source PK coverage')
    if(fileHash(frozen.fd)!==snapshot || observationManifest(s).digest!==sm.digest) throw new Error('Source drift')
    if(!isDeepStrictEqual(upgradeForeignKeyFailures(t),inheritedForeignKeys) || !upgradeIntegrityGate(t)) throw new Error('Target integrity failure')
    if (prior.transformVersion===RECONCILE_SLOT_T04) verifyReconcileHistory(s,t)
    db.update(schema.platformMigrationRun).set({state:'complete'}).where(eq(schema.platformMigrationRun.runId,options.runId)).run()
    return {state:'complete' as const,copiedCount:count,lastOldId:last,batchDigest:chain,unresolved,sourceManifest:sm,inheritedForeignKeys}
  }finally{t.close()}
}
