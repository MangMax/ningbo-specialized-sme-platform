CREATE FUNCTION reject_file_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER stored_file_audit_append_only
BEFORE UPDATE OR DELETE ON stored_file_audit
FOR EACH ROW EXECUTE FUNCTION reject_file_audit_mutation();
CREATE TRIGGER file_maintenance_audit_append_only
BEFORE UPDATE OR DELETE ON file_maintenance_audit
FOR EACH ROW EXECUTE FUNCTION reject_file_audit_mutation();
