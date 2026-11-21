import { getTableColumns, getTableName, sql, type Table } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]

export function postgresPlatformInsert<T extends Table>(table: T, values: T['$inferInsert'], extra: Record<string, unknown> = {}) {
  const columns = getTableColumns(table)
  const row: Array<[string, unknown]> = []
  for (const [key,value] of Object.entries(values)) {
    const column = columns[key]!
    if (value !== undefined) row.push([column.name,
      value === null ? null : column.dataType === 'json' ? JSON.stringify(value) : column.dataType === 'boolean' ? Number(value) : value])
  }
  row.push(...Object.entries(extra))
  return sql`INSERT INTO ${sql.identifier(getTableName(table))}
    (${sql.join(row.map(([name]) => sql.identifier(name)),sql`,`)})
    VALUES(${sql.join(row.map(([,value]) => sql`${value}`),sql`,`)})`
}

export async function insertPostgresPlatformRow<T extends Table>(tx: Tx, table: T, values: T['$inferInsert'], extra?: Record<string,unknown>) {
  const { rows: [row] } = await tx.execute<{ id: number }>(sql`${postgresPlatformInsert(table,values,extra)} RETURNING id::float8 AS id`)
  return row!.id
}

export function encodePlatformExactCell(column: string, value: string | number | Buffer | null) {
  if (value === null) return { [column]: null, [column+'_sqlite_storage']: 'null' }
  if (Buffer.isBuffer(value)) return { [column]: value, [column+'_sqlite_storage']: 'blob' }
  if (typeof value === 'string') return { [column]: Buffer.from(value), [column+'_sqlite_storage']: 'text' }
  const bytes = Buffer.alloc(8)
  const storage = Number.isSafeInteger(value) ? 'integer' : 'real'
  if (storage === 'integer') bytes.writeBigInt64BE(BigInt(value))
  else bytes.writeDoubleBE(value)
  return { [column]: bytes, [column+'_sqlite_storage']: storage }
}
