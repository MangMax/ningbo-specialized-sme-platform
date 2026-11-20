-- Create indexes before validating the foreign keys on the loaded rows.
CREATE INDEX comparison_scope_proof_audit_proof_idx ON comparison_scope_proof_audit (proof_id,id);
CREATE INDEX comparison_scope_proof_kind_idx ON comparison_scope_proof (kind);
CREATE UNIQUE INDEX difference_reason_command_uq ON difference_reason(idempotency_key);
CREATE INDEX difference_reason_impact_head_113_idx ON difference_reason(enterprise_id,title_code,direction,recorded_at,id);
CREATE INDEX difference_reason_impact_title_113_idx ON difference_reason(title_code,id);
CREATE INDEX difference_reason_managed_idx ON difference_reason(enterprise_id,title_code,direction) WHERE lifecycle_action IS NOT NULL;
CREATE UNIQUE INDEX difference_reason_version_uq ON difference_reason (enterprise_id,title_code,direction,recorded_at);
CREATE UNIQUE INDEX enterprise_fact_revision_key ON enterprise_fact_revision(enterprise_id,fact_id,revision);
CREATE INDEX event_correction_audit_event_idx ON event_correction_audit (event_id, id);
CREATE INDEX evidence_correction_audit_evidence_idx ON evidence_correction_audit (evidence_id, id);
CREATE UNIQUE INDEX evidence_impact_link_113_uq ON evidence_impact_link_113(revision_id,impact_id);
CREATE INDEX evidence_impact_link_state_113_idx ON evidence_impact_link_113(impact_id,revision_id);
CREATE INDEX evidence_impact_pending_113_idx ON evidence_impact_progress_113(done,revision_id);
CREATE INDEX evidence_review_decision_114_idx ON evidence_review_receipt_114(decision_id,id);
CREATE INDEX evidence_review_scope_114_idx ON evidence_review_receipt_114(enterprise_id,title_code,direction,decision_id,id);
CREATE INDEX evidence_review_source_decision_114_idx ON evidence_review_receipt_114(source_decision_id,id);
CREATE UNIQUE INDEX evidence_revision_event_113_uq ON evidence_revision_event_113(revision_id,event_id);
CREATE INDEX evidence_revision_event_scope_113_idx ON evidence_revision_event_113(revision_id,enterprise_id,title_code,event_id);
CREATE INDEX evidence_revision_scope_113_idx ON evidence_revision_113(enterprise_id,title_code,id);
CREATE UNIQUE INDEX evidence_revision_source_113_uq ON evidence_revision_113(source_kind,source_key,source_version);
CREATE UNIQUE INDEX evidence_rule_release_scope_114_uq ON evidence_rule_release_114(rule_id,version,enterprise_id,title_code,direction);
CREATE UNIQUE INDEX explanation_impact_coordinate_113_uq ON explanation_impact_113(enterprise_id,title_code,direction,decision_id);
CREATE INDEX explanation_impact_decision_113_idx ON explanation_impact_113(decision_id);
CREATE INDEX explanation_impact_enterprise_113_idx ON explanation_impact_113(enterprise_id,id);
CREATE INDEX file_declaration_681_order_idx ON file_declaration_669(file_id, display_sequence);
CREATE INDEX file_parse_105_history_idx ON file_parse_audit_105 (file_id,id);
CREATE UNIQUE INDEX file_parse_105_key_uq ON file_parse_audit_105 (file_id,idempotency_key);
CREATE UNIQUE INDEX import_batch_idempotency_uq ON import_batch (idempotency_key);
CREATE INDEX import_batch_status_idx ON import_batch (status);
CREATE INDEX import_receipt_batch_id_idx ON import_receipt (batch_id, id);
CREATE INDEX import_receipt_body_owner_idx ON import_receipt(batch_id,request_hash,id) WHERE body_receipt_id IS NULL;
CREATE INDEX official_evidence_row_event_idx ON official_evidence_row_revision (event_id,evidence_id,revision);
CREATE UNIQUE INDEX official_evidence_row_revision_uq ON official_evidence_row_revision (evidence_id,revision);
CREATE INDEX official_evidence_row_source_idx ON official_evidence_row_revision (source_document_id,sha256,bytes,attachment,section_key,list_no,evidence_id,revision);
CREATE INDEX platform_apply_projection_applied_idx ON platform_apply_projection (applied_at);
CREATE INDEX platform_apply_projection_kind_idx ON platform_apply_projection (declare_kind);
CREATE UNIQUE INDEX platform_apply_projection_observation_uq ON platform_apply_projection (observation_id);
CREATE INDEX platform_apply_projection_record_idx ON platform_apply_projection (record_id);
CREATE INDEX platform_apply_projection_source_archive_idx ON platform_apply_projection(source_archive_id);
CREATE INDEX platform_apply_projection_status_idx ON platform_apply_projection (status);
CREATE INDEX platform_apply_projection_title_version_idx ON platform_apply_projection (title_raw,version_id);
CREATE INDEX platform_apply_projection_uscc_idx ON platform_apply_projection (uscc_raw);
CREATE UNIQUE INDEX platform_apply_projection_version_uq ON platform_apply_projection (version_id);
CREATE INDEX platform_apply_projection_year_idx ON platform_apply_projection (declaration_year);
CREATE INDEX platform_assignment_enterprise_idx ON platform_observation_assignment (enterprise_id,observation_id,revision);
CREATE INDEX platform_assignment_uscc_idx ON platform_observation_assignment (uscc_raw,observation_id);
CREATE INDEX platform_business_observation_record_idx ON platform_business_observation(record_id, version_id, id);
CREATE INDEX platform_business_observation_version_idx ON platform_business_observation(version_id, id);
CREATE INDEX platform_business_projection_applied_idx ON platform_business_projection (applied_at);
CREATE INDEX platform_business_projection_batch_idx ON platform_business_projection (batch);
CREATE INDEX platform_business_projection_kind_idx ON platform_business_projection (declare_kind);
CREATE UNIQUE INDEX platform_business_projection_observation_uq ON platform_business_projection (observation_id);
CREATE INDEX platform_business_projection_record_idx ON platform_business_projection (record_id);
CREATE INDEX platform_business_projection_source_archive_idx ON platform_business_projection(source_archive_id);
CREATE INDEX platform_business_projection_status_idx ON platform_business_projection (status);
CREATE INDEX platform_business_projection_title_version_idx ON platform_business_projection (title_raw,version_id);
CREATE INDEX platform_business_projection_uscc_idx ON platform_business_projection (uscc_raw);
CREATE UNIQUE INDEX platform_business_projection_version_uq ON platform_business_projection (version_id);
CREATE INDEX platform_business_projection_year_idx ON platform_business_projection (business_year);
CREATE UNIQUE INDEX platform_business_record_identity_uq ON platform_business_record(interface, platform_key);
CREATE INDEX platform_business_version_canonical_archive_idx ON platform_business_record_version(canonical_archive_id);
CREATE UNIQUE INDEX platform_business_version_hash_uq ON platform_business_record_version(record_id, hash_algorithm, content_hash);
CREATE UNIQUE INDEX platform_business_version_owner_uq ON platform_business_record_version(id, record_id);
CREATE UNIQUE INDEX platform_collection_archive_ref_archive_id_unique ON platform_collection_archive_ref (archive_id);
CREATE UNIQUE INDEX platform_collection_identity_uq ON platform_collection (interface,query_key,rdjb,queried_at);
CREATE INDEX platform_collection_key_idx ON platform_collection (query_key, id);
CREATE UNIQUE INDEX platform_collection_page_ordinal_uq ON platform_collection_page (collection_id,ordinal);
CREATE INDEX platform_collection_page_title_idx ON platform_collection_page (collection_id,rdjb,page_no);
CREATE INDEX platform_collection_status_time_idx ON platform_collection (status,queried_at,id);
CREATE INDEX platform_collection_title_idx ON platform_collection (title_code,id);
CREATE UNIQUE INDEX platform_export_batch_identity_uq ON platform_export_batch (title_code,year,sha256);
CREATE INDEX platform_export_row_identity_113_idx ON platform_export_row(batch_id,upper(trim(uscc_raw)),name_raw);
CREATE UNIQUE INDEX platform_export_row_identity_uq ON platform_export_row (batch_id,source_row_no);
CREATE UNIQUE INDEX platform_legacy_query_alias_collection_id_unique ON platform_legacy_query_alias (collection_id);
CREATE UNIQUE INDEX platform_legacy_relation_alias_observation_id_unique ON platform_legacy_relation_alias (observation_id);
CREATE UNIQUE INDEX platform_observation_archive_ref_archive_id_unique ON platform_observation_archive_ref (archive_id);
CREATE UNIQUE INDEX platform_observation_collection_sequence_uq ON platform_business_observation (collection_id,sequence_no);
CREATE INDEX platform_observation_position_idx ON platform_business_observation (collection_id,page_id,sequence_no);
CREATE INDEX platform_query_title_scope_rdjb_collection_idx ON platform_query_title_scope(rdjb,collection_id);
CREATE INDEX platform_recognized_projection_batch_idx ON platform_recognized_projection (maintenance_batch);
CREATE INDEX platform_recognized_projection_district_idx ON platform_recognized_projection (district);
CREATE UNIQUE INDEX platform_recognized_projection_observation_uq ON platform_recognized_projection (observation_id);
CREATE INDEX platform_recognized_projection_record_idx ON platform_recognized_projection (record_id);
CREATE INDEX platform_recognized_projection_source_archive_idx ON platform_recognized_projection(source_archive_id);
CREATE INDEX platform_recognized_projection_title_version_idx ON platform_recognized_projection (title_raw,version_id);
CREATE INDEX platform_recognized_projection_uscc_idx ON platform_recognized_projection (uscc_raw);
CREATE INDEX platform_recognized_projection_validity_idx ON platform_recognized_projection (validity_date_raw);
CREATE UNIQUE INDEX platform_recognized_projection_version_uq ON platform_recognized_projection (version_id);
CREATE INDEX platform_recognized_projection_year_idx ON platform_recognized_projection (maintenance_year);
CREATE UNIQUE INDEX platform_version_archive_ref_archive_id_unique ON platform_version_archive_ref (archive_id);
CREATE INDEX reconciliation_dir_idx ON reconciliation_result (direction);
CREATE INDEX record_correspondence_audit_edge_idx ON record_correspondence_audit (correspondence_id,id);
CREATE UNIQUE INDEX record_correspondence_edge_uq ON record_correspondence (edge_key);
CREATE INDEX record_correspondence_enterprise_idx ON record_correspondence (enterprise_id,title_code);
CREATE INDEX record_correspondence_event_idx ON record_correspondence (event_id);
CREATE INDEX record_correspondence_export_idx ON record_correspondence (export_row_id);
CREATE INDEX record_correspondence_observation_idx ON record_correspondence (observation_id);
CREATE INDEX record_correspondence_predecessor_idx ON record_correspondence (predecessor_event_id);
CREATE INDEX record_district_idx ON record (district);
CREATE INDEX record_event_record_idx ON record_event (record_id,sort_key,id);
CREATE INDEX record_evidence_coordinate_idx ON record_evidence (source_file COLLATE "C", list_no, attachment);
CREATE INDEX record_evidence_event_idx ON record_evidence (record_event_id);
CREATE UNIQUE INDEX record_identity_uq ON record (enterprise_id,title_code,source);
CREATE INDEX record_source_idx ON record (source);
CREATE INDEX record_title_idx ON record (title_code);
CREATE INDEX roster_file_classification_category_state_idx ON roster_file_classification (category_state);
CREATE INDEX roster_file_classification_parse_state_idx ON roster_file_classification (parse_state);
CREATE INDEX roster_file_classification_source_idx ON roster_file_classification (source);
CREATE UNIQUE INDEX stored_file_part_coordinate_uq
  ON stored_file_part (file_id, title_code, event_kind, year, batch, attachment) NULLS NOT DISTINCT;
CREATE INDEX title_cycle_disposition_scope ON title_cycle_disposition_revision(enterprise_id,title_code,cycle_event_id,id,revision);
CREATE INDEX title_cycle_disposition_source ON title_cycle_disposition_revision(source_file_id,source_sha256);
CREATE INDEX roster_announcement_member_intake_idx ON roster_announcement_member(intake_id, enterprise_id);
CREATE INDEX platform_observation_page_fk_idx ON platform_business_observation(page_id, collection_id) WHERE page_id IS NOT NULL;
CREATE INDEX platform_export_batch_latest_idx ON platform_export_batch(title_code, year DESC, id DESC);
CREATE INDEX source_document_path_idx ON source_document(path, id);

ALTER TABLE comparison_scope_proof_audit
  ADD FOREIGN KEY (proof_id) REFERENCES comparison_scope_proof(id);
ALTER TABLE comparison_scope_proof_audit
  ADD FOREIGN KEY (batch_id) REFERENCES import_batch(id);
ALTER TABLE difference_reason
  ADD FOREIGN KEY (previous_id) REFERENCES difference_reason(id);
ALTER TABLE difference_reason
  ADD FOREIGN KEY (enterprise_id) REFERENCES enterprise(id) ON DELETE CASCADE;
ALTER TABLE difference_reason
  ADD FOREIGN KEY (title_code) REFERENCES title(code);
ALTER TABLE difference_reason
  ADD FOREIGN KEY (evidence_query_id) REFERENCES platform_collection(id);
ALTER TABLE difference_reason
  ADD FOREIGN KEY (evidence_relation_id) REFERENCES platform_business_observation(id);
ALTER TABLE difference_reason
  ADD FOREIGN KEY (moved_in_title_code) REFERENCES title(code);
ALTER TABLE enterprise_difference_comparison
  ADD FOREIGN KEY (enterprise_id) REFERENCES enterprise(id) ON DELETE CASCADE;
ALTER TABLE enterprise_difference_comparison
  ADD FOREIGN KEY (title_code) REFERENCES title(code);
ALTER TABLE enterprise_fact_revision
  ADD FOREIGN KEY (enterprise_id) REFERENCES enterprise(id);
ALTER TABLE event_correction_audit
  ADD FOREIGN KEY (event_id) REFERENCES record_event(id);
ALTER TABLE event_correction_audit
  ADD FOREIGN KEY (batch_id) REFERENCES import_batch(id);
ALTER TABLE evidence_correction_audit
  ADD FOREIGN KEY (evidence_id) REFERENCES record_evidence(id);
ALTER TABLE evidence_correction_audit
  ADD FOREIGN KEY (event_id) REFERENCES record_event(id);
ALTER TABLE evidence_correction_audit
  ADD FOREIGN KEY (batch_key) REFERENCES evidence_correction_batch(idempotency_key);
ALTER TABLE evidence_impact_link_113
  ADD FOREIGN KEY (revision_id) REFERENCES evidence_revision_113(id);
ALTER TABLE evidence_impact_link_113
  ADD FOREIGN KEY (impact_id) REFERENCES explanation_impact_113(id);
ALTER TABLE evidence_impact_progress_113
  ADD FOREIGN KEY (revision_id) REFERENCES evidence_revision_113(id);
ALTER TABLE evidence_revision_event_113
  ADD FOREIGN KEY (revision_id) REFERENCES evidence_revision_113(id);
ALTER TABLE file_declaration_669
  ADD FOREIGN KEY (file_id) REFERENCES stored_file(id);
ALTER TABLE file_parse_audit_105
  ADD FOREIGN KEY (file_id) REFERENCES stored_file(id);
ALTER TABLE import_receipt
  ADD FOREIGN KEY (batch_id) REFERENCES import_batch(id);
ALTER TABLE import_receipt
  ADD FOREIGN KEY (body_receipt_id) REFERENCES import_receipt(id);
ALTER TABLE official_evidence_row_revision
  ADD FOREIGN KEY (evidence_id) REFERENCES record_evidence(id);
ALTER TABLE official_evidence_row_revision
  ADD FOREIGN KEY (event_id) REFERENCES record_event(id);
ALTER TABLE official_evidence_row_revision
  ADD FOREIGN KEY (source_document_id) REFERENCES source_document(id);
ALTER TABLE official_evidence_row_revision
  ADD FOREIGN KEY (stored_file_id) REFERENCES stored_file(id);
ALTER TABLE official_evidence_row_revision
  ADD FOREIGN KEY (import_batch_id) REFERENCES import_batch(id);
ALTER TABLE official_evidence_row_revision
  ADD FOREIGN KEY (correction_batch_key) REFERENCES evidence_correction_batch(idempotency_key);
ALTER TABLE official_evidence_row_revision
  ADD FOREIGN KEY (evidence_id, event_id) REFERENCES record_evidence(id, record_event_id);
ALTER TABLE platform_apply_projection
  ADD FOREIGN KEY (observation_id) REFERENCES platform_business_observation(id) ON DELETE RESTRICT;
ALTER TABLE platform_apply_projection
  ADD FOREIGN KEY (version_id) REFERENCES platform_business_record_version(id) ON DELETE RESTRICT;
ALTER TABLE platform_apply_projection
  ADD FOREIGN KEY (record_id) REFERENCES platform_business_record(id) ON DELETE RESTRICT;
ALTER TABLE platform_apply_projection
  ADD FOREIGN KEY (source_archive_id) REFERENCES platform_archive_value(id) ON DELETE RESTRICT;
ALTER TABLE platform_apply_projection
  ADD FOREIGN KEY (version_id,record_id) REFERENCES platform_business_record_version(id,record_id) ON DELETE RESTRICT;
ALTER TABLE platform_business_observation
  ADD FOREIGN KEY (candidate_scope_archive_id) REFERENCES platform_archive_value(id) ON DELETE RESTRICT;
ALTER TABLE platform_business_observation
  ADD FOREIGN KEY (witness_archive_id) REFERENCES platform_archive_value(id) ON DELETE RESTRICT;
ALTER TABLE platform_business_observation
  ADD FOREIGN KEY (collection_id) REFERENCES platform_collection(id) ON DELETE RESTRICT;
ALTER TABLE platform_business_observation
  ADD FOREIGN KEY (page_id, collection_id) REFERENCES platform_collection_page(id, collection_id) ON DELETE RESTRICT;
ALTER TABLE platform_business_observation
  ADD FOREIGN KEY (record_id) REFERENCES platform_business_record(id) ON DELETE RESTRICT;
ALTER TABLE platform_business_observation
  ADD FOREIGN KEY (batch_id) REFERENCES import_batch(id) ON DELETE RESTRICT;
ALTER TABLE platform_business_observation
  ADD FOREIGN KEY (version_id,record_id) REFERENCES platform_business_record_version(id,record_id) ON DELETE RESTRICT;
ALTER TABLE platform_business_observation
  ADD FOREIGN KEY (apply_exact_owner_id,apply_exact_state,apply_sql_fact_title_state)
        REFERENCES platform_apply_projection(observation_id,exact_stored_state,sql_fact_title_state) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE platform_business_observation
  ADD FOREIGN KEY (process_exact_owner_id,process_exact_state,process_sql_fact_title_state)
        REFERENCES platform_business_projection(observation_id,exact_stored_state,sql_fact_title_state) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE platform_business_projection
  ADD FOREIGN KEY (observation_id) REFERENCES platform_business_observation(id) ON DELETE RESTRICT;
ALTER TABLE platform_business_projection
  ADD FOREIGN KEY (version_id) REFERENCES platform_business_record_version(id) ON DELETE RESTRICT;
ALTER TABLE platform_business_projection
  ADD FOREIGN KEY (record_id) REFERENCES platform_business_record(id) ON DELETE RESTRICT;
ALTER TABLE platform_business_projection
  ADD FOREIGN KEY (source_archive_id) REFERENCES platform_archive_value(id) ON DELETE RESTRICT;
ALTER TABLE platform_business_projection
  ADD FOREIGN KEY (version_id,record_id) REFERENCES platform_business_record_version(id,record_id) ON DELETE RESTRICT;
ALTER TABLE platform_business_record_version
  ADD FOREIGN KEY (record_id) REFERENCES platform_business_record(id) ON DELETE RESTRICT;
ALTER TABLE platform_business_record_version
  ADD FOREIGN KEY (canonical_archive_id) REFERENCES platform_archive_value(id);
ALTER TABLE platform_collection
  ADD FOREIGN KEY (reconcile_slot_raw_archive_id) REFERENCES platform_archive_value(id) ON DELETE RESTRICT;
ALTER TABLE platform_collection
  ADD FOREIGN KEY (witness_archive_id) REFERENCES platform_archive_value(id) ON DELETE RESTRICT;
ALTER TABLE platform_collection
  ADD FOREIGN KEY (title_code) REFERENCES title(code) ON DELETE RESTRICT;
ALTER TABLE platform_collection_archive_ref
  ADD FOREIGN KEY (owner_id) REFERENCES platform_collection(id) ON DELETE RESTRICT;
ALTER TABLE platform_collection_archive_ref
  ADD FOREIGN KEY (archive_id) REFERENCES platform_archive_value(id) ON DELETE RESTRICT;
ALTER TABLE platform_collection_condition
  ADD FOREIGN KEY (collection_id) REFERENCES platform_collection(id) ON DELETE RESTRICT;
ALTER TABLE platform_collection_legacy_provenance
  ADD FOREIGN KEY (collection_id) REFERENCES platform_collection(id) ON DELETE RESTRICT;
ALTER TABLE platform_collection_legacy_provenance
  ADD FOREIGN KEY (import_batch_id) REFERENCES import_batch(id) ON DELETE RESTRICT;
ALTER TABLE platform_collection_legacy_provenance
  ADD FOREIGN KEY (archive_id) REFERENCES platform_archive_value(id) ON DELETE RESTRICT;
ALTER TABLE platform_collection_page
  ADD FOREIGN KEY (collection_id) REFERENCES platform_collection(id) ON DELETE RESTRICT;
ALTER TABLE platform_collection_unfinished
  ADD FOREIGN KEY (collection_id) REFERENCES platform_collection(id) ON DELETE RESTRICT;
ALTER TABLE platform_export_batch
  ADD FOREIGN KEY (title_code) REFERENCES title(code);
ALTER TABLE platform_export_batch
  ADD FOREIGN KEY (source_document_id) REFERENCES source_document(id);
ALTER TABLE platform_export_batch
  ADD FOREIGN KEY (import_batch_id) REFERENCES import_batch(id);
ALTER TABLE platform_export_batch
  ADD FOREIGN KEY (replaced_batch_id) REFERENCES platform_export_batch(id);
ALTER TABLE platform_export_row
  ADD FOREIGN KEY (batch_id) REFERENCES platform_export_batch(id) ON DELETE CASCADE;
ALTER TABLE platform_legacy_query_alias
  ADD FOREIGN KEY (collection_id) REFERENCES platform_collection(id) ON DELETE RESTRICT;
ALTER TABLE platform_legacy_relation_alias
  ADD FOREIGN KEY (observation_id) REFERENCES platform_business_observation(id) ON DELETE RESTRICT;
ALTER TABLE platform_migration_checkpoint
  ADD FOREIGN KEY (run_id) REFERENCES platform_migration_run(run_id) ON DELETE RESTRICT;
ALTER TABLE platform_observation_archive_ref
  ADD FOREIGN KEY (owner_id) REFERENCES platform_business_observation(id) ON DELETE RESTRICT;
ALTER TABLE platform_observation_archive_ref
  ADD FOREIGN KEY (archive_id) REFERENCES platform_archive_value(id) ON DELETE RESTRICT;
ALTER TABLE platform_observation_assignment
  ADD FOREIGN KEY (observation_id) REFERENCES platform_business_observation(id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE platform_observation_assignment
  ADD FOREIGN KEY (enterprise_id) REFERENCES enterprise(id) ON DELETE RESTRICT;
ALTER TABLE platform_observation_fingerprint_basis
  ADD FOREIGN KEY (input_archive_id) REFERENCES platform_archive_value(id) ON DELETE RESTRICT;
ALTER TABLE platform_observation_fingerprint_basis
  ADD FOREIGN KEY (observation_id) REFERENCES platform_business_observation(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE platform_query_title_scope
  ADD FOREIGN KEY (collection_id) REFERENCES platform_collection(id) ON DELETE RESTRICT;
ALTER TABLE platform_query_title_scope_error
  ADD FOREIGN KEY (collection_id) REFERENCES platform_collection(id) ON DELETE RESTRICT;
ALTER TABLE platform_recognized_projection
  ADD FOREIGN KEY (exact_title_archive_id) REFERENCES platform_archive_value(id) ON DELETE RESTRICT;
ALTER TABLE platform_recognized_projection
  ADD FOREIGN KEY (observation_id) REFERENCES platform_business_observation(id) ON DELETE RESTRICT;
ALTER TABLE platform_recognized_projection
  ADD FOREIGN KEY (version_id) REFERENCES platform_business_record_version(id) ON DELETE RESTRICT;
ALTER TABLE platform_recognized_projection
  ADD FOREIGN KEY (record_id) REFERENCES platform_business_record(id) ON DELETE RESTRICT;
ALTER TABLE platform_recognized_projection
  ADD FOREIGN KEY (source_archive_id) REFERENCES platform_archive_value(id) ON DELETE RESTRICT;
ALTER TABLE platform_recognized_projection
  ADD FOREIGN KEY (version_id,record_id) REFERENCES platform_business_record_version(id,record_id) ON DELETE RESTRICT;
ALTER TABLE platform_version_archive_ref
  ADD FOREIGN KEY (owner_id) REFERENCES platform_business_record_version(id) ON DELETE RESTRICT;
ALTER TABLE platform_version_archive_ref
  ADD FOREIGN KEY (archive_id) REFERENCES platform_archive_value(id) ON DELETE RESTRICT;
ALTER TABLE reconciliation_result
  ADD FOREIGN KEY (title_code) REFERENCES title(code);
ALTER TABLE reconciliation_result
  ADD FOREIGN KEY (enterprise_id) REFERENCES enterprise(id);
ALTER TABLE record
  ADD FOREIGN KEY (enterprise_id) REFERENCES enterprise(id);
ALTER TABLE record
  ADD FOREIGN KEY (title_code) REFERENCES title(code);
ALTER TABLE record_correspondence
  ADD FOREIGN KEY (event_id) REFERENCES record_event(id);
ALTER TABLE record_correspondence
  ADD FOREIGN KEY (predecessor_event_id) REFERENCES record_event(id);
ALTER TABLE record_correspondence
  ADD FOREIGN KEY (observation_id) REFERENCES platform_business_observation(id);
ALTER TABLE record_correspondence
  ADD FOREIGN KEY (export_row_id) REFERENCES platform_export_row(id);
ALTER TABLE record_correspondence
  ADD FOREIGN KEY (enterprise_id) REFERENCES enterprise(id);
ALTER TABLE record_correspondence
  ADD FOREIGN KEY (title_code) REFERENCES title(code);
ALTER TABLE record_correspondence_audit
  ADD FOREIGN KEY (correspondence_id) REFERENCES record_correspondence(id);
ALTER TABLE record_correspondence_audit
  ADD FOREIGN KEY (batch_id) REFERENCES import_batch(id);
ALTER TABLE record_event
  ADD FOREIGN KEY (record_id) REFERENCES record(id) ON DELETE CASCADE;
ALTER TABLE record_evidence
  ADD FOREIGN KEY (record_event_id) REFERENCES record_event(id) ON DELETE CASCADE;
ALTER TABLE roster_file_classification
  ADD FOREIGN KEY (file_id) REFERENCES stored_file(id) ON DELETE CASCADE;
ALTER TABLE roster_file_classification
  ADD FOREIGN KEY (title_code) REFERENCES title(code);
ALTER TABLE stored_file_part
  ADD FOREIGN KEY (file_id) REFERENCES stored_file(id) ON DELETE CASCADE;
ALTER TABLE stored_file_part
  ADD FOREIGN KEY (title_code) REFERENCES title(code);
ALTER TABLE title_cycle_disposition_revision
  ADD FOREIGN KEY (enterprise_id) REFERENCES enterprise(id);
ALTER TABLE title_cycle_disposition_revision
  ADD FOREIGN KEY (cycle_event_id) REFERENCES record_event(id);
ALTER TABLE title_cycle_disposition_revision
  ADD FOREIGN KEY (source_file_id) REFERENCES stored_file(id);
ALTER TABLE roster_legacy_member
  ADD FOREIGN KEY (enterprise_id) REFERENCES enterprise(id) ON DELETE CASCADE;
ALTER TABLE roster_announcement_member
  ADD FOREIGN KEY (enterprise_id) REFERENCES enterprise(id) ON DELETE CASCADE;
ALTER TABLE roster_announcement_member
  ADD FOREIGN KEY (intake_id) REFERENCES roster_announcement_intake(id);
