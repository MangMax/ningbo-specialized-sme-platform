import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { attachPostgresReviewedEnterprise, type ReviewedSubject } from '../../../core/server/public'
import { evidenceDigest113 } from './evidence-impact-113'
import { appendPostgresEvidenceRevision } from './evidence-revision-postgres'

type Transaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]

export async function readPostgresIdentityMaterial(tx: Transaction, enterpriseId: number) {
  const { rows: [enterprise] } = await tx.execute<{ uscc: string | null; name: string }>(sql`
    SELECT uscc_norm AS uscc, name_norm AS name FROM enterprise WHERE id = ${enterpriseId}`)
  const { rows } = await tx.execute<{ name: string; from: string | null; to: string | null }>(sql`
    SELECT DISTINCT name_norm AS name, valid_from AS "from", valid_to AS "to" FROM enterprise_alias
    WHERE enterprise_id = ${enterpriseId} AND verification_status = 'confirmed'`)
  return evidenceDigest113({ enterprise: enterprise ?? null, aliases: rows.map(evidenceDigest113).sort() })
}

export async function capturePostgresIdentityChange(tx: Transaction, enterpriseId: number, sourceVersion: string, before: string) {
  const after = await readPostgresIdentityMaterial(tx, enterpriseId)
  if (before === after) return
  const revisionId = await appendPostgresEvidenceRevision(tx, {
    sourceKind: 'identity', sourceKey: `enterprise:${enterpriseId}`, sourceVersion, enterpriseId,
    beforeFactDigest: evidenceDigest113(before), factDigest: evidenceDigest113(after), metadata: { fromEnterpriseId: null },
  })
  if (revisionId === null) return
  await tx.execute(sql`
    INSERT INTO evidence_revision_event_113 (revision_id, event_id, enterprise_id, title_code)
    SELECT ${revisionId}, e.id, r.enterprise_id, r.title_code FROM record r JOIN record_event e ON e.record_id = r.id
    WHERE r.enterprise_id = ${enterpriseId} ON CONFLICT DO NOTHING`)
}

export async function applyPostgresReviewedRosterIdentity(tx: Transaction, subject: Extract<ReviewedSubject, { action: 'attach' }>) {
  if (subject.fields?.name === undefined && subject.fields?.uscc === undefined) {
    return attachPostgresReviewedEnterprise(tx, subject)
  }
  await tx.execute(sql`SELECT id FROM enterprise WHERE id = ${subject.enterpriseId} FOR UPDATE`)
  const before = await readPostgresIdentityMaterial(tx, subject.enterpriseId)
  const applied = await attachPostgresReviewedEnterprise(tx, subject)
  if (applied.auditId === null) return applied
  await capturePostgresIdentityChange(tx, subject.enterpriseId, `profile:${applied.auditId}`, before)
  return applied
}
