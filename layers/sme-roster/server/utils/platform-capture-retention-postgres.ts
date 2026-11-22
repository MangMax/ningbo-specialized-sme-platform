import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

export function lockPostgresCurrentCapture(tx: Pick<NodePgDatabase, 'execute'>) {
  return tx.execute(sql`SELECT pg_advisory_xact_lock_shared(21785,0)`)
}

export async function prunePostgresPlatformCaptures(
  db: Pick<NodePgDatabase, 'execute'>, recordIds: readonly number[], keepPrevious: boolean,
) {
  if (!recordIds.length) return 0
  // Retiring one capture includes source references and three version projections.
  const { rows } = await db.execute<{ removed: number }>(
    sql`select business.prune_platform_captures(${sql.param(recordIds)}::bigint[], ${keepPrevious}) as removed`,
  )
  return rows[0]!.removed
}
