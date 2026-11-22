\set ON_ERROR_STOP on
\if :{?target}
\else
\set target business
\endif

BEGIN;
SET LOCAL search_path TO :"target", pg_catalog;
ALTER TABLE difference_reason
  ADD COLUMN IF NOT EXISTS retired_evidence_validity text
    CHECK (retired_evidence_validity IN ('valid', 'evidence_changed', 'premise_invalid')),
  ADD COLUMN IF NOT EXISTS retired_evidence_reviewed boolean;

SELECT to_regclass('explanation_impact_113') IS NOT NULL AS freeze_needed \gset
\if :freeze_needed
LOCK TABLE explanation_impact_113, evidence_scope_version_113 IN SHARE MODE;
\set evidence_source :target
\ir freeze-decision-evidence.sql
\endif

DROP TABLE IF EXISTS evidence_impact_link_113, evidence_impact_progress_113,
  evidence_revision_event_113, explanation_impact_113, evidence_scope_version_113,
  evidence_semantic_head_113, evidence_revision_113, evidence_rule_release_114;
COMMIT;
