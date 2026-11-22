CREATE OR REPLACE FUNCTION guard_platform_canonical_archive() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.record_id, OLD.hash_algorithm, OLD.content_hash, OLD.canonical_archive_id)
      IS DISTINCT FROM (NEW.record_id, NEW.hash_algorithm, NEW.content_hash, NEW.canonical_archive_id) THEN
      RAISE EXCEPTION 'Canonical version evidence is immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM platform_version_archive_ref r JOIN platform_archive_value a ON a.id = r.archive_id
    WHERE r.owner_id = NEW.id AND r.archive_id = NEW.canonical_archive_id
      AND r.field = 'canonicalRawJson' AND r.sealed = 1 AND a.storage_class = 'text'
  ) THEN
    RAISE EXCEPTION 'Canonical version requires its sealed text archive' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER platform_version_canonical_archive
  BEFORE UPDATE ON platform_business_record_version
  FOR EACH ROW EXECUTE FUNCTION guard_platform_canonical_archive();

CREATE CONSTRAINT TRIGGER platform_version_canonical_archive_required
  AFTER INSERT ON platform_business_record_version DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION guard_platform_canonical_archive();
