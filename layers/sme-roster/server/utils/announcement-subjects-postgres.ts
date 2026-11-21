import { sql } from 'drizzle-orm'
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
      const { rows: [target] } = await tx.execute<{ name_norm: string; uscc_norm: string | null; confirmed_alias: boolean }>(sql`
        SELECT name_norm,uscc_norm,EXISTS(SELECT 1 FROM enterprise_alias a WHERE a.enterprise_id=e.id
          AND a.name_norm=${name} AND a.verification_status='confirmed') AS confirmed_alias FROM enterprise e WHERE e.id=${owner}`)
      return !!target && (sourceUscc ? target.uscc_norm !== null && normalizeReviewedUscc(target.uscc_norm) === sourceUscc
        : target.name_norm === name || target.confirmed_alias)
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
