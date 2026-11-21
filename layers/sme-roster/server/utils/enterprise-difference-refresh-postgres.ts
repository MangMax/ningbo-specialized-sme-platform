import { sql } from 'drizzle-orm'
import { createError } from 'h3'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PostgresQualificationTransaction } from '../../lib/roster/current-qualification-postgres'
import { parseEnterpriseDifferenceRefreshInput, projectRefreshComparison, refreshComparisonFailure } from './enterprise-difference-refresh'
import { preparePostgresRefreshComparison } from './enterprise-difference-refresh-comparison-postgres'
import { readPostgresRefreshFingerprints } from './enterprise-difference-refresh-fingerprint-postgres'

type Tx = PostgresQualificationTransaction
type Result = { titleCode: string; comparisonState: string; reasons: string[]; comparisonError: string | null;
  status: string; reasonCode: string | null; businessFingerprint: string; changedAt: string; refreshedAt: string }
type Comparison = ReturnType<typeof projectRefreshComparison> | ReturnType<typeof refreshComparisonFailure>
type Pending = { enterpriseId: number; title: string; fingerprint: string; comparison?: Comparison }
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`

async function resolveScope(tx: Tx, requested: number[] | undefined) {
  const { rows } = requested ? await tx.execute<{ id: number }>(sql`
    SELECT id::float8 AS id FROM enterprise WHERE id=ANY(${ids(requested)}) ORDER BY id`)
    : await tx.execute<{ id: number }>(sql`
      SELECT DISTINCT enterprise_id::float8 AS id FROM record WHERE source='jxj' ORDER BY id`)
  if (requested && requested.length !== rows.length) throw createError({ statusCode: 400, message: 'Unknown enterprise ID' })
  return rows.map(row => row.id)
}

async function readScope(tx: Tx, enterpriseIds: number[]) {
  const { rows } = await tx.execute<{ enterpriseId: number; comparison: Result }>(sql`
    SELECT c.enterprise_id::float8 AS "enterpriseId",json_build_object(
      'titleCode',c.title_code,'comparisonState',c.comparison_state,'reasons',c.reasons::json,'comparisonError',c.comparison_error,
      'status',coalesce(decision.status,'needs_review'),'reasonCode',decision.reason_code,'businessFingerprint',c.business_fingerprint,
      'changedAt',c.changed_at,'refreshedAt',c.refreshed_at) AS comparison
    FROM enterprise_difference_comparison c
    LEFT JOIN LATERAL (SELECT status,reason_code FROM difference_reason d WHERE d.enterprise_id=c.enterprise_id
      AND d.title_code=c.title_code AND d.id>c.decision_cutoff_id ORDER BY d.recorded_at COLLATE "C" DESC,d.id DESC LIMIT 1) decision ON true
    WHERE c.enterprise_id=ANY(${ids(enterpriseIds)}) ORDER BY c.enterprise_id,c.title_code COLLATE "C"`)
  const byOwner = Map.groupBy(rows, row => row.enterpriseId)
  return enterpriseIds.map(id => ({ enterpriseId: id, comparisons: byOwner.get(id)?.map(row => row.comparison) ?? [] }))
}

export async function readPostgresEnterpriseDifferenceComparisons(db: NodePgDatabase, raw: unknown) {
  const { enterpriseIds } = parseEnterpriseDifferenceRefreshInput(raw)
  return db.transaction(async tx => ({
    refreshed: 0, unchanged: 0, enterprises: await readScope(tx, await resolveScope(tx, enterpriseIds)),
  }), { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

async function refreshBlock(tx: Tx, enterpriseIds: number[], now: string) {
  const { rows } = await tx.execute<{ key: string; fingerprint: string }>(sql`
    SELECT enterprise_id || ':' || title_code AS key, business_fingerprint AS fingerprint
    FROM enterprise_difference_comparison WHERE enterprise_id=ANY(${ids(enterpriseIds)})`)
  const previous = new Map(rows.map(row => [row.key, row.fingerprint]))
  const pending: Pending[] = []
  for (const { subject, fingerprints } of await readPostgresRefreshFingerprints(tx, enterpriseIds)) {
    const changed = [...fingerprints].filter(([title, fingerprint]) => previous.get(subject.id + ':' + title) !== fingerprint)
    const compare = changed.length ? await preparePostgresRefreshComparison(tx, subject, Date.parse(now), changed.map(([title]) => title)) : undefined
    const comparisons = new Map<string, Comparison>()
    for (const [title] of changed) {
      try { comparisons.set(title, projectRefreshComparison(await compare!(title))) }
      catch (error) { comparisons.set(title, refreshComparisonFailure(error)) }
    }
    for (const [title, fingerprint] of fingerprints) {
      pending.push({ enterpriseId: subject.id, title, fingerprint, comparison: comparisons.get(title) })
    }
  }
  const unchanged = pending.filter(row => !row.comparison)
  if (unchanged.length) {
    const keys = unchanged.map(({ enterpriseId, title }) => ({ enterprise_id: enterpriseId, title_code: title }))
    await tx.execute(sql`
      UPDATE enterprise_difference_comparison c SET refreshed_at=${now}
      FROM json_to_recordset(${JSON.stringify(keys)}::json) AS x(enterprise_id bigint,title_code text)
      WHERE c.enterprise_id=x.enterprise_id AND c.title_code=x.title_code`)
  }
  const changed = pending.flatMap(row => row.comparison ? [{
    enterprise_id: row.enterpriseId, title_code: row.title, fingerprint: row.fingerprint,
    state: row.comparison.state, reasons: JSON.stringify(row.comparison.reasons), error: row.comparison.error,
  }] : [])
  if (changed.length) {
    await tx.execute(sql`
      INSERT INTO enterprise_difference_comparison(enterprise_id,title_code,comparison_state,reasons,comparison_error,
        decision_cutoff_id,business_fingerprint,changed_at,refreshed_at)
      SELECT x.enterprise_id,x.title_code,x.state,x.reasons,x.error,
        coalesce((SELECT max(id) FROM difference_reason d WHERE d.enterprise_id=x.enterprise_id AND d.title_code=x.title_code),0),
        x.fingerprint,${now},${now}
      FROM json_to_recordset(${JSON.stringify(changed)}::json) AS x(
        enterprise_id bigint,title_code text,state text,reasons text,error text,fingerprint text)
      ORDER BY x.enterprise_id,x.title_code COLLATE "C"
      ON CONFLICT(enterprise_id,title_code) DO UPDATE SET comparison_state=excluded.comparison_state,
        reasons=excluded.reasons,comparison_error=excluded.comparison_error,decision_cutoff_id=excluded.decision_cutoff_id,
        business_fingerprint=excluded.business_fingerprint,changed_at=excluded.changed_at,refreshed_at=excluded.refreshed_at`)
  }
  return { refreshed: changed.length, unchanged: unchanged.length }
}

export async function refreshPostgresEnterpriseDifferences(db: NodePgDatabase, raw: unknown, now?: string) {
  const { enterpriseIds } = parseEnterpriseDifferenceRefreshInput(raw)
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async tx => {
        const at = now ?? new Date().toISOString()
        const scope = await resolveScope(tx, enterpriseIds)
        let refreshed = 0, unchanged = 0
        for (let start = 0; start < scope.length; start += 100) {
          const result = await refreshBlock(tx, scope.slice(start, start + 100), at)
          refreshed += result.refreshed
          unchanged += result.unchanged
        }
        return { refreshed, unchanged, enterprises: await readScope(tx, scope) }
      }, { isolationLevel: 'repeatable read' })
    } catch (error) {
      const cause = error as { code?: string; cause?: { code?: string } }
      if (!['40001', '40P01'].includes(cause.code ?? cause.cause?.code ?? '') || attempt === 2) throw error
    }
  }
}
