CREATE TRIGGER platform_recognized_exact_title_fixed BEFORE UPDATE ON platform_recognized_projection
  FOR EACH ROW WHEN (
    (NEW.exact_title_raw, NEW.exact_title_raw_sqlite_storage, NEW.exact_title_state)
    IS DISTINCT FROM (OLD.exact_title_raw, OLD.exact_title_raw_sqlite_storage, OLD.exact_title_state))
  EXECUTE FUNCTION reject_roster_history_mutation();
