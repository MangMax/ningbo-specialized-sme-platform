-- The caller provides the schema containing legacy evidence tracking rows.
-- Ignore an impact whose decision has since moved to another scope.
WITH frozen AS (
  SELECT d.id,
    CASE
      WHEN i.latest_revision_id > coalesce(i.reviewed_revision_id, -1) THEN i.classification
      WHEN i.reviewed_revision_id IS NOT NULL AND EXISTS (
        SELECT
        FROM (VALUES (d.enterprise_id), (NULL)) e(id)
        CROSS JOIN (VALUES (d.title_code), (NULL)) t(code)
        CROSS JOIN (VALUES (d.direction), (NULL)) r(direction)
        JOIN :"evidence_source".evidence_scope_version_113 scope ON scope.scope_key = format('[%s,%s,%s]',
          coalesce(e.id::text, 'null'), coalesce(to_json(t.code)::text, 'null'),
          coalesce(to_json(r.direction)::text, 'null'))
        WHERE scope.pending_count <> 0
      ) THEN 'evidence_changed'
      WHEN i.reviewed_revision_id IS NOT NULL THEN 'valid'
    END AS validity,
    i.reviewed_revision_id IS NOT NULL AS reviewed
  FROM difference_reason d
  JOIN :"evidence_source".explanation_impact_113 i ON i.decision_id = d.id
    AND i.enterprise_id = d.enterprise_id AND i.title_code = d.title_code AND i.direction = d.direction
)
UPDATE difference_reason d
SET retired_evidence_validity = frozen.validity,
    retired_evidence_reviewed = CASE WHEN frozen.reviewed THEN true END
FROM frozen
WHERE d.id = frozen.id AND frozen.validity IS NOT NULL;
