import { createHash } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { createError } from 'h3'
import { z } from 'zod'
import { postgresLeadListRow as leadRow, postgresLeadListVersion as leadVersion } from '../../../../db/postgresql/lead-tables'
import { createPostgresReviewedEnterprise, enterpriseFieldsSchema, EnterpriseKernelError, lockPostgresReviewedEnterpriseBatch, registerPostgresEnterpriseSource } from '../../../core/server/public'
import { applyPostgresReviewedRosterIdentity } from '../../../sme-roster/public'
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

function leadReviewHash(decision: LeadSupplementInput['decisions'][number], { actor, basis }: LeadSupplementInput) {
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
      const pending = input.decisions.filter(item => byId.get(item.rowId)!.enterpriseId === null)
      const enterpriseIds = new Set(rows.flatMap(row => row.enterpriseId === null ? [] : [row.enterpriseId]))
      for (const item of pending) if (item.action === 'attach') enterpriseIds.add(item.enterpriseId)
      await lockPostgresReviewedEnterpriseBatch(tx, [...enterpriseIds], pending.flatMap(item => item.fields ? [item.fields] : []))
      const resolved = []
      for (const item of input.decisions) {
        const row = byId.get(item.rowId)!
        const requestHash = leadReviewHash(item, input)
        if (row.enterpriseId !== null) {
          if (row.reviewHash !== requestHash) throw createError({ statusCode: 409, message: '该行已有核对结果' })
          resolved.push({ rowId: item.rowId, enterpriseId: row.enterpriseId })
          continue
        }
        const audit = { idempotencyKey: `lead-lists:${row.id}`, requestHash, actor: input.actor, basis: input.basis }
        const enterpriseId = item.action === 'create'
          ? await createPostgresReviewedEnterprise(tx, item.fields)
          : (await applyPostgresReviewedRosterIdentity(tx, { ...item, audit })).id
        await tx.update(leadRow).set({
          enterpriseId,
          reviewHash: requestHash,
          reviewActor: JSON.stringify(input.actor),
          reviewBasis: input.basis,
          reviewedAt: new Date().toISOString(),
        }).where(and(eq(leadRow.id, item.rowId), eq(leadRow.versionId, id)))
        resolved.push({ rowId: item.rowId, enterpriseId })
      }
      const sourceId = await registerPostgresEnterpriseSource(tx, {
        ...version, module: 'lead-lists', businessTable: 'lead_list_version', versionKey: String(id),
      }, resolved.map(row => row.enterpriseId))
      return { sourceId, rows: resolved }
    }, { isolationLevel: 'read committed' })
  } catch (error) {
    if (error instanceof EnterpriseKernelError) {
      throw createError({ statusCode: error.statusCode, message: error.message, data: { code: error.code } })
    }
    throw error
  }
}
