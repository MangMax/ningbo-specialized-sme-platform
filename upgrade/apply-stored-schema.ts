/** #728 populated rebuild. Only called inside the offline successor's immediate transaction. */
import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import { finalizationCatalog, observationIncomingOwners } from './finalize-observations'
export { APPLY_STORED_VERSION } from '../db/schema-phase'
export const applyStoredColumns = [
  'exact_status','exact_declare_kind','exact_applied_at','exact_year','exact_title_raw',
  'exact_stored_state','exact_stored_rule','exact_stored_origin','exact_stored_reason',
  'sql_fact_title','sql_fact_title_state','sql_fact_title_rule','sql_fact_title_reason',
] as const
export const applyPairColumns = ['apply_exact_owner_id','apply_exact_state','apply_sql_fact_title_state'] as const
const quote = (s:string) => '"'+s.replaceAll('"','""')+'"'
export function installApplyStoredSchema(t:Database.Database, step?:(stage:string)=>void) {
  if(t.pragma('foreign_keys',{simple:true})!==1)throw new Error('apply successor requires foreign_keys=ON before entry')
  if(!t.inTransaction)throw new Error('apply successor requires immediate transaction')
  const parent='platform_business_observation', projection='platform_apply_projection'
  const incoming=[...observationIncomingOwners,'platform_observation_fingerprint_basis'].sort()
  const catalog=finalizationCatalog(t)
  const actual=catalog.filter(x=>x.type==='table'&&x.name!==parent&&(t.pragma(`foreign_key_list(${quote(x.name)})`) as {table:string}[]).some(f=>f.table===parent)).map(x=>x.name).sort()
  if(!isDeepStrictEqual(incoming,actual))throw new Error('Unexpected incoming observation FK inventory')
  const tables=[parent,...incoming]
  for(const x of catalog.filter(x=>x.type==='table'&&!tables.includes(x.name))) {
    if((t.pragma(`foreign_key_list(${quote(x.name)})`) as {table:string}[]).some(f=>incoming.includes(f.table)))throw new Error('Unexpected incoming child FK inventory')
  }
  if(catalog.some(x=>x.type==='view'&&tables.some(n=>x.sql.includes(n))))throw new Error('Unexpected dependent view')
  const affected=catalog.filter(x=>tables.includes(x.tbl_name)||(x.type==='trigger'&&tables.some(n=>x.sql.includes(n))))
  const sequences=t.prepare('SELECT name,seq FROM sqlite_sequence').safeIntegers().all() as {name:string,seq:bigint}[]
  for(const x of affected.filter(x=>x.type==='trigger'))t.exec(`DROP TRIGGER ${quote(x.name)}`)
  for(const name of tables)t.exec(`CREATE TEMP TABLE ${quote('s728_'+name)} AS SELECT * FROM ${quote(name)}`)
  for(const name of [...incoming,parent])t.exec(`DROP TABLE ${quote(name)}`)
  step?.('dropped')
  for(const name of tables) {
    let ddl=affected.find(x=>x.type==='table'&&x.name===name)!.sql
    if(name===parent)ddl=ddl.replace('(', '(apply_exact_owner_id INTEGER, apply_exact_state TEXT, apply_sql_fact_title_state TEXT,').replace(/\)\s*$/,`,
      CHECK((apply_exact_owner_id IS NULL AND apply_exact_state IS NULL AND apply_sql_fact_title_state IS NULL) OR
        (apply_exact_owner_id IS NOT NULL AND apply_exact_owner_id=id AND apply_exact_state IN ('captured','uncaptured') AND apply_exact_state IS NOT NULL AND apply_sql_fact_title_state IN ('captured','uncaptured') AND apply_sql_fact_title_state IS NOT NULL)),
      FOREIGN KEY(apply_exact_owner_id,apply_exact_state,apply_sql_fact_title_state)
        REFERENCES platform_apply_projection(observation_id,exact_stored_state,sql_fact_title_state) DEFERRABLE INITIALLY DEFERRED
    )`)
    if(name===projection)ddl=ddl.replace('(', `(exact_status TEXT, exact_declare_kind TEXT, exact_applied_at TEXT, exact_year INTEGER, exact_title_raw TEXT, exact_stored_state TEXT, exact_stored_rule TEXT, exact_stored_origin TEXT, exact_stored_reason TEXT, sql_fact_title TEXT, sql_fact_title_state TEXT, sql_fact_title_rule TEXT, sql_fact_title_reason TEXT,`).replace(/\)\s*$/,`,
      CONSTRAINT platform_apply_stored_pair_uq UNIQUE(observation_id,exact_stored_state,sql_fact_title_state),
      CHECK((observation_id IS NULL AND ${applyStoredColumns.map(c=>c+' IS NULL').join(' AND ')}) OR
        (observation_id IS NOT NULL AND
          ((exact_stored_state IS 'captured' AND exact_stored_rule IS 'apply-stored-cells-v1' AND exact_stored_origin IN ('legacy_source','sealed_snapshot','command_materialized') AND exact_stored_origin IS NOT NULL AND exact_stored_reason IS NULL) OR
           (exact_stored_state IS 'uncaptured' AND ${applyStoredColumns.slice(0,5).map(c=>c+' IS NULL').join(' AND ')} AND exact_stored_rule IS NULL AND exact_stored_origin IS NULL AND typeof(exact_stored_reason)='text' AND length(exact_stored_reason)>0)) AND
          ((sql_fact_title_state IS 'captured' AND sql_fact_title_rule IS 'apply-legacy-sql-fact-title-v1' AND sql_fact_title_reason IS NULL AND typeof(sql_fact_title) IN ('null','text')) OR
           (sql_fact_title_state IS 'uncaptured' AND sql_fact_title IS NULL AND sql_fact_title_rule IS NULL AND typeof(sql_fact_title_reason)='text' AND length(sql_fact_title_reason)>0))))
    )`)
    t.exec(ddl)
  }
  step?.('created')
  // Capture fields are populated by the successor before checks/constraints become observable.
  // Seed unknown states for the historical owner inventory, then fill once before barriers.
  for(const name of tables) {
    const columns=(t.pragma(`table_info(${quote('s728_'+name)})`) as {name:string}[]).map(c=>quote(c.name)).join(',')
    const extra=name===projection?",exact_stored_state,exact_stored_reason,sql_fact_title_state,sql_fact_title_reason":''
    const values=name===projection?",CASE WHEN observation_id IS NOT NULL THEN 'uncaptured' END,CASE WHEN observation_id IS NOT NULL THEN 'offline-recovery-pending' END,CASE WHEN observation_id IS NOT NULL THEN 'uncaptured' END,CASE WHEN observation_id IS NOT NULL THEN 'offline-recovery-pending' END":''
    t.exec(`INSERT INTO ${quote(name)}(${columns}${extra}) SELECT ${columns}${values} FROM ${quote('s728_'+name)}`)
    step?.('copied:'+name)
  }
  for(const {name,seq} of sequences)if(tables.includes(name))t.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(seq,name)
  for(const x of affected.filter(x=>x.type==='index'||x.type==='trigger'))t.exec(x.sql)
  for(const name of tables)t.exec(`DROP TABLE ${quote('s728_'+name)}`)
  step?.('restored')
}
export function installApplyStoredBarrier(t:Database.Database) {
  if(t.pragma('foreign_keys',{simple:true})!==1||!t.inTransaction)throw new Error('FK ON transaction required')
  t.exec(`CREATE TRIGGER platform_apply_stored_no_update BEFORE UPDATE ON platform_apply_projection BEGIN SELECT RAISE(ABORT,'immutable apply stored projection'); END;
  CREATE TRIGGER platform_apply_stored_no_delete BEFORE DELETE ON platform_apply_projection BEGIN SELECT RAISE(ABORT,'immutable apply stored projection'); END;
  CREATE TRIGGER platform_apply_stored_insert BEFORE INSERT ON platform_apply_projection WHEN EXISTS(SELECT 1 FROM platform_apply_projection WHERE id=NEW.id OR observation_id=NEW.observation_id OR version_id=NEW.version_id)
    BEGIN SELECT RAISE(ABORT,'immutable apply stored projection'); END;
  CREATE TRIGGER platform_apply_pair_insert BEFORE INSERT ON platform_business_observation WHEN
    EXISTS(SELECT 1 FROM platform_business_observation WHERE id=NEW.id) OR
    CASE WHEN (SELECT interface FROM platform_collection WHERE id=NEW.collection_id)='apply_list' THEN
      NEW.apply_exact_owner_id IS NOT NEW.id OR NEW.apply_exact_state IS NOT 'captured' OR NEW.apply_sql_fact_title_state IS NOT 'captured' OR
      NOT EXISTS(SELECT 1 FROM platform_observation_assignment WHERE observation_id=NEW.id AND revision=1) OR
      NOT EXISTS(SELECT 1 FROM platform_observation_fingerprint_basis WHERE observation_id=NEW.id AND scheme='target-command-v1')
    ELSE NEW.apply_exact_owner_id IS NOT NULL OR NEW.apply_exact_state IS NOT NULL OR NEW.apply_sql_fact_title_state IS NOT NULL END
    BEGIN SELECT RAISE(ABORT,'complete captured apply pair/revision1/basis required'); END;
  CREATE TRIGGER platform_apply_pair_update BEFORE UPDATE ON platform_business_observation WHEN
    NEW.apply_exact_owner_id IS NOT OLD.apply_exact_owner_id OR NEW.apply_exact_state IS NOT OLD.apply_exact_state OR NEW.apply_sql_fact_title_state IS NOT OLD.apply_sql_fact_title_state OR NEW.collection_id IS NOT OLD.collection_id OR NEW.id IS NOT OLD.id
    BEGIN SELECT RAISE(ABORT,'immutable apply pair'); END;`)
}
