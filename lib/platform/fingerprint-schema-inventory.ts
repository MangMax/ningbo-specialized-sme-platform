import { witnessInstalled } from './recognized-witness-catalog'
import { recognizedStoredInstalled } from './recognized-stored-catalog'
import type Database from 'better-sqlite3'
const refs=['platform_collection_archive_ref','platform_observation_archive_ref','platform_version_archive_ref'] as const
const expected=[...refs.map(table=>`${table}.archive_id`),'platform_apply_projection.source_archive_id','platform_business_projection.source_archive_id','platform_recognized_projection.source_archive_id','platform_business_record_version.canonical_archive_id'].sort()
/** Offline completion check; never called by ordinary fingerprint requests. */
export function fingerprintArchiveInventory(t:Database.Database) {
  const incoming=(t.prepare("select m.name owner,f.[from] source,f.[to] destination from sqlite_schema m join pragma_foreign_key_list(m.name) f where m.type='table' and f.[table]='platform_archive_value'").all() as {owner:string,source:string,destination:string}[]).map(f=>`${f.owner}.${f.source}${f.destination==='id'?'':`->${f.destination}`}`).sort()
  const stored=recognizedStoredInstalled(t)?['platform_recognized_projection.exact_title_archive_id']:[]
  const witness=witnessInstalled(t)?['platform_collection.witness_archive_id','platform_business_observation.witness_archive_id']:[]
  const baseExpected = [71609,71610,71611,71612].includes(Number(t.pragma('user_version',{simple:true}))) ? [...expected,...stored,...witness,'platform_business_observation.candidate_scope_archive_id'].sort() : expected
  const allowed=t.prepare("select 1 from sqlite_schema where name='platform_observation_fingerprint_basis'").get()?[...baseExpected,'platform_observation_fingerprint_basis.input_archive_id'].sort():baseExpected
  if(JSON.stringify(incoming)!==JSON.stringify(allowed))throw new Error('Unexpected archive FK owner inventory: '+JSON.stringify(incoming))
  return incoming
}
