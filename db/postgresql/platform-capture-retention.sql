CREATE OR REPLACE TRIGGER platform_assignment_append_only
  BEFORE UPDATE ON platform_observation_assignment
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();

CREATE OR REPLACE TRIGGER platform_process_projection_append_only
  BEFORE UPDATE ON platform_business_projection
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();

CREATE OR REPLACE TRIGGER platform_apply_projection_append_only
  BEFORE UPDATE ON platform_apply_projection
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();

DROP TRIGGER IF EXISTS platform_observation_public_id_retained ON platform_business_observation;

CREATE OR REPLACE FUNCTION prune_platform_captures(
  selected_records bigint[], keep_previous boolean
) RETURNS integer LANGUAGE plpgsql SET search_path = business, pg_catalog AS $$
DECLARE
  expired bigint[];
  affected_versions bigint[];
BEGIN
  PERFORM pg_advisory_xact_lock(21785, 0);
  WITH ranked AS (
    SELECT o.id, o.version_id,
      dense_rank() OVER (
        PARTITION BY o.record_id
        ORDER BY coalesce(c.last_collected_at, c.queried_at) COLLATE "C" DESC, c.public_id DESC
      ) AS position
    FROM platform_business_observation o
    JOIN platform_collection c ON c.id = o.collection_id
    WHERE o.record_id IS NOT NULL
      AND o.content_state = 'verified' AND o.version_id IS NOT NULL
      AND (selected_records IS NULL OR o.record_id = ANY(selected_records))
  )
  SELECT array_agg(id), array_agg(DISTINCT version_id)
    INTO expired, affected_versions
  FROM ranked WHERE position > CASE WHEN keep_previous THEN 2 ELSE 1 END;

  IF expired IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE difference_reason
     SET evidence_relation_id = NULL, evidence_query_id = NULL,
         retired_evidence_validity = 'evidence_changed'
   WHERE evidence_relation_id = ANY(expired);

  UPDATE record_correspondence SET observation_id = NULL WHERE observation_id = ANY(expired);

  DELETE FROM platform_observation_assignment WHERE observation_id = ANY(expired);
  DELETE FROM platform_business_observation WHERE id = ANY(expired);

  SELECT array_agg(candidate.version_id) INTO affected_versions
    FROM unnest(affected_versions) AS candidate(version_id)
   WHERE NOT EXISTS (
     SELECT 1 FROM platform_business_observation o WHERE o.version_id = candidate.version_id
   );

  DELETE FROM platform_apply_projection WHERE version_id = ANY(affected_versions);
  DELETE FROM platform_business_projection WHERE version_id = ANY(affected_versions);
  DELETE FROM platform_recognized_projection WHERE version_id = ANY(affected_versions);
  DELETE FROM platform_business_record_version WHERE id = ANY(affected_versions);

  RETURN cardinality(expired);
END;
$$;
