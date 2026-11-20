import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { createError } from 'h3'
import { createPostgresReviewedEnterprise, lockPostgresReviewedEnterpriseBatch, registerPostgresEnterpriseSource } from '../../../core/server/public'
import { applyPostgresReviewedRosterIdentity } from '../../../sme-roster/public'
import { leadReviewHash, leadSupplementError, type LeadSupplementInput } from './versions'

type VersionSource = {
  series: string; channel: string; listType: string; acquiredOn: string; fileId: string; sha256: string
}
type LeadReview = { id: string; enterpriseId: string | null; reviewHash: string | null }

export async function supplementPostgresLeadVersion(db: NodePgDatabase, id: number, input: LeadSupplementInput) {
  try {
    return await db.transaction(async tx => {
      const { rows: [version] } = await tx.execute<VersionSource>(sql`
        SELECT series, channel_code AS channel, list_type_code AS "listType", acquired_on AS "acquiredOn",
          file_id AS "fileId", file_sha256 AS sha256
        FROM lead_list_version WHERE id = ${id} FOR NO KEY UPDATE`)
      if (!version) throw createError({ statusCode: 404, message: '名单版本不存在' })

      const { rows } = await tx.execute<LeadReview>(sql`
        SELECT id, enterprise_id AS "enterpriseId", review_hash AS "reviewHash"
        FROM lead_list_row WHERE version_id = ${id} AND id IN (${sql.join(input.decisions.map(item => sql`${item.rowId}`), sql`, `)})
        ORDER BY id FOR UPDATE`)
      if (rows.length !== input.decisions.length) throw createError({ statusCode: 404, message: '所选行不在此名单版本中' })
      const byId = new Map(rows.map(row => [Number(row.id), row]))
      const pending = input.decisions.filter(item => byId.get(item.rowId)!.enterpriseId === null)
      const enterpriseIds = new Set(rows.flatMap(row => row.enterpriseId === null ? [] : [Number(row.enterpriseId)]))
      for (const item of pending) if (item.action === 'attach') enterpriseIds.add(item.enterpriseId)
      // Different versions may review the same subjects in opposite order.
      await lockPostgresReviewedEnterpriseBatch(tx, [...enterpriseIds], pending.flatMap(item => item.fields ? [item.fields] : []))
      const resolved = []
      for (const item of input.decisions) {
        const row = byId.get(item.rowId)!
        const requestHash = leadReviewHash(item, input)
        if (row.enterpriseId !== null) {
          if (row.reviewHash !== requestHash) throw createError({ statusCode: 409, message: '该行已有核对结果' })
          resolved.push({ rowId: item.rowId, enterpriseId: Number(row.enterpriseId) })
          continue
        }
        const audit = { idempotencyKey: `lead-lists:${row.id}`, requestHash, actor: input.actor, basis: input.basis }
        const enterpriseId = item.action === 'create'
          ? await createPostgresReviewedEnterprise(tx, item.fields)
          : (await applyPostgresReviewedRosterIdentity(tx, { ...item, audit })).id
        await tx.execute(sql`
          UPDATE lead_list_row SET enterprise_id = ${enterpriseId}, review_hash = ${requestHash},
            review_actor = ${JSON.stringify(input.actor)}, review_basis = ${input.basis}, reviewed_at = ${new Date().toISOString()}
          WHERE id = ${item.rowId} AND version_id = ${id}`)
        resolved.push({ rowId: item.rowId, enterpriseId })
      }
      const sourceId = await registerPostgresEnterpriseSource(tx, {
        ...version, fileId: Number(version.fileId), module: 'lead-lists', businessTable: 'lead_list_version', versionKey: String(id),
      }, resolved.map(row => row.enterpriseId))
      return { sourceId, rows: resolved }
    }, { isolationLevel: 'read committed' })
  } catch (error) {
    leadSupplementError(error)
  }
}
