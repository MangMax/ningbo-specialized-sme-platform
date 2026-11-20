import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { readPostgresCollectionScopes } from '../../lib/roster/query-coverage-postgres'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { queryImpactRelevant113, scopeKey113, type ImpactDecision113, type Snapshot113 } from './evidence-impact-113'
import { postgresSnapshotDigest } from './export-snapshot-import-postgres'

type Reader = Pick<NodePgDatabase, 'execute'>
type Revision = typeof schema.evidenceRevision113.$inferSelect

export async function readPostgresEvidenceRevision(db: Reader, revisionId: number) {
  const { rows: [found] } = await db.execute<{ row: Revision }>(sql`
    SELECT ${postgresRosterRow(schema.evidenceRevision113,'p')} AS row FROM evidence_revision_113 p WHERE id=${revisionId}`)
  return found?.row
}

export async function classifyPostgresEvidenceImpacts(db: Reader, revision: Revision, decisions: readonly ImpactDecision113[]) {
  const sourceIds = revision.sourceKind === 'query_archive' ? [...new Set(decisions.flatMap(d =>
    d.evidenceQueryId && d.status !== 'not_queried' ? [d.evidenceQueryId] : []))] : []
  const found = sourceIds.length ? (await db.execute<{ id: number; collection: typeof schema.platformCollection.$inferSelect }>(sql`
    SELECT a.old_id::float8 AS id,${postgresRosterRow(schema.platformCollection,'c')} AS collection
    FROM platform_legacy_query_alias a JOIN platform_collection c ON c.id=a.collection_id
    WHERE a.old_id=ANY(${sql.param(sourceIds)}::bigint[])`)).rows : []
  const collections = new Map(found.map(row => [row.id, row.collection]))
  const scopes = await readPostgresCollectionScopes(db, found.map(row => row.collection))
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

export async function processPostgresEvidenceImpacts(db: Reader, limit: number) {
  let processed = 0
  while (processed < limit) {
    const { rows: [progress] } = await db.execute<{ revisionId: number; cursor: number }>(sql`
      SELECT revision_id::float8 AS "revisionId",cursor::float8 AS cursor
      FROM evidence_impact_progress_113 WHERE done=0 ORDER BY revision_id LIMIT 1 FOR UPDATE`)
    if (!progress) break
    const revision = (await readPostgresEvidenceRevision(db, progress.revisionId))!
    const remaining = limit - processed
    const { rows: candidates } = await db.execute<ImpactDecision113>(sql`
      SELECT d.id::float8 AS id,d.enterprise_id::float8 AS "enterpriseId",d.title_code AS "titleCode",d.direction,d.status,
        a.old_id::float8 AS "evidenceQueryId"
      FROM difference_reason d LEFT JOIN platform_legacy_query_alias a ON a.collection_id=d.evidence_query_id
      WHERE d.id>${progress.cursor} AND d.id<=${revision.maxDecisionId}
      AND ${revision.enterpriseId === null ? sql`true` : sql`d.enterprise_id=${revision.enterpriseId}`}
      AND ${revision.titleCode === null ? sql`true` : sql`d.title_code=${revision.titleCode}`}
      AND ${revision.direction === null ? sql`true` : sql`d.direction=${revision.direction}`}
      AND d.lifecycle_action IS DISTINCT FROM 'withdraw'
      AND NOT EXISTS(SELECT 1 FROM difference_reason n WHERE n.enterprise_id=d.enterprise_id AND n.title_code=d.title_code
        AND n.direction=d.direction AND (n.recorded_at,n.id)>(d.recorded_at,d.id))
      ORDER BY d.id LIMIT ${remaining}`)
    const classifications = await classifyPostgresEvidenceImpacts(db, revision, candidates)
    for (const [index, decision] of candidates.entries()) {
      const classification = classifications[index]!
      if (classification === 'no_review') continue
      await db.execute(sql`
        WITH impact AS (
          INSERT INTO explanation_impact_113 AS i(enterprise_id,title_code,direction,decision_id,latest_revision_id,pending_since_revision_id,classification)
          VALUES(${decision.enterpriseId},${decision.titleCode},${decision.direction},${decision.id},${revision.id},${revision.id},${classification})
          ON CONFLICT(enterprise_id,title_code,direction,decision_id) DO UPDATE
          SET latest_revision_id=excluded.latest_revision_id,
            classification=CASE WHEN i.classification='premise_invalid' THEN 'premise_invalid' ELSE excluded.classification END,
            pending_since_revision_id=CASE WHEN i.reviewed_revision_id>=i.latest_revision_id THEN excluded.latest_revision_id ELSE i.pending_since_revision_id END
          RETURNING id
        )
        INSERT INTO evidence_impact_link_113(revision_id,impact_id,classification)
        SELECT ${revision.id},id,${classification} FROM impact ON CONFLICT DO NOTHING`)
    }
    processed += Math.max(1, candidates.length)
    const done = candidates.length < remaining
    await db.execute(sql`UPDATE evidence_impact_progress_113 SET cursor=${candidates.at(-1)?.id ?? progress.cursor},done=${done ? 1 : 0}
      WHERE revision_id=${progress.revisionId}`)
    if (done) {
      const key = scopeKey113(revision.enterpriseId, revision.titleCode, revision.direction)
      await db.execute(sql`UPDATE evidence_scope_version_113 SET pending_count=pending_count-1 WHERE scope_key=${key}`)
    }
  }
  const { rows: [watermark] } = await db.execute<{ next: number | null; last: number }>(sql`
    SELECT (SELECT min(revision_id) FROM evidence_impact_progress_113 WHERE done=0)::float8 AS next,
      coalesce((SELECT max(id) FROM evidence_revision_113),0)::float8 AS last`)
  return { processed, unfinished: watermark!.next !== null, watermark: watermark!.next === null ? watermark!.last : watermark!.next - 1 }
}
