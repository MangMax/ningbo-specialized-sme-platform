/** Original command envelope is never replaced by this materialized view. */
import { sqliteConnection } from './target-connection'
import { captureSqlFactTitle } from './apply-stored-cells'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { RosterImportRelation } from '../../../../lib/roster-import-client'
import { normalizePlatformRelation } from './normalization'
export const APPLY_MATERIALIZATION_RULE='legacy-apply-insert-v1'
export const materializedText=(v:unknown)=>typeof v==='string'?v.trim()||null:null
export function applyMaterialization<S extends Record<string,unknown>>(db:BetterSQLite3Database<S>,input:RosterImportRelation,rawText:string|null){
 const row=normalizePlatformRelation('apply_list',input)
 // Frozen legacyRawRdjb grammar against actual serialized rawFields, never parsed rdjb.
 const title=captureSqlFactTitle(sqliteConnection(db),rawText)
 return {exactStatus:materializedText(row.status),exactDeclareKind:materializedText(row.declareKind),exactAppliedAt:materializedText(row.appliedAt),exactYear:typeof row.year==='number'&&Number.isFinite(row.year)?Math.trunc(row.year):null,exactTitleRaw:title,sqlFactTitle:title,nameRaw:materializedText(row.nameRaw),usccRaw:materializedText(row.usccRaw),sourceRelationKey:materializedText(row.relationKey)}
}

export function capturedApplyValues(value:ReturnType<typeof applyMaterialization>){
 const {nameRaw:_,usccRaw:__,sourceRelationKey:___,...cells}=value
 return {...cells,exactStoredState:'captured' as const,exactStoredRule:'apply-stored-cells-v1',exactStoredOrigin:'command_materialized' as const,exactStoredReason:null,sqlFactTitleState:'captured' as const,sqlFactTitleRule:'apply-legacy-sql-fact-title-v1',sqlFactTitleReason:null}
}
