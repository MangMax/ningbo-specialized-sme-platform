import { createHash } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { createError } from 'h3'
import { z } from 'zod'
import { postgresLeadListRow as leadRow, postgresLeadListVersion as leadVersion } from '../../../../db/postgresql/lead-tables'
import { applyReviewedEnterpriseSupplement, enterpriseFieldsSchema, EnterpriseKernelError } from '../../../core/server/public'
import { leadListId } from '../../lib/contracts'

const reviewer = z.strictObject({ type: z.enum(['user', 'agent']), id: z.string().trim().min(1).max(120) })
const decision = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), rowId: leadListId, fields: enterpriseFieldsSchema.required({ name: true }) }),
  z.strictObject({ action: z.literal('attach'), rowId: leadListId, enterpriseId: leadListId, expectedRevision: leadListId, fields: enterpriseFieldsSchema.optional() }),
])
export const browserSupplementInput = z.strictObject({
  decisions: z.array(decision).min(1).max(200).refine(items => new Set(items.map(item => item.rowId)).size === items.length),
})
export const supplementInput = browserSupplementInput.extend({
  actor: reviewer,
  basis: z.string().trim().min(1).max(500),
})

type LeadSupplementInput = z.infer<typeof supplementInput>
type LeadDecision = LeadSupplementInput['decisions'][number]

function leadReviewHash(decision: LeadDecision, { actor, basis }: LeadSupplementInput) {
  return createHash('sha256').update(JSON.stringify({ decision, actor, basis })).digest('hex')
}

export async function supplementPostgresLeadVersion(db: NodePgDatabase, id: number, input: LeadSupplementInput) {
  try {
    return await db.transaction(async tx => {
      const [version] = await tx.select({
        series: leadVersion.series,
        channel: leadVersion.channel,
        listType: leadVersion.listType,
        acquiredOn: leadVersion.acquiredOn,
        fileId: leadVersion.fileId,
        sha256: leadVersion.fileSha256,
      }).from(leadVersion).where(eq(leadVersion.id, id)).for('no key update')
      if (!version) throw createError({ statusCode: 404, message: '名单版本不存在' })

      const rows = await tx.select({ id: leadRow.id, enterpriseId: leadRow.enterpriseId, reviewHash: leadRow.reviewHash })
        .from(leadRow).where(and(eq(leadRow.versionId, id), inArray(leadRow.id, input.decisions.map(item => item.rowId))))
        .orderBy(asc(leadRow.id)).for('update')
      if (rows.length !== input.decisions.length) throw createError({ statusCode: 404, message: '所选行不在此名单版本中' })
      const byId = new Map(rows.map(row => [row.id, row]))
      const requestHashes = new Map(input.decisions.map(item => [item.rowId, leadReviewHash(item, input)] as const))
      const pending = input.decisions.filter(item => byId.get(item.rowId)!.enterpriseId === null)
      const enterpriseIds = new Set(rows.flatMap(row => row.enterpriseId === null ? [] : [row.enterpriseId]))
      for (const item of pending) if (item.action === 'attach') enterpriseIds.add(item.enterpriseId)
      const subjects = input.decisions.map(item => {
        const row = byId.get(item.rowId)!
        const audit = { idempotencyKey: `lead-lists:${row.id}`, requestHash: requestHashes.get(item.rowId)!, actor: input.actor, basis: input.basis }
        return item.action === 'attach' ? { ...item, audit } : item
      })
      const { owners, sourceId } = await applyReviewedEnterpriseSupplement(tx, {
        lock: { enterpriseIds: [...enterpriseIds], fields: pending.flatMap(item => item.fields ? [item.fields] : []) },
        subjects,
        hooks: {
          async resolve(_tx, subject) {
            const row = byId.get(subject.rowId)!
            if (row.enterpriseId === null) return undefined
            if (row.reviewHash !== requestHashes.get(subject.rowId)) throw createError({ statusCode: 409, message: '该行已有核对结果' })
            return row.enterpriseId
          },
          async afterResolve(nested, subject, _index, owner) {
            const row = byId.get(subject.rowId)!
            if (row.enterpriseId !== null) return
            await nested.update(leadRow).set({
              enterpriseId: owner,
              reviewHash: requestHashes.get(subject.rowId)!,
              reviewActor: JSON.stringify(input.actor),
              reviewBasis: input.basis,
              reviewedAt: new Date().toISOString(),
            }).where(and(eq(leadRow.id, subject.rowId), eq(leadRow.versionId, id)))
          },
        },
        source: { ...version, module: 'lead-lists', businessTable: 'lead_list_version', versionKey: String(id) },
      })
      return { sourceId, rows: input.decisions.map((item, index) => ({ rowId: item.rowId, enterpriseId: owners.get(index)! })) }
    }, { isolationLevel: 'read committed' })
  } catch (error) {
    if (error instanceof EnterpriseKernelError) {
      throw createError({ statusCode: error.statusCode, message: error.message, data: { code: error.code } })
    }
    throw error
  }
}
