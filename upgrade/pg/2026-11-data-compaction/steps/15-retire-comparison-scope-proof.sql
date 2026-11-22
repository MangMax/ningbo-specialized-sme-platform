\set ON_ERROR_STOP on
\if :{?target}
\else
\set target business
\endif

BEGIN;
SET LOCAL search_path TO :"target", pg_catalog;

LOCK TABLE record_correspondence, record_correspondence_audit IN SHARE MODE;
SELECT to_regclass(format('%I.comparison_scope_proof', :'target')) IS NOT NULL
    OR to_regclass(format('%I.comparison_scope_proof_audit', :'target')) IS NOT NULL AS has_proof_tables
\gset
\if :has_proof_tables
LOCK TABLE comparison_scope_proof, comparison_scope_proof_audit IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT FROM comparison_scope_proof)
    OR EXISTS (SELECT FROM comparison_scope_proof_audit)
    OR EXISTS (SELECT FROM record_correspondence WHERE type = 'recognized_export' AND status = 'confirmed')
    OR EXISTS (
      SELECT FROM record_correspondence_audit audit
      JOIN record_correspondence edge ON edge.id = audit.correspondence_id
      WHERE edge.type = 'recognized_export' AND audit.to_status = 'confirmed'
    ) THEN
    RAISE EXCEPTION 'Source retains comparison scope proof or confirmed interface-export correspondence';
  END IF;
END;
$$;
DROP TABLE comparison_scope_proof_audit, comparison_scope_proof;
\endif
COMMIT;
