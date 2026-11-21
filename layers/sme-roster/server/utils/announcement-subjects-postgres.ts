import { and, eq, exists } from 'drizzle-orm'
import { enterprise, enterpriseAlias } from '../../../../db/postgresql/enterprise-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { z } from 'zod'
import { createPostgresReviewedEnterprise, EnterpriseKernelError, lockPostgresReviewedEnterpriseBatch } from '../../../core/server/public'
import { normalizeReviewedUscc } from '../../../core/public'
import { normalizeName } from '../../lib/domain'
import type { RosterImportAnnouncement } from '../../lib/roster-import-client'
import { applyPostgresReviewedRosterIdentity } from './postgres-identity-evidence'
import type { supplementSchema } from './announcement-intake'
import { ImportReceiptError } from './import-receipts'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Review = z.infer<typeof supplementSchema>

export async function reviewPostgresAnnouncementSubjects(tx: Tx, intakeId: number, decision: string,
  rows: RosterImportAnnouncement['records'], input: Review) {
  const ids = input.rows.flatMap(row => row.action === 'attach' ? [row.enterpriseId] : [])
  const fields = input.rows.flatMap(row => row.action !== 'same_subject' && row.fields ? [row.fields] : [])
  await lockPostgresReviewedEnterpriseBatch(tx, [...new Set(ids)], fields)
  const owners = new Map<number, number>(), created = new Set<number>()
  for (const [index, subject] of input.rows.entries()) {
    const source = rows[index]!.enterprise
    const sourceUscc = typeof source.uscc === 'string' ? normalizeReviewedUscc(source.uscc) : ''
    const name = normalizeName(source.name)
    const matchesSource = async (owner: number) => {
      const confirmedAlias = tx.select({ id: enterpriseAlias.id }).from(enterpriseAlias).where(and(
        eq(enterpriseAlias.enterpriseId, enterprise.id), eq(enterpriseAlias.nameNorm, name),
        eq(enterpriseAlias.verificationStatus, 'confirmed'),
      ))
      const [target] = await tx.select({
        nameNorm: enterprise.nameNorm, usccNorm: enterprise.usccNorm, confirmedAlias: exists(confirmedAlias).mapWith(Boolean),
      }).from(enterprise).where(eq(enterprise.id, owner))
      return !!target && (sourceUscc ? target.usccNorm !== null && normalizeReviewedUscc(target.usccNorm) === sourceUscc
        : target.nameNorm === name || target.confirmedAlias)
    }
    const matchedBefore = subject.action === 'attach' && await matchesSource(subject.enterpriseId)
    let owner: number | undefined
    if (subject.action === 'same_subject') {
      owner = owners.get(subject.row)
    } else if (subject.action === 'create') {
      owner = await createPostgresReviewedEnterprise(tx, subject.fields)
      created.add(owner)
    } else {
      owner = (await applyPostgresReviewedRosterIdentity(tx, { ...subject, audit: {
        idempotencyKey: 'announcement-intake:' + intakeId + ':' + index + ':' + decision, requestHash: decision,
        actor: { type: 'agent', id: 'roster-announcement-supplement' }, basis: input.basis,
      } })).id
    }
    if (!owner) throw new ImportReceiptError(422, 'invalid_subject_reference', 'Choose an earlier reviewed row')
    if (!matchedBefore && !await matchesSource(owner)) throw new EnterpriseKernelError(409, 'reviewed_identity_mismatch', 'The reviewed enterprise no longer matches the source identity')
    owners.set(index, owner)
  }
  return { owners, created }
}
