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

ALTER TABLE record_correspondence ADD COLUMN IF NOT EXISTS platform_evidence_rebound_revision bigint;
ALTER TABLE difference_reason
  ADD COLUMN IF NOT EXISTS original_evidence_relation_public_id bigint,
  ADD COLUMN IF NOT EXISTS original_evidence_query_public_id bigint;

CREATE OR REPLACE FUNCTION prune_platform_captures(
  selected_records bigint[], keep_previous boolean
) RETURNS integer LANGUAGE plpgsql SET search_path = business, pg_catalog AS $$
DECLARE
  superseded bigint[];
  expired bigint[];
  affected_versions bigint[];
BEGIN
  PERFORM pg_advisory_xact_lock(21785, 0);
  WITH captures AS MATERIALIZED (
    SELECT o.id, o.record_id, o.version_id, o.collection_id,
      coalesce(c.last_collected_at, c.queried_at) COLLATE "C" AS collected_at,
      c.public_id AS collection_public_id
    FROM platform_business_observation o
    JOIN platform_collection c ON c.id = o.collection_id
    WHERE o.record_id IS NOT NULL
      AND o.content_state = 'verified' AND o.version_id IS NOT NULL
      AND (selected_records IS NULL OR o.record_id = ANY(selected_records))
  ), rounds AS (
    SELECT record_id, collection_id, collection_public_id, collected_at,
      array_agg(DISTINCT version_id ORDER BY version_id) AS versions
    FROM captures GROUP BY record_id, collection_id, collection_public_id, collected_at
  ), chronological_rounds AS MATERIALIZED (
    SELECT *, row_number() OVER (
      PARTITION BY record_id ORDER BY collected_at DESC, collection_public_id DESC
    ) AS recency FROM rounds
  ), newest_per_content AS (
    SELECT DISTINCT ON (record_id, versions) *
    FROM chronological_rounds
    ORDER BY record_id, versions, recency
  ), kept AS (
    SELECT record_id, collection_id, row_number() OVER (
      PARTITION BY record_id ORDER BY recency
    ) AS position FROM newest_per_content
  ), old_captures AS MATERIALIZED (
    SELECT c.*, r.recency, k.position IS NULL OR k.position > CASE WHEN keep_previous THEN 2 ELSE 1 END AS expired
    FROM captures c
    JOIN chronological_rounds r USING (record_id, collection_id)
    LEFT JOIN kept k USING (record_id, collection_id)
    WHERE r.recency > 1
  ), referenced_observations AS (
    SELECT o.id, o.record_id
    FROM old_captures o JOIN record_correspondence e ON e.observation_id = o.id
    UNION
    SELECT o.id, o.record_id
    FROM old_captures o JOIN difference_reason d ON d.evidence_relation_id = o.id
  ), referenced_records AS (
    SELECT DISTINCT record_id FROM referenced_observations
  ), title_codes(rdjb, code) AS (
    VALUES ('1', 'innovative_sme'), ('2', 'specialized_sme'), ('3', 'little_giant')
  ), evidence_rows AS MATERIALIZED (
    SELECT o.id, o.public_id, o.sequence_no, r.record_id, o.version_id, r.recency, c.id AS collection_id,
      c.public_id AS collection_public_id, c.interface, c.query_key, c.rdjb, c.queried_at,
      owner.enterprise_id, owner.verification_status, owner.revision AS assignment_revision,
      CASE WHEN owner.verification_status = 'confirmed' THEN 2 ELSE 0 END
        + CASE WHEN owner.match_basis <> 'none' THEN 1 ELSE 0 END AS ownership_strength,
      coalesce(page_title.code, c.title_code, scope_title.code, row_title.code) AS effective_title,
      CASE WHEN c.status IN ('success', 'partial')
        AND o.source_values IS NOT NULL
        AND owner.revision IS NOT NULL AND original.revision IS NOT NULL
        AND NOT page.ambiguous
        AND (page_title.code IS NULL OR c.rdjb = '' OR page.rdjb = ANY(string_to_array(c.rdjb, ',')))
        AND (c.title_code IS NULL OR (
          (page_title.code IS NULL OR page_title.code = c.title_code)
          AND (scope_title.code IS NULL OR scope_title.code = c.title_code)
        ))
        THEN jsonb_build_array(
          c.interface, c.query_key,
          -- Positive row evidence depends on material filters, independent of
          -- pagination, ordering, and identity fields already expressed in the query key.
          coalesce(c.condition_facts->'values', '{}'::jsonb) - ARRAY['orderField', 'orderDirection']
            - CASE WHEN c.condition_facts #>> '{values,combination,value}' = 'and' THEN ARRAY['combination'] ELSE ARRAY[]::text[] END
            - CASE WHEN c.condition_facts #>> '{values,uscc,value}' = c.query_key THEN ARRAY['uscc'] ELSE ARRAY[]::text[] END
            - CASE WHEN 'name:' || (c.condition_facts #>> '{values,name,value}') = c.query_key THEN ARRAY['name'] ELSE ARRAY[]::text[] END,
          o.source_relation_key, owner.enterprise_id, original.uscc_raw, original.name_raw, original.alias_name_raw,
          coalesce(nullif(o.source_values->'titleRaw', 'null'), to_jsonb(coalesce(a.title_raw, b.title_raw, recognized.title_raw))),
          coalesce(nullif(o.source_values->'status', 'null'), to_jsonb(coalesce(a.status, b.status))),
          CASE jsonb_typeof(process.declare_kind) WHEN 'string' THEN
            to_jsonb(CASE btrim(process.declare_kind #>> '{}')
              WHEN '申请' THEN 'apply' WHEN '更新' THEN 'update' WHEN '复核' THEN 'review'
              ELSE btrim(process.declare_kind #>> '{}') END)
            ELSE process.declare_kind END,
          coalesce(nullif(o.source_values->'appliedAt', 'null'), to_jsonb(coalesce(a.applied_at, b.applied_at))),
          coalesce(nullif(o.source_values->'year', 'null'), to_jsonb(coalesce(a.declaration_year, b.business_year))),
          coalesce(nullif(o.source_values->'batch', 'null'), to_jsonb(b.batch)),
          coalesce(nullif(o.source_values->'awardBatchLabel', 'null'), to_jsonb(b.award_batch_label)),
          coalesce(nullif(o.source_values->'province', 'null'), to_jsonb(b.province))
        ) END AS evidence
    FROM captures capture
    JOIN referenced_records USING (record_id)
    JOIN chronological_rounds r USING (record_id, collection_id)
    JOIN platform_business_observation o ON o.id = capture.id
    JOIN platform_collection c ON c.id = r.collection_id
    JOIN platform_business_record_version v ON v.id = o.version_id
    LEFT JOIN platform_apply_projection a ON a.version_id = v.id
    LEFT JOIN platform_business_projection b ON b.version_id = v.id
    LEFT JOIN platform_recognized_projection recognized ON recognized.version_id = v.id
    CROSS JOIN LATERAL (
      SELECT coalesce(nullif(o.source_values->'declareKind', 'null'), to_jsonb(coalesce(a.declare_kind, b.declare_kind))) AS declare_kind
    ) process
    LEFT JOIN platform_observation_assignment original ON original.observation_id = o.id AND original.revision = 1
    LEFT JOIN LATERAL (
      SELECT a.revision, a.enterprise_id, a.match_basis, a.verification_status
      FROM platform_observation_assignment a WHERE a.observation_id = o.id
      ORDER BY a.revision DESC LIMIT 1
    ) owner ON true
    LEFT JOIN LATERAL (
      SELECT min(p.rdjb) AS rdjb, count(DISTINCT p.rdjb) > 1 AS ambiguous
      FROM platform_collection_page p WHERE p.collection_id = c.id AND p.status = 'success'
        AND (p.id = o.page_id OR (o.page_id IS NULL AND o.sequence_no BETWEEN p.sequence_start AND p.sequence_end))
    ) page ON true
    LEFT JOIN title_codes page_title ON page_title.rdjb = page.rdjb
    LEFT JOIN title_codes scope_title ON scope_title.rdjb = c.rdjb
    LEFT JOIN title_codes row_title ON row_title.rdjb = v.business_fields->>'rdjb'
      AND (c.rdjb = '' OR row_title.rdjb = ANY(string_to_array(c.rdjb, ',')))
  ), equivalent_round_rows AS (
    -- Repeated copies of the same semantic row have one canonical destination.
    -- Competing ownership or business attribution within the same title admits none.
    SELECT record_id, min(version_id) AS version_id, recency, effective_title,
      (array_agg(id ORDER BY ownership_strength DESC, public_id DESC))[1] AS observation_id
    FROM evidence_rows
    WHERE effective_title IS NOT NULL
    GROUP BY record_id, recency, effective_title
    HAVING count(DISTINCT version_id) = 1 AND count(evidence) = count(*) AND count(DISTINCT evidence) = 1
  ), round_timeline AS (
    SELECT r.*, observed.evidence, observed.ownership_strength,
      lag(observed.assignment_revision) OVER title_rounds AS newer_assignment_revision,
      lag(r.recency) OVER title_rounds AS newer_recency,
      lag(r.version_id) OVER title_rounds AS newer_version_id,
      lag(observed.evidence) OVER title_rounds AS newer_evidence,
      lag(observed.ownership_strength) OVER title_rounds AS newer_strength
    FROM equivalent_round_rows r JOIN evidence_rows observed ON observed.id = r.observation_id
    WINDOW title_rounds AS (PARTITION BY r.record_id, r.effective_title ORDER BY r.recency)
  ), uninterrupted_rounds AS (
    -- An intervening change or missing title severs the approval chain.
    SELECT *, bool_and(recency = 1 OR coalesce(
      newer_recency = recency - 1 AND newer_version_id = version_id
        AND newer_evidence = evidence
        AND (ownership_strength <= newer_strength OR (newer_recency > 1 AND newer_assignment_revision = 1)), false
    )) OVER (PARTITION BY record_id, effective_title ORDER BY recency ROWS UNBOUNDED PRECEDING) AS uninterrupted
    FROM round_timeline
  ), replacements AS MATERIALIZED (
    SELECT old.id AS old_id, old.recency, old.collection_id AS old_collection_id,
      old.public_id AS old_public_id, old.collection_public_id AS old_collection_public_id,
      live.id, live.public_id, live.sequence_no, live.collection_id,
      live.collection_public_id, live.interface, live.query_key, live.rdjb, live.queried_at, live.effective_title,
      live.enterprise_id, live.verification_status, live.assignment_revision
    FROM referenced_observations refs
    JOIN evidence_rows old ON old.id = refs.id
    JOIN uninterrupted_rounds source ON source.record_id = old.record_id AND source.recency = old.recency
      AND source.effective_title = old.effective_title AND source.ownership_strength = old.ownership_strength
      AND source.uninterrupted
    JOIN equivalent_round_rows target ON target.record_id = old.record_id AND target.version_id = old.version_id
      AND target.effective_title = old.effective_title AND target.recency = 1
    JOIN evidence_rows live ON live.id = target.observation_id AND live.evidence = old.evidence
  ), edge_destinations AS (
    SELECT e.id AS edge_id, e.status, r.*,
      -- These compact JSON arrays match the JavaScript correspondenceEdgeKey input.
      encode(sha256(convert_to(CASE e.type
        WHEN 'later_process' THEN format('[%s,%s,%s,%s,%s,%s]',
          to_json(e.type), e.enterprise_id, to_json(e.title_code), coalesce(e.predecessor_event_id::text, 'null'),
          r.public_id, to_json(e.role))
        WHEN 'event_process' THEN format('[%s,%s,%s,%s]', to_json(e.type), e.event_id, r.public_id, to_json(e.role))
        WHEN 'event_recognized' THEN format('[%s,%s,%s,%s]', to_json(e.type), e.event_id, r.public_id, to_json(e.role))
        WHEN 'process_export_context' THEN format('[%s,%s,%s,%s]', to_json(e.type), r.public_id, e.export_row_id, to_json(e.role))
        WHEN 'recognized_export' THEN format('[%s,%s,%s,%s]', to_json(e.type), r.public_id, e.export_row_id, to_json(e.role))
      END, 'UTF8')), 'hex') AS destination_key
    FROM record_correspondence e
    JOIN replacements r ON e.observation_id = r.old_id AND e.title_code = r.effective_title
    WHERE (e.enterprise_id IS NULL OR r.enterprise_id IS NULL OR e.enterprise_id = r.enterprise_id)
      AND ((e.type = 'later_process' AND e.enterprise_id IS NOT NULL)
        OR (e.type IN ('event_process', 'event_recognized') AND e.event_id IS NOT NULL)
        OR (e.type IN ('process_export_context', 'recognized_export') AND e.export_row_id IS NOT NULL))
  ), uncontested_edges AS (
    SELECT destination_key, (array_agg(edge_id ORDER BY recency, edge_id DESC))[1] AS edge_id
    FROM edge_destinations
    GROUP BY destination_key
    HAVING count(DISTINCT status) = 1 AND min(status) IN ('candidate', 'confirmed', 'rejected', 'unlinked')
  ), rebound_edges AS (
    UPDATE record_correspondence e
    SET observation_id = dest.id, edge_key = dest.destination_key, platform_evidence_rebound_revision = dest.assignment_revision,
      target_identity = (e.target_identity::jsonb || jsonb_build_object(
        'relationId', dest.public_id, 'queryId', dest.collection_public_id,
        'queryNaturalKey', jsonb_build_array(dest.interface, dest.query_key, dest.rdjb, dest.queried_at, dest.sequence_no)
      ))::text
    FROM edge_destinations dest JOIN uncontested_edges winner
      ON winner.destination_key = dest.destination_key AND winner.edge_id = dest.edge_id
    WHERE e.id = dest.edge_id
      AND NOT EXISTS (SELECT 1 FROM record_correspondence another WHERE another.edge_key = dest.destination_key)
  ), rebound_decisions AS (
    UPDATE difference_reason d
    SET evidence_relation_id = r.id, evidence_query_id = CASE WHEN d.evidence_query_id IS NOT NULL THEN r.collection_id END,
      original_evidence_relation_public_id = coalesce(d.original_evidence_relation_public_id, r.old_public_id),
      original_evidence_query_public_id = coalesce(d.original_evidence_query_public_id,
        CASE WHEN d.evidence_query_id IS NOT NULL THEN r.old_collection_public_id END)
    FROM replacements r
    WHERE d.evidence_relation_id = r.old_id AND d.title_code = r.effective_title
      AND (d.evidence_query_id IS NULL OR d.evidence_query_id = r.old_collection_id)
      AND (r.enterprise_id IS NULL OR d.enterprise_id = r.enterprise_id)
      AND (d.current_qualification IS NULL OR r.verification_status = 'confirmed')
  )
  SELECT array_agg(o.id), array_agg(o.id) FILTER (WHERE o.expired),
    array_agg(DISTINCT o.version_id) FILTER (WHERE o.expired)
    INTO superseded, expired, affected_versions
  FROM old_captures o;

  UPDATE difference_reason d
     SET evidence_relation_id = NULL, evidence_query_id = NULL,
         original_evidence_relation_public_id = coalesce(d.original_evidence_relation_public_id, o.public_id),
         original_evidence_query_public_id = coalesce(d.original_evidence_query_public_id,
           (SELECT c.public_id FROM platform_collection c WHERE c.id = d.evidence_query_id)),
         retired_evidence_reviewed = false,
         retired_evidence_validity = CASE WHEN d.retired_evidence_validity = 'premise_invalid'
           THEN 'premise_invalid' ELSE 'evidence_changed' END
    FROM platform_business_observation o
   WHERE d.evidence_relation_id = o.id AND o.id = ANY(superseded);

  UPDATE record_correspondence SET observation_id = NULL, platform_evidence_rebound_revision = NULL
  WHERE observation_id = ANY(superseded);

  IF expired IS NULL THEN
    RETURN 0;
  END IF;

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
