/** Evidence-only capture of new writer original cells, in the existing sealed observation owner. */
import { eq, sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { RosterImportRelation } from '../../../../lib/roster-import-client'
import { targetSchema as s } from './target-schema'
import { insertArchiveValue, bindArchive } from './target-archive'
import { normalizePlatformRelation } from './normalization'
import { materializedText } from './apply-materialization'
import { captureSqlFactTitle } from './apply-stored-cells'
import { sqliteConnection } from './target-connection'
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
  const collection=db.select({source:s.platformCollection.interface}).from(s.platformCollection).where(eq(s.platformCollection.id,input.collectionId)).get()
  if(!collection)throw new Error('Missing collection for relation evidence')
  const row=normalizePlatformRelation(collection.source,input.row)
  const raw=input.row.rawFields==null?null:JSON.stringify(input.row.rawFields)
  const title=captureSqlFactTitle(sqliteConnection(db),raw)
  const values:Record<string,SQL>={id:sql`cast(${input.relationAlias} as integer)`,queryId:sql`cast(${query.oldId} as integer)`,sequenceNo:sql`cast(${input.row.sequenceNo} as integer)`,enterpriseId:sql`cast(${input.assignment.enterpriseId??null} as integer)`,year:sql`cast(${typeof row.year==='number'&&Number.isFinite(row.year)?Math.trunc(row.year):null} as integer)`}
  const text={...Object.fromEntries(Object.entries(row).map(([key,value])=>[key,materializedText(value)])),rawFields:raw,titleRaw:title,matchBasis:input.assignment.matchBasis,verificationStatus:input.assignment.verificationStatus,createdAt:input.createdAt}
  const fields=relationEvidenceColumns.map(([key,name])=>{
    const value=values[key]??sql`${key in text ? text[key as keyof typeof text]??null:null}`
    const c=db.select({storageClass:sql<string>`typeof(${value})`,hex:sql<string>`hex(cast(${value} as blob))`}).from(s.platformBusinessObservation).where(eq(s.platformBusinessObservation.id,input.observationId)).get()!
    return {name,...c}
  })
  const archiveId=insertArchiveValue(db,{storageClass:'blob',bytes:Buffer.from(JSON.stringify({encoding:'t05a-sqlite-cells-v1',fields})),createdAt:input.createdAt})
  bindArchive(db,{kind:'observation',ownerId:input.observationId,field:'legacyRowSnapshot',archiveId})
}
