import { getTableColumns, sql, type Table } from 'drizzle-orm'

export function postgresRosterRow(table: Table, alias: string) {
  const fields = Object.entries(getTableColumns(table)).map(([key, column]) => {
    const value = sql`${sql.identifier(alias)}.${sql.identifier(column.name)}`
    return sql`${column.dataType === 'json' ? sql`${value}::json` : value} AS ${sql.identifier(key)}`
  })
  return sql`(SELECT row_to_json(projected) FROM (SELECT ${sql.join(fields, sql`,`)}) projected)`
}
