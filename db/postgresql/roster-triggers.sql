CREATE FUNCTION reject_roster_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER platform_assignment_append_only BEFORE UPDATE OR DELETE ON platform_observation_assignment
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();
\ir platform-public-id-triggers.sql
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

\ir platform-projection-owner.sql

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

\ir platform-collection-scope-integrity.sql

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

\ir platform-recognized-title-trigger.sql
