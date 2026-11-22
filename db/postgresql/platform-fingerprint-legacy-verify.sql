DO $legacy_input$
DECLARE bad_observation bigint;
BEGIN
  SELECT min(r.observation_id) INTO bad_observation
  FROM pg_temp.legacy_platform_fingerprint_release r
  LEFT JOIN platform_business_observation o ON o.id = r.observation_id
  LEFT JOIN platform_archive_value a ON a.id = r.archive_id
  WHERE a.storage_class IS DISTINCT FROM 'blob'
     OR o.input_fingerprint IS NULL
     OR a.byte_length IS DISTINCT FROM length(a.bytes)
     OR a.sha256 IS DISTINCT FROM o.input_fingerprint
     OR encode(pg_catalog.sha256(a.bytes), 'hex') IS DISTINCT FROM o.input_fingerprint;

  IF bad_observation IS NOT NULL THEN
    RAISE EXCEPTION 'Legacy observation % has no verified fingerprint archive', bad_observation
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$legacy_input$;
