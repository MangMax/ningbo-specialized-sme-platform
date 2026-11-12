import { processPredecessorSchema } from './process-stored-catalog'
import { authenticateH1cCatalog, H1C_CATALOG_VERSION } from './h1c-catalog'
/** Exact #733 A catalog successor to the accepted #732 receipt, not a reader exemption. */
import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import { schemaHash } from './sqlite-row-cells'
import { witnessDefinitions } from './recognized-witness-schema'
import { WITNESS_RULE } from './recognized-witness-capture'
export const WITNESS_TRANSFORM='recognized-witness-offline-v1'
const normalize=(s:string)=>s.trim().replace(/;$/,'').replace(/\s+/g,' ')
const changed=(table:keyof typeof witnessDefinitions)=>Object.keys(witnessDefinitions[table]).map(n=>`NEW.${n} IS NOT OLD.${n} OR typeof(NEW.${n})<>typeof(OLD.${n})`).join(' OR ')
const valueShape=(p:string)=>`((NEW.${p}_kind IN ('absent','null') AND NEW.${p}_value IS NULL) OR (NEW.${p}_kind IN ('text','number','boolean','array','object') AND typeof(NEW.${p}_value)='blob'))`
const bound=`EXISTS(SELECT 1 FROM platform_collection_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id WHERE r.owner_id=NEW.id AND r.field='collectionEvidence' AND r.sealed=1 AND a.id=NEW.witness_archive_id AND a.sha256 IS NEW.witness_sha256)`
export const witnessTriggers=`CREATE TRIGGER recognized_witness_collection_update BEFORE UPDATE ON platform_collection WHEN
 (OLD.witness_rule IS NOT NULL AND (${changed('platform_collection')} OR NEW.id<>OLD.id)) OR
 ((${changed('platform_collection')}) AND (NEW.witness_state NOT IN ('captured','error','uncaptured') OR NEW.witness_rule IS NOT '${WITNESS_RULE}' OR
  (NEW.witness_state='uncaptured' AND (NEW.witness_archive_id IS NOT NULL OR NEW.witness_sha256 IS NOT NULL OR NEW.witness_gate IS NOT NULL OR NEW.witness_error_name IS NOT NULL OR NEW.witness_error IS NOT 'missing_original_collection_evidence')) OR
  (NEW.witness_state<>'uncaptured' AND NOT ${bound}) OR
  (NEW.witness_state='captured' AND (NEW.witness_gate IS NULL OR NEW.witness_gate NOT IN (0,1) OR NEW.witness_error IS NOT NULL OR NEW.witness_error_name IS NOT NULL)) OR
  (NEW.witness_state='error' AND (NEW.witness_gate IS NOT NULL OR NEW.witness_error IS NULL OR NEW.witness_error_name IS NULL))))
 BEGIN SELECT RAISE(ABORT,'immutable or invalid recognized witness collection'); END;
CREATE TRIGGER recognized_witness_collection_insert BEFORE INSERT ON platform_collection WHEN NEW.witness_state<>'uncaptured' OR NEW.witness_rule IS NOT NULL OR NEW.witness_gate IS NOT NULL OR NEW.witness_archive_id IS NOT NULL OR NEW.witness_sha256 IS NOT NULL OR NEW.witness_error IS NOT NULL OR NEW.witness_error_name IS NOT NULL
 BEGIN SELECT RAISE(ABORT,'recognized witness capture follows sealed source'); END;
CREATE TRIGGER recognized_witness_condition_insert BEFORE INSERT ON platform_collection_condition WHEN NEW.witness_kind IS NOT NULL OR NEW.witness_value IS NOT NULL OR EXISTS(SELECT 1 FROM platform_collection_condition old WHERE old.collection_id=NEW.collection_id AND old.name=NEW.name AND old.witness_kind IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'recognized witness condition follows sealed source'); END;
CREATE TRIGGER recognized_witness_condition_update BEFORE UPDATE ON platform_collection_condition WHEN
 (OLD.witness_kind IS NOT NULL AND (${changed('platform_collection_condition')} OR NEW.collection_id<>OLD.collection_id OR NEW.name<>OLD.name)) OR
 ((NEW.collection_id<>OLD.collection_id OR NEW.name<>OLD.name) AND EXISTS(SELECT 1 FROM platform_collection_condition destination WHERE destination.collection_id=NEW.collection_id AND destination.name=NEW.name AND destination.witness_kind IS NOT NULL))
 BEGIN SELECT RAISE(ABORT,'immutable recognized witness condition'); END;
CREATE TRIGGER recognized_witness_condition_delete BEFORE DELETE ON platform_collection_condition WHEN OLD.witness_kind IS NOT NULL
 BEGIN SELECT RAISE(ABORT,'immutable recognized witness condition'); END;
CREATE TRIGGER recognized_witness_condition_shape BEFORE UPDATE ON platform_collection_condition WHEN
 NEW.witness_kind IS NOT NULL AND (NEW.name NOT IN ('rddqrq','whpcyear','whpc') OR NOT (
 (NEW.witness_kind IN ('absent','null') AND NEW.witness_value IS NULL) OR
 (NEW.witness_kind IN ('text','array','object') AND typeof(NEW.witness_value)='text') OR
 (NEW.witness_kind IN ('true','false','integer','real') AND typeof(NEW.witness_value) IN ('integer','real'))))
 BEGIN SELECT RAISE(ABORT,'invalid recognized witness condition'); END;
CREATE TRIGGER recognized_witness_observation_update BEFORE UPDATE ON platform_business_observation WHEN
 (OLD.witness_rule IS NOT NULL AND (${changed('platform_business_observation')} OR NEW.id<>OLD.id OR NEW.collection_id<>OLD.collection_id OR NEW.sequence_no<>OLD.sequence_no)) OR
 ((${changed('platform_business_observation')}) AND (NEW.witness_rule IS NOT '${WITNESS_RULE}' OR NEW.witness_collection_id IS NOT NEW.collection_id OR NEW.witness_sequence_no IS NOT NEW.sequence_no OR NEW.witness_state NOT IN ('uncaptured','not_applicable','matched','unmatched','rejected','error') OR
 NOT EXISTS(SELECT 1 FROM platform_collection c WHERE c.id=NEW.collection_id AND c.witness_rule=NEW.witness_rule AND c.witness_archive_id IS NEW.witness_archive_id AND c.witness_sha256 IS NEW.witness_sha256 AND ((c.witness_state='uncaptured' AND NEW.witness_state='uncaptured') OR (c.witness_state='error' AND NEW.witness_state='error') OR (c.witness_state='captured' AND c.witness_gate=0 AND NEW.witness_state='not_applicable') OR (c.witness_state='captured' AND c.witness_gate=1 AND NEW.witness_state IN ('matched','unmatched','rejected','error')))) OR
 (NEW.witness_state='matched' AND (NEW.witness_ordinal IS NULL OR typeof(NEW.witness_ordinal)<>'integer' OR NEW.witness_ordinal<0 OR NEW.witness_rdjb_kind IS NULL OR NEW.witness_page_kind IS NULL OR NOT ${valueShape('witness_rdjb')} OR NOT ${valueShape('witness_page')} OR (NEW.witness_rdjb_key IS NOT NULL AND (typeof(NEW.witness_rdjb_key)<>'text' OR length(NEW.witness_rdjb_key)%4<>0 OR NEW.witness_rdjb_key GLOB '*[^0-9a-f]*')))) OR
 (NEW.witness_state<>'matched' AND (NEW.witness_ordinal IS NOT NULL OR NEW.witness_rdjb_kind IS NOT NULL OR NEW.witness_rdjb_value IS NOT NULL OR NEW.witness_rdjb_key IS NOT NULL OR NEW.witness_page_kind IS NOT NULL OR NEW.witness_page_value IS NOT NULL)) OR
 (NEW.witness_state='uncaptured' AND (NEW.witness_error IS NOT 'missing_original_collection_evidence' OR NEW.witness_error_name IS NOT NULL)) OR (NEW.witness_state='error' AND (NEW.witness_error IS NULL OR NEW.witness_error_name IS NULL)) OR (NEW.witness_state NOT IN ('error','uncaptured') AND (NEW.witness_error IS NOT NULL OR NEW.witness_error_name IS NOT NULL))))
 BEGIN SELECT RAISE(ABORT,'immutable or invalid recognized witness position'); END;
CREATE TRIGGER recognized_witness_observation_insert BEFORE INSERT ON platform_business_observation WHEN NEW.witness_state<>'uncaptured' OR NEW.witness_rule IS NOT NULL
 BEGIN SELECT RAISE(ABORT,'recognized witness capture follows observation'); END;`
const scratch=new WeakSet<Database.Database>()
export function witnessCatalogPresent(t:Database.Database) {
 if(t.pragma('user_version',{simple:true})===H1C_CATALOG_VERSION)return t.transaction(()=>{
  authenticateH1cCatalog(t);return witnessCatalogInSnapshot(t)
 }).deferred()
 return witnessCatalogInSnapshot(t)
}
function witnessCatalogInSnapshot(t:Database.Database) {
 const all=t.prepare("SELECT name FROM pragma_table_info('platform_collection') WHERE name LIKE 'witness_%'").all()
 if(!all.length) {
  if(t.prepare("SELECT 1 FROM sqlite_schema WHERE name LIKE 'recognized_witness_%'").get() || t.prepare('SELECT 1 FROM platform_migration_run WHERE transform_version=?').get(WITNESS_TRANSFORM))throw new Error('witness_partial_catalog')
  for(const name of ['platform_collection_condition','platform_business_observation'])if(t.prepare(`SELECT 1 FROM pragma_table_info('${name}') WHERE name LIKE 'witness_%'`).get())throw new Error('witness_partial_catalog')
  return false
 }
 if(t.pragma('user_version',{simple:true})!==71609&&processPredecessorSchema(t)===null)throw new Error('witness_schema_phase')
 for(const [table,fields] of Object.entries(witnessDefinitions)) {
  const actual=t.prepare(`PRAGMA table_info('${table}')`).all() as {name:string,type:string,notnull:number,dflt_value:unknown,pk:number}[]
  const w=actual.filter(c=>c.name.startsWith('witness_'))
  if(w.length!==Object.keys(fields).length||w.some((c,i)=>c.name!==Object.keys(fields)[i]||c.type!==Object.values(fields)[i]!.split(' ')[0]||c.notnull!==Number(c.name==='witness_state')||c.dflt_value!==(c.name==='witness_state'?"'uncaptured'":null)||c.pk!==0))throw new Error('witness_schema_columns')
  const fks=t.prepare(`PRAGMA foreign_key_list('${table}')`).all() as {from:string,table:string,to:string,on_delete:string,on_update:string}[]
  const refs=fks.filter(f=>f.from.startsWith('witness_'))
  if(refs.length!==Number('witness_archive_id' in fields)||refs.some(r=>r.from!=='witness_archive_id'||r.table!=='platform_archive_value'||r.to!=='id'||r.on_delete!=='RESTRICT'||r.on_update!=='NO ACTION'))throw new Error('witness_schema_fk')
 }
 const actual=t.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name LIKE 'recognized_witness_%' ORDER BY name").all() as {sql:string}[]
 if(!isDeepStrictEqual(actual.map(r=>normalize(r.sql)).sort(),witnessTriggers.split(/(?<=END;)\s*(?=CREATE TRIGGER)/).map(normalize).sort()))throw new Error('witness_schema_triggers')
 return true
}
/** Returns only this one authenticated predecessor's actual catalog hash. */
export function witnessPredecessorSchema(t:Database.Database):string|null {
 if(t.pragma('user_version',{simple:true})===H1C_CATALOG_VERSION)return t.transaction(()=>{
  authenticateH1cCatalog(t);return witnessPredecessorInSnapshot(t)
 }).deferred()
 return witnessPredecessorInSnapshot(t)
}
function witnessPredecessorInSnapshot(t:Database.Database):string|null {
 if(!witnessCatalogPresent(t))return null
 const rows=t.prepare("SELECT r.source_schema_hash FROM platform_migration_run r JOIN platform_migration_checkpoint c ON c.run_id=r.run_id WHERE r.transform_version=? AND r.state='complete' AND r.target_schema_version=? AND c.phase='recognized-witness' AND c.source_table='platform_collection' AND c.last_old_id=0 AND c.copied_count>=0 AND length(c.batch_digest)=64").all(WITNESS_TRANSFORM,processPredecessorSchema(t)??schemaHash(t)) as {source_schema_hash:string}[]
 const all=t.prepare('SELECT 1 FROM platform_migration_run WHERE transform_version=?').all(WITNESS_TRANSFORM)
 if(rows.length!==1||all.length!==1)throw new Error('witness_schema_receipt')
 const prior=t.prepare("SELECT 1 FROM platform_migration_run r JOIN platform_migration_checkpoint c ON c.run_id=r.run_id WHERE r.transform_version='recognized-stored-title-v1' AND r.state='complete' AND r.target_schema_version=? AND c.phase='recognized-stored' AND c.source_table='platform_recognized_projection' AND c.last_old_id=0 AND length(c.batch_digest)=64").all(rows[0]!.source_schema_hash)
 if(prior.length!==1)throw new Error('witness_predecessor_receipt')
 return rows[0]!.source_schema_hash
}
export function witnessInstalled(t:Database.Database) {
 if(t.pragma('user_version',{simple:true})===H1C_CATALOG_VERSION)return t.transaction(()=>{
  authenticateH1cCatalog(t);return witnessInstalledInSnapshot(t)
 }).deferred()
 return witnessInstalledInSnapshot(t)
}
function witnessInstalledInSnapshot(t:Database.Database) {
 if(!witnessCatalogPresent(t))return false
 if(scratch.has(t))return true
 witnessPredecessorSchema(t);return true
}
export function inheritWitnessCatalog(source:Database.Database,target:Database.Database) {
 if(source.pragma('user_version',{simple:true})===H1C_CATALOG_VERSION)throw new Error('h1c_verifier_staging_unwired')
 if(!witnessInstalled(source))return
 if(!target.memory||!witnessCatalogPresent(target)||(target.prepare('SELECT count(*) n FROM platform_business_observation').get() as {n:number}).n!==0)throw new Error('witness_scratch_catalog')
 scratch.add(target)
}
