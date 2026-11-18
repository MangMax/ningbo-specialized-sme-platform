import { isFinalPlatformRuntimeVersion } from '../../../../db/schema-phase'
import type Database from 'better-sqlite3'
import { hasColumns, migrationFinished, requireH1cReady } from './h1c-catalog'
export const RECOGNIZED_STORED_RULE = 'recognized-stored-title-v1'
export function recognizedStoredInstalled(t:Database.Database) {
 const phase=Number(t.pragma('user_version',{simple:true}))
 if(!isFinalPlatformRuntimeVersion(phase))throw new Error('Final native platform schema required')
 requireH1cReady(t)
 if(!hasColumns(t,'platform_recognized_projection',['observation_id','exact_title_raw','exact_title_state','exact_title_origin','exact_title_archive_id','exact_title_sha256'])){throw new Error('Recognized migration incomplete; necessary title columns are missing')}
 if(!migrationFinished(t,RECOGNIZED_STORED_RULE))throw new Error('Recognized migration incomplete; finish stored title capture before use')
 return true
}
