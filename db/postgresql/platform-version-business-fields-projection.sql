DO $placement$
DECLARE conflict_id bigint;
BEGIN
  SELECT version_id INTO conflict_id
  FROM pg_temp.projected_platform_business_fields
  WHERE version_id IS NOT NULL
  GROUP BY version_id
  HAVING count(DISTINCT jsonb_build_array(facts IS NULL, facts)) > 1
  ORDER BY version_id
  LIMIT 1;

  IF conflict_id IS NOT NULL THEN
    RAISE EXCEPTION 'Platform version % has conflicting observation business fields', conflict_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$placement$;

WITH projected AS (
  SELECT DISTINCT ON (version_id) version_id, facts
  FROM pg_temp.projected_platform_business_fields
  WHERE version_id IS NOT NULL
  ORDER BY version_id, observation_id
)
UPDATE platform_business_record_version v SET business_fields=projected.facts
FROM projected
WHERE projected.version_id=v.id AND v.business_fields IS DISTINCT FROM projected.facts;

UPDATE platform_business_observation o
SET business_fields=CASE WHEN p.version_id IS NULL THEN p.facts END
FROM pg_temp.projected_platform_business_fields p
WHERE p.observation_id=o.id
  AND o.business_fields IS DISTINCT FROM CASE WHEN p.version_id IS NULL THEN p.facts END;
