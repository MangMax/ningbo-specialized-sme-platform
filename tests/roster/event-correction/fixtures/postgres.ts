import type { useIsolatedPostgresCases } from '../../../support/isolated-postgres-cases'

export async function failEventUpdate(db: ReturnType<ReturnType<typeof useIsolatedPostgresCases>>, id: number) {
  await db.$client.query(`
    CREATE FUNCTION fail_event_update() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'synthetic event write failure'; END; $$;
    CREATE TRIGGER fail_event_update BEFORE UPDATE ON record_event
    FOR EACH ROW WHEN (OLD.id = ${id}) EXECUTE FUNCTION fail_event_update();
  `)
  return async () => {
    await db.$client.query('DROP TRIGGER fail_event_update ON record_event; DROP FUNCTION fail_event_update()')
  }
}
