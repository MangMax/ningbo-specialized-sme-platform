import type Database from 'better-sqlite3'
import type pg from 'pg'
import { readFileSync } from 'node:fs'

const tables = {
  enterprise: 'id:i name name_norm uscc_norm',
  platform_business_record: 'id:i platform_key interface identity_rule_version created_at',
  platform_business_record_version: 'id:i record_id:i hash_algorithm content_hash created_at',
  platform_collection: 'id:i interface rdjb title_code queried_at created_at last_collected_at query_key status failure_reason provenance_state',
  platform_archive_value: 'id:i storage_class bytes:b byte_length:i',
  platform_collection_archive_ref: 'owner_id:i field archive_id:i sealed:i',
  platform_observation_archive_ref: 'owner_id:i field archive_id:i sealed:i',
  platform_collection_legacy_provenance: 'collection_id:i origin archive_id:i',
  platform_business_observation: 'id:i collection_id:i record_id:i version_id:i sequence_no:i source_relation_key identity_state content_state key_source projection_rule_version',
  platform_observation_assignment: 'observation_id:i revision:i enterprise_id:i name_raw uscc_raw match_basis verification_status',
  platform_legacy_query_alias: 'old_id:i collection_id:i',
  platform_legacy_relation_alias: 'old_id:i observation_id:i',
  platform_query_title_scope: 'collection_id:i rdjb',
  platform_query_title_scope_error: 'collection_id:i',
  platform_export_batch: 'id:i title_code year:i collected_on original_filename sha256 row_count:i import_status source_document_id:i import_batch_id:i replaced_batch_id:i created_at',
  platform_export_row: 'id:i batch_id:i source_row_no:i uscc_raw name_raw province city district reg_status',
  record_correspondence: 'id:i observation_id:i status revision:i',
  platform_apply_projection: 'id:i observation_id:i record_id:i version_id:i rule_version title_raw name_raw uscc_raw declare_kind declaration_year:i applied_at status exact_title_raw:x exact_declare_kind:x exact_year:x exact_applied_at:x exact_status:x exact_stored_state sql_fact_title_state',
  platform_business_projection: 'id:i observation_id:i record_id:i version_id:i rule_version title_raw name_raw uscc_raw declare_kind business_year:i applied_at status batch award_batch_label province exact_title_raw:x exact_declare_kind:x exact_year:x exact_applied_at:x exact_status:x exact_batch:x exact_award_batch_label:x exact_province:x exact_stored_state exact_stored_rule sql_fact_title_state sql_fact_title_rule',
  platform_recognized_projection: 'id:i observation_id:i record_id:i version_id:i rule_version title_raw name_raw uscc_raw validity_date_raw maintenance_year:i maintenance_batch district award_note exact_title_raw:x exact_title_state',
}

export async function installArchiveFixture(pg: pg.Client, sqlite: Database.Database) {
  await pg.query('CREATE SCHEMA business')
  for (const [table, spec] of Object.entries(tables)) {
    const columns = spec.split(' ').map(def => def.split(':') as [string, string?])
    const pgColumns = columns.flatMap(([name, type]) => type === 'x'
      ? [`${name} bytea`, `${name}_sqlite_storage text`]
      : [`${name} ${type === 'i' ? 'bigint' : type === 'b' ? 'bytea' : 'text COLLATE "C"'}`])
    await pg.query(`CREATE TABLE business.${table} (${pgColumns.join(', ')})`)
    const selection = columns.flatMap(([name, type]) => type === 'x' ? [`typeof(${name})`, name] : [name])
    const rows = sqlite.prepare(`SELECT ${selection.join(', ')} FROM ${table}`).raw(true).safeIntegers(true).all() as unknown[][]
    for (const row of rows) {
      const values = columns.flatMap(([, type]) => {
        const value = row.shift()
        if (type !== 'x') return [value]
        const cell = row.shift()
        if (value === 'null') return [null, value]
        if (value === 'blob') return [cell, value]
        if (value === 'text') return [Buffer.from(String(cell)), value]
        const bytes = Buffer.alloc(8)
        if (value === 'integer') bytes.writeBigInt64BE(cell as bigint)
        else if (value === 'real') bytes.writeDoubleBE(cell as number)
        else throw new Error(`Unexpected storage class ${value}`)
        return [bytes, value]
      })
      await pg.query(`INSERT INTO business.${table} VALUES (${values.map((_, i) => '$' + (i + 1)).join(', ')})`, values)
    }
  }
  await pg.query(`SET search_path TO business, pg_catalog;
    ${readFileSync(new URL('../../../db/postgresql/platform-observation-snapshot.sql', import.meta.url), 'utf8')}`)
}
