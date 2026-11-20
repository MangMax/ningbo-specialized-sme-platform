import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { z } from 'zod'
import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { readPostgresQueryCoverage } from '../../lib/roster/query-coverage-postgres'
import { readPostgresEvidenceImpacts113 } from '../../lib/roster/query-assessment-postgres'
import { currentPostgresDecisions102, readPostgresDecision102, readPostgresDecisionHead102 } from './decision-lifecycle-102/postgres-reads'
import { DecisionError102, parse102 } from './decision-lifecycle-102'
import { classifyPostgresEvidenceImpacts, readPostgresEvidenceRevision } from './evidence-impact-postgres'
import {
  decodeImpactCursor, impactList114, impactScopeFilter114, invalidImpactCursor, pageImpactRows,
  type EvidenceReviewAnchor, type impactSources114, type impactEvents114, type impactPreview114,
} from './evidence-review-114'
import type { ImpactDecision113 } from './evidence-impact-113'

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
  const { rows: [row] } = await db.execute<EvidenceReviewAnchor>(sql`
    SELECT coalesce(${includePending ? sql`NULL` : sql`(SELECT min(revision_id)-1 FROM evidence_impact_progress_113 WHERE done=0)`},
      (SELECT max(id) FROM evidence_revision_113),0)::float8 AS revision,
      coalesce((SELECT max(id) FROM explanation_impact_113),0)::float8 AS impact,
      coalesce((SELECT max(id) FROM difference_reason),0)::float8 AS decision,
      coalesce((SELECT max(id) FROM evidence_review_receipt_114),0)::float8 AS receipt`)
  return row!
}

async function pageContext(db: NodePgDatabase, operation: string, input: { cursor?: string }) {
  const { cursor, ...filter } = input
  return { filter, ...(cursor ? decodeImpactCursor(operation, filter, cursor) : { asOf: await readAnchor(db), after: 0 }) }
}

async function readRows(db: NodePgDatabase, input: List, anchor: EvidenceReviewAnchor, after: number, id?: number) {
  const { rows } = await db.execute<Impact>(sql`
    WITH frozen AS (
      SELECT i.id,i.enterprise_id,i.title_code,i.direction,i.decision_id,
        coalesce((SELECT max(l.revision_id) FROM evidence_impact_link_113 l WHERE l.impact_id=i.id AND l.revision_id<=${anchor.revision}),0) AS last,
        (SELECT max(r.reviewed_revision_id) FROM evidence_review_receipt_114 r WHERE r.enterprise_id=i.enterprise_id AND r.title_code=i.title_code
          AND r.direction=i.direction AND (r.decision_id=i.decision_id OR r.source_decision_id=i.decision_id) AND r.id<=${anchor.receipt}) AS reviewed,
        (SELECT d.id FROM difference_reason d WHERE d.enterprise_id=i.enterprise_id AND d.title_code=i.title_code AND d.direction=i.direction
          AND d.id<=${anchor.decision} ORDER BY d.recorded_at DESC,d.id DESC LIMIT 1) AS head,
        EXISTS(SELECT 1 FROM enterprise e WHERE e.id=i.enterprise_id AND NOT EXISTS(
          SELECT 1 FROM enterprise_merge m WHERE m.from_enterprise_id=e.id)) AS owner_exists
      FROM explanation_impact_113 i WHERE i.id>${after} AND i.id<=${anchor.impact} AND ${impactScopeFilter114(input,'i')}
        AND ${id === undefined ? sql`true` : sql`i.id=${id}`}
        AND ${input.eventId === undefined ? sql`true` : sql`EXISTS(SELECT 1 FROM evidence_impact_link_113 l
          JOIN evidence_revision_event_113 e ON e.revision_id=l.revision_id WHERE l.impact_id=i.id AND l.revision_id<=${anchor.revision}
            AND e.event_id=${input.eventId} AND e.enterprise_id=i.enterprise_id AND e.title_code=i.title_code)`}
    ), classified AS (
      SELECT f.*,last>coalesce(reviewed,-1) AS pending,
        CASE WHEN NOT owner_exists THEN 'merged'
          WHEN (SELECT lifecycle_action FROM difference_reason WHERE id=f.head)='withdraw' THEN 'withdrawn'
          WHEN decision_id=head THEN 'current' ELSE 'historical' END AS lineage,
        CASE WHEN EXISTS(SELECT 1 FROM evidence_impact_link_113 l WHERE l.impact_id=f.id AND l.revision_id<=${anchor.revision}
          AND l.revision_id>coalesce(f.reviewed,-1) AND l.classification='premise_invalid')
          THEN 'premise_invalid' ELSE 'evidence_changed' END AS classification
      FROM frozen f WHERE last>0 OR reviewed IS NOT NULL
    )
    SELECT id::float8 AS id,enterprise_id::float8 AS "enterpriseId",title_code AS "titleCode",direction,decision_id::float8 AS "decisionId",
      last::float8 AS "latestRevisionId",reviewed::float8 AS "reviewedRevisionId",pending,lineage,classification FROM classified
    WHERE ${input.view === 'all' ? sql`true` : input.view === 'current' ? sql`lineage='current'` : sql`lineage<>'current'`}
      AND ${input.state === 'all' ? sql`true` : input.state === 'pending' ? sql`pending` : sql`NOT pending`}
    ORDER BY id LIMIT ${input.limit + 1}`)
  return rows
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
  return !(await db.execute(sql`SELECT 1 FROM evidence_impact_progress_113 WHERE done=0 LIMIT 1`)).rows.length
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
  const { rows: owners } = await db.execute<{ id: number; name_norm: string; uscc_norm: string | null }>(sql`
    SELECT e.id::float8 AS id,name_norm,uscc_norm FROM enterprise e WHERE id=${row.enterpriseId}
      AND NOT EXISTS(SELECT 1 FROM enterprise_merge m WHERE m.from_enterprise_id=e.id)`)
  const [current] = owners.length ? await currentPostgresDecisions102(db, [scope]) : []
  const latest = current?.versionId ?? (await readPostgresDecisionHead102(db, scope))?.id ?? null
  const { token } = (await readPostgresEvidenceImpacts113(db, [{ scope, decisionId: null, latestDecisionId: latest }]))[0]!
  const coverage = await readPostgresQueryCoverage(db, owners, [scope.titleCode])
  const queryCoverage = coverage.get(row.enterpriseId)?.get(row.titleCode) ?? null
  const { rows: [reviewedBaseline] } = await db.execute(sql`
    SELECT reviewed_revision_id::float8 AS "reviewedRevisionId",actor::json AS actor,basis,rule_version AS "ruleVersion",
      effective_at AS "effectiveAt",recorded_at AS "recordedAt" FROM evidence_review_receipt_114
    WHERE enterprise_id=${row.enterpriseId} AND title_code=${row.titleCode} AND direction=${row.direction}
      AND (decision_id=${row.decisionId} OR source_decision_id=${row.decisionId}) AND reviewed_revision_id IS NOT NULL ORDER BY id DESC LIMIT 1`)
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
  const { rows } = await db.execute<ImpactDecision113>(sql`
    SELECT d.id::float8 AS id,d.enterprise_id::float8 AS "enterpriseId",d.title_code AS "titleCode",d.direction,d.status,
      a.old_id::float8 AS "evidenceQueryId",d.lifecycle_action AS "lifecycleAction"
    FROM difference_reason d LEFT JOIN platform_legacy_query_alias a ON a.collection_id=d.evidence_query_id
    WHERE d.id>${context.after} AND d.id<=${Math.min(context.asOf.decision, revision.maxDecisionId)} AND ${impactScopeFilter114(input,'d')}
      AND ${revision.enterpriseId === null ? sql`true` : sql`d.enterprise_id=${revision.enterpriseId}`}
      AND ${revision.titleCode === null ? sql`true` : sql`d.title_code=${revision.titleCode}`}
      AND ${revision.direction === null ? sql`true` : sql`d.direction=${revision.direction}`}
      AND NOT EXISTS(SELECT 1 FROM difference_reason n WHERE n.enterprise_id=d.enterprise_id AND n.title_code=d.title_code
        AND n.direction=d.direction AND n.id<=${context.asOf.decision} AND (n.recorded_at,n.id)>(d.recorded_at,d.id))
    ORDER BY d.id LIMIT ${input.limit+1}`)
  const classifications = await classifyPostgresEvidenceImpacts(db, revision, rows)
  return pageImpactRows(rows.map((row, index) => ({ ...row, classification: classifications[index]! })), input.limit, 'preview', context, row => row.id)
}

export async function listPostgresImpactSources114(db: NodePgDatabase, input: z.infer<typeof impactSources114>) {
  if (!(await db.execute(sql`SELECT 1 FROM explanation_impact_113 WHERE id=${input.id}`)).rows.length) {
    throw new DecisionError102(404, 'not_found', 'Evidence impact not found')
  }
  const context = await pageContext(db, 'sources', input)
  const { rows } = await db.execute<{ revisionId: number }>(sql`
    SELECT r.id::float8 AS "revisionId",r.source_kind AS "sourceKind",r.source_key AS "sourceKey",r.source_version AS "sourceVersion",
      r.enterprise_id::float8 AS "enterpriseId",r.title_code AS "titleCode",r.direction,r.event_id::float8 AS "eventId",
      r.coverage_changed AS "coverageChanged",r.fact_changed AS "factChanged",r.created_at AS "createdAt",l.classification
    FROM evidence_impact_link_113 l JOIN evidence_revision_113 r ON r.id=l.revision_id
    WHERE l.impact_id=${input.id} AND r.id>${context.after} AND r.id<=${context.asOf.revision}
    ORDER BY r.id LIMIT ${input.limit+1}`)
  return pageImpactRows(rows, input.limit, 'sources', context, row => row.revisionId)
}

export async function listPostgresRevisionEvents114(db: NodePgDatabase, input: z.infer<typeof impactEvents114>) {
  if (!await readPostgresEvidenceRevision(db, input.revisionId)) {
    throw new DecisionError102(404, 'not_found', 'Committed evidence revision not found')
  }
  const context = await pageContext(db, 'events', input)
  const { rows } = await db.execute<{ eventId: number }>(sql`
    SELECT revision_id::float8 AS "revisionId",event_id::float8 AS "eventId",enterprise_id::float8 AS "enterpriseId",title_code AS "titleCode"
    FROM evidence_revision_event_113 WHERE revision_id=${input.revisionId} AND event_id>${context.after}
      AND ${input.enterpriseId === undefined ? sql`true` : sql`enterprise_id=${input.enterpriseId}`}
    ORDER BY event_id LIMIT ${input.limit+1}`)
  return pageImpactRows(rows, input.limit, 'events', context, row => row.eventId)
}
