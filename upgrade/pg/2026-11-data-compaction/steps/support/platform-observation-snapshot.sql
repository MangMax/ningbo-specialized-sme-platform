-- The compact payload replaces only an exactly reproduced raw_fields hex string.
CREATE OR REPLACE FUNCTION platform_observation_snapshot(owner bigint, snapshot bytea) RETURNS bytea
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
  document text;
  cell text[];
  original bytea;
  hex text;
BEGIN
  IF snapshot IS NULL OR position(convert_to('"hex":"@raw-', 'UTF8') IN snapshot) = 0 THEN
    RETURN snapshot;
  END IF;

  document := convert_from(snapshot, 'UTF8');
  cell := regexp_match(document, '[{]"name":"raw_fields","storageClass":"(text|blob)","hex":"(@raw-(upper|lower))"[}]');
  IF cell IS NULL THEN
    RAISE EXCEPTION 'Invalid compact platform observation snapshot';
  END IF;

  SELECT a.bytes INTO original
  FROM platform_observation_archive_ref r JOIN platform_archive_value a ON a.id = r.archive_id
  WHERE r.owner_id = owner AND r.field = 'rawFields' AND r.sealed = 1 AND a.storage_class = cell[1];
  IF original IS NULL THEN
    RAISE EXCEPTION 'Missing sealed raw fields for platform observation %', owner;
  END IF;

  hex := encode(original, 'hex');
  IF cell[3] = 'upper' THEN
    hex := upper(hex);
  END IF;
  RETURN convert_to(replace(document, '"hex":"' || cell[2] || '"', '"hex":"' || hex || '"'), 'UTF8');
END;
$$;
