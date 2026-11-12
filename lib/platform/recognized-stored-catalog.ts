import { processPredecessorSchema } from './process-stored-catalog'
import { witnessPredecessorSchema } from './recognized-witness-catalog'
import { schemaHash } from './sqlite-row-cells'
import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
export const RECOGNIZED_STORED_RULE = 'recognized-stored-title-v1'
export const recognizedStoredTriggers = `CREATE TRIGGER recognized_stored_update BEFORE UPDATE ON platform_recognized_projection WHEN
 NEW.exact_title_raw IS NOT OLD.exact_title_raw OR typeof(NEW.exact_title_raw)<>typeof(OLD.exact_title_raw) OR NEW.exact_title_state IS NOT OLD.exact_title_state OR NEW.exact_title_origin IS NOT OLD.exact_title_origin OR NEW.exact_title_archive_id IS NOT OLD.exact_title_archive_id OR NEW.exact_title_sha256 IS NOT OLD.exact_title_sha256 OR NEW.observation_id IS NOT OLD.observation_id
 BEGIN SELECT RAISE(ABORT,'immutable recognized stored title'); END;
 CREATE TRIGGER recognized_stored_insert BEFORE INSERT ON platform_recognized_projection WHEN
 CASE WHEN NEW.observation_id IS NULL THEN NEW.exact_title_raw IS NOT NULL OR NEW.exact_title_state IS NOT NULL OR NEW.exact_title_origin IS NOT NULL OR NEW.exact_title_archive_id IS NOT NULL OR NEW.exact_title_sha256 IS NOT NULL
 ELSE NEW.exact_title_state IS NOT 'captured' OR NEW.exact_title_origin IS NOT 'commandInput' OR NEW.exact_title_archive_id IS NULL OR NEW.exact_title_sha256 IS NULL OR NOT EXISTS(SELECT 1 FROM platform_observation_fingerprint_basis b JOIN platform_archive_value a ON a.id=b.input_archive_id WHERE b.observation_id=NEW.observation_id AND b.scheme='target-command-v1' AND a.id=NEW.exact_title_archive_id AND a.sha256=NEW.exact_title_sha256) END
 BEGIN SELECT RAISE(ABORT,'captured recognized stored title required'); END;`
const scratchCatalogs = new WeakSet<Database.Database>()
const names = ['exact_title_raw','exact_title_state','exact_title_origin','exact_title_archive_id','exact_title_sha256']
const types = ['BLOB','TEXT','TEXT','INTEGER','TEXT']
const normalize = (sql:string) => sql.trim().replace(/;$/, '').replace(/\s+/g,' ')
function catalogPresent(t:Database.Database) {
 const columns=t.prepare("PRAGMA table_info('platform_recognized_projection')").all() as {name:string,type:string,notnull:number,dflt_value:unknown,pk:number}[]
 const exact=columns.filter(c=>c.name.startsWith('exact_title_'))
 const triggers=t.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name LIKE 'recognized_stored_%' ORDER BY name").all() as {name:string,sql:string}[]
 const receipts=t.prepare('SELECT run_id,state,target_schema_version FROM platform_migration_run WHERE transform_version=?').all(RECOGNIZED_STORED_RULE) as {run_id:string,state:string,target_schema_version:string}[]
 const checkpoints=t.prepare("SELECT run_id FROM platform_migration_checkpoint WHERE phase='recognized-stored'").all()
 if(!exact.length&&!triggers.length&&!receipts.length&&!checkpoints.length) {
  if(![71605,71606,71607,71608,71609].includes(Number(t.pragma('user_version',{simple:true}))))throw new Error('recognized_stored_schema_phase')
  return false
 }
 if((t.pragma('user_version',{simple:true})!==71609&&processPredecessorSchema(t)===null) || exact.length!==names.length || exact.some((c,i)=>c.name!==names[i]||c.type!==types[i]||c.notnull!==0||c.dflt_value!==null||c.pk!==0))throw new Error('recognized_stored_schema_columns')
 const fk=t.prepare("PRAGMA foreign_key_list('platform_recognized_projection')").all() as {from:string,table:string,to:string,on_delete:string,on_update:string,match:string}[]
 const refs=fk.filter(f=>f.from.startsWith('exact_title_'))
 if(refs.length!==1||refs[0]!.from!=='exact_title_archive_id'||refs[0]!.table!=='platform_archive_value'||refs[0]!.to!=='id'||refs[0]!.on_delete!=='RESTRICT'||refs[0]!.on_update!=='NO ACTION')throw new Error('recognized_stored_schema_fk')
 const expected=recognizedStoredTriggers.split(/(?<=END;)\s*(?=CREATE TRIGGER)/).map(normalize).sort()
 if(!isDeepStrictEqual(triggers.map(r=>normalize(r.sql)).sort(),expected))throw new Error('recognized_stored_schema_triggers')
 return true
}
export function recognizedStoredInstalled(t:Database.Database) {
 if(!catalogPresent(t))return false
 if(scratchCatalogs.has(t))return true
 const receipts=t.prepare("SELECT r.run_id FROM platform_migration_run r JOIN platform_migration_checkpoint c ON c.run_id=r.run_id WHERE r.transform_version=? AND r.state='complete' AND r.target_schema_version=? AND c.phase='recognized-stored' AND c.source_table='platform_recognized_projection' AND c.last_old_id=0 AND c.copied_count>=0 AND length(c.batch_digest)=64").all(RECOGNIZED_STORED_RULE,witnessPredecessorSchema(t)??schemaHash(t))
 const runs=t.prepare('SELECT run_id FROM platform_migration_run WHERE transform_version=?').all(RECOGNIZED_STORED_RULE)
 if(receipts.length!==1||runs.length!==1)throw new Error('recognized_stored_schema_receipt')
 return true
}
/** Only the verifier's empty in-memory catalog may inherit its validated source state. */
export function inheritRecognizedStoredCatalog(source:Database.Database,scratch:Database.Database) {
 if(!recognizedStoredInstalled(source))return
 if(!scratch.memory||!catalogPresent(scratch)|| (scratch.prepare('SELECT count(*) n FROM platform_business_observation').get() as {n:number}).n!==0)throw new Error('recognized_stored_schema_scratch')
 scratchCatalogs.add(scratch)
}
