SELECT EXISTS (SELECT 1 FROM pg_temp.legacy_platform_fingerprint_release) AS retiring_platform_inputs
\gset
\if :retiring_platform_inputs

-- PostgreSQL's row-level FK checks need indexes on the optional archive pointers for this bulk delete.
CREATE INDEX retire_platform_candidate_fk_idx ON platform_business_observation(candidate_scope_archive_id) WHERE candidate_scope_archive_id IS NOT NULL;
CREATE INDEX retire_platform_position_fk_idx ON platform_business_observation(witness_archive_id) WHERE witness_archive_id IS NOT NULL;
CREATE INDEX retire_platform_slot_fk_idx ON platform_collection(reconcile_slot_raw_archive_id) WHERE reconcile_slot_raw_archive_id IS NOT NULL;
CREATE INDEX retire_platform_collection_witness_fk_idx ON platform_collection(witness_archive_id) WHERE witness_archive_id IS NOT NULL;
CREATE INDEX retire_platform_exact_title_fk_idx ON platform_recognized_projection(exact_title_archive_id) WHERE exact_title_archive_id IS NOT NULL;

ALTER TABLE platform_archive_value DISABLE TRIGGER platform_archive_append_only;

WITH pinned(id) AS MATERIALIZED (
  SELECT input_archive_id FROM platform_observation_fingerprint_basis WHERE input_archive_id IS NOT NULL
  UNION ALL SELECT archive_id FROM platform_collection_archive_ref
  UNION ALL SELECT archive_id FROM platform_collection_legacy_provenance
  UNION ALL SELECT archive_id FROM platform_observation_archive_ref
  UNION ALL SELECT archive_id FROM platform_version_archive_ref
  UNION ALL SELECT canonical_archive_id FROM platform_business_record_version
  UNION ALL SELECT source_archive_id FROM platform_apply_projection WHERE source_archive_id IS NOT NULL
  UNION ALL SELECT source_archive_id FROM platform_business_projection WHERE source_archive_id IS NOT NULL
  UNION ALL SELECT source_archive_id FROM platform_recognized_projection WHERE source_archive_id IS NOT NULL
  UNION ALL SELECT exact_title_archive_id FROM platform_recognized_projection WHERE exact_title_archive_id IS NOT NULL
  UNION ALL SELECT candidate_scope_archive_id FROM platform_business_observation WHERE candidate_scope_archive_id IS NOT NULL
  UNION ALL SELECT witness_archive_id FROM platform_business_observation WHERE witness_archive_id IS NOT NULL
  UNION ALL SELECT witness_archive_id FROM platform_collection WHERE witness_archive_id IS NOT NULL
  UNION ALL SELECT reconcile_slot_raw_archive_id FROM platform_collection WHERE reconcile_slot_raw_archive_id IS NOT NULL
)
DELETE FROM platform_archive_value a
USING pg_temp.legacy_platform_fingerprint_release r
WHERE a.id = r.archive_id AND NOT EXISTS (SELECT 1 FROM pinned p WHERE p.id = a.id);

ALTER TABLE platform_archive_value ENABLE TRIGGER platform_archive_append_only;

DROP INDEX retire_platform_candidate_fk_idx, retire_platform_position_fk_idx, retire_platform_slot_fk_idx,
  retire_platform_collection_witness_fk_idx, retire_platform_exact_title_fk_idx;
\endif
