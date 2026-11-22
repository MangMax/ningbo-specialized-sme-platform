CREATE OR REPLACE FUNCTION guard_platform_collection_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE has_scope boolean := OLD.condition_facts IS NOT NULL OR OLD.unfinished_positions <> '[]'::jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF has_scope THEN
      RAISE EXCEPTION 'Collection scope is retained' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF has_scope AND NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Collection scope owner is retained' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.condition_facts ? 'witnesses' AND
    (NEW.condition_facts -> 'witnesses') IS DISTINCT FROM (OLD.condition_facts -> 'witnesses') THEN
    RAISE EXCEPTION 'Collection condition witnesses are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER platform_collection_scope_retained
  BEFORE UPDATE OF id, condition_facts OR DELETE ON platform_collection
  FOR EACH ROW EXECUTE FUNCTION guard_platform_collection_scope();
