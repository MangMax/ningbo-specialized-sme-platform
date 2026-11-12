/** Explicit target-only evidence serialization. Never use archive cells for business filtering. */
import { createHash } from 'node:crypto'
import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import { targetSchema as s } from './target-schema'
import { resolveLegacyReference, readOwnerArchive } from './target-archive'
import { MAX_EVIDENCE_CHUNK_BYTES, type PlatformEvidenceInput } from './evidence-read'

import { platformQueryResultShape } from './live-query'
import { relationEvidenceColumns } from './relation-evidence-snapshot'
const cellSchema = z.object({name:z.string(),storageClass:z.enum(['null','text','blob','integer','real']),hex:z.string().regex(/^(?:[a-fA-F0-9]{2})*$/),real64be:z.string().regex(/^[a-fA-F0-9]{16}$/).optional()})
const commandProvenanceSchema=z.object({interface:z.enum(['apply_list','business_list','recognized_list']),queryKey:z.string(),rdjb:z.string().optional(),queriedAt:z.string(),reuseExisting:z.literal(true).optional(),rawResponse:z.string().nullish(),collectionEvidence:z.object(platformQueryResultShape).nullish()})
const snapshotSchema=z.object({encoding:z.literal('t05a-sqlite-cells-v1'),fields:z.array(cellSchema)})
function cellExpression(c:z.infer<typeof cellSchema>):SQL {
  const bytes=Buffer.from(c.hex,'hex')
  switch(c.storageClass) {
    case 'null': return sql`NULL`
    case 'text': return sql`cast(${bytes} as text)`
    case 'blob': return sql`${bytes}`
    case 'integer': return sql`${BigInt(bytes.toString('utf8'))}`
    case 'real': {
      if(!c.real64be)throw new Error('Missing original REAL bits')
      return sql`${Buffer.from(c.real64be,'hex').readDoubleBE()}`
    }
  }
}
function fail(statusCode:number,message:string):never {throw Object.assign(new Error(message),{statusCode,statusMessage:message})}
function integer(value:number|undefined,fallback:number,min:number,max=Number.MAX_SAFE_INTEGER) {
  const n=value??fallback
  if(!Number.isSafeInteger(n)||n<min||n>max)fail(400,'Invalid platform evidence parameters')
  return n
}
/** T02 absence is meaningful only within a complete, committed, known caller field set.
 * This is evidence authorization, never a business fallback or an online archive repair. */
function provenancePresence<S extends Record<string,unknown>>(db:BetterSQLite3Database<S>,collectionId:number,queryId:number) {
  const c=db.select().from(s.platformCollection).where(eq(s.platformCollection.id,collectionId)).get()
  if(!c)throw new Error('Missing provenance collection lifecycle')
  const r=s.platformCollectionArchiveRef,v=s.platformArchiveValue
  const refs=db.select({field:r.field,sealed:r.sealed,archiveId:v.id,storageClass:v.storageClass,byteLength:v.byteLength,sha256:v.sha256}).from(r).leftJoin(v,eq(v.id,r.archiveId)).where(eq(r.ownerId,collectionId)).all()
  if(refs.some(ref=>ref.sealed!==1||ref.archiveId===null||ref.storageClass===null))throw new Error('Incomplete sealed provenance owner')
  const evidence=refs.find(ref=>ref.field==='collectionEvidence')
  const hasProvenance=refs.some(ref=>ref.field==='legacyProvenance')
  const complete=(fields:string[])=>refs.length===fields.length&&fields.every(field=>refs.some(ref=>ref.field===field))
  if(c.ruleVersion==='t04-collection-v1') {
    const run=s.platformMigrationRun,cp=s.platformMigrationCheckpoint
    const receipts=db.select({lastOldId:cp.lastOldId,copiedCount:cp.copiedCount,batchDigest:cp.batchDigest,sourceSnapshotSha256:run.sourceSnapshotSha256,sourceManifestSha256:run.sourceManifestSha256}).from(run).innerJoin(cp,eq(cp.runId,run.runId)).where(and(eq(run.transformVersion,'t04-collection-v1'),eq(run.state,'complete'),eq(cp.phase,'collections'),eq(cp.sourceTable,'platform_query'))).all()
    if(queryId!==collectionId||receipts.length!==1||!receipts.every(receipt=>receipt.lastOldId>=collectionId&&receipt.copiedCount>0&&[receipt.batchDigest,receipt.sourceSnapshotSha256,receipt.sourceManifestSha256].every(hash=>/^[0-9a-f]{64}$/.test(hash))))throw new Error('Missing completed T04 provenance receipt')
    if(!complete(hasProvenance?['rawResponse','collectionEvidence','legacyProvenance']:['rawResponse','collectionEvidence']))throw new Error('Incomplete T04 provenance field set')
    const expectedPresence=c.provenanceState==='legacy_supplement'||c.provenanceState==='conflict'
    const expectedEvidence=c.provenanceState==='captured'||c.provenanceState==='conflict'
    if(hasProvenance!==expectedPresence||!evidence||(evidence.storageClass!=='null')!==expectedEvidence||(c.parseState==='absent')!==(c.provenanceState==='unknown'))throw new Error('Contradictory T04 provenance lifecycle')
    if(hasProvenance&&refs.find(ref=>ref.field==='legacyProvenance')?.storageClass!=='blob')throw new Error('Invalid T04 provenance envelope storage')
    return hasProvenance
  }
  if(c.ruleVersion==='w4a-new-collection-v1') {
    // Accepted atomic new-only command: request/raw/evidence seal, then alias, then observations.
    // It has no legacy-supplement input or receipt. Future receipt composition is a different owner.
    if(!complete(['request','rawResponse','collectionEvidence'])||!evidence)throw new Error('Incomplete command provenance field set')
    const request=refs.find(ref=>ref.field==='request')
    if(request?.storageClass!=='text'||!request.byteLength||!request.sha256)throw new Error('Missing original command provenance input')
    const parts:Buffer[]=[]
    let offset=0
    for(;;) {
      const chunk=readOwnerArchive(db,{kind:'collection',ownerId:collectionId,field:'request'},{offset,length:MAX_EVIDENCE_CHUNK_BYTES})
      if(!chunk||chunk.isNull)throw new Error('Missing original command provenance input')
      const bytes=Buffer.from(chunk.data,'base64');parts.push(bytes);offset+=bytes.length
      if(!chunk.hasMore)break
    }
    const bytes=Buffer.concat(parts)
    if(bytes.length!==request.byteLength||createHash('sha256').update(bytes).digest('hex')!==request.sha256)throw new Error('Original command provenance input drift')
    let original:z.infer<typeof commandProvenanceSchema>
    try {original=commandProvenanceSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)))}catch {throw new Error('Untrusted original command provenance input')}
    const hasEvidence=evidence.storageClass!=='null'
    if(original.reuseExisting||original.interface!==c.interface||original.queryKey!==c.queryKey||original.queriedAt!==c.queriedAt||(original.rdjb?.trim()??'')!==c.rdjb||Boolean(original.collectionEvidence)!==hasEvidence||(!hasEvidence&&(c.interface==='recognized_list'||typeof original.rawResponse!=='string')))throw new Error('Contradictory original command provenance input')
    const raw=refs.find(ref=>ref.field==='rawResponse')!
    if(original.rawResponse==null ? raw.storageClass!=='null' : raw.storageClass!=='text'||raw.sha256!==createHash('sha256').update(Buffer.from(original.rawResponse)).digest('hex'))throw new Error('Contradictory original command raw archive')
    if(original.collectionEvidence&&(original.collectionEvidence.source!==c.source||original.collectionEvidence.status!==c.evidenceStatus))throw new Error('Contradictory original command evidence metadata')
    if(c.provenanceState!==(hasEvidence?'captured':'unknown')||c.parseState!==(hasEvidence?'valid':'absent'))throw new Error('Contradictory command provenance lifecycle')
    return false
  }
  throw new Error('Unknown provenance lifecycle')
}
/** Snapshot is deliberately whole-row: O(snapshot bytes + full computed DTO) before SQLite slices.
 * Raw/evidence ranges stay in SQLite. Provenance authorizes full request/envelope owners;
 * neither provenance nor relation promises chunk-sized whole-owner construction. */
export function readTargetPlatformEvidence<S extends Record<string,unknown>>(db:BetterSQLite3Database<S>,input:PlatformEvidenceInput) {
  const queryId=integer(input.queryId,0,1),offset=integer(input.offset,0,0,Number.MAX_SAFE_INTEGER-MAX_EVIDENCE_CHUNK_BYTES)
  const length=integer(input.length,MAX_EVIDENCE_CHUNK_BYTES,1,MAX_EVIDENCE_CHUNK_BYTES),page=integer(input.page,1,1),pageSize=integer(input.pageSize,100,1,200)
  if(!['rawResponse','collectionEvidence','legacyProvenance','relations','relation'].includes(input.field))fail(400,'Invalid platform evidence parameters')
  const relationId=input.field==='relation'?integer(input.relationId,0,1):undefined
  return db.transaction(tx=>{
    const ref=resolveLegacyReference(tx,relationId===undefined?{version:1,kind:'query',queryId}:{version:1,kind:'relation',queryId,relationId})
    if(!ref)fail(404,'Platform evidence not found')
    const o=s.platformBusinessObservation,a=s.platformLegacyRelationAlias
    if(input.field==='relations') {
      const total=tx.select({n:sql<number>`count(*)`}).from(o).where(eq(o.collectionId,ref.collectionId)).get()!.n
      const rows=tx.select({id:a.oldId,sequenceNo:o.sequenceNo}).from(o).leftJoin(a,eq(a.observationId,o.id)).where(eq(o.collectionId,ref.collectionId)).orderBy(o.sequenceNo).limit(pageSize).offset(Math.min(Number.MAX_SAFE_INTEGER,(page-1)*pageSize)).all()
      if(rows.some(row=>row.id===null))throw new Error('Missing observation alias')
      return {queryId,field:input.field,total,page,pageSize,rows}
    }
    if(ref.kind==='collection') {
      if(input.field==='relation')throw new Error('Observation reference required')
      const r=s.platformCollectionArchiveRef
      if(input.field==='legacyProvenance'&&!provenancePresence(tx,ref.collectionId,queryId)) {
        return {queryId,field:input.field,encoding:'base64' as const,offset,byteLength:0,totalBytes:0,isNull:true,hasMore:false,data:''}
      }
      const binding=tx.select().from(r).where(and(eq(r.ownerId,ref.collectionId),eq(r.field,input.field))).get()
      if(!binding||binding.sealed!==1)throw new Error('Missing sealed collection archive')
      const owner={kind:'collection' as const,ownerId:ref.collectionId,field:input.field}
      if(input.field==='legacyProvenance') {
        // T04 stores an exact length-prefixed multi-cell envelope, not the old collection DTO.
        const parts:Buffer[]=[]
        let cursor=0
        for(;;) {
          const part=readOwnerArchive(tx,owner,{offset:cursor,length:MAX_EVIDENCE_CHUNK_BYTES})
          if(!part||part.isNull)throw new Error('Missing original provenance envelope')
          const bytes=Buffer.from(part.data,'base64');parts.push(bytes);cursor+=bytes.length
          if(!part.hasMore)break
        }
        const envelope=Buffer.concat(parts)
        let cursorByte=Buffer.byteLength('T04-PROVENANCE\n')
        if(!envelope.subarray(0,cursorByte).equals(Buffer.from('T04-PROVENANCE\n')))throw new Error('Invalid original provenance envelope')
        for(const field of ['query_id','source_identity','source_sha256','segment_index','collection','input_fingerprint','import_batch_id','created_at']) {
          const end=envelope.indexOf(10,cursorByte)
          const match=/^(\w+) (null|text|blob|integer|real) (\d+)$/.exec(envelope.subarray(cursorByte,end).toString())
          if(end<0||!match||match[1]!==field)throw new Error('Invalid original provenance cell')
          const size=Number(match[3]),begin=end+1,tail=begin+size
          if(!Number.isSafeInteger(size)||tail>=envelope.length||envelope[tail]!==10)throw new Error('Truncated original provenance cell')
          if(field==='collection') {
            const data=envelope.subarray(begin+Math.min(offset,size),begin+Math.min(offset+length,size))
            return {queryId,field:input.field,encoding:'base64' as const,offset,byteLength:data.length,totalBytes:size,isNull:match[2]==='null',hasMore:offset+data.length<size,data:data.toString('base64')}
          }
          cursorByte=tail+1
        }
        throw new Error('Missing original provenance collection')
      }
      const value=readOwnerArchive(tx,owner,{offset,length})
      if(!value)throw new Error('Missing collection archive value')
      const {storageClass:_storageClass,sha256:_sha256,...chunk}=value
      return {queryId,field:input.field,...chunk}
    }
    const r=s.platformObservationArchiveRef,v=s.platformArchiveValue
    const archive=tx.select({bytes:v.bytes,sealed:r.sealed}).from(r).innerJoin(v,eq(v.id,r.archiveId)).where(and(eq(r.ownerId,ref.observationId),eq(r.field,'legacyRowSnapshot'))).get()
    if(!archive?.bytes||archive.sealed!==1)throw new Error('Missing sealed original relation snapshot')
    const cells=snapshotSchema.parse(JSON.parse(archive.bytes.toString('utf8'))).fields
    const assignment=tx.select().from(s.platformObservationAssignment).where(eq(s.platformObservationAssignment.observationId,ref.observationId)).orderBy(desc(s.platformObservationAssignment.revision)).get()
    if(!assignment)throw new Error('Missing observation assignment')
    const args=relationEvidenceColumns.flatMap(([key,name])=>{
      let value:SQL
      // Only mutable attribution comes from the latest assignment. Original source names remain frozen.
      if(key==='id')value=sql`cast(${relationId} as integer)`
      else if(key==='queryId')value=sql`cast(${queryId} as integer)`
      else if(key==='enterpriseId')value=sql`cast(${assignment.enterpriseId} as integer)`
      else if(key==='matchBasis')value=sql`${assignment.matchBasis}`
      else if(key==='verificationStatus')value=sql`${assignment.verificationStatus}`
      else {
        const c=cells.find(c=>c.name===name)
        if(!c)throw new Error(`Missing original relation cell: ${name}`)
        value=cellExpression(c)
      }
      return [sql`${key}`,key==='rawFields'?sql`json(${value})`:value]
    })
    const expression=sql`json_object(${sql.join(args,sql`, `)})`
    const found=tx.select({data:sql<Buffer>`substr(cast(${expression} as blob),${offset+1},${length})`,totalBytes:sql<number>`length(cast(${expression} as blob))`}).from(o).where(eq(o.id,ref.observationId)).get()!
    return {queryId,field:input.field,relationId,encoding:'base64' as const,offset,byteLength:found.data.length,totalBytes:found.totalBytes,isNull:false,hasMore:offset+found.data.length<found.totalBytes,data:found.data.toString('base64')}
  })
}
