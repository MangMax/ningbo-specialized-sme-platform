import { and, eq, inArray, not, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { platformBusinessObservation as observation } from '../../../../db/postgresql/platform-tables'
import { recordCorrespondence as edge } from '../../../../db/postgresql/qualification-tables'
import { isCurrentPlatformCaptureRow } from '../../lib/platform/current-observation-postgres'
import { readPostgresCorrespondenceRefs } from './record-correspondence-postgres-refs'

export function lockPostgresCurrentCapture(tx: Pick<NodePgDatabase, 'execute'>) {
  return tx.execute(sql`SELECT pg_advisory_xact_lock_shared(21785,0)`)
}

export async function prunePostgresPlatformCaptures(
  db: Pick<NodePgDatabase, 'transaction'>, recordIds: readonly number[] | null, keepPrevious: boolean,
) {
  if (recordIds?.length === 0) return 0
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(21785,0)`)
    const sourceEdges = await tx.select({ id: edge.id }).from(edge)
      .innerJoin(observation, eq(edge.observationId, observation.id))
      .where(and(recordIds === null ? undefined : inArray(observation.recordId, recordIds),
        not(isCurrentPlatformCaptureRow(tx))))
      .orderBy(edge.id)
    const validSourceEdges: number[] = []
    for (let offset = 0; offset < sourceEdges.length; offset += 500) {
      const rebindSourceIds = sourceEdges.slice(offset, offset + 500).map(row => row.id)
      const sources = await readPostgresCorrespondenceRefs(tx, { rebindSourceIds })
      validSourceEdges.push(...sources.filter(row => !row.requiresRevalidation).map(row => row.id))
    }
    const { rows } = await tx.execute<{ removed: number }>(
      sql`select business.prune_platform_captures(${sql.param(recordIds)}::bigint[], ${keepPrevious}, ${sql.param(validSourceEdges)}::bigint[]) as removed`,
    )
    return rows[0]!.removed
  })
}
