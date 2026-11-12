/** Evidence-only capture of new writer original cells, in the existing sealed observation owner. */
import { eq, sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { RosterImportRelation } from '../roster-import-client'
import { targetSchema as s } from './target-schema'
import { insertArchiveValue, bindArchive } from './target-archive'
export const relationEvidenceColumns = [
  ['id','id'],['queryId','query_id'],['sequenceNo','sequence_no'],['relationKey','relation_key'],
  ['enterpriseId','enterprise_id'],['rawFields','raw_fields'],['titleRaw','title_raw'],['sourceText','source_text'],
  ['usccRaw','uscc_raw'],['nameRaw','name_raw'],['aliasNameRaw','alias_name_raw'],['province','province'],
  ['status','status'],['batch','batch'],['declareKind','declare_kind'],['appliedAt','applied_at'],
  ['awardBatchLabel','award_batch_label'],['year','year'],['matchBasis','match_basis'],
  ['verificationStatus','verification_status'],['createdAt','created_at'],
] as const
export function captureRelationEvidence<S extends Record<string,unknown>>(db:BetterSQLite3Database<S>,input:{observationId:number,collectionId:number,relationAlias:number,row:RosterImportRelation,assignment:typeof s.platformObservationAssignment.$inferInsert,createdAt:string}) {
  const query=db.select().from(s.platformLegacyQueryAlias).where(eq(s.platformLegacyQueryAlias.collectionId,input.collectionId)).get()
  if(!query)throw new Error('Missing collection alias for relation evidence')
  const raw=input.row.rawFields==null?null:JSON.stringify(input.row.rawFields)
  const title=typeof input.row.rawFields?.rdjb==='string' ? input.row.rawFields.rdjb.trim()||null:null
  const values:Record<string,SQL>={id:sql`cast(${input.relationAlias} as integer)`,queryId:sql`cast(${query.oldId} as integer)`,sequenceNo:sql`cast(${input.row.sequenceNo} as integer)`,enterpriseId:sql`cast(${input.assignment.enterpriseId??null} as integer)`,year:sql`cast(${input.row.year??null} as integer)`}
  const text={...input.row,rawFields:raw,titleRaw:title,matchBasis:input.assignment.matchBasis,verificationStatus:input.assignment.verificationStatus,createdAt:input.createdAt}
  const fields=relationEvidenceColumns.map(([key,name])=>{
    const value=values[key]??sql`${key in text ? text[key as keyof typeof text]??null:null}`
    const c=db.select({storageClass:sql<string>`typeof(${value})`,hex:sql<string>`hex(cast(${value} as blob))`}).from(s.platformBusinessObservation).where(eq(s.platformBusinessObservation.id,input.observationId)).get()!
    return {name,...c}
  })
  const archiveId=insertArchiveValue(db,{storageClass:'blob',bytes:Buffer.from(JSON.stringify({encoding:'t05a-sqlite-cells-v1',fields})),createdAt:input.createdAt})
  bindArchive(db,{kind:'observation',ownerId:input.observationId,field:'legacyRowSnapshot',archiveId})
}
