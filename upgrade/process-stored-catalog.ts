/** Offline historical oracle from ab503081dae3e24680afc9b07395a7e3ff21fc9f. */
/** Runtime readiness only; FK/catalog/data validation runs at offline completion. */
import type Database from 'better-sqlite3'
import { hasColumns, migrationFinished, requireH1cReady } from './h1c-catalog'
export const PROCESS_STORED_TRANSFORM='process-exact-stored-offline-v1'
export function processStoredInstalled(t:Database.Database) {
 const phase=Number(t.pragma('user_version',{simple:true}))
 if(phase!==71610&&phase!==71611&&phase!==71612&&phase!==71613)return false
 if((phase===71611||phase===71612||phase===71613))requireH1cReady(t)
 if(!hasColumns(t,'platform_business_projection',['observation_id','exact_status','exact_declare_kind','exact_applied_at','exact_year','exact_title_raw','exact_batch','exact_award_batch_label','exact_province','exact_stored_state','exact_stored_rule','exact_stored_origin','exact_stored_reason','sql_fact_title','sql_fact_title_state','sql_fact_title_rule','sql_fact_title_reason'])||!hasColumns(t,'platform_business_observation',['process_exact_owner_id','process_exact_state','process_sql_fact_title_state'])||!migrationFinished(t,PROCESS_STORED_TRANSFORM))throw new Error('Process migration incomplete; finish stored process migration before use')
 return true
}
export function ensureProcessStoredReady(t:Database.Database) {
 const phase=Number(t.pragma('user_version',{simple:true}))
 if(phase===71610||(phase===71611||phase===71612||phase===71613))processStoredInstalled(t)
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
