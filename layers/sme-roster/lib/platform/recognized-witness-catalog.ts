import { isFinalPlatformRuntimeVersion } from '../../../../db/schema-phase'
import type Database from 'better-sqlite3'
import { hasColumns, migrationFinished, requireH1cReady } from './h1c-catalog'
import { witnessDefinitions } from './recognized-witness-schema'
export const WITNESS_TRANSFORM='recognized-witness-offline-v1'
export function witnessCatalogPresent(t:Database.Database) {
 return Object.entries(witnessDefinitions).every(([table,fields])=>hasColumns(t,table,Object.keys(fields)))
}
export function witnessInstalled(t:Database.Database) {
 const phase=Number(t.pragma('user_version',{simple:true}))
 if(!isFinalPlatformRuntimeVersion(phase))throw new Error('Final native platform schema required')
 requireH1cReady(t)
 if(!witnessCatalogPresent(t)){throw new Error('Witness migration incomplete; necessary capture columns are missing')}
 if(!migrationFinished(t,WITNESS_TRANSFORM))throw new Error('Witness migration incomplete; finish witness capture before use')
 return true
}
