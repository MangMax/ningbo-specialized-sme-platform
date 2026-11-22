\set ON_ERROR_STOP on
\if :{?target}
\else
\set target business
\endif

BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL search_path TO :"target", pg_catalog;
SELECT (current_schema() = :'target' AND :'target' <> :'staging'
    AND current_setting('server_encoding') = 'UTF8'
    AND current_setting('server_version_num')::integer BETWEEN 190000 AND 199999
    AND to_regclass(format('%I.enterprise', :'target')) IS NOT NULL
    AND to_regclass(format('%I.enterprise_merge', :'target')) IS NOT NULL
    AND to_regclass(format('%I.stored_file', :'target')) IS NOT NULL) IS TRUE AS ready
\gset
\if :ready
\else
DO $$ BEGIN RAISE EXCEPTION 'Roster materialization requires a distinct native target and UTF-8 PostgreSQL 19'; END $$;
\endif

\ir ../../../db/postgresql/roster-schema.sql
\ir ../../../db/postgresql/roster-platform-schema.sql
\ir staging-platform-archives.sql
\ir ../../../db/postgresql/roster-review-schema.sql

-- The source staging schema remains an exact copy. Retiring the native proof
-- tables must not discard a populated historical source or a past confirmation.
SELECT NOT (
  EXISTS (SELECT FROM :"staging".comparison_scope_proof)
  OR EXISTS (SELECT FROM :"staging".comparison_scope_proof_audit)
  OR EXISTS (SELECT FROM :"staging".record_correspondence WHERE type = 'recognized_export' AND status = 'confirmed')
  OR EXISTS (
    SELECT FROM :"staging".record_correspondence_audit audit
    JOIN :"staging".record_correspondence edge ON edge.id = audit.correspondence_id
    WHERE edge.type = 'recognized_export' AND audit.to_status = 'confirmed'
  )
) AS without_retired_comparison_evidence
\gset
\if :without_retired_comparison_evidence
\else
DO $$ BEGIN RAISE EXCEPTION 'Source retains comparison scope proof or confirmed interface-export correspondence'; END $$;
\endif

INSERT INTO difference_reason (
  id, enterprise_id, title_code, direction, status, reason_code, reason_note, measure_code, measure_note,
  evidence_query_id, evidence_relation_id, moved_in_city, moved_in_title_code, moved_in_year,
  moved_in_batch, verification_status, recorded_at, created_at, lifecycle_action, previous_id, actor, basis,
  rule_version, effective_at, idempotency_key, request_hash, current_qualification, fact_references
)
SELECT id, enterprise_id, title_code, direction, status, reason_code, reason_note, measure_code, measure_note,
  evidence_query_id, evidence_relation_id, moved_in_city, moved_in_title_code, moved_in_year,
  moved_in_batch, verification_status, recorded_at, created_at, lifecycle_action, previous_id, actor, basis,
  rule_version, effective_at, idempotency_key, request_hash, current_qualification, fact_references
FROM :"staging".difference_reason;

\set evidence_source :staging
\ir ../2026-11-data-compaction/steps/support/freeze-decision-evidence.sql

INSERT INTO enterprise_difference_comparison (
  enterprise_id, title_code, comparison_state, reasons, comparison_error, decision_cutoff_id,
  business_fingerprint, changed_at, refreshed_at
)
SELECT enterprise_id, title_code, comparison_state, reasons, comparison_error, decision_cutoff_id,
  business_fingerprint, changed_at, refreshed_at
FROM :"staging".enterprise_difference_comparison;

INSERT INTO enterprise_fact_receipt (
  idempotency_key, request_hash, receipt
)
SELECT idempotency_key, request_hash, receipt
FROM :"staging".enterprise_fact_receipt;

INSERT INTO enterprise_fact_revision (
  id, enterprise_id, fact_id, revision, status, fact, replaces, action, actor, basis, created_at
)
SELECT id, enterprise_id, fact_id, revision, status, fact, replaces, action, actor, basis, created_at
FROM :"staging".enterprise_fact_revision;

INSERT INTO event_correction_audit (
  id, event_id, batch_id, record_id, enterprise_id, before, after, evidence, source_identity, actor_type,
  actor_id, basis, corrected_at
)
SELECT id, event_id, batch_id, record_id, enterprise_id, before, after, evidence, source_identity, actor_type,
  actor_id, basis, corrected_at
FROM :"staging".event_correction_audit;

INSERT INTO evidence_correction_audit (
  id, evidence_id, event_id, batch_key, entry_point, actor, basis, before, after, created_at
)
SELECT id, evidence_id, event_id, batch_key, entry_point, actor, basis, before, after, created_at
FROM :"staging".evidence_correction_audit;

INSERT INTO evidence_correction_batch (
  idempotency_key, request_hash, plan_hash, receipt, created_at
)
SELECT idempotency_key, request_hash, plan_hash, receipt, created_at
FROM :"staging".evidence_correction_batch;

INSERT INTO evidence_review_receipt_114 (
  id, idempotency_key, request_hash, kind, enterprise_id, title_code, direction, decision_id,
  source_decision_id, reviewed_revision_id, actor, basis, rule_version, effective_at, response, recorded_at
)
SELECT id, idempotency_key, request_hash, kind, enterprise_id, title_code, direction, decision_id,
  source_decision_id, reviewed_revision_id, actor, basis, rule_version, effective_at, response, recorded_at
FROM :"staging".evidence_review_receipt_114;

INSERT INTO file_declaration_669 (
  declaration_id, file_id, revision, active, sha256, content_version, part, page_ranges, display_sequence
)
SELECT declaration_id, file_id, revision, active, sha256, content_version, part, page_ranges, display_sequence
FROM :"staging".file_declaration_669;

INSERT INTO file_parse_audit_105 (
  id, file_id, idempotency_key, request_hash, operation, actor, reason, before, after, created_at
)
SELECT id, file_id, idempotency_key, request_hash, operation, actor, reason, before, after, created_at
FROM :"staging".file_parse_audit_105;

INSERT INTO import_batch (
  id, idempotency_key, source_kind, source_identity, source_sha256, status, preflight_result, item_results,
  summary, error, created_at, committed_at
)
SELECT id, idempotency_key, source_kind, source_identity, source_sha256, status, preflight_result, item_results,
  summary, error, created_at, committed_at
FROM :"staging".import_batch;

\ir ../2026-11-data-compaction/steps/support/classify-import-receipt.sql
INSERT INTO import_receipt (
  id, batch_id, operation, request_hash, historical_projection, status, summary, item_results, created_at, completed_at
)
SELECT receipt.id, receipt.batch_id, receipt.operation, receipt.request_hash,
  CASE WHEN batch.source_kind = 'platform_archive'
    THEN pg_temp.import_historical_projection(coalesce(owner.request_body, receipt.request_body)) ELSE false END,
  receipt.status, receipt.summary, receipt.item_results, receipt.created_at, receipt.completed_at
FROM :"staging".import_receipt receipt
LEFT JOIN :"staging".import_batch batch ON batch.id = receipt.batch_id
LEFT JOIN :"staging".import_receipt owner ON owner.id = receipt.body_receipt_id;

INSERT INTO official_evidence_row_revision (
  evidence_id, revision, format_version, event_id, captured_record_id, captured_enterprise_id, name_raw,
  uscc_raw, district_raw, source_document_id, stored_file_id, path, sha256, bytes, attachment, section_key,
  list_no, page, source_binding_known, actor, basis, command_kind, import_batch_id, correction_batch_key,
  created_at, name_raw_json, uscc_raw_json, district_raw_json
)
SELECT evidence_id, revision, format_version, event_id, captured_record_id, captured_enterprise_id,
  CASE WHEN pg_input_is_valid(name_raw, 'jsonb') THEN name_raw::json #>> '{}' END,
  CASE WHEN pg_input_is_valid(uscc_raw, 'jsonb') THEN uscc_raw::json #>> '{}' END,
  CASE WHEN pg_input_is_valid(district_raw, 'jsonb') THEN district_raw::json #>> '{}' END,
  source_document_id, stored_file_id, path, sha256, bytes, attachment, section_key,
  list_no, page, source_binding_known, actor, basis, command_kind, import_batch_id, correction_batch_key,
  created_at,
  CASE WHEN NOT pg_input_is_valid(name_raw, 'jsonb') THEN name_raw END,
  CASE WHEN NOT pg_input_is_valid(uscc_raw, 'jsonb') THEN uscc_raw END,
  CASE WHEN NOT pg_input_is_valid(district_raw, 'jsonb') THEN district_raw END
FROM :"staging".official_evidence_row_revision;

INSERT INTO platform_apply_projection (
  exact_status_sqlite_storage, exact_declare_kind_sqlite_storage, exact_applied_at_sqlite_storage,
  exact_year_sqlite_storage, exact_title_raw_sqlite_storage, exact_status, exact_declare_kind,
  exact_applied_at, exact_year, exact_title_raw, exact_stored_state, exact_stored_rule,
  exact_stored_origin, exact_stored_reason, sql_fact_title, sql_fact_title_state, sql_fact_title_rule,
  sql_fact_title_reason, id, observation_id, basis, version_id, record_id, declare_kind, declaration_year,
  applied_at, status, title_raw, name_raw, uscc_raw, source_title_kind, source_title_text,
  source_title_number_text, source_title_boolean, source_title_rule_version, parse_state, stored_province,
  parsed_province, reconciled_province, province_conflict, stored_status, parsed_status, reconciled_status,
  status_conflict, stored_batch, parsed_batch, reconciled_batch, batch_conflict, stored_declare_kind,
  parsed_declare_kind, reconciled_declare_kind, declare_kind_conflict, stored_applied_at,
  parsed_applied_at, reconciled_applied_at, applied_at_conflict, stored_award_batch_label,
  parsed_award_batch_label, reconciled_award_batch_label, award_batch_label_conflict, stored_year,
  parsed_year, reconciled_year, year_conflict, rule_version, created_at
)
SELECT exact_status_sqlite_storage, exact_declare_kind_sqlite_storage, exact_applied_at_sqlite_storage,
  exact_year_sqlite_storage, exact_title_raw_sqlite_storage, exact_status, exact_declare_kind,
  exact_applied_at, exact_year, exact_title_raw, exact_stored_state, exact_stored_rule,
  exact_stored_origin, exact_stored_reason, sql_fact_title, sql_fact_title_state, sql_fact_title_rule,
  sql_fact_title_reason, id, observation_id, basis, version_id, record_id, declare_kind, declaration_year,
  applied_at, status, title_raw, name_raw, uscc_raw, source_title_kind, source_title_text,
  source_title_number_text, source_title_boolean, source_title_rule_version, parse_state, stored_province,
  parsed_province, reconciled_province, province_conflict, stored_status, parsed_status, reconciled_status,
  status_conflict, stored_batch, parsed_batch, reconciled_batch, batch_conflict, stored_declare_kind,
  parsed_declare_kind, reconciled_declare_kind, declare_kind_conflict, stored_applied_at,
  parsed_applied_at, reconciled_applied_at, applied_at_conflict, stored_award_batch_label,
  parsed_award_batch_label, reconciled_award_batch_label, award_batch_label_conflict, stored_year,
  parsed_year, reconciled_year, year_conflict, rule_version, created_at
FROM :"staging".platform_apply_projection;

INSERT INTO platform_archive_value (
  id, storage_class, bytes, byte_length, sha256, created_at
)
SELECT id, storage_class, bytes, byte_length, sha256, created_at
FROM :"staging".platform_archive_value;

INSERT INTO platform_business_observation (
  process_exact_owner_id, process_exact_state, process_sql_fact_title_state, apply_exact_owner_id,
  apply_exact_state, apply_sql_fact_title_state, id, collection_id, sequence_no, page_id, page_row_no,
  position_state, source_relation_key, record_id, version_id, identity_state, content_state, key_source,
  projection_rule_version, input_fingerprint, indexed_at, batch_id, candidate_scope_mask,
  candidate_scope_rule, candidate_scope_archive_id, candidate_scope_rdjb, candidate_scope_title_code,
  candidate_scope_sequence_no, candidate_scope_error, candidate_scope_state, witness_rule,
  witness_collection_id, witness_sequence_no, witness_archive_id, witness_sha256, witness_ordinal,
  witness_rdjb_kind, witness_rdjb_value, witness_rdjb_value_sqlite_storage, witness_rdjb_key,
  witness_page_kind, witness_page_value, witness_page_value_sqlite_storage, witness_error_name,
  witness_error, witness_state, public_id
)
SELECT process_exact_owner_id, process_exact_state, process_sql_fact_title_state, apply_exact_owner_id,
  apply_exact_state, apply_sql_fact_title_state, id, collection_id, sequence_no, page_id, page_row_no,
  position_state, source_relation_key, record_id, version_id, identity_state, content_state, key_source,
  projection_rule_version, input_fingerprint, indexed_at, batch_id, candidate_scope_mask,
  candidate_scope_rule, candidate_scope_archive_id, candidate_scope_rdjb, candidate_scope_title_code,
  candidate_scope_sequence_no, candidate_scope_error, candidate_scope_state, witness_rule,
  witness_collection_id, witness_sequence_no, witness_archive_id, witness_sha256, witness_ordinal,
  witness_rdjb_kind, witness_rdjb_value, witness_rdjb_value_sqlite_storage, witness_rdjb_key,
  witness_page_kind, witness_page_value, witness_page_value_sqlite_storage, witness_error_name,
  witness_error, witness_state,
  (SELECT alias.old_id FROM :"staging".platform_legacy_relation_alias alias WHERE alias.observation_id = source.id)
FROM :"staging".platform_business_observation AS source;

INSERT INTO platform_business_projection (
  exact_status_sqlite_storage, exact_declare_kind_sqlite_storage, exact_applied_at_sqlite_storage,
  exact_year_sqlite_storage, exact_title_raw_sqlite_storage, exact_batch_sqlite_storage,
  exact_award_batch_label_sqlite_storage, exact_province_sqlite_storage, exact_status, exact_declare_kind,
  exact_applied_at, exact_year, exact_title_raw, exact_batch, exact_award_batch_label, exact_province,
  exact_stored_state, exact_stored_rule, exact_stored_origin, exact_stored_reason, sql_fact_title,
  sql_fact_title_state, sql_fact_title_rule, sql_fact_title_reason, id, observation_id, basis, version_id,
  record_id, declare_kind, business_year, applied_at, status, batch, award_batch_label, province,
  title_raw, name_raw, uscc_raw, source_title_kind, source_title_text, source_title_number_text,
  source_title_boolean, source_title_rule_version, parse_state, stored_province, parsed_province,
  reconciled_province, province_conflict, stored_status, stored_status_sqlite_storage, parsed_status,
  reconciled_status, reconciled_status_sqlite_storage, status_conflict, stored_batch, parsed_batch,
  reconciled_batch, batch_conflict, stored_declare_kind, parsed_declare_kind, reconciled_declare_kind,
  declare_kind_conflict, stored_applied_at, parsed_applied_at, reconciled_applied_at, applied_at_conflict,
  stored_award_batch_label, parsed_award_batch_label, reconciled_award_batch_label,
  award_batch_label_conflict, stored_year, parsed_year, reconciled_year, year_conflict, rule_version,
  created_at
)
SELECT exact_status_sqlite_storage, exact_declare_kind_sqlite_storage, exact_applied_at_sqlite_storage,
  exact_year_sqlite_storage, exact_title_raw_sqlite_storage, exact_batch_sqlite_storage,
  exact_award_batch_label_sqlite_storage, exact_province_sqlite_storage, exact_status, exact_declare_kind,
  exact_applied_at, exact_year, exact_title_raw, exact_batch, exact_award_batch_label, exact_province,
  exact_stored_state, exact_stored_rule, exact_stored_origin, exact_stored_reason, sql_fact_title,
  sql_fact_title_state, sql_fact_title_rule, sql_fact_title_reason, id, observation_id, basis, version_id,
  record_id, declare_kind, business_year, applied_at, status, batch, award_batch_label, province,
  title_raw, name_raw, uscc_raw, source_title_kind, source_title_text, source_title_number_text,
  source_title_boolean, source_title_rule_version, parse_state, stored_province, parsed_province,
  reconciled_province, province_conflict, stored_status, stored_status_sqlite_storage, parsed_status,
  reconciled_status, reconciled_status_sqlite_storage, status_conflict, stored_batch, parsed_batch,
  reconciled_batch, batch_conflict, stored_declare_kind, parsed_declare_kind, reconciled_declare_kind,
  declare_kind_conflict, stored_applied_at, parsed_applied_at, reconciled_applied_at, applied_at_conflict,
  stored_award_batch_label, parsed_award_batch_label, reconciled_award_batch_label,
  award_batch_label_conflict, stored_year, parsed_year, reconciled_year, year_conflict, rule_version,
  created_at
FROM :"staging".platform_business_projection;

INSERT INTO platform_business_record (
  id, interface, platform_key, identity_rule_version, created_at
)
SELECT id, interface, platform_key, identity_rule_version, created_at
FROM :"staging".platform_business_record;

INSERT INTO platform_business_record_version (
  id, record_id, hash_algorithm, content_hash, created_at
)
SELECT id, record_id, hash_algorithm, content_hash, created_at
FROM :"staging".platform_business_record_version;

INSERT INTO platform_collection (
  id, interface, query_key, rdjb, title_code, queried_at, created_at, last_collected_at, status,
  failure_reason, source, evidence_status, completed_at, completeness, full_range, fetched_count,
  declared_total, scope_mode, provenance_state, parse_state, rule_version, error_code, error_message,
  max_requests, max_rows, max_duration_ms, page_size, witness_gate, witness_rule, witness_archive_id, witness_sha256, witness_error_name,
  witness_error, witness_state, public_id
)
SELECT id, interface, query_key, rdjb, title_code, queried_at, created_at, last_collected_at, status,
  failure_reason, source, evidence_status, completed_at, completeness, full_range, fetched_count,
  declared_total, scope_mode, provenance_state, parse_state, rule_version, error_code, error_message,
  max_requests, max_rows, max_duration_ms, page_size, witness_gate, witness_rule, witness_archive_id, witness_sha256, witness_error_name,
  witness_error, witness_state,
  (SELECT alias.old_id FROM :"staging".platform_legacy_query_alias alias WHERE alias.collection_id = source.id)
FROM :"staging".platform_collection AS source;

INSERT INTO platform_collection_archive_ref (
  owner_id, field, archive_id, sealed
)
SELECT owner_id, field, archive_id, sealed
FROM :"staging".platform_collection_archive_ref;

\set scope_source :staging
\ir ../2026-11-data-compaction/steps/support/backfill-platform-collection-scope.sql

INSERT INTO platform_collection_legacy_provenance (
  collection_id, origin, source_identity, source_sha256, segment_index, input_fingerprint, import_batch_id,
  created_at, archive_id
)
SELECT collection_id, origin, source_identity, source_sha256, segment_index, input_fingerprint, import_batch_id,
  created_at, archive_id
FROM :"staging".platform_collection_legacy_provenance;

INSERT INTO platform_collection_page (
  id, collection_id, ordinal, source, rdjb, page_no, max_page, fetched_count, declared_total, status,
  error_code, error_message, sequence_start, sequence_end, position_state, max_page_present
)
SELECT id, collection_id, ordinal, source, rdjb, page_no, max_page, fetched_count, declared_total, status,
  error_code, error_message, sequence_start, sequence_end, position_state, max_page_present
FROM :"staging".platform_collection_page;

INSERT INTO platform_export_batch (
  id, title_code, year, collected_on, original_filename, sha256, row_count, import_status,
  source_document_id, import_batch_id, replaced_batch_id, created_at
)
SELECT id, title_code, year, collected_on, original_filename, sha256, row_count, import_status,
  source_document_id, import_batch_id, replaced_batch_id, created_at
FROM :"staging".platform_export_batch;

INSERT INTO platform_export_row (
  id, batch_id, source_row_no, uscc_raw, name_raw, district, province, city, reg_status, raw_fields,
  created_at
)
SELECT id, batch_id, source_row_no, uscc_raw, name_raw, district, province, city, reg_status, raw_fields,
  created_at
FROM :"staging".platform_export_row;

INSERT INTO platform_observation_archive_ref (
  owner_id, field, archive_id, sealed
)
SELECT owner_id, field, archive_id, sealed
FROM :"staging".platform_observation_archive_ref;

INSERT INTO platform_observation_assignment (
  observation_id, revision, enterprise_id, match_basis, verification_status, uscc_raw, name_raw,
  alias_name_raw, actor, basis, command_receipt_id, recorded_at, origin
)
SELECT observation_id, revision, enterprise_id, match_basis, verification_status, uscc_raw, name_raw,
  alias_name_raw, actor, basis, command_receipt_id, recorded_at, origin
FROM :"staging".platform_observation_assignment;

INSERT INTO platform_query_title_scope (
  collection_id, rdjb
)
SELECT collection_id, rdjb
FROM :"staging".platform_query_title_scope;

INSERT INTO platform_recognized_projection (
  source_recognized_at, source_valid_flag, source_valid_flag_sqlite_storage, source_invalidated_at,
  source_invalidation_reason, source_province_name, source_city_name, source_district_name,
  qualification_fields_rule, id, observation_id, basis, version_id, record_id, validity_date_raw,
  maintenance_year, maintenance_batch, source_validity_date, source_maintenance_batch,
  source_maintenance_year_absent, district, award_note, title_raw, name_raw, uscc_raw, source_title_kind,
  source_title_text, source_title_number_text, source_title_boolean, source_title_rule_version,
  parse_state, stored_province, parsed_province, reconciled_province, province_conflict, stored_status,
  parsed_status, reconciled_status, status_conflict, stored_batch, parsed_batch, reconciled_batch,
  batch_conflict, stored_declare_kind, parsed_declare_kind, reconciled_declare_kind, declare_kind_conflict,
  stored_applied_at, parsed_applied_at, reconciled_applied_at, applied_at_conflict,
  stored_award_batch_label, parsed_award_batch_label, reconciled_award_batch_label,
  award_batch_label_conflict, stored_year, parsed_year, reconciled_year, year_conflict, rule_version,
  created_at, exact_title_raw, exact_title_raw_sqlite_storage, exact_title_state
)
SELECT source_recognized_at, source_valid_flag, source_valid_flag_sqlite_storage, source_invalidated_at,
  source_invalidation_reason, source_province_name, source_city_name, source_district_name,
  qualification_fields_rule, id, observation_id, basis, version_id, record_id, validity_date_raw,
  maintenance_year, maintenance_batch, source_validity_date, source_maintenance_batch,
  source_maintenance_year_absent, district, award_note, title_raw, name_raw, uscc_raw, source_title_kind,
  source_title_text, source_title_number_text, source_title_boolean, source_title_rule_version,
  parse_state, stored_province, parsed_province, reconciled_province, province_conflict, stored_status,
  parsed_status, reconciled_status, status_conflict, stored_batch, parsed_batch, reconciled_batch,
  batch_conflict, stored_declare_kind, parsed_declare_kind, reconciled_declare_kind, declare_kind_conflict,
  stored_applied_at, parsed_applied_at, reconciled_applied_at, applied_at_conflict,
  stored_award_batch_label, parsed_award_batch_label, reconciled_award_batch_label,
  award_batch_label_conflict, stored_year, parsed_year, reconciled_year, year_conflict, rule_version,
  created_at, exact_title_raw, exact_title_raw_sqlite_storage, exact_title_state
FROM :"staging".platform_recognized_projection;

INSERT INTO record (
  id, enterprise_id, title_code, source, district, uscc_raw, name_raw, quality_flags
)
SELECT id, enterprise_id, title_code, source, district, uscc_raw, name_raw, quality_flags
FROM :"staging".record;

INSERT INTO record_correspondence (
  id, edge_key, type, role, event_id, predecessor_event_id, observation_id, export_row_id, enterprise_id,
  title_code, status, revision, target_identity, provenance, source_fingerprint, rule_id, rule_version,
  created_at, decided_at, ended_at
)
SELECT id, edge_key, type, role, event_id, predecessor_event_id, observation_id, export_row_id, enterprise_id,
  title_code, status, revision, target_identity, provenance, source_fingerprint, rule_id, rule_version,
  created_at, decided_at, ended_at
FROM :"staging".record_correspondence;

INSERT INTO record_correspondence_audit (
  id, correspondence_id, batch_id, idempotency_key, from_status, to_status, expected_revision,
  resulting_revision, actor_type, actor_id, basis, rule_id, rule_version, evidence, decided_at
)
SELECT id, correspondence_id, batch_id, idempotency_key, from_status, to_status, expected_revision,
  resulting_revision, actor_type, actor_id, basis, rule_id, rule_version, evidence, decided_at
FROM :"staging".record_correspondence_audit;
\ir ../2026-11-data-compaction/steps/support/compact-correspondence-query-evidence.sql

INSERT INTO record_event (
  id, record_id, event_type, year, batch_seq, sort_key, review_outcome, decided_year, revision,
  formal_validity
)
SELECT id, record_id, event_type, year, batch_seq, sort_key, review_outcome, decided_year, revision,
  formal_validity
FROM :"staging".record_event;

INSERT INTO record_evidence (
  id, record_event_id, source_file, attachment, list_no, page
)
SELECT id, record_event_id, source_file, attachment, list_no, page
FROM :"staging".record_evidence;

INSERT INTO roster_file_classification (
  file_id, source, kind, year, batch, title_code, category_state, parse_state
)
SELECT file_id, source, kind, year, batch, title_code, category_state, parse_state
FROM :"staging".roster_file_classification;

INSERT INTO source_document (
  id, source, title, doc_number, issue_date, path
)
SELECT id, source, title, doc_number, issue_date, path
FROM :"staging".source_document;

INSERT INTO stored_file_part (
  id, file_id, title_code, event_kind, year, batch, attachment, row_count, origin, has_conflict
)
SELECT id, file_id, title_code, event_kind, year, batch, attachment, row_count, origin, has_conflict
FROM :"staging".stored_file_part;

INSERT INTO title (
  code, name_zh, level, rank
)
SELECT code, name_zh, level, rank
FROM :"staging".title;

INSERT INTO title_cycle_disposition_receipt (
  key, request_hash, receipt
)
SELECT key, request_hash, receipt
FROM :"staging".title_cycle_disposition_receipt;

INSERT INTO title_cycle_disposition_revision (
  revision_id, id, revision, enterprise_id, title_code, cycle_event_id, status, kind, source_file_id,
  source_sha256, cycle_revision, effective_precision, effective_value, fact, audit
)
SELECT revision_id, id, revision, enterprise_id, title_code, cycle_event_id, status, kind, source_file_id,
  source_sha256, cycle_revision, effective_precision, effective_value, fact, audit
FROM :"staging".title_cycle_disposition_revision;

INSERT INTO roster_announcement_intake (
  id, idempotency_key, digest, request, removed_reason, supplement_digest, reviewed_request, receipt
)
SELECT id, idempotency_key, digest, request, removed_reason, supplement_digest, reviewed_request, receipt
FROM :"staging".roster_announcement_intake;

INSERT INTO roster_legacy_member (
  enterprise_id
)
SELECT enterprise_id
FROM :"staging".roster_legacy_member;

INSERT INTO roster_announcement_member (
  enterprise_id, intake_id
)
SELECT enterprise_id, intake_id
FROM :"staging".roster_announcement_member;

-- SQLite uses the integer part of a REAL sequence value when allocating rowids.
-- The staging tool tags the complete sequence column when a snapshot has any mixed cells.
CREATE FUNCTION pg_temp.roster_sequence_high_water(value text, storage text) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  bits bigint;
  exponent integer;
  significand bigint;
BEGIN
  CASE storage
    WHEN 'null' THEN RETURN 0;
    WHEN 'bigint' THEN RETURN value::bigint;
    WHEN 'integer' THEN RETURN ('x' || substr(value, 3))::bit(64)::bigint;
    WHEN 'real' THEN
      bits := ('x' || substr(value, 3))::bit(64)::bigint;
      exponent := (bits >> 52) & 2047;
      IF exponent = 2047 OR (bits >= 0 AND exponent > 1085) THEN
        RAISE EXCEPTION 'SQLite REAL sequence value is out of range';
      END IF;
      IF bits < 0 OR exponent < 1023 THEN
        RETURN 0;
      END IF;
      significand := (bits & 4503599627370495) + 4503599627370496;
      IF exponent < 1075 THEN
        RETURN significand / (1::bigint << (1075 - exponent));
      END IF;
      RETURN significand << (exponent - 1075);
    ELSE
      RAISE EXCEPTION 'Unsupported SQLite sequence storage class: %', storage;
  END CASE;
END;
$$;

CREATE TEMP TABLE roster_sequence_restart (table_name text, column_name text, next_id bigint) ON COMMIT DROP;
WITH owned_sequences(table_name, column_name) AS (
  VALUES
    ('difference_reason', 'id'),
    ('enterprise_fact_revision', 'id'),
    ('event_correction_audit', 'id'),
    ('evidence_correction_audit', 'id'),
    ('evidence_review_receipt_114', 'id'),
    ('file_parse_audit_105', 'id'),
    ('import_batch', 'id'),
    ('import_receipt', 'id'),
    ('platform_apply_projection', 'id'),
    ('platform_business_observation', 'id'),
    ('platform_business_projection', 'id'),
    ('platform_business_record', 'id'),
    ('platform_business_record_version', 'id'),
    ('platform_collection', 'id'),
    ('platform_collection_page', 'id'),
    ('platform_export_batch', 'id'),
    ('platform_export_row', 'id'),
    ('platform_recognized_projection', 'id'),
    ('record', 'id'),
    ('record_correspondence', 'id'),
    ('record_correspondence_audit', 'id'),
    ('record_event', 'id'),
    ('record_evidence', 'id'),
    ('source_document', 'id'),
    ('stored_file_part', 'id'),
    ('title_cycle_disposition_revision', 'revision_id'),
    ('roster_announcement_intake', 'id')
)
SELECT format(
  'INSERT INTO pg_temp.roster_sequence_restart SELECT %L, %L, '
    'greatest(coalesce(max(%I), 0), coalesce((SELECT '
    'pg_temp.roster_sequence_high_water(seq::text, coalesce(to_jsonb(s)->>''seq_sqlite_storage'', ''bigint'')) '
    'FROM %I.sqlite_sequence s WHERE name = %L), 0)) + 1 FROM %I',
  table_name, column_name, column_name, :'staging', table_name, table_name
)
FROM owned_sequences
\gexec
SELECT format('ALTER TABLE %I ALTER COLUMN %I RESTART WITH %s', table_name, column_name, next_id)
FROM pg_temp.roster_sequence_restart
\gexec

DROP FUNCTION pg_temp.roster_sequence_high_water(text, text);

WITH highest AS (
  SELECT greatest(coalesce(max(public_id), 0),
    coalesce((SELECT high_water FROM :"staging".platform_legacy_alias_sequence WHERE namespace='query'),0)) AS last
  FROM platform_collection
)
SELECT setval(pg_get_serial_sequence('platform_collection','public_id'),greatest(last,1),last>0) FROM highest;

WITH highest AS (
  SELECT greatest(coalesce(max(public_id), 0),
    coalesce((SELECT high_water FROM :"staging".platform_legacy_alias_sequence WHERE namespace='relation'),0)) AS last
  FROM platform_business_observation
)
SELECT setval(pg_get_serial_sequence('platform_business_observation','public_id'),greatest(last,1),last>0) FROM highest;

\ir ../../../db/postgresql/roster-constraints.sql
\ir ../../../db/postgresql/roster-triggers.sql
\ir ../../../db/postgresql/platform-observation-snapshot.sql
\ir ../../../db/postgresql/platform-business-facts-backfill.sql
\ir ../../../db/postgresql/platform-offline-read-facts.sql
DROP FUNCTION platform_observation_snapshot(bigint, bytea);
DROP TABLE platform_observation_archive_ref, platform_collection_archive_ref,
  platform_collection_legacy_provenance, platform_archive_value;

SELECT format('ANALYZE %I.%I', :'target', tablename)
FROM pg_tables
WHERE schemaname = :'target' AND tablename IN (
  'difference_reason',
  'enterprise_difference_comparison', 'enterprise_fact_receipt', 'enterprise_fact_revision',
  'event_correction_audit', 'evidence_correction_audit', 'evidence_correction_batch',
  'evidence_review_receipt_114',
  'file_declaration_669', 'file_parse_audit_105', 'import_batch', 'import_receipt',
  'official_evidence_row_revision', 'platform_apply_projection',
  'platform_business_observation', 'platform_business_projection', 'platform_business_record',
  'platform_business_record_version', 'platform_collection',
  'platform_collection_page',
  'platform_export_batch', 'platform_export_row',

  'platform_observation_assignment', 'platform_query_title_scope',
  'platform_recognized_projection',
  'record', 'record_correspondence', 'record_correspondence_audit', 'record_event',
  'record_evidence', 'roster_file_classification', 'source_document', 'stored_file_part', 'title',
  'title_cycle_disposition_receipt', 'title_cycle_disposition_revision', 'roster_announcement_intake',
  'roster_legacy_member', 'roster_announcement_member'
)
\gexec
COMMIT;
