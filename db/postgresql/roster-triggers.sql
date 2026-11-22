CREATE FUNCTION reject_roster_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER platform_archive_append_only BEFORE UPDATE OR DELETE ON platform_archive_value
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER platform_assignment_append_only BEFORE UPDATE OR DELETE ON platform_observation_assignment
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER platform_provenance_append_only BEFORE UPDATE OR DELETE ON platform_collection_legacy_provenance
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER platform_fingerprint_append_only BEFORE UPDATE OR DELETE ON platform_observation_fingerprint_basis
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER platform_query_alias_append_only BEFORE UPDATE OR DELETE ON platform_legacy_query_alias
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER platform_relation_alias_append_only BEFORE UPDATE OR DELETE ON platform_legacy_relation_alias
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER platform_process_projection_append_only BEFORE UPDATE OR DELETE ON platform_business_projection
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER platform_apply_projection_append_only BEFORE UPDATE OR DELETE ON platform_apply_projection
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER official_evidence_revision_append_only BEFORE UPDATE OR DELETE ON official_evidence_row_revision
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER event_correction_append_only BEFORE UPDATE OR DELETE ON event_correction_audit
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER evidence_correction_append_only BEFORE UPDATE OR DELETE ON evidence_correction_audit
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER roster_file_parse_append_only BEFORE UPDATE OR DELETE ON file_parse_audit_105
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER correspondence_audit_append_only BEFORE UPDATE OR DELETE ON record_correspondence_audit
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();

CREATE FUNCTION guard_platform_archive_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE owner_sealed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Archive binding is append-only' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  EXECUTE format('SELECT 1 FROM %I WHERE id = $1 FOR NO KEY UPDATE', TG_ARGV[0]) USING NEW.owner_id;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.sealed <> 0 OR NEW.sealed <> 1 OR (NEW.owner_id, NEW.field, NEW.archive_id)
        IS DISTINCT FROM (OLD.owner_id, OLD.field, OLD.archive_id) THEN
      RAISE EXCEPTION 'Archive binding permits only sealing' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE owner_id = $1 AND sealed = 1)', TG_TABLE_NAME)
      INTO STRICT owner_sealed USING NEW.owner_id;
    IF owner_sealed THEN
      RAISE EXCEPTION 'Archive owner is sealed' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_collection_archive_binding
  BEFORE INSERT OR UPDATE OR DELETE ON platform_collection_archive_ref
  FOR EACH ROW EXECUTE FUNCTION guard_platform_archive_binding('platform_collection');
CREATE TRIGGER platform_observation_archive_binding
  BEFORE INSERT OR UPDATE OR DELETE ON platform_observation_archive_ref
  FOR EACH ROW EXECUTE FUNCTION guard_platform_archive_binding('platform_business_observation');
CREATE TRIGGER platform_version_archive_binding
  BEFORE INSERT OR UPDATE OR DELETE ON platform_version_archive_ref
  FOR EACH ROW EXECUTE FUNCTION guard_platform_archive_binding('platform_business_record_version');

\ir platform-canonical-archive-triggers.sql
\ir platform-observation-snapshot.sql

CREATE FUNCTION guard_platform_projection_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.record_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM platform_business_record WHERE id = NEW.record_id AND interface = TG_ARGV[0]
    )) OR (NEW.observation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM platform_business_observation o JOIN platform_collection c ON c.id = o.collection_id
      WHERE o.id = NEW.observation_id AND c.interface = TG_ARGV[0]
    )) OR (NEW.source_archive_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM platform_observation_archive_ref
      WHERE owner_id = NEW.observation_id AND archive_id = NEW.source_archive_id
        AND field = 'rawFields' AND sealed = 1
    )) THEN
    RAISE EXCEPTION 'Projection source or archive owner mismatch' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_apply_projection_owner BEFORE INSERT ON platform_apply_projection
  FOR EACH ROW EXECUTE FUNCTION guard_platform_projection_owner('apply_list');
CREATE TRIGGER platform_process_projection_owner BEFORE INSERT ON platform_business_projection
  FOR EACH ROW EXECUTE FUNCTION guard_platform_projection_owner('business_list');
CREATE TRIGGER platform_recognized_projection_owner BEFORE INSERT OR UPDATE ON platform_recognized_projection
  FOR EACH ROW EXECUTE FUNCTION guard_platform_projection_owner('recognized_list');

CREATE TRIGGER platform_collection_interface_fixed BEFORE UPDATE OF interface ON platform_collection
  FOR EACH ROW WHEN (NEW.interface IS DISTINCT FROM OLD.interface)
  EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER platform_record_interface_fixed BEFORE UPDATE OF interface ON platform_business_record
  FOR EACH ROW WHEN (NEW.interface IS DISTINCT FROM OLD.interface)
  EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER platform_observation_collection_fixed BEFORE UPDATE OF collection_id ON platform_business_observation
  FOR EACH ROW WHEN (NEW.collection_id IS DISTINCT FROM OLD.collection_id)
  EXECUTE FUNCTION reject_roster_history_mutation();

CREATE FUNCTION follow_roster_membership_merge() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO roster_legacy_member(enterprise_id)
    SELECT NEW.into_enterprise_id FROM roster_legacy_member
    WHERE enterprise_id = NEW.from_enterprise_id
    ON CONFLICT DO NOTHING;
  INSERT INTO roster_announcement_member(enterprise_id, intake_id)
    SELECT NEW.into_enterprise_id, intake_id FROM roster_announcement_member
    WHERE enterprise_id = NEW.from_enterprise_id
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER roster_membership_follow_merge AFTER INSERT ON enterprise_merge
  FOR EACH ROW EXECUTE FUNCTION follow_roster_membership_merge();

CREATE FUNCTION guard_platform_assignment_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE previous_revision bigint;
BEGIN
  SELECT revision INTO previous_revision FROM platform_observation_assignment
  WHERE observation_id = NEW.observation_id
  ORDER BY revision DESC LIMIT 1;
  IF NEW.revision <> coalesce(previous_revision, 0) + 1 THEN
    RAISE EXCEPTION 'Assignment revision must append' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_assignment_revision BEFORE INSERT ON platform_observation_assignment
  FOR EACH ROW EXECUTE FUNCTION guard_platform_assignment_revision();

CREATE FUNCTION guard_platform_observation_source() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE source_interface text;
BEGIN
  SELECT interface INTO STRICT source_interface FROM platform_collection WHERE id = NEW.collection_id;
  IF NEW.record_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM platform_business_record WHERE id = NEW.record_id AND interface = source_interface
  ) THEN
    RAISE EXCEPTION 'Observation and record interface disagree' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF ((source_interface = 'apply_list') IS DISTINCT FROM
        (NEW.apply_exact_owner_id IS NOT NULL AND NEW.apply_exact_state = 'captured'
          AND NEW.apply_sql_fact_title_state = 'captured'))
      OR ((source_interface = 'business_list') IS DISTINCT FROM
        (NEW.process_exact_owner_id IS NOT NULL AND NEW.process_exact_state = 'captured'
          AND NEW.process_sql_fact_title_state = 'captured')) THEN
      RAISE EXCEPTION 'Observation requires its source-specific stored projection'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_observation_source
  BEFORE INSERT OR UPDATE OF record_id ON platform_business_observation
  FOR EACH ROW EXECUTE FUNCTION guard_platform_observation_source();

CREATE TRIGGER platform_condition_witness_fixed BEFORE UPDATE ON platform_collection_condition
  FOR EACH ROW WHEN (OLD.witness_kind IS NOT NULL
    AND (NEW.collection_id, NEW.name, NEW.witness_kind, NEW.witness_value, NEW.witness_value_sqlite_storage)
      IS DISTINCT FROM
        (OLD.collection_id, OLD.name, OLD.witness_kind, OLD.witness_value, OLD.witness_value_sqlite_storage))
  EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER platform_condition_witness_retained BEFORE DELETE ON platform_collection_condition
  FOR EACH ROW WHEN (OLD.witness_kind IS NOT NULL)
  EXECUTE FUNCTION reject_roster_history_mutation();

CREATE TRIGGER platform_collection_witness_fixed BEFORE UPDATE ON platform_collection
  FOR EACH ROW WHEN (OLD.witness_rule IS NOT NULL
    AND (NEW.witness_gate, NEW.witness_rule, NEW.witness_archive_id, NEW.witness_sha256,
      NEW.witness_error_name, NEW.witness_error, NEW.witness_state)
      IS DISTINCT FROM
        (OLD.witness_gate, OLD.witness_rule, OLD.witness_archive_id, OLD.witness_sha256,
          OLD.witness_error_name, OLD.witness_error, OLD.witness_state))
  EXECUTE FUNCTION reject_roster_history_mutation();

CREATE TRIGGER platform_observation_witness_fixed BEFORE UPDATE ON platform_business_observation
  FOR EACH ROW WHEN (OLD.witness_rule IS NOT NULL
    AND (NEW.id, NEW.collection_id, NEW.sequence_no, NEW.witness_rule, NEW.witness_collection_id,
      NEW.witness_sequence_no, NEW.witness_archive_id, NEW.witness_sha256, NEW.witness_ordinal,
      NEW.witness_rdjb_kind, NEW.witness_rdjb_value, NEW.witness_rdjb_value_sqlite_storage, NEW.witness_rdjb_key,
      NEW.witness_page_kind, NEW.witness_page_value, NEW.witness_page_value_sqlite_storage,
      NEW.witness_error_name, NEW.witness_error, NEW.witness_state)
      IS DISTINCT FROM
        (OLD.id, OLD.collection_id, OLD.sequence_no, OLD.witness_rule, OLD.witness_collection_id,
          OLD.witness_sequence_no, OLD.witness_archive_id, OLD.witness_sha256, OLD.witness_ordinal,
          OLD.witness_rdjb_kind, OLD.witness_rdjb_value, OLD.witness_rdjb_value_sqlite_storage, OLD.witness_rdjb_key,
          OLD.witness_page_kind, OLD.witness_page_value, OLD.witness_page_value_sqlite_storage,
          OLD.witness_error_name, OLD.witness_error, OLD.witness_state))
  EXECUTE FUNCTION reject_roster_history_mutation();

CREATE TRIGGER platform_recognized_exact_title_fixed BEFORE UPDATE ON platform_recognized_projection
  FOR EACH ROW WHEN (
    (NEW.exact_title_raw, NEW.exact_title_raw_sqlite_storage, NEW.exact_title_state, NEW.exact_title_origin,
      NEW.exact_title_archive_id, NEW.exact_title_sha256)
    IS DISTINCT FROM
      (OLD.exact_title_raw, OLD.exact_title_raw_sqlite_storage, OLD.exact_title_state, OLD.exact_title_origin,
        OLD.exact_title_archive_id, OLD.exact_title_sha256))
  EXECUTE FUNCTION reject_roster_history_mutation();

CREATE TRIGGER platform_alias_counter_monotone BEFORE UPDATE ON platform_legacy_alias_sequence
  FOR EACH ROW WHEN (NEW.namespace IS DISTINCT FROM OLD.namespace OR NEW.high_water < OLD.high_water)
  EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER platform_alias_counter_retained BEFORE DELETE ON platform_legacy_alias_sequence
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();
