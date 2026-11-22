ALTER TABLE platform_apply_projection
  ADD CONSTRAINT platform_apply_projection_capture_ck CHECK (
    CASE WHEN observation_id IS NULL THEN num_nonnulls(
      source_title_kind, source_title_text, source_title_number_text, source_title_boolean,
      source_title_rule_version, parse_state, stored_province, parsed_province, reconciled_province,
      province_conflict, stored_status, parsed_status, reconciled_status, status_conflict, stored_batch,
      parsed_batch, reconciled_batch, batch_conflict, stored_declare_kind, parsed_declare_kind,
      reconciled_declare_kind, declare_kind_conflict, stored_applied_at, parsed_applied_at,
      reconciled_applied_at, applied_at_conflict, stored_award_batch_label, parsed_award_batch_label,
      reconciled_award_batch_label, award_batch_label_conflict, stored_year, parsed_year, reconciled_year,
      year_conflict
    ) = 0 ELSE num_nulls(
      source_title_kind, source_title_rule_version, parse_state, province_conflict, status_conflict,
      batch_conflict, declare_kind_conflict, applied_at_conflict, award_batch_label_conflict, year_conflict
    ) = 0 END
  );

ALTER TABLE platform_business_projection
  ADD CONSTRAINT platform_business_projection_capture_ck CHECK (
    CASE WHEN observation_id IS NULL THEN num_nonnulls(
      source_title_kind, source_title_text, source_title_number_text, source_title_boolean,
      source_title_rule_version, parse_state, stored_province, parsed_province, reconciled_province,
      province_conflict, stored_status, parsed_status, reconciled_status, status_conflict, stored_batch,
      parsed_batch, reconciled_batch, batch_conflict, stored_declare_kind, parsed_declare_kind,
      reconciled_declare_kind, declare_kind_conflict, stored_applied_at, parsed_applied_at,
      reconciled_applied_at, applied_at_conflict, stored_award_batch_label, parsed_award_batch_label,
      reconciled_award_batch_label, award_batch_label_conflict, stored_year, parsed_year, reconciled_year,
      year_conflict
    ) = 0 ELSE num_nulls(
      source_title_kind, source_title_rule_version, parse_state, province_conflict, status_conflict,
      batch_conflict, declare_kind_conflict, applied_at_conflict, award_batch_label_conflict, year_conflict
    ) = 0 END
  );

ALTER TABLE platform_recognized_projection
  ADD CONSTRAINT platform_recognized_projection_capture_ck CHECK (
    CASE WHEN observation_id IS NULL THEN num_nonnulls(
      source_title_kind, source_title_text, source_title_number_text, source_title_boolean,
      source_title_rule_version, parse_state, stored_province, parsed_province, reconciled_province,
      province_conflict, stored_status, parsed_status, reconciled_status, status_conflict, stored_batch,
      parsed_batch, reconciled_batch, batch_conflict, stored_declare_kind, parsed_declare_kind,
      reconciled_declare_kind, declare_kind_conflict, stored_applied_at, parsed_applied_at,
      reconciled_applied_at, applied_at_conflict, stored_award_batch_label, parsed_award_batch_label,
      reconciled_award_batch_label, award_batch_label_conflict, stored_year, parsed_year, reconciled_year,
      year_conflict
    ) = 0 ELSE num_nulls(
      source_title_kind, source_title_rule_version, parse_state, province_conflict, status_conflict,
      batch_conflict, declare_kind_conflict, applied_at_conflict, award_batch_label_conflict, year_conflict
    ) = 0 END
  );

ALTER TABLE platform_business_projection
  ADD CONSTRAINT platform_business_projection_stored_status_ck
    CHECK (stored_status_sqlite_storage IN ('null','text','blob'));

ALTER TABLE platform_recognized_projection
  ADD CONSTRAINT platform_recognized_projection_no_process_parse_ck CHECK (
    observation_id IS NULL OR num_nonnulls(parsed_province, parsed_status, parsed_batch,
      parsed_declare_kind, parsed_applied_at, parsed_award_batch_label, parsed_year) = 0
  );
