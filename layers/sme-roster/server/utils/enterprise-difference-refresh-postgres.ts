import { and, desc, eq, gt, inArray, max, or, sql } from 'drizzle-orm'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { record } from '../../../../db/postgresql/ledger-tables'
import { differenceReason as d, enterpriseDifferenceComparison as c } from '../../../../db/postgresql/roster-selection-tables'
import { createError } from 'h3'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PostgresQualificationTransaction } from '../../lib/roster/current-qualification-postgres'
import { parseEnterpriseDifferenceRefreshInput, projectRefreshComparison, refreshComparisonFailure } from './enterprise-difference-refresh-contract'
import { preparePostgresRefreshComparison } from './enterprise-difference-refresh-comparison-postgres'
import { readPostgresRefreshFingerprints } from './enterprise-difference-refresh-fingerprint-postgres'

type Tx = PostgresQualificationTransaction
type Comparison = ReturnType<typeof projectRefreshComparison> | ReturnType<typeof refreshComparisonFailure>
type Pending = { enterpriseId: number; title: string; fingerprint: string; comparison?: Comparison }
const key = (enterpriseId: number, title: string) => enterpriseId + ':' + title
// Drizzle 0.45.4 has no COLLATE expression builder.
const orderedTitle = sql`${c.titleCode} COLLATE "C"`

async function resolveScope(tx: Tx, requested: number[] | undefined) {
  const rows = requested
    ? await tx.select({ id: enterprise.id }).from(enterprise).where(inArray(enterprise.id, requested)).orderBy(enterprise.id)
    : await tx.selectDistinct({ id: record.enterpriseId }).from(record).where(eq(record.source, 'jxj')).orderBy(record.enterpriseId)
  if (requested && requested.length !== rows.length) throw createError({ statusCode: 400, message: 'Unknown enterprise ID' })
  return rows.map(row => row.id)
}

async function readScope(tx: Tx, enterpriseIds: number[]) {
  const decision = tx.select({ status: d.status, reasonCode: d.reasonCode }).from(d)
    .where(and(eq(d.enterpriseId, c.enterpriseId), eq(d.titleCode, c.titleCode), gt(d.id, c.decisionCutoffId)))
    .orderBy(desc(sql`${d.recordedAt} COLLATE "C"`), desc(d.id)).limit(1).as('decision')
  const rows = await tx.select({
    enterpriseId: c.enterpriseId, titleCode: c.titleCode, comparisonState: c.comparisonState,
    reasons: c.reasons, comparisonError: c.comparisonError, status: decision.status, reasonCode: decision.reasonCode,
    businessFingerprint: c.businessFingerprint, changedAt: c.changedAt, refreshedAt: c.refreshedAt,
  }).from(c).leftJoinLateral(decision, sql`true`).where(sql`${c.enterpriseId} = any(${sql.param(enterpriseIds)}::bigint[])`)
    .orderBy(c.enterpriseId, orderedTitle)
  const byOwner = Map.groupBy(rows, row => row.enterpriseId)
  return enterpriseIds.map(id => ({
    enterpriseId: id,
    comparisons: (byOwner.get(id) ?? []).map(({ enterpriseId: _, reasons, status, ...comparison }) => ({
      ...comparison, reasons: JSON.parse(reasons), status: status ?? 'needs_review',
    })),
  }))
}

export async function readPostgresEnterpriseDifferenceComparisons(db: NodePgDatabase, raw: unknown) {
  const { enterpriseIds } = parseEnterpriseDifferenceRefreshInput(raw)
  return db.transaction(async tx => ({
    refreshed: 0, unchanged: 0, enterprises: await readScope(tx, await resolveScope(tx, enterpriseIds)),
  }), { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

async function refreshBlock(tx: Tx, enterpriseIds: number[], now: string) {
  const rows = await tx.select({ enterpriseId: c.enterpriseId, title: c.titleCode, fingerprint: c.stateFingerprint })
    .from(c).where(inArray(c.enterpriseId, enterpriseIds))
  const previous = new Map(rows.map(row => [key(row.enterpriseId, row.title), row.fingerprint]))
  const pending: Pending[] = []
  for (const { subject, fingerprints } of await readPostgresRefreshFingerprints(tx, enterpriseIds)) {
    const changed = [...fingerprints].filter(([title, fingerprint]) => previous.get(key(subject.id, title)) !== fingerprint)
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
    await tx.update(c).set({ refreshedAt: now }).where(or(...unchanged.map(row =>
      and(eq(c.enterpriseId, row.enterpriseId), eq(c.titleCode, row.title)))))
  }
  const changed = pending.flatMap(row => row.comparison ? [{ ...row, comparison: row.comparison }] : [])
  if (changed.length) {
    const decisions = await tx.select({
      enterpriseId: d.enterpriseId, title: d.titleCode, cutoff: max(d.id),
    }).from(d).where(or(...changed.map(row =>
      and(eq(d.enterpriseId, row.enterpriseId), eq(d.titleCode, row.title))))).groupBy(d.enterpriseId, d.titleCode)
    const cutoffs = new Map(decisions.map(row => [key(row.enterpriseId, row.title), row.cutoff]))
    changed.sort((a, b) => a.enterpriseId - b.enterpriseId || (a.title < b.title ? -1 : Number(a.title > b.title)))
    // Drizzle 0.45.4 does not expose the proposed row of ON CONFLICT as typed columns.
    await tx.insert(c).values(changed.map(row => ({
      enterpriseId: row.enterpriseId, titleCode: row.title, comparisonState: row.comparison.state,
      reasons: JSON.stringify(row.comparison.reasons), comparisonError: row.comparison.error,
      decisionCutoffId: cutoffs.get(key(row.enterpriseId, row.title)) ?? 0,
      businessFingerprint: row.fingerprint, stateFingerprint: row.fingerprint, changedAt: now, refreshedAt: now,
    }))).onConflictDoUpdate({
      target: [c.enterpriseId, c.titleCode],
      set: {
        comparisonState: sql`excluded.comparison_state`, reasons: sql`excluded.reasons`,
        comparisonError: sql`excluded.comparison_error`, decisionCutoffId: sql`excluded.decision_cutoff_id`,
        businessFingerprint: sql`excluded.business_fingerprint`, stateFingerprint: sql`excluded.state_fingerprint`, changedAt: now, refreshedAt: now,
      },
    })
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
