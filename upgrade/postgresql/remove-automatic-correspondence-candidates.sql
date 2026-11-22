\set ON_ERROR_STOP on
\if :{?target}
\else
\set target business
\endif

BEGIN;
SET LOCAL search_path TO :"target", pg_catalog;

-- Lock the decision and its audit before selecting candidates for removal.
LOCK TABLE import_batch, record_correspondence, record_correspondence_audit IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE retired_automatic_candidates ON COMMIT DROP AS
SELECT edge.id AS edge_id, audit.id AS audit_id, batch.id AS batch_id
FROM record_correspondence edge
JOIN record_correspondence_audit audit ON audit.correspondence_id = edge.id
JOIN import_batch batch ON batch.id = audit.batch_id
JOIN platform_business_observation observation ON observation.id = edge.observation_id
WHERE edge.status = 'candidate'
  AND edge.revision = 1
  AND edge.decided_at IS NULL
  AND edge.ended_at IS NULL
  AND edge.type IN ('event_process', 'event_recognized')
  AND audit.from_status IS NULL
  AND audit.to_status = 'candidate'
  AND audit.expected_revision = 0
  AND audit.resulting_revision = 1
  AND audit.actor_type = 'agent'
  AND audit.actor_id = 'candidate-discovery-job'
  AND audit.basis = '归档原行精确身份与称号匹配；仅生成待核候选，人工核对后决定。'
  AND audit.rule_id = 'archived-row-exact-identity-title'
  AND audit.rule_version = 'event-archive-212-v1'
  AND batch.source_kind = 'correspondence_decision'
  AND batch.status = 'committed'
  AND batch.source_identity ~ '^candidate-job/[^/:]+$'
  AND audit.idempotency_key = batch.idempotency_key
  AND batch.idempotency_key = 'candidate-job:' || substr(batch.source_identity, length('candidate-job/') + 1)
    || ':' || edge.event_id || ':' || observation.public_id
  AND NOT EXISTS (
    SELECT FROM record_correspondence_audit other
    WHERE other.correspondence_id = edge.id AND other.id <> audit.id
  );

ALTER TABLE record_correspondence_audit DISABLE TRIGGER correspondence_audit_append_only;
DELETE FROM record_correspondence_audit audit
USING retired_automatic_candidates retired
WHERE audit.id = retired.audit_id;
ALTER TABLE record_correspondence_audit ENABLE TRIGGER correspondence_audit_append_only;

DELETE FROM record_correspondence edge
USING retired_automatic_candidates retired
WHERE edge.id = retired.edge_id;

-- Remove only the dedicated worker receipt for that one edge. Preserve any
-- shared batch. Referential constraints protect other out-of-scope consumers.
SELECT EXISTS (SELECT FROM retired_automatic_candidates) AS has_retired_candidates \gset
\if :has_retired_candidates
-- PostgreSQL checks each referencing table for each deleted batch. Index the
-- referencing columns for this migration, then release the temporary storage.
CREATE INDEX retire_auto_candidate_event_batch_idx ON event_correction_audit (batch_id);
CREATE INDEX retire_auto_candidate_evidence_batch_idx ON official_evidence_row_revision (import_batch_id);
CREATE INDEX retire_auto_candidate_observation_batch_idx ON platform_business_observation (batch_id);
SELECT to_regclass('platform_collection_legacy_provenance') IS NOT NULL AS has_legacy_provenance \gset
\if :has_legacy_provenance
CREATE INDEX retire_auto_candidate_provenance_batch_idx ON platform_collection_legacy_provenance (import_batch_id);
\endif
CREATE INDEX retire_auto_candidate_export_batch_idx ON platform_export_batch (import_batch_id);
CREATE INDEX retire_auto_candidate_audit_batch_idx ON record_correspondence_audit (batch_id);

DELETE FROM import_batch batch
USING retired_automatic_candidates retired
WHERE batch.id = retired.batch_id
  AND CASE WHEN batch.item_results IS JSON ARRAY
    THEN batch.item_results::jsonb = jsonb_build_array(retired.edge_id)
    ELSE false END
  AND CASE WHEN batch.summary IS JSON OBJECT
    THEN batch.summary::jsonb -> 'correspondenceIds' = jsonb_build_array(retired.edge_id)
    ELSE false END
  AND NOT EXISTS (SELECT FROM record_correspondence_audit audit WHERE audit.batch_id = batch.id)
  AND NOT EXISTS (SELECT FROM import_receipt receipt WHERE receipt.batch_id = batch.id);

DROP INDEX retire_auto_candidate_event_batch_idx, retire_auto_candidate_evidence_batch_idx,
  retire_auto_candidate_observation_batch_idx,
  retire_auto_candidate_export_batch_idx, retire_auto_candidate_audit_batch_idx;
\if :has_legacy_provenance
DROP INDEX retire_auto_candidate_provenance_batch_idx;
\endif
\endif

COMMIT;
