CREATE INDEX enterprise_alias_name_norm_idx ON enterprise_alias(name_norm);
CREATE INDEX enterprise_alias_enterprise_idx ON enterprise_alias(enterprise_id);
CREATE INDEX enterprise_alias_status_page_idx ON enterprise_alias(enterprise_id, verification_status, id);
CREATE INDEX enterprise_alias_audit_page_idx ON enterprise_alias_audit(alias_id, id);
CREATE INDEX enterprise_profile_audit_enterprise_idx ON enterprise_profile_audit(enterprise_id, id);

CREATE FUNCTION sync_former_name_enterprise() RETURNS trigger
LANGUAGE plpgsql SET search_path = business, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO enterprise_former_name (alias_id, uscc)
      SELECT NEW.id, uscc_norm FROM enterprise WHERE id = NEW.enterprise_id;
  ELSE
    UPDATE enterprise_former_name SET uscc = (SELECT uscc_norm FROM enterprise WHERE id = NEW.enterprise_id)
      WHERE alias_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER enterprise_former_name_insert AFTER INSERT ON enterprise_alias
  FOR EACH ROW EXECUTE FUNCTION sync_former_name_enterprise();
CREATE TRIGGER enterprise_former_name_reassign AFTER UPDATE OF enterprise_id ON enterprise_alias
  FOR EACH ROW EXECUTE FUNCTION sync_former_name_enterprise();

CREATE FUNCTION sync_former_name_uscc() RETURNS trigger
LANGUAGE plpgsql SET search_path = business, pg_catalog AS $$
BEGIN
  UPDATE enterprise_former_name SET uscc = NEW.uscc_norm
    WHERE alias_id IN (SELECT id FROM enterprise_alias WHERE enterprise_id = NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER enterprise_former_name_uscc AFTER UPDATE OF uscc_norm ON enterprise
  FOR EACH ROW EXECUTE FUNCTION sync_former_name_uscc();

CREATE FUNCTION bump_enterprise_directory_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = business, pg_catalog AS $$
BEGIN
  INSERT INTO enterprise_directory(enterprise_id, revision) VALUES (NEW.id, 2)
    ON CONFLICT (enterprise_id) DO UPDATE SET revision = enterprise_directory.revision + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER enterprise_directory_identity_revision AFTER UPDATE OF name, city, district, uscc_norm ON enterprise
  FOR EACH ROW WHEN ((OLD.name, OLD.city, OLD.district, OLD.uscc_norm) IS DISTINCT FROM
                    (NEW.name, NEW.city, NEW.district, NEW.uscc_norm))
  EXECUTE FUNCTION bump_enterprise_directory_revision();

CREATE FUNCTION guard_enterprise_merge() RETURNS trigger
LANGUAGE plpgsql SET search_path = business, pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'enterprise_merge_append_only';
  END IF;
  PERFORM id FROM enterprise WHERE id IN (NEW.from_enterprise_id, NEW.into_enterprise_id) ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM enterprise_merge WHERE from_enterprise_id IN (NEW.from_enterprise_id, NEW.into_enterprise_id)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'enterprise_merge_current_identity_required';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER enterprise_merge_guard BEFORE INSERT OR UPDATE OR DELETE ON enterprise_merge
  FOR EACH ROW EXECUTE FUNCTION guard_enterprise_merge();

CREATE FUNCTION follow_enterprise_merge_sources() RETURNS trigger
LANGUAGE plpgsql SET search_path = business, pg_catalog AS $$
BEGIN
  INSERT INTO enterprise_source_link(enterprise_id, source_id)
    SELECT NEW.into_enterprise_id, source_id FROM enterprise_source_link WHERE enterprise_id = NEW.from_enterprise_id
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER enterprise_source_follow_merge AFTER INSERT ON enterprise_merge
  FOR EACH ROW EXECUTE FUNCTION follow_enterprise_merge_sources();
