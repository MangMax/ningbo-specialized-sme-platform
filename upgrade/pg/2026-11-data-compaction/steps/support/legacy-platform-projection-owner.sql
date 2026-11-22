CREATE OR REPLACE FUNCTION guard_platform_projection_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.record_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM platform_business_record WHERE id = NEW.record_id AND interface = TG_ARGV[0]
    )) OR (NEW.observation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM platform_business_observation o JOIN platform_collection c ON c.id = o.collection_id
      WHERE o.id = NEW.observation_id AND c.interface = TG_ARGV[0]
    )) THEN
    RAISE EXCEPTION 'Projection source owner mismatch' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
