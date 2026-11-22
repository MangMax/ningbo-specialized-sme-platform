CREATE OR REPLACE FUNCTION guard_platform_observation_source() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE source_interface text;
BEGIN
  SELECT interface INTO STRICT source_interface FROM platform_collection WHERE id = NEW.collection_id;
  IF NEW.record_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM platform_business_record WHERE id = NEW.record_id AND interface = source_interface
  ) THEN
    RAISE EXCEPTION 'Observation and record interface disagree' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;
