/** Fixed H1c verifier memory capability. Never a primary writer/version adapter. */
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { authenticateH1cCatalog, H1C_CATALOG_VERSION, type H1cCatalogBinding } from './h1c-catalog'

type Context={binding:H1cCatalogBinding;catalog:string;ledger:string;processSourceSchema:string}
const contexts=new WeakMap<Database.Database,Context>()
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"'
const catalog=(t:Database.Database)=>JSON.stringify(t.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all())
const ledger=(t:Database.Database)=>createHash('sha256').update(JSON.stringify([
 t.prepare('SELECT * FROM platform_migration_run ORDER BY run_id').all(),
 t.prepare('SELECT * FROM platform_migration_checkpoint ORDER BY run_id,phase,source_table').all(),
])).digest('hex')
function context(t:Database.Database){
 const found=contexts.get(t)
 if(found&&(!t.memory||t.pragma('user_version',{simple:true})!==H1C_CATALOG_VERSION||t.pragma('foreign_keys',{simple:true})!==1||catalog(t)!==found.catalog))throw new Error('h1c_fingerprint_context_drift')
 return found
}
export function isH1cFingerprintScratch(t:Database.Database){return context(t)!==undefined}
export function authenticateH1cFingerprintCatalog(t:Database.Database):H1cCatalogBinding {
 const inherited=context(t)
 return inherited?{...inherited.binding}:authenticateH1cCatalog(t)
}
export function h1cFingerprintProcessSource(t:Database.Database){return context(t)?.processSourceSchema??null}
/** Only registration is empty-only. The owner then materializes expected inputs. */
export function inheritH1cFingerprintContext(source:Database.Database,target:Database.Database){
 return source.transaction(()=>{
  const binding=authenticateH1cFingerprintCatalog(source)
  const sourceContext=context(source),sourceCatalog=catalog(source)
  if(!target.memory||target.pragma('user_version',{simple:true})!==H1C_CATALOG_VERSION||target.pragma('foreign_keys',{simple:true})!==1||catalog(target)!==sourceCatalog)throw new Error('h1c_fingerprint_empty_catalog')
  const highwaters=target.prepare('SELECT namespace,high_water FROM platform_legacy_alias_sequence ORDER BY namespace').all()
  if(JSON.stringify(highwaters)!==JSON.stringify([{namespace:'query',high_water:0},{namespace:'relation',high_water:0}]))throw new Error('h1c_fingerprint_empty_highwaters')
  const tables=z.array(z.object({name:z.string()})).parse(target.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name<>'platform_legacy_alias_sequence' AND (name NOT GLOB 'sqlite_*' OR name='sqlite_sequence')").all())
  if(tables.some(({name})=>target.prepare(`SELECT 1 FROM ${quote(name)} LIMIT 1`).get()))throw new Error('h1c_fingerprint_empty_data')
  const processSourceSchema=sourceContext?.processSourceSchema??z.object({source_schema_hash:z.string()}).parse(source.prepare("SELECT source_schema_hash FROM platform_migration_run WHERE transform_version='process-exact-stored-offline-v1'").get()).source_schema_hash
  contexts.set(target,{binding,catalog:sourceCatalog,ledger:sourceContext?.ledger??ledger(source),processSourceSchema})
 }).deferred()
}
/** Bind reconstructed memory to this exact authenticated source ledger, not a marker. */
export function assertH1cFingerprintSource(source:Database.Database,scratch:Database.Database){
 return source.transaction(()=>{
  const proof=context(scratch)
  if(!proof)throw new Error('h1c_fingerprint_context_missing')
  authenticateH1cFingerprintCatalog(source)
  if(catalog(source)!==proof.catalog||(context(source)?.ledger??ledger(source))!==proof.ledger)throw new Error('h1c_fingerprint_source_binding')
 }).deferred()
}
