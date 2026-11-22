import { and, asc, eq, gt, inArray, isNull, lte, max, min, ne, notExists, or, sql } from 'drizzle-orm'
import { alias, type PgColumn } from 'drizzle-orm/pg-core'
import {
  evidenceImpactLink113, evidenceImpactProgress113, evidenceRevision113, evidenceScopeVersion113, explanationImpact113,
} from '../../../../db/postgresql/evidence-review-tables'
import { platformCollection, platformLegacyQueryAlias } from '../../../../db/postgresql/platform-tables'
import { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../../../../db/schema'
import { readPostgresCollectionScopes } from '../../lib/roster/query-coverage-postgres'
import { queryImpactRelevant113, scopeKey113 } from './evidence-impact-model'
import { type ImpactDecision113, type Snapshot113 } from './evidence-impact-113'
import { postgresSnapshotDigest } from './export-snapshot-import-postgres'

type Reader = Pick<NodePgDatabase, 'execute' | 'select'>
type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Revision = typeof schema.evidenceRevision113.$inferSelect
type CollectionScope = Parameters<typeof readPostgresCollectionScopes>[1][number]

export async function readPostgresEvidenceRevision(db: Reader, revisionId: number) {
  const [row] = await db.select().from(evidenceRevision113).where(eq(evidenceRevision113.id, revisionId))
  return row && {
    ...row, coverageChanged: Boolean(row.coverageChanged), factChanged: Boolean(row.factChanged),
    queryExecuted: Boolean(row.queryExecuted), metadata: JSON.parse(row.metadata),
  } satisfies Revision
}

export async function classifyPostgresEvidenceImpacts(db: Reader, revision: Revision, decisions: readonly ImpactDecision113[]) {
  const sourceIds = revision.sourceKind === 'query_archive' ? [...new Set(decisions.flatMap(d =>
    d.evidenceQueryId && d.status !== 'not_queried' ? [d.evidenceQueryId] : []))] : []
  const found = sourceIds.length ? await db.select({ id: platformLegacyQueryAlias.oldId, collection: platformCollection })
    .from(platformLegacyQueryAlias).innerJoin(platformCollection, eq(platformCollection.id, platformLegacyQueryAlias.collectionId))
    .where(inArray(platformLegacyQueryAlias.oldId, sourceIds)) : []
  const collections = new Map(found.map(row => [row.id, row.collection]))
  const scopes = await readPostgresCollectionScopes(db, found.map(row => row.collection as CollectionScope))
  const results: Array<'no_review' | 'premise_invalid' | 'evidence_changed'> = []
  for (const decision of decisions) {
    let relevant = decision.id <= revision.maxDecisionId && decision.lifecycleAction !== 'withdraw'
      && (revision.enterpriseId === null || revision.enterpriseId === decision.enterpriseId)
      && (revision.titleCode === null || revision.titleCode === decision.titleCode)
      && (revision.direction === null || revision.direction === decision.direction)
    if (relevant && revision.sourceKind === 'query_archive' && decision.evidenceQueryId && decision.status !== 'not_queried') {
      const collection = collections.get(decision.evidenceQueryId)
      const scope = collection && scopes.get(collection.id)
      relevant = queryImpactRelevant113(revision.metadata, decision.titleCode, collection && scope ? {
        interface: collection.interface, conditions: scope.conditions, fullRange: collection.fullRange,
        pages: scope.pages.map(page => ({ rdjb: page.rdjb, page: page.pageNo })),
      } : null)
    }
    if (relevant && revision.sourceKind === 'selected_snapshot') {
      const before = await postgresSnapshotDigest(db, revision.metadata.before as Snapshot113 | null, decision.enterpriseId)
      const after = await postgresSnapshotDigest(db, revision.metadata.after as Snapshot113, decision.enterpriseId)
      relevant = before !== after
    }
    results.push(!relevant ? 'no_review' : revision.queryExecuted && decision.status === 'not_queried' ? 'premise_invalid'
      : revision.factChanged ? 'evidence_changed' : 'no_review')
  }
  return results
}

export async function readPostgresImpactDecisions(db: Reader, input: {
  after: number; maxId: number; limit: number; headMaxId?: number; includeWithdrawn?: boolean
  enterpriseId?: number | null; titleCode?: string | null; direction?: string | null
  enterpriseFilter?: number; titleFilter?: string; directionFilter?: string; decisionFilter?: number
}) {
  const decision = differenceReason
  const newer = alias(decision, 'newer_decision')
  const laterInScope = db.select({ id: newer.id }).from(newer).where(and(
    eq(newer.enterpriseId, decision.enterpriseId), eq(newer.titleCode, decision.titleCode), eq(newer.direction, decision.direction),
    input.headMaxId === undefined ? undefined : lte(newer.id, input.headMaxId),
    or(gt(newer.recordedAt, decision.recordedAt), and(eq(newer.recordedAt, decision.recordedAt), gt(newer.id, decision.id))),
  ))
  const filter = (column: PgColumn, value: number | string | null | undefined) => value == null ? undefined : eq(column, value)
  const rows = await db.select({
    id: decision.id, enterpriseId: decision.enterpriseId, titleCode: decision.titleCode, direction: decision.direction, status: decision.status,
    evidenceQueryId: platformLegacyQueryAlias.oldId, lifecycleAction: decision.lifecycleAction,
  }).from(decision).leftJoin(platformLegacyQueryAlias, eq(platformLegacyQueryAlias.collectionId, decision.evidenceQueryId))
    .where(and(gt(decision.id, input.after), lte(decision.id, input.maxId),
      filter(decision.enterpriseId, input.enterpriseId), filter(decision.titleCode, input.titleCode), filter(decision.direction, input.direction),
      filter(decision.enterpriseId, input.enterpriseFilter), filter(decision.titleCode, input.titleFilter), filter(decision.direction, input.directionFilter), filter(decision.id, input.decisionFilter),
      input.includeWithdrawn ? undefined : or(ne(decision.lifecycleAction, 'withdraw'), isNull(decision.lifecycleAction)),
      notExists(laterInScope),
    )).orderBy(asc(decision.id)).limit(input.limit)
  return rows satisfies ImpactDecision113[]
}

export async function processPostgresEvidenceImpacts(tx: Tx, limit: number) {
  const state = evidenceImpactProgress113
  const impacts = explanationImpact113
  let processed = 0
  while (processed < limit) {
    const [progress] = await tx.select().from(state).where(eq(state.done, 0))
      .orderBy(asc(state.revisionId)).limit(1).for('update')
    if (!progress) break
    const revision = (await readPostgresEvidenceRevision(tx, progress.revisionId))!
    const remaining = limit - processed
    const candidates = await readPostgresImpactDecisions(tx, {
      ...revision, after: progress.cursor, maxId: revision.maxDecisionId, limit: remaining,
    })
    const classifications = await classifyPostgresEvidenceImpacts(tx, revision, candidates)
    for (const [index, decision] of candidates.entries()) {
      const classification = classifications[index]!
      if (classification === 'no_review') continue
      const [impact] = await tx.insert(impacts).values({
        enterpriseId: decision.enterpriseId, titleCode: decision.titleCode, direction: decision.direction, decisionId: decision.id,
        latestRevisionId: revision.id, pendingSinceRevisionId: revision.id, classification,
      }).onConflictDoUpdate({
        target: [impacts.enterpriseId, impacts.titleCode, impacts.direction, impacts.decisionId],
        set: {
          latestRevisionId: revision.id,
          // Drizzle has no CASE expression builder. Keep both state transitions inside the atomic upsert.
          classification: sql`CASE WHEN ${impacts.classification}='premise_invalid' THEN 'premise_invalid' ELSE ${classification} END`,
          pendingSinceRevisionId: sql`CASE WHEN ${impacts.reviewedRevisionId}>=${impacts.latestRevisionId} THEN ${revision.id} ELSE ${impacts.pendingSinceRevisionId} END`,
        },
      }).returning({ id: impacts.id })
      await tx.insert(evidenceImpactLink113).values({ revisionId: revision.id, impactId: impact!.id, classification }).onConflictDoNothing()
    }
    processed += Math.max(1, candidates.length)
    const done = candidates.length < remaining
    await tx.update(state).set({ cursor: candidates.at(-1)?.id ?? progress.cursor, done: Number(done) })
      .where(eq(state.revisionId, progress.revisionId))
    if (done) {
      const key = scopeKey113(revision.enterpriseId, revision.titleCode, revision.direction)
      // Drizzle has no arithmetic update operator. Keep the decrement atomic with the write.
      await tx.update(evidenceScopeVersion113).set({ pendingCount: sql`${evidenceScopeVersion113.pendingCount} - 1` })
        .where(eq(evidenceScopeVersion113.scopeKey, key))
    }
  }
  const next = tx.select({ id: min(state.revisionId).as('next_revision_id') }).from(state).where(eq(state.done, 0)).as('next_revision')
  const last = tx.select({ id: max(evidenceRevision113.id).as('last_revision_id') }).from(evidenceRevision113).as('last_revision')
  const [watermark] = await tx.select({ next: next.id, last: last.id }).from(next).crossJoin(last)
  return { processed, unfinished: watermark!.next !== null, watermark: watermark!.next === null ? watermark!.last ?? 0 : watermark!.next - 1 }
}
