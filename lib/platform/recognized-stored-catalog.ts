import type Database from 'better-sqlite3'
import { hasColumns, migrationFinished, requireH1cReady } from './h1c-catalog'
export const RECOGNIZED_STORED_RULE = 'recognized-stored-title-v1'
export const recognizedStoredTriggers = `CREATE TRIGGER recognized_stored_update BEFORE UPDATE ON platform_recognized_projection WHEN
 NEW.exact_title_raw IS NOT OLD.exact_title_raw OR typeof(NEW.exact_title_raw)<>typeof(OLD.exact_title_raw) OR NEW.exact_title_state IS NOT OLD.exact_title_state OR NEW.exact_title_origin IS NOT OLD.exact_title_origin OR NEW.exact_title_archive_id IS NOT OLD.exact_title_archive_id OR NEW.exact_title_sha256 IS NOT OLD.exact_title_sha256 OR NEW.observation_id IS NOT OLD.observation_id
 BEGIN SELECT RAISE(ABORT,'immutable recognized stored title'); END;
 CREATE TRIGGER recognized_stored_insert BEFORE INSERT ON platform_recognized_projection WHEN
 CASE WHEN NEW.observation_id IS NULL THEN NEW.exact_title_raw IS NOT NULL OR NEW.exact_title_state IS NOT NULL OR NEW.exact_title_origin IS NOT NULL OR NEW.exact_title_archive_id IS NOT NULL OR NEW.exact_title_sha256 IS NOT NULL
 ELSE NEW.exact_title_state IS NOT 'captured' OR NEW.exact_title_origin IS NOT 'commandInput' OR NEW.exact_title_archive_id IS NULL OR NEW.exact_title_sha256 IS NULL OR NOT EXISTS(SELECT 1 FROM platform_observation_fingerprint_basis b JOIN platform_archive_value a ON a.id=b.input_archive_id WHERE b.observation_id=NEW.observation_id AND b.scheme='target-command-v1' AND a.id=NEW.exact_title_archive_id AND a.sha256=NEW.exact_title_sha256) END
 BEGIN SELECT RAISE(ABORT,'captured recognized stored title required'); END;`
export function recognizedStoredInstalled(t:Database.Database) {
 const phase=Number(t.pragma('user_version',{simple:true}))
 if(phase!==71609&&phase!==71610&&phase!==71611&&phase!==71612)return false
 if((phase===71611||phase===71612))requireH1cReady(t)
 if(!hasColumns(t,'platform_recognized_projection',['observation_id','exact_title_raw','exact_title_state','exact_title_origin','exact_title_archive_id','exact_title_sha256'])){if(phase===71609)return false;throw new Error('Recognized migration incomplete; necessary title columns are missing')}
 if(!migrationFinished(t,RECOGNIZED_STORED_RULE))throw new Error('Recognized migration incomplete; finish stored title capture before use')
 return true
}
