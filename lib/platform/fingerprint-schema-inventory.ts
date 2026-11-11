import type Database from 'better-sqlite3'
const refs=['platform_collection_archive_ref','platform_observation_archive_ref','platform_version_archive_ref'] as const
const expected=[...refs.map(table=>`${table}.archive_id`),'platform_apply_projection.source_archive_id','platform_business_projection.source_archive_id','platform_recognized_projection.source_archive_id','platform_business_record_version.canonical_archive_id'].sort()
export function fingerprintArchiveInventory(t:Database.Database) {
  const tables=t.prepare("select name from sqlite_schema where type='table'").all() as {name:string}[]
  const incoming=tables.flatMap(({name})=>(t.pragma(`foreign_key_list("${name.replaceAll('"','""')}")`) as {table:string,from:string,to:string}[]).filter(f=>f.table==='platform_archive_value').map(f=>`${name}.${f.from}${f.to==='id'?'':`->${f.to}`}`)).sort()
  const allowed=t.prepare("select 1 from sqlite_schema where name='platform_observation_fingerprint_basis'").get()?[...expected,'platform_observation_fingerprint_basis.input_archive_id'].sort():expected
  if(JSON.stringify(incoming)!==JSON.stringify(allowed))throw new Error('Unexpected archive FK owner inventory: '+JSON.stringify(incoming))
  return incoming
}
