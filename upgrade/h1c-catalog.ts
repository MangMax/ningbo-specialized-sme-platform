/** Offline historical oracle from ab503081dae3e24680afc9b07395a7e3ff21fc9f. */
import { hasColumns, migrationFinished } from '../lib/platform/migration-readiness'
export { hasColumns, migrationFinished } from '../lib/platform/migration-readiness'
import { requireDifferenceReferencesReady } from './difference-reference-catalog'
import { requireLegacyProvenanceReady } from './legacy-provenance-catalog'
/** Internal target migration readiness; comprehensive validation belongs offline. */
import type Database from 'better-sqlite3'
export const H1C_CATALOG_VERSION = 71611
export const H1C_CATALOG_TRANSFORM = 'h1c-correspondence-observation-v1'
export function requireH1cReady(t:Database.Database) {
 if(t.pragma('user_version',{simple:true})===71613) {
  requireLegacyProvenanceReady(t)
  return
 }
 if(t.pragma('user_version',{simple:true})===71612)requireDifferenceReferencesReady(t)
 if(![H1C_CATALOG_VERSION,71612].includes(Number(t.pragma('user_version',{simple:true}))))throw new Error('Unsupported H1c schema version')
 if(!hasColumns(t,'record_correspondence',['id','observation_id'])||!hasColumns(t,'platform_business_observation',['id','collection_id'])||!migrationFinished(t,H1C_CATALOG_TRANSFORM))throw new Error('H1c migration incomplete; finish the offline migration before using this target')
}
