CREATE OR REPLACE FUNCTION business.notify_task_center_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_catalog.pg_notify('task_center_changed', '');
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER task_center_changed
  AFTER INSERT OR UPDATE OR DELETE ON business.job
  FOR EACH ROW EXECUTE FUNCTION business.notify_task_center_change();
