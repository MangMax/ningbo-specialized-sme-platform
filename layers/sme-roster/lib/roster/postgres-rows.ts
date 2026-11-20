import { getTableColumns, sql, type SQL, type Table } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

// Map the same stored columns the SQLite hydration projects. JSON text is
// decoded by PostgreSQL so both readers feed identical values to the mapper.
export async function readPostgresRosterRowsById<T extends Table>(db: Pick<NodePgDatabase, 'execute'>, table: T, from: SQL) {
  const { rows } = await db.execute<{ row: T['$inferSelect'] }>(sql`
    SELECT ${postgresRosterRow(table, 'p')} AS row ${from} ORDER BY p.id`)
  return rows.map(value => value.row)
}

export function postgresRosterRow(table: Table, alias: string) {
  const fields = Object.entries(getTableColumns(table)).map(([key, column]) => {
    const value = sql`${sql.identifier(alias)}.${sql.identifier(column.name)}`
    return sql`${key}::text,${column.dataType === 'json' ? sql`${value}::json` : value}`
  })
  return sql`json_build_object(${sql.join(fields, sql`,`)})`
}
