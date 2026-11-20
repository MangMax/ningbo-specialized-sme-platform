import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { attachPostgresReviewedEnterprise, EnterpriseKernelError, type ReviewedSubject } from '../../../core/server/public'
import { evidenceDigest113 } from './evidence-impact-113'

type Transaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]

async function identityMaterial(tx: Transaction, enterpriseId: number) {
  const { rows: [enterprise] } = await tx.execute<{ uscc: string | null; name: string }>(sql`
    SELECT uscc_norm AS uscc, name_norm AS name FROM enterprise WHERE id = ${enterpriseId}`)
  const { rows } = await tx.execute<{ name: string; from: string | null; to: string | null }>(sql`
    SELECT DISTINCT name_norm AS name, valid_from AS "from", valid_to AS "to" FROM enterprise_alias
    WHERE enterprise_id = ${enterpriseId} AND verification_status = 'confirmed'`)
  return evidenceDigest113({ enterprise: enterprise ?? null, aliases: rows.map(evidenceDigest113).sort() })
}

async function captureIdentityRevision(tx: Transaction, enterpriseId: number, auditId: number, factDigest: string) {
  const sourceKey = `identity:enterprise:${enterpriseId}`
  const empty = evidenceDigest113([])
  const { rows: [revision] } = await tx.execute<{ id: string }>(sql`
    INSERT INTO evidence_revision_113 (source_kind, source_key, source_version, enterprise_id,
      coverage_digest, fact_digest, coverage_changed, fact_changed, query_executed, metadata, max_decision_id, created_at)
    SELECT 'identity', ${sourceKey}, ${`profile:${auditId}`}, ${enterpriseId}, ${empty}, ${factDigest},
      CASE WHEN coalesce((SELECT coverage_digest FROM evidence_semantic_head_113 WHERE source_key = ${sourceKey}), ${empty}) = ${empty}
           THEN '0' ELSE '1' END::bigint,
      '1', '0', ${JSON.stringify({ fromEnterpriseId: null })}, coalesce((SELECT max(id) FROM difference_reason), 0),
      ${new Date().toISOString()}
    ON CONFLICT (source_kind, source_key, source_version) DO NOTHING RETURNING id`)
  if (!revision) return
  const revisionId = revision.id
  await tx.execute(sql`
    INSERT INTO evidence_semantic_head_113 (source_key, coverage_digest, fact_digest, latest_revision_id)
    VALUES (${sourceKey}, ${empty}, ${factDigest}, ${revisionId})
    ON CONFLICT (source_key) DO UPDATE SET coverage_digest = excluded.coverage_digest,
      fact_digest = excluded.fact_digest, latest_revision_id = excluded.latest_revision_id`)
  await tx.execute(sql`INSERT INTO evidence_impact_progress_113 (revision_id) VALUES (${revisionId})`)
  await tx.execute(sql`
    INSERT INTO evidence_scope_version_113 (scope_key, latest_revision_id, pending_count)
    VALUES (${JSON.stringify([enterpriseId, null, null])}, ${revisionId}, 1)
    ON CONFLICT (scope_key) DO UPDATE SET latest_revision_id = excluded.latest_revision_id,
      pending_count = evidence_scope_version_113.pending_count + 1`)
  await tx.execute(sql`
    INSERT INTO evidence_revision_event_113 (revision_id, event_id, enterprise_id, title_code)
    SELECT ${revisionId}, e.id, r.enterprise_id, r.title_code FROM record r JOIN record_event e ON e.record_id = r.id
    WHERE r.enterprise_id = ${enterpriseId} ON CONFLICT DO NOTHING`)
}

export async function applyPostgresReviewedRosterIdentity(tx: Transaction, subject: Extract<ReviewedSubject, { action: 'attach' }>) {
  if (subject.fields?.name === undefined && subject.fields?.uscc === undefined) {
    return attachPostgresReviewedEnterprise(tx, subject)
  }
  // Capture the previous material after any earlier writer has released the enterprise row.
  await tx.execute(sql`SELECT id FROM enterprise WHERE id = ${subject.enterpriseId} FOR UPDATE`)
  const before = await identityMaterial(tx, subject.enterpriseId)
  const applied = await attachPostgresReviewedEnterprise(tx, subject)
  if (applied.auditId === null) return applied
  const after = await identityMaterial(tx, subject.enterpriseId)
  if (before === after) return applied
  try {
    await captureIdentityRevision(tx, subject.enterpriseId, applied.auditId, evidenceDigest113(after))
  } catch (error) {
    // The native roster schema is a required participant in this transaction.
    if (error instanceof Error && (error.cause as { code?: string } | undefined)?.code === '42P01') {
      throw new EnterpriseKernelError(503, 'roster_identity_evidence_unavailable', '名录身份依据尚未接入 PostgreSQL 验收库。')
    }
    throw error
  }
  return applied
}
