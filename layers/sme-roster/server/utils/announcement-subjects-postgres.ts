import { and, eq, exists } from 'drizzle-orm'
import { enterprise, enterpriseAlias } from '../../../../db/postgresql/enterprise-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { z } from 'zod'
import { applyReviewedEnterpriseSupplement, EnterpriseKernelError } from '../../../core/server/public'
import { normalizeReviewedUscc } from '../../../core/public'
import { normalizeName } from '../../lib/domain'
import type { RosterImportAnnouncement } from '../../lib/roster-import-client'
import type { supplementSchema } from './announcement-intake-model'
import { ImportReceiptError } from './import-receipt-model'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Review = z.infer<typeof supplementSchema>

export async function reviewPostgresAnnouncementSubjects(tx: Tx, intakeId: number, decision: string,
  rows: RosterImportAnnouncement['records'], input: Review) {
  const ids = input.rows.flatMap(row => row.action === 'attach' ? [row.enterpriseId] : [])
  const fields = input.rows.flatMap(row => row.action !== 'same_subject' && row.fields ? [row.fields] : [])
  const matchedBefore = new Map<number, boolean>()
  // 来源身份连续性核验是名录模块自己的业务判断（按名录的名称归一化口径），留在名录内：
  // 附着解析前预核一次，解析后对企业现值复核一次；已匹配的目标不重复核验。
  const matchesSource = async (owner: number, index: number) => {
    const source = rows[index]!.enterprise
    const sourceUscc = typeof source.uscc === 'string' ? normalizeReviewedUscc(source.uscc) : ''
    const name = normalizeName(source.name)
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
  const subjects = input.rows.map((subject, index) => subject.action === 'attach'
    ? { ...subject, audit: {
      idempotencyKey: 'announcement-intake:' + intakeId + ':' + index + ':' + decision, requestHash: decision,
      actor: { type: 'agent' as const, id: 'roster-announcement-supplement' }, basis: input.basis,
    } }
    : subject)
  const { owners, created } = await applyReviewedEnterpriseSupplement(tx, {
    lock: { enterpriseIds: [...new Set(ids)], fields },
    subjects,
    hooks: {
      async beforeResolve(_nested, subject, index) {
        if (subject.action === 'attach') matchedBefore.set(index, await matchesSource(subject.enterpriseId, index))
      },
      async resolve(_nested, subject, _index, resolved) {
        if (subject.action !== 'same_subject') return undefined
        const owner = resolved.get(subject.row)
        if (!owner) throw new ImportReceiptError(422, 'invalid_subject_reference', 'Choose an earlier reviewed row')
        return owner
      },
      async afterResolve(_nested, _subject, index, owner) {
        if ((matchedBefore.get(index) ?? false) || await matchesSource(owner, index)) return
        throw new EnterpriseKernelError(409, 'reviewed_identity_mismatch', 'The reviewed enterprise no longer matches the source identity')
      },
    },
  })
  return { owners, created }
}
