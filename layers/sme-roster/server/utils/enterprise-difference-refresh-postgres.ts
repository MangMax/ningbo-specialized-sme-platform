import { sql } from 'drizzle-orm'
import { createError } from 'h3'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterpriseDifferenceRefreshInput } from './enterprise-difference-refresh'

type Result = { titleCode: string; comparisonState: string; reasons: string[]; comparisonError: string | null;
  status: string; reasonCode: string | null; businessFingerprint: string; changedAt: string; refreshedAt: string }

export async function readPostgresEnterpriseDifferenceComparisons(db: NodePgDatabase, raw: unknown) {
  const parsed = enterpriseDifferenceRefreshInput.safeParse(raw)
  if (!parsed.success) throw createError({ statusCode: 400, message: 'Invalid enterpriseIds; provide distinct positive IDs or omit for all published enterprises' })
  return db.transaction(async tx => {
    const requested = parsed.data.enterpriseIds
    const { rows: ids } = requested ? await tx.execute<{ id: number }>(sql`
      SELECT id::float8 AS id FROM enterprise WHERE id=ANY(${sql.param(requested)}::bigint[]) ORDER BY id`)
      : await tx.execute<{ id: number }>(sql`
        SELECT DISTINCT enterprise_id::float8 AS id FROM record WHERE source='jxj' ORDER BY id`)
    if (requested && requested.length !== ids.length) throw createError({ statusCode: 400, message: 'Unknown enterprise ID' })
    const { rows } = await tx.execute<{ enterpriseId: number; comparison: Result }>(sql`
      SELECT c.enterprise_id::float8 AS "enterpriseId",json_build_object(
        'titleCode',c.title_code,'comparisonState',c.comparison_state,'reasons',c.reasons::json,'comparisonError',c.comparison_error,
        'status',coalesce(decision.status,'needs_review'),'reasonCode',decision.reason_code,'businessFingerprint',c.business_fingerprint,
        'changedAt',c.changed_at,'refreshedAt',c.refreshed_at) AS comparison
      FROM enterprise_difference_comparison c
      LEFT JOIN LATERAL (SELECT status,reason_code FROM difference_reason d WHERE d.enterprise_id=c.enterprise_id
        AND d.title_code=c.title_code AND d.id>c.decision_cutoff_id ORDER BY d.recorded_at DESC,d.id DESC LIMIT 1) decision ON true
      WHERE c.enterprise_id=ANY(${sql.param(ids.map(row => row.id))}::bigint[]) ORDER BY c.enterprise_id,c.title_code COLLATE "C"`)
    const byOwner = Map.groupBy(rows, row => row.enterpriseId)
    return { refreshed: 0, unchanged: 0,
      enterprises: ids.map(({ id }) => ({ enterpriseId: id, comparisons: byOwner.get(id)?.map(row => row.comparison) ?? [] })) }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
