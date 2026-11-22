\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO business, pg_catalog;
SELECT pg_advisory_xact_lock(42458,114);

-- Check that every receipt can be projected without changing a decision or
-- replacing its stored metadata. Refuse unexpected receipt shapes atomically.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM evidence_review_receipt_114 r
    LEFT JOIN difference_reason target ON target.id = r.decision_id
    LEFT JOIN difference_reason source ON source.id = r.source_decision_id
    WHERE NOT CASE
      WHEN r.kind = 'process' THEN
        r.decision_id IS NULL AND r.source_decision_id IS NULL AND r.reviewed_revision_id IS NULL
        AND jsonb_typeof(r.response::jsonb) = 'object'
      WHEN r.kind = 'maintain' THEN
        target.id IS NOT NULL AND (r.source_decision_id IS NULL OR r.source_decision_id = target.id)
        AND r.reviewed_revision_id IS NOT NULL AND jsonb_typeof(r.response::jsonb) = 'object'
      WHEN r.kind = 'replace' THEN
        target.id IS NOT NULL AND (r.source_decision_id IS NULL OR source.id IS NOT NULL)
        AND r.reviewed_revision_id BETWEEN 0 AND 9007199254740991
        AND target.lifecycle_action = 'replace' AND target.previous_id IS NOT DISTINCT FROM source.id
        AND target.idempotency_key = r.idempotency_key AND target.request_hash = r.request_hash
        AND target.basis = r.basis AND target.effective_at IS NOT DISTINCT FROM r.effective_at
        AND r.response::jsonb = jsonb_build_object(
          'versionId', target.id, 'currentId', target.id, 'previousId', target.previous_id,
          'action', target.lifecycle_action, 'recordedAt', target.recorded_at,
          'reviewedRevisionId', r.reviewed_revision_id
        )
      ELSE false
    END IS TRUE
  ) THEN
    RAISE EXCEPTION 'Evidence review receipt cannot be projected without changing decision semantics';
  END IF;
END
$$;

INSERT INTO import_batch
  (idempotency_key, source_kind, source_identity, source_sha256, status, summary, created_at, committed_at)
SELECT
  'evidence-review:' || r.idempotency_key,
  CASE r.kind WHEN 'process' THEN 'retired_evidence_review_process'
              WHEN 'maintain' THEN 'maintained_difference'
              ELSE 'reviewed_difference_replacement' END,
  COALESCE(r.decision_id::text, 'process'),
  CASE WHEN r.kind <> 'replace' THEN r.request_hash END,
  'committed',
  CASE r.kind WHEN 'process' THEN r.response
              WHEN 'maintain' THEN json_build_object(
                'response', r.response::json,
                'qualification', json_build_object('basis', r.basis, 'effectiveAt', r.effective_at)
              )::text
              ELSE json_build_object('reviewedRevisionId', r.reviewed_revision_id)::text END,
  r.recorded_at, r.recorded_at
FROM evidence_review_receipt_114 r
ORDER BY r.id;
COMMIT;
