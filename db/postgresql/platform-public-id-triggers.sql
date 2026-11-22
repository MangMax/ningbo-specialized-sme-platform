CREATE TRIGGER platform_collection_public_id_fixed BEFORE UPDATE OF id, public_id ON platform_collection
  FOR EACH ROW WHEN ((NEW.id, NEW.public_id) IS DISTINCT FROM (OLD.id, OLD.public_id))
  EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER platform_collection_public_id_retained BEFORE DELETE ON platform_collection
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER platform_observation_public_id_fixed BEFORE UPDATE OF id, public_id ON platform_business_observation
  FOR EACH ROW WHEN ((NEW.id, NEW.public_id) IS DISTINCT FROM (OLD.id, OLD.public_id))
  EXECUTE FUNCTION reject_roster_history_mutation();
CREATE TRIGGER platform_observation_public_id_retained BEFORE DELETE ON platform_business_observation
  FOR EACH ROW EXECUTE FUNCTION reject_roster_history_mutation();
