import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { evidenceDigest113 } from './evidence-impact-113'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Revision = {
  sourceKind: string; sourceKey: string; sourceVersion: string; factDigest: string
  beforeFactDigest?: string; coverageDigest?: string; queryExecuted?: boolean
  enterpriseId?: number; titleCode?: string; direction?: string; eventId?: number
  metadata?: Record<string, unknown>
}
const empty = evidenceDigest113([])

export async function appendPostgresEvidenceRevision(tx: Tx, input: Revision) {
  const sourceKey = `${input.sourceKind}:${input.sourceKey}`
  const coverage = input.coverageDigest ?? empty
  const metadata = JSON.stringify(input.metadata ?? {})
  if (Buffer.byteLength(metadata) > 16384) throw new Error('Evidence revision metadata exceeds 16KiB')
  const { rows: [revision] } = await tx.execute<{ id: number }>(sql`
    INSERT INTO evidence_revision_113(source_kind,source_key,source_version,enterprise_id,title_code,direction,event_id,
      coverage_digest,fact_digest,coverage_changed,fact_changed,query_executed,metadata,max_decision_id,created_at)
    SELECT ${input.sourceKind},${sourceKey},${input.sourceVersion},${input.enterpriseId ?? null},${input.titleCode ?? null},
      ${input.direction ?? null},${input.eventId ?? null},${coverage},${input.factDigest},changed.coverage::int,changed.fact::int,
      ${input.queryExecuted ? 1 : 0},${metadata},coalesce((SELECT max(id) FROM difference_reason),0),${new Date().toISOString()}
    FROM (SELECT ${coverage}<>coalesce(h.coverage_digest,${empty}) AS coverage,
      ${input.factDigest}<>coalesce(${input.beforeFactDigest ?? null},h.fact_digest,${empty}) AS fact
      FROM (VALUES (${sourceKey})) v(key) LEFT JOIN evidence_semantic_head_113 h ON h.source_key=v.key) changed
    WHERE changed.coverage OR changed.fact
    ON CONFLICT (source_kind,source_key,source_version) DO NOTHING RETURNING id::float8 AS id`)
  if (!revision) return null
  await tx.execute(sql`
    INSERT INTO evidence_semantic_head_113(source_key,coverage_digest,fact_digest,latest_revision_id)
      VALUES (${sourceKey},${coverage},${input.factDigest},${revision.id})
    ON CONFLICT(source_key) DO UPDATE SET coverage_digest=excluded.coverage_digest,fact_digest=excluded.fact_digest,
      latest_revision_id=excluded.latest_revision_id`)
  await tx.execute(sql`INSERT INTO evidence_impact_progress_113(revision_id) VALUES (${revision.id})`)
  const scope = JSON.stringify([input.enterpriseId ?? null,input.titleCode ?? null,input.direction ?? null])
  await tx.execute(sql`
    INSERT INTO evidence_scope_version_113(scope_key,latest_revision_id,pending_count) VALUES (${scope},${revision.id},1)
    ON CONFLICT(scope_key) DO UPDATE SET latest_revision_id=excluded.latest_revision_id,
      pending_count=evidence_scope_version_113.pending_count+1`)
  if (input.eventId != null && input.enterpriseId != null && input.titleCode != null) await tx.execute(sql`
    INSERT INTO evidence_revision_event_113(revision_id,event_id,enterprise_id,title_code)
    VALUES (${revision.id},${input.eventId},${input.enterpriseId},${input.titleCode}) ON CONFLICT DO NOTHING`)
  return revision.id
}
