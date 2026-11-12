/** A1 completion/cell-readiness gate. A2 runtime authentication is deliberately separate. */
import type Database from 'better-sqlite3'
import { schemaHash } from './sqlite-row-cells'
import { z } from 'zod'
export const PROCESS_STORED_TRANSFORM='process-exact-stored-offline-v1'
const inherited=new WeakMap<Database.Database,{predecessor:string,catalog:string}>()
export function processStoredInstalled(t:Database.Database) {
 const columns=t.prepare("SELECT name FROM pragma_table_info('platform_business_projection') WHERE name LIKE 'exact_%' OR name LIKE 'sql_fact_title%'").all()
 const runs=t.prepare('SELECT * FROM platform_migration_run WHERE transform_version=?').all(PROCESS_STORED_TRANSFORM)
 const partial=t.prepare("SELECT 1 FROM sqlite_schema WHERE name LIKE 'platform_process_stored_%' OR name LIKE 'platform_process_pair_%'").get()||t.prepare("SELECT 1 FROM pragma_table_info('platform_business_observation') WHERE name LIKE 'process_exact_%' OR name='process_sql_fact_title_state'").get()||t.prepare("SELECT 1 FROM platform_migration_checkpoint WHERE phase='process-stored'").get()
 if(!columns.length&&!runs.length){if(partial||t.pragma('user_version',{simple:true})===71610)throw new Error('process_stored_partial_catalog');return false}
 if(t.pragma('user_version',{simple:true})!==71610||(!inherited.has(t)&&runs.length!==1))throw new Error('process_stored_phase_or_receipt')
 const triggers=t.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND (name LIKE 'platform_process_stored_%' OR name LIKE 'platform_process_pair_%') ORDER BY name").all() as {sql:string}[]
 const normalize=(s:string)=>s.trim().replace(/;$/, '').replace(/\s+/g,' ')
 const expected=processStoredBarrierSql.split(/(?<=END;)\s*(?=CREATE TRIGGER)/).map(normalize).sort()
 if(JSON.stringify(triggers.map(r=>normalize(r.sql)).sort())!==JSON.stringify(expected))throw new Error('process_stored_catalog_triggers')
 const names=['exact_status','exact_declare_kind','exact_applied_at','exact_year','exact_title_raw','exact_batch','exact_award_batch_label','exact_province','exact_stored_state','exact_stored_rule','exact_stored_origin','exact_stored_reason','sql_fact_title','sql_fact_title_state','sql_fact_title_rule','sql_fact_title_reason']
 const actual=t.prepare("PRAGMA table_info('platform_business_projection')").all() as {name:string,type:string,notnull:number,dflt_value:unknown,pk:number}[]
 const capture=actual.filter(c=>c.name.startsWith('exact_')||c.name.startsWith('sql_fact_title'))
 if(capture.length!==names.length||capture.some((c,i)=>c.name!==names[i]||c.type!==(c.name==='exact_year'?'INTEGER':'TEXT')||c.notnull!==0||c.dflt_value!==null||c.pk!==0))throw new Error('process_stored_catalog_columns')
 const pairing=t.prepare("PRAGMA foreign_key_list('platform_business_observation')").all() as {from:string,table:string,to:string}[]
 const expectedPair={process_exact_owner_id:'observation_id',process_exact_state:'exact_stored_state',process_sql_fact_title_state:'sql_fact_title_state'}
 if(pairing.filter(f=>f.from.startsWith('process_')).length!==3||Object.entries(expectedPair).some(([from,to])=>!pairing.some(f=>f.from===from&&f.table==='platform_business_projection'&&f.to===to)))throw new Error('process_stored_catalog_pair')
 const pairSql=z.object({sql:z.string()}).parse(t.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='platform_business_observation'").get()).sql.replace(/\s+/g,' ')
 if(!pairSql.includes('FOREIGN KEY(process_exact_owner_id,process_exact_state,process_sql_fact_title_state) REFERENCES platform_business_projection(observation_id,exact_stored_state,sql_fact_title_state) DEFERRABLE INITIALLY DEFERRED'))throw new Error('process_stored_catalog_deferred_pair')
 const staging=inherited.get(t)
 if(staging){if(staging.catalog!==schemaHash(t))throw new Error('process_stored_scratch_catalog_drift');return true}
 const receipt=z.object({run_id:z.string(),state:z.literal('complete'),source_schema_hash:z.string(),target_schema_version:z.literal(schemaHash(t))}).parse(runs[0])
 const prior=t.prepare("SELECT 1 FROM platform_migration_run r JOIN platform_migration_checkpoint c ON c.run_id=r.run_id WHERE r.transform_version='recognized-witness-offline-v1' AND r.state='complete' AND r.target_schema_version=? AND c.phase='recognized-witness' AND c.source_table='platform_collection' AND c.last_old_id=0 AND length(c.batch_digest)=64").all(receipt.source_schema_hash)
 const completion=t.prepare("SELECT 1 FROM platform_migration_checkpoint WHERE run_id=? AND phase='process-stored' AND source_table='platform_business_projection' AND last_old_id=0 AND copied_count>=0 AND length(batch_digest)=64").all(receipt.run_id)
 if(prior.length!==1||completion.length!==1)throw new Error('process_stored_predecessor_or_checkpoint')
 return true
}

/** Only this authenticated successor may unwrap the preserved 71609 receipt chain. */
export function processPredecessorSchema(t:Database.Database):string|null {
 if(t.pragma('user_version',{simple:true})!==71610)return null
 if(!processStoredInstalled(t))throw new Error('process_stored_catalog_required')
 return inherited.get(t)?.predecessor??z.object({source_schema_hash:z.string()}).parse(t.prepare('SELECT source_schema_hash FROM platform_migration_run WHERE transform_version=?').get(PROCESS_STORED_TRANSFORM)).source_schema_hash
}
function emptyStagingData(t:Database.Database) {
 // Only the two initialization highwaters may exist before staging begins.
 const highwaters=t.prepare('SELECT namespace,high_water FROM platform_legacy_alias_sequence ORDER BY namespace').all()
 if(JSON.stringify(highwaters)!==JSON.stringify([{namespace:'query',high_water:0},{namespace:'relation',high_water:0}]))return false
 const tables=t.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'platform_legacy_alias_sequence'").all() as {name:string}[]
 return tables.every(({name})=>!t.prepare(`SELECT 1 FROM "${name.replaceAll('"','""')}" LIMIT 1`).get())
}
/** Private verifier staging: same catalog, empty memory, authenticated source only. */
export function inheritProcessStoredCatalog(source:Database.Database,target:Database.Database){
 const predecessor=processPredecessorSchema(source)
 if(predecessor===null)return
 if(!target.memory||schemaHash(target)!==schemaHash(source)||!emptyStagingData(target))throw new Error('process_stored_scratch_catalog')
 inherited.set(target,{predecessor,catalog:schemaHash(source)})
}

export const processStoredBarrierSql=`CREATE TRIGGER platform_process_stored_no_update BEFORE UPDATE ON platform_business_projection BEGIN SELECT RAISE(ABORT,'immutable process stored projection'); END;
  CREATE TRIGGER platform_process_stored_no_delete BEFORE DELETE ON platform_business_projection BEGIN SELECT RAISE(ABORT,'immutable process stored projection'); END;
  CREATE TRIGGER platform_process_stored_insert BEFORE INSERT ON platform_business_projection WHEN EXISTS(SELECT 1 FROM platform_business_projection WHERE id=NEW.id OR observation_id=NEW.observation_id OR version_id=NEW.version_id)
    BEGIN SELECT RAISE(ABORT,'immutable process stored projection'); END;
  CREATE TRIGGER platform_process_pair_insert BEFORE INSERT ON platform_business_observation WHEN
    EXISTS(SELECT 1 FROM platform_business_observation WHERE id=NEW.id OR (collection_id=NEW.collection_id AND sequence_no=NEW.sequence_no AND process_exact_owner_id IS NOT NULL)) OR
    CASE WHEN (SELECT interface FROM platform_collection WHERE id=NEW.collection_id)='business_list' THEN
      NEW.process_exact_owner_id IS NOT NEW.id OR NEW.process_exact_state IS NOT 'captured' OR NEW.process_sql_fact_title_state IS NOT 'captured' OR
      NOT EXISTS(SELECT 1 FROM platform_observation_assignment WHERE observation_id=NEW.id AND revision=1) OR
      NOT EXISTS(SELECT 1 FROM platform_observation_fingerprint_basis WHERE observation_id=NEW.id AND scheme='target-command-v1')
    ELSE NEW.process_exact_owner_id IS NOT NULL OR NEW.process_exact_state IS NOT NULL OR NEW.process_sql_fact_title_state IS NOT NULL END
    BEGIN SELECT RAISE(ABORT,'complete captured process pair/revision1/basis required'); END;
  CREATE TRIGGER platform_process_pair_update BEFORE UPDATE ON platform_business_observation WHEN
    NEW.process_exact_owner_id IS NOT OLD.process_exact_owner_id OR NEW.process_exact_state IS NOT OLD.process_exact_state OR NEW.process_sql_fact_title_state IS NOT OLD.process_sql_fact_title_state OR NEW.collection_id IS NOT OLD.collection_id OR NEW.id IS NOT OLD.id OR (OLD.process_exact_owner_id IS NOT NULL AND NEW.sequence_no IS NOT OLD.sequence_no)
    BEGIN SELECT RAISE(ABORT,'immutable process pair'); END;
  CREATE TRIGGER platform_process_pair_delete BEFORE DELETE ON platform_business_observation WHEN OLD.process_exact_owner_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable process observation'); END;`
