CREATE OR REPLACE FUNCTION guard_platform_projection_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM platform_business_record WHERE id = NEW.record_id AND interface = TG_ARGV[0]
  ) THEN
    RAISE EXCEPTION 'Projection source owner mismatch' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
