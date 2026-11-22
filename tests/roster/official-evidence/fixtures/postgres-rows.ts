import type pg from 'pg'

/** Read small fixture facts as JSON numbers, including PostgreSQL bigint IDs and counts. */
export function postgresFixtureRows(pool: pg.Pool) {
  const readRows = async (query: string, parameters: unknown[] = []) => {
    const output = await pool.query<{ row: Record<string, unknown> }>(
      'SELECT row_to_json(fixture_row) AS row FROM (' + query + ') AS fixture_row', parameters)
    return output.rows.map(item => item.row)
  }
  const readFirst = async (query: string, parameters?: unknown[]) => (await readRows(query, parameters))[0]
  return { readRows, readFirst }
}
