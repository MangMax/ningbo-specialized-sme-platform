import { createHash } from 'node:crypto'
import { count, desc, eq, sql } from 'drizzle-orm'
import { enterprise, enterpriseProfileAudit as audit } from '../../../../db/postgresql/enterprise-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import {
  applyEnterpriseProfileChange, enterpriseProfileVersion, lockReviewedEnterpriseBatch,
  canonicalEnterpriseId, enterpriseProfileState, type EnterpriseProfile,
} from '../../../core/server/public'
import { EnterpriseProfileError } from './enterprise-profile-model'
import { boundedEnterpriseProfileHistory, enterpriseProfilePatchSchema, parseEnterpriseProfileHistoryQuery } from './enterprise-profile-model'

export function getPostgresEnterpriseProfile(db: NodePgDatabase, enterpriseId: number) {
  return db.transaction(async tx => {
    const current = await enterpriseProfileState(tx, await canonicalEnterpriseId(tx, enterpriseId) ?? enterpriseId)
    return { profile: current.profile, version: enterpriseProfileVersion(current) }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

function profileAudit(row: typeof audit.$inferSelect) {
  const { requestHash: _requestHash, idempotencyKey: _idempotencyKey, ...view } = row
  return { ...view, before: JSON.parse(row.before) as EnterpriseProfile, after: JSON.parse(row.after) as EnterpriseProfile,
    actor: JSON.parse(row.actor) as { type: string; id: string }, aliasCreated: row.aliasCreated === 1 }
}

export function patchPostgresEnterpriseProfile(db: NodePgDatabase, enterpriseId: number, body: unknown) {
  if (process.env.NUXT_DB_READONLY === '1') {
    throw new EnterpriseProfileError(503, 'write_unavailable', 'PostgreSQL 企业资料处于只读模式')
  }
  const parsed = enterpriseProfilePatchSchema.safeParse(body)
  if (!parsed.success) throw new EnterpriseProfileError(400, 'invalid_request', z.prettifyError(parsed.error))
  const input = parsed.data
  return db.transaction(async tx => {
    const owner = await canonicalEnterpriseId(tx, enterpriseId) ?? enterpriseId
    const requestHash = createHash('sha256').update(JSON.stringify({ enterpriseId: owner, ...input })).digest('hex')
    // Drizzle has no transaction advisory lock or hashtextextended builder.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`enterprise-profile:${input.idempotencyKey}`}, 0))`)
    const [prior] = await tx.select().from(audit).where(eq(audit.idempotencyKey, input.idempotencyKey))
    if (prior) {
      if (prior.requestHash !== requestHash) throw new EnterpriseProfileError(409, 'idempotency_conflict', 'Key already used for a different profile request')
      const view = profileAudit(prior)
      return { auditId: view.id, profile: view.after, version: view.afterVersion,
        retainedAlias: view.retainedAliasId === null ? null : { id: view.retainedAliasId, name: view.before.name, created: view.aliasCreated },
        committedAt: view.createdAt }
    }
    await lockReviewedEnterpriseBatch(tx, [owner], [input.changes])
    if (owner !== (await canonicalEnterpriseId(tx, enterpriseId) ?? enterpriseId)) throw new EnterpriseProfileError(409, 'version_conflict', 'Enterprise profile changed; read it again')
    const current = await enterpriseProfileState(tx, owner)
    if (input.expectedVersion !== enterpriseProfileVersion(current)) {
      throw new EnterpriseProfileError(409, 'version_conflict', 'Enterprise profile changed; read it again')
    }
    for (const [key, value] of Object.entries(input.expectedValues ?? {})) {
      if (current.profile[key as keyof EnterpriseProfile] !== value) throw new EnterpriseProfileError(409, 'old_value_conflict', `Unexpected old ${key}`)
    }
    const result = await applyEnterpriseProfileChange(tx, current, input.changes, {
      idempotencyKey: input.idempotencyKey, requestHash, actor: input.actor, basis: input.basis, previousName: input.previousName?.name,
    })
    return result
  })
}

export function getPostgresEnterpriseProfileHistory(db: NodePgDatabase, enterpriseId: number, query: Record<string, unknown>) {
  const { page, pageSize } = parseEnterpriseProfileHistoryQuery(query)
  return db.transaction(async tx => {
    const scope = eq(audit.enterpriseId, enterpriseId)
    const [counted] = await tx.select({ total: count() }).from(audit).where(scope)
    const total = counted!.total
    if (!total && !(await tx.select({ id: enterprise.id }).from(enterprise).where(eq(enterprise.id, enterpriseId))).length) {
      throw new EnterpriseProfileError(404, 'not_found', 'Enterprise and profile history not found')
    }
    const rows = await tx.select().from(audit).where(scope).orderBy(desc(audit.id)).limit(pageSize).offset((page - 1) * pageSize)
    return boundedEnterpriseProfileHistory({ total, page, pageSize, rows: rows.map(profileAudit) })
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
