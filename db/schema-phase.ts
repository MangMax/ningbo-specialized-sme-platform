import type Database from 'better-sqlite3'
export const PLATFORM_RUNTIME_VERSION = 71613
export const PLATFORM_RETIREMENT_RULE = 'platform-mixed-model-retirement-v1'
export const RETIRED_PLATFORM_TABLES = [
  'platform_query_legacy_provenance',
  'platform_relation_body_ref', 'platform_query_body_ref', 'platform_version_body_ref',
  'platform_body_part', 'platform_body_root', 'platform_body_leaf',
  'platform_relation', 'platform_query',
] as const
const retiredName = new RegExp(`\\b(?:${RETIRED_PLATFORM_TABLES.join('|')})\\b`, 'i')

/** Scope tables retain their historical names, with collection-owned keys. */
export function assertNoRetiredPlatformSchema(sqlite: Database.Database) {
  const entries = sqlite.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL").all() as { type: string; name: string; sql: string }[]
  const dependency = entries.find(entry => retiredName.test(entry.name) || retiredName.test(entry.sql))
  if (dependency) throw new Error(`Retired platform schema dependency remains: ${dependency.type} ${dependency.name}`)
}

/** Completion is a one-time offline decision, separate from the 71613 reader phase.
 * Opening a target never installs DDL or replays expand migrations. */
export function assertFinalPlatformRuntime(sqlite: Database.Database) {
  if (sqlite.pragma('user_version', { simple: true }) !== PLATFORM_RUNTIME_VERSION) throw new Error('Unsupported final platform runtime schema')
  const marker = sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='platform_runtime_completion'").get()
  if (!marker || !sqlite.prepare('SELECT 1 FROM platform_runtime_completion WHERE id=1 AND rule=? AND schema_version=?').get(PLATFORM_RETIREMENT_RULE, PLATFORM_RUNTIME_VERSION)) {
    throw new Error('Platform runtime retirement incomplete; finish explicit offline retirement')
  }
  assertNoRetiredPlatformSchema(sqlite)
  sqlite.prepare(`SELECT c.id,c.reconcile_slot_state,c.witness_state,o.id,o.collection_id,o.sequence_no,
    a.revision,r.observation_id,d.evidence_relation_id,p.collection_id,f.input_archive_id,
    s.collection_id,se.collection_id,e.from_enterprise_id,pa.exact_status,pb.exact_status,
    pr.exact_title_raw,pr.source_recognized_at,pr.source_valid_flag,pr.source_invalidated_at,pr.source_invalidation_reason,pr.source_province_name,pr.source_city_name,pr.source_district_name,pr.qualification_fields_rule,v.canonical_archive_id,cp.collection_id,cp.max_page_present,cu.collection_id,cc.collection_id
    FROM platform_collection c,platform_business_observation o,platform_observation_assignment a,
    record_correspondence r,difference_reason d,platform_collection_legacy_provenance p,
    platform_observation_fingerprint_basis f,platform_query_title_scope s,platform_query_title_scope_error se,
    enterprise_merge e,platform_apply_projection pa,platform_business_projection pb,platform_recognized_projection pr,
    platform_business_record_version v,platform_collection_page cp,platform_collection_unfinished cu,
    platform_collection_condition cc LIMIT 0`).all()
}
