import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, exists, gt, isNotNull, isNull, lte, max, min, ne, notExists, or, sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise, enterpriseMerge } from '../../../../db/postgresql/enterprise-tables'
import {
  evidenceImpactLink113, evidenceImpactProgress113, evidenceReviewReceipt114, evidenceRevision113,
  evidenceRevisionEvent113, explanationImpact113,
} from '../../../../db/postgresql/evidence-review-tables'
import { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import type { z } from 'zod'
import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { readPostgresQueryCoverage } from '../../lib/roster/query-coverage-postgres'
import { readPostgresEvidenceImpacts113 } from '../../lib/roster/query-assessment-postgres'
import { currentPostgresDecisions102, readPostgresDecision102, readPostgresDecisionHead102 } from './decision-lifecycle-102/postgres-reads'
import { DecisionError102, parse102 } from './decision-lifecycle-102/contract'
import { classifyPostgresEvidenceImpacts, readPostgresEvidenceRevision, readPostgresImpactDecisions } from './evidence-impact-postgres'
import { decodeImpactCursor, impactList114, invalidImpactCursor, pageImpactRows, type EvidenceReviewAnchor, type impactSources114, type impactEvents114, type impactPreview114 } from './evidence-review-114-contract'

type List = z.infer<typeof impactList114>
type Impact = { id: number; enterpriseId: number; titleCode: string; direction: 'missing_in_miit' | 'extra_in_miit';
  decisionId: number; latestRevisionId: number; reviewedRevisionId: number | null; pending: boolean;
  lineage: 'current' | 'historical' | 'withdrawn' | 'merged'; classification: 'premise_invalid' | 'evidence_changed' }
type Snapshot = { db: NodePgDatabase; close(): Promise<void> }
const snapshots = new Map<string, Snapshot>()

async function closeSnapshot(id: string) {
  const snapshot = snapshots.get(id)
  if (!snapshot) return
  snapshots.delete(id)
  await snapshot.close()
}

export async function closePostgresReviewSnapshots() {
  await Promise.all([...snapshots.keys()].map(closeSnapshot))
}

async function openSnapshot() {
  if (snapshots.size >= 4) await closeSnapshot(snapshots.keys().next().value!)
  const client = await usePostgresDirectoryDb()!.$client.connect()
  // Drizzle's transaction callback cannot return a transaction for later HTTP requests. Keep the read-only client leased until cursor expiry.
  try { await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY') }
  catch (error) { client.release(true); throw error }
  const id = randomUUID()
  const timer = setTimeout(() => { void closeSnapshot(id) }, 120_000)
  timer.unref()
  const onError = () => { void closeSnapshot(id) }
  client.on('error', onError)
  const snapshot = { db: drizzle({ client }), async close() {
    clearTimeout(timer)
    client.off('error', onError)
    try { await client.query('ROLLBACK'); client.release() }
    catch { client.release(true) }
  } }
  while (snapshots.size >= 4) await closeSnapshot(snapshots.keys().next().value!)
  snapshots.set(id, snapshot)
  return { id, ...snapshot }
}

async function readAnchor(db: NodePgDatabase, includePending = false) {
  const impact = db.select({ id: max(explanationImpact113.id).as('max_impact_id') }).from(explanationImpact113).as('impact_anchor')
  const revision = db.select({ id: max(evidenceRevision113.id).as('max_revision_id') }).from(evidenceRevision113).as('revision_anchor')
  const decision = db.select({ id: max(differenceReason.id).as('max_decision_id') }).from(differenceReason).as('decision_anchor')
  const receipt = db.select({ id: max(evidenceReviewReceipt114.id).as('max_receipt_id') }).from(evidenceReviewReceipt114).as('receipt_anchor')
  const progress = db.select({ id: min(evidenceImpactProgress113.revisionId).as('first_pending_revision_id') }).from(evidenceImpactProgress113)
    .where(eq(evidenceImpactProgress113.done, 0)).as('progress_anchor')
  const [row] = await db.select({
    impact: impact.id, revision: revision.id, decision: decision.id, receipt: receipt.id, firstPending: progress.id,
  }).from(revision).crossJoin(impact).crossJoin(decision).crossJoin(receipt).crossJoin(progress)
  const { firstPending } = row!
  return {
    impact: row!.impact ?? 0, decision: row!.decision ?? 0, receipt: row!.receipt ?? 0,
    revision: !includePending && firstPending !== null ? firstPending - 1 : row!.revision ?? 0,
  } satisfies EvidenceReviewAnchor
}

async function pageContext(db: NodePgDatabase, operation: string, input: { cursor?: string }) {
  const { cursor, ...filter } = input
  return { filter, ...(cursor ? decodeImpactCursor(operation, filter, cursor) : { asOf: await readAnchor(db), after: 0 }) }
}

async function readRows(db: NodePgDatabase, input: List, anchor: EvidenceReviewAnchor, after: number, id?: number) {
  const i = explanationImpact113
  const link = evidenceImpactLink113
  const event = evidenceRevisionEvent113
  const receipt = evidenceReviewReceipt114
  const decision = differenceReason
  const last = db.select({ id: max(link.revisionId).as('last_link_revision_id') }).from(link)
    .where(and(eq(link.impactId, i.id), lte(link.revisionId, anchor.revision))).as('last_revision')
  const reviewed = db.select({ id: max(receipt.reviewedRevisionId).as('max_reviewed_revision_id') }).from(receipt).where(and(
    eq(receipt.enterpriseId, i.enterpriseId), eq(receipt.titleCode, i.titleCode), eq(receipt.direction, i.direction),
    or(eq(receipt.decisionId, i.decisionId), eq(receipt.sourceDecisionId, i.decisionId)), lte(receipt.id, anchor.receipt),
  )).as('reviewed_revision')
  const head = db.select({ id: decision.id, action: decision.lifecycleAction }).from(decision).where(and(
    eq(decision.enterpriseId, i.enterpriseId), eq(decision.titleCode, i.titleCode), eq(decision.direction, i.direction), lte(decision.id, anchor.decision),
  )).orderBy(desc(decision.recordedAt), desc(decision.id)).limit(1).as('decision_head')
  const merge = db.select({ id: enterpriseMerge.fromEnterpriseId }).from(enterpriseMerge)
    .where(eq(enterpriseMerge.fromEnterpriseId, enterprise.id))
  const liveOwner = db.select({ id: enterprise.id }).from(enterprise).where(and(eq(enterprise.id, i.enterpriseId), notExists(merge)))
  const invalidPremise = db.select({ id: link.revisionId }).from(link).where(and(
    eq(link.impactId, i.id), lte(link.revisionId, anchor.revision), eq(link.classification, 'premise_invalid'),
    or(isNull(reviewed.id), gt(link.revisionId, reviewed.id)),
  ))
  const matchingEvent = input.eventId === undefined ? undefined : exists(db.select({ id: event.eventId }).from(link)
    .innerJoin(event, eq(event.revisionId, link.revisionId)).where(and(
      eq(link.impactId, i.id), lte(link.revisionId, anchor.revision), eq(event.eventId, input.eventId),
      eq(event.enterpriseId, i.enterpriseId), eq(event.titleCode, i.titleCode),
    )))
  const classified = db.$with('classified').as(db.select({
    id: i.id, enterpriseId: i.enterpriseId, titleCode: i.titleCode, direction: i.direction, decisionId: i.decisionId,
    latestRevisionId: last.id, reviewedRevisionId: reviewed.id,
    pending: or(isNull(reviewed.id), and(isNotNull(last.id), gt(last.id, reviewed.id)))!.as('pending'),
    // Drizzle has no CASE expression builder. These classifications also drive filtering before pagination.
    lineage: sql<Impact['lineage']>`CASE WHEN ${notExists(liveOwner)} THEN 'merged'
      WHEN ${eq(head.action, 'withdraw')} THEN 'withdrawn'
      WHEN ${eq(i.decisionId, head.id)} THEN 'current' ELSE 'historical' END`.as('lineage'),
    classification: sql<Impact['classification']>`CASE WHEN ${exists(invalidPremise)} THEN 'premise_invalid'
      ELSE 'evidence_changed' END`.as('classification'),
  }).from(i).crossJoinLateral(last).crossJoinLateral(reviewed).leftJoinLateral(head, sql`true`)
    .where(and(gt(i.id, after), lte(i.id, anchor.impact), or(gt(last.id, 0), isNotNull(reviewed.id)),
      input.enterpriseId == null ? undefined : eq(i.enterpriseId, input.enterpriseId),
      input.titleCode == null ? undefined : eq(i.titleCode, input.titleCode),
      input.direction == null ? undefined : eq(i.direction, input.direction),
      input.decisionId == null ? undefined : eq(i.decisionId, input.decisionId),
      id === undefined ? undefined : eq(i.id, id), matchingEvent,
    )))
  const rows = await db.with(classified).select().from(classified).where(and(
    input.view === 'all' ? undefined : input.view === 'current' ? eq(classified.lineage, 'current') : ne(classified.lineage, 'current'),
    input.state === 'all' ? undefined : eq(classified.pending, input.state === 'pending'),
  )).orderBy(asc(classified.id)).limit(input.limit + 1)
  return rows.map(row => ({
    ...row, direction: row.direction as Impact['direction'], latestRevisionId: row.latestRevisionId ?? 0, pending: Boolean(row.pending),
  })) satisfies Impact[]
}

async function hydrate(db: NodePgDatabase, row: Impact) {
  try { return { ...row, oldDecision: { ...await readPostgresDecision102(db, row.decisionId), isCurrent: row.lineage === 'current' } } }
  catch (error) {
    if (!(error instanceof DecisionError102) || error.code !== 'not_found') throw error
    return { ...row, oldDecision: null }
  }
}

async function projectionReady(db: NodePgDatabase, input: List) {
  if (input.enterpriseId && input.titleCode && input.direction) {
    return (await readPostgresEvidenceImpacts113(db, [{
      scope: { enterpriseId: input.enterpriseId, titleCode: input.titleCode, direction: input.direction },
      decisionId: null, latestDecisionId: null,
    }]))[0]!.token.projectionReady
  }
  return !(await db.select({ id: evidenceImpactProgress113.revisionId }).from(evidenceImpactProgress113)
    .where(eq(evidenceImpactProgress113.done, 0)).limit(1)).length
}

export async function listPostgresImpacts114(input: List) {
  const { cursor, ...filter } = input
  const opened = cursor ? null : await openSnapshot()
  let id: string | undefined = opened?.id
  try {
    const context = cursor ? decodeImpactCursor('list', filter, cursor)
      : { asOf: { ...await readAnchor(opened!.db), snapshotId: opened!.id }, after: 0 }
    id = context.asOf.snapshotId
    const snapshot = snapshots.get(id!)
    if (!snapshot) throw invalidImpactCursor()
    const rows = await readRows(snapshot.db, input, context.asOf, context.after)
    const ready = await projectionReady(snapshot.db, input)
    const items = []
    for (const row of rows) items.push(await hydrate(snapshot.db, row))
    const page = pageImpactRows(items, input.limit, 'list', { ...context, filter }, row => row.id)
    if (!page.nextCursor && opened) await closeSnapshot(opened.id)
    return { ...page, projectionReady: ready }
  } catch (error) {
    if (id) await closeSnapshot(id)
    throw error
  }
}

export async function getPostgresImpact114(db: NodePgDatabase, id: number) {
  const [row] = await readRows(db, parse102(impactList114, { view: 'all', state: 'all' }), await readAnchor(db, true), 0, id)
  if (!row) throw new DecisionError102(404, 'not_found', 'Evidence impact not found')
  const scope = { enterpriseId: row.enterpriseId, titleCode: row.titleCode, direction: row.direction }
  const merged = db.select({ id: enterpriseMerge.fromEnterpriseId }).from(enterpriseMerge)
    .where(eq(enterpriseMerge.fromEnterpriseId, enterprise.id))
  const owners = await db.select({ id: enterprise.id, name_norm: enterprise.nameNorm, uscc_norm: enterprise.usccNorm })
    .from(enterprise).where(and(eq(enterprise.id, row.enterpriseId), notExists(merged)))
  const [current] = owners.length ? await currentPostgresDecisions102(db, [scope]) : []
  const latest = current?.versionId ?? (await readPostgresDecisionHead102(db, scope))?.id ?? null
  const { token } = (await readPostgresEvidenceImpacts113(db, [{ scope, decisionId: null, latestDecisionId: latest }]))[0]!
  const coverage = await readPostgresQueryCoverage(db, owners, [scope.titleCode])
  const queryCoverage = coverage.get(row.enterpriseId)?.get(row.titleCode) ?? null
  const r = evidenceReviewReceipt114
  const [baseline] = await db.select({
    reviewedRevisionId: r.reviewedRevisionId, actor: r.actor, basis: r.basis, ruleVersion: r.ruleVersion,
    effectiveAt: r.effectiveAt, recordedAt: r.recordedAt,
  }).from(r).where(and(eq(r.enterpriseId, row.enterpriseId), eq(r.titleCode, row.titleCode), eq(r.direction, row.direction),
    or(eq(r.decisionId, row.decisionId), eq(r.sourceDecisionId, row.decisionId)), isNotNull(r.reviewedRevisionId),
  )).orderBy(desc(r.id)).limit(1)
  const reviewedBaseline = baseline ? { ...baseline, actor: JSON.parse(baseline.actor) } : null
  const hydrated = await hydrate(db, row)
  return { ...hydrated, reviewedBaseline: reviewedBaseline ?? null, currentDecision: current ?? null, evidenceToken: token, queryCoverage,
    gaps: { decisionUnavailable: !hydrated.oldDecision, coverageStatus: queryCoverage?.status ?? 'unknown',
      truncated: queryCoverage?.truncated ?? false, subjectUnknown: !queryCoverage?.sources.some(source => ['exact_uscc','matched_relation'].includes(source.subjectMatch)),
      projectionReady: token.projectionReady } }
}

export async function previewPostgresImpacts114(db: NodePgDatabase, input: z.infer<typeof impactPreview114>) {
  const revision = await readPostgresEvidenceRevision(db, input.revisionId)
  if (!revision) throw new DecisionError102(404, 'not_found', 'Committed evidence revision not found')
  const context = await pageContext(db, 'preview', input)
  const rows = await readPostgresImpactDecisions(db, {
    ...revision, after: context.after, maxId: Math.min(context.asOf.decision, revision.maxDecisionId),
    headMaxId: context.asOf.decision, includeWithdrawn: true, limit: input.limit + 1,
    enterpriseFilter: input.enterpriseId, titleFilter: input.titleCode, directionFilter: input.direction, decisionFilter: input.decisionId,
  })
  const classifications = await classifyPostgresEvidenceImpacts(db, revision, rows)
  return pageImpactRows(rows.map((row, index) => ({ ...row, classification: classifications[index]! })), input.limit, 'preview', context, row => row.id)
}

export async function listPostgresImpactSources114(db: NodePgDatabase, input: z.infer<typeof impactSources114>) {
  if (!(await db.select({ id: explanationImpact113.id }).from(explanationImpact113).where(eq(explanationImpact113.id, input.id))).length) {
    throw new DecisionError102(404, 'not_found', 'Evidence impact not found')
  }
  const context = await pageContext(db, 'sources', input)
  const r = evidenceRevision113
  const link = evidenceImpactLink113
  const revisions = await db.select({
    revisionId: r.id, sourceKind: r.sourceKind, sourceKey: r.sourceKey, sourceVersion: r.sourceVersion,
    enterpriseId: r.enterpriseId, titleCode: r.titleCode, direction: r.direction, eventId: r.eventId,
    coverageChanged: r.coverageChanged, factChanged: r.factChanged, createdAt: r.createdAt, classification: link.classification,
  }).from(link).innerJoin(r, eq(r.id, link.revisionId))
    .where(and(eq(link.impactId, input.id), gt(r.id, context.after), lte(r.id, context.asOf.revision)))
    .orderBy(asc(r.id)).limit(input.limit + 1)
  const rows = revisions.map(row => ({ ...row, coverageChanged: String(row.coverageChanged), factChanged: String(row.factChanged) }))
  return pageImpactRows(rows, input.limit, 'sources', context, row => row.revisionId)
}

export async function listPostgresRevisionEvents114(db: NodePgDatabase, input: z.infer<typeof impactEvents114>) {
  if (!await readPostgresEvidenceRevision(db, input.revisionId)) {
    throw new DecisionError102(404, 'not_found', 'Committed evidence revision not found')
  }
  const context = await pageContext(db, 'events', input)
  const event = evidenceRevisionEvent113
  const rows = await db.select().from(event).where(and(
    eq(event.revisionId, input.revisionId), gt(event.eventId, context.after),
    input.enterpriseId === undefined ? undefined : eq(event.enterpriseId, input.enterpriseId),
  )).orderBy(asc(event.eventId)).limit(input.limit + 1)
  return pageImpactRows(rows, input.limit, 'events', context, row => row.eventId)
}
