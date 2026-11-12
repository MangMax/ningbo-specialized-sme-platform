import type Database from 'better-sqlite3'
import { hasColumns, migrationFinished, requireH1cReady } from './h1c-catalog'
import { witnessDefinitions } from './recognized-witness-schema'
import { WITNESS_RULE } from './recognized-witness-capture'
export const WITNESS_TRANSFORM='recognized-witness-offline-v1'
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
export function witnessCatalogPresent(t:Database.Database) {
 return Object.entries(witnessDefinitions).every(([table,fields])=>hasColumns(t,table,Object.keys(fields)))
}
export function witnessInstalled(t:Database.Database) {
 const phase=Number(t.pragma('user_version',{simple:true}))
 if(phase!==71609&&phase!==71610&&phase!==71611)return false
 if(phase===71611)requireH1cReady(t)
 if(!witnessCatalogPresent(t)){if(phase===71609)return false;throw new Error('Witness migration incomplete; necessary capture columns are missing')}
 if(!migrationFinished(t,WITNESS_TRANSFORM))throw new Error('Witness migration incomplete; finish witness capture before use')
 return true
}
