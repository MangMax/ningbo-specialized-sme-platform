import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

export function lockPostgresCurrentCapture(tx: Pick<NodePgDatabase, 'execute'>) {
  return tx.execute(sql`SELECT pg_advisory_xact_lock_shared(21785,0)`)
}

export async function prunePostgresPlatformCaptures(
  db: Pick<NodePgDatabase, 'transaction'>, recordIds: readonly number[] | null, keepPrevious: boolean,
) {
  if (recordIds?.length === 0) return 0
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(21785,0)`)
    const { rows } = await tx.execute<{ removed: number }>(
      sql`select business.prune_platform_captures(${sql.param(recordIds)}::bigint[], ${keepPrevious}) as removed`,
    )
    return rows[0]!.removed
  })
}
