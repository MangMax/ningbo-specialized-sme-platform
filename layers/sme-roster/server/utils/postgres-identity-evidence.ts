import { and, eq, sql } from 'drizzle-orm'
import { enterprise, enterpriseAlias } from '../../../../db/postgresql/enterprise-tables'
import { evidenceRevisionEvent113 } from '../../../../db/postgresql/evidence-review-tables'
import { record, recordEvent } from '../../../../db/postgresql/ledger-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { attachPostgresReviewedEnterprise, type ReviewedSubject } from '../../../core/server/public'
import { evidenceDigest113 } from './evidence-impact-113'
import { appendPostgresEvidenceRevision } from './evidence-revision-postgres'

type Transaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]

export async function readPostgresIdentityMaterial(tx: Transaction, enterpriseId: number) {
  const [subject] = await tx.select({ uscc: enterprise.usccNorm, name: enterprise.nameNorm }).from(enterprise).where(eq(enterprise.id, enterpriseId))
  const aliases = await tx.selectDistinct({ name: enterpriseAlias.nameNorm, from: enterpriseAlias.validFrom, to: enterpriseAlias.validTo })
    .from(enterpriseAlias).where(and(eq(enterpriseAlias.enterpriseId, enterpriseId), eq(enterpriseAlias.verificationStatus, 'confirmed')))
  return evidenceDigest113({ enterprise: subject ?? null, aliases: aliases.map(evidenceDigest113).sort() })
}

export async function capturePostgresIdentityChange(tx: Transaction, enterpriseId: number, sourceVersion: string, before: string) {
  const after = await readPostgresIdentityMaterial(tx, enterpriseId)
  if (before === after) return
  const revisionId = await appendPostgresEvidenceRevision(tx, {
    sourceKind: 'identity', sourceKey: `enterprise:${enterpriseId}`, sourceVersion, enterpriseId,
    beforeFactDigest: evidenceDigest113(before), factDigest: evidenceDigest113(after), metadata: { fromEnterpriseId: null },
  })
  if (revisionId !== null) await attachPostgresIdentityRevisionEvents(tx, revisionId, enterpriseId)
}

export async function attachPostgresIdentityRevisionEvents(tx: Transaction, revisionId: number, enterpriseId: number) {
  await tx.insert(evidenceRevisionEvent113).select(tx.select({
    revisionId: sql<number>`${revisionId}`.as('revision_id'), eventId: recordEvent.id,
    enterpriseId: record.enterpriseId, titleCode: record.titleCode,
  }).from(record).innerJoin(recordEvent, eq(recordEvent.recordId, record.id)).where(eq(record.enterpriseId, enterpriseId)))
    .onConflictDoNothing()
}

export async function applyPostgresReviewedRosterIdentity(tx: Transaction, subject: Extract<ReviewedSubject, { action: 'attach' }>) {
  if (subject.fields?.name === undefined && subject.fields?.uscc === undefined) {
    return attachPostgresReviewedEnterprise(tx, subject)
  }
  await tx.select({ id: enterprise.id }).from(enterprise).where(eq(enterprise.id, subject.enterpriseId)).for('update')
  const before = await readPostgresIdentityMaterial(tx, subject.enterpriseId)
  const applied = await attachPostgresReviewedEnterprise(tx, subject)
  if (applied.auditId === null) return applied
  await capturePostgresIdentityChange(tx, subject.enterpriseId, `profile:${applied.auditId}`, before)
  return applied
}
