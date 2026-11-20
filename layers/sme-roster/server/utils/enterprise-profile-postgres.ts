import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import {
  applyPostgresEnterpriseProfileChange, enterpriseProfileVersion, lockPostgresReviewedEnterpriseBatch,
  postgresCanonicalEnterpriseId, postgresEnterpriseProfileState, type EnterpriseProfile,
} from '../../../core/server/public'
import {
  boundedEnterpriseProfileHistory, EnterpriseProfileError, enterpriseProfilePatchSchema, parseEnterpriseProfileHistoryQuery,
} from './enterprise-profile'
import { capturePostgresIdentityChange, readPostgresIdentityMaterial } from './postgres-identity-evidence'

export function getPostgresEnterpriseProfile(db: NodePgDatabase, enterpriseId: number) {
  return db.transaction(async tx => {
    const current = await postgresEnterpriseProfileState(tx, await postgresCanonicalEnterpriseId(tx, enterpriseId) ?? enterpriseId)
    return { profile: current.profile, version: enterpriseProfileVersion(current) }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

type Audit = { id: string; enterpriseId: string; requestHash: string; before: EnterpriseProfile; after: EnterpriseProfile;
  beforeVersion: string; afterVersion: string; actor: { type: string; id: string }; basis: string;
  retainedAliasId: string | null; aliasCreated: string; createdAt: string }
const auditFields = sql`id, enterprise_id AS "enterpriseId", before::json, after::json,
  before_version AS "beforeVersion", after_version AS "afterVersion", actor::json, basis,
  retained_alias_id AS "retainedAliasId", alias_created AS "aliasCreated", created_at AS "createdAt"`

export function patchPostgresEnterpriseProfile(db: NodePgDatabase, enterpriseId: number, body: unknown) {
  if (process.env.NUXT_POSTGRES_DIRECTORY_WRITE !== '1') {
    throw new EnterpriseProfileError(503, 'write_unavailable', 'PostgreSQL 企业资料处于只读模式')
  }
  const parsed = enterpriseProfilePatchSchema.safeParse(body)
  if (!parsed.success) throw new EnterpriseProfileError(400, 'invalid_request', z.prettifyError(parsed.error))
  const input = parsed.data
  return db.transaction(async tx => {
    const owner = await postgresCanonicalEnterpriseId(tx, enterpriseId) ?? enterpriseId
    const requestHash = createHash('sha256').update(JSON.stringify({ enterpriseId: owner, ...input })).digest('hex')
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`enterprise-profile:${input.idempotencyKey}`}, 0))`)
    const { rows: [prior] } = await tx.execute<Audit>(sql`SELECT ${auditFields}, request_hash AS "requestHash"
      FROM enterprise_profile_audit WHERE idempotency_key = ${input.idempotencyKey}`)
    if (prior) {
      if (prior.requestHash !== requestHash) throw new EnterpriseProfileError(409, 'idempotency_conflict', 'Key already used for a different profile request')
      return { auditId: Number(prior.id), profile: prior.after, version: prior.afterVersion,
        retainedAlias: prior.retainedAliasId === null ? null : { id: Number(prior.retainedAliasId), name: prior.before.name, created: prior.aliasCreated === '1' },
        committedAt: prior.createdAt }
    }
    await lockPostgresReviewedEnterpriseBatch(tx, [owner], [input.changes])
    if (owner !== (await postgresCanonicalEnterpriseId(tx, enterpriseId) ?? enterpriseId)) throw new EnterpriseProfileError(409, 'version_conflict', 'Enterprise profile changed; read it again')
    const current = await postgresEnterpriseProfileState(tx, owner)
    if (input.expectedVersion !== enterpriseProfileVersion(current)) {
      throw new EnterpriseProfileError(409, 'version_conflict', 'Enterprise profile changed; read it again')
    }
    for (const [key, value] of Object.entries(input.expectedValues ?? {})) {
      if (current.profile[key as keyof EnterpriseProfile] !== value) throw new EnterpriseProfileError(409, 'old_value_conflict', `Unexpected old ${key}`)
    }
    const renamed = input.changes.name !== undefined && input.changes.name !== current.profile.name
    const before = renamed ? await readPostgresIdentityMaterial(tx, owner) : null
    const result = await applyPostgresEnterpriseProfileChange(tx, current, input.changes, {
      idempotencyKey: input.idempotencyKey, requestHash, actor: input.actor, basis: input.basis, previousName: input.previousName?.name,
    })
    if (before !== null) await capturePostgresIdentityChange(tx, owner, `profile:${result.auditId}`, before)
    return result
  })
}

export function getPostgresEnterpriseProfileHistory(db: NodePgDatabase, enterpriseId: number, query: Record<string, unknown>) {
  const { page, pageSize } = parseEnterpriseProfileHistoryQuery(query)
  return db.transaction(async tx => {
    const { rows: [scope] } = await tx.execute<{ total: string; present: boolean }>(sql`SELECT
      (SELECT count(*) FROM enterprise_profile_audit WHERE enterprise_id = ${enterpriseId}) AS total,
      EXISTS (SELECT 1 FROM enterprise WHERE id = ${enterpriseId}) AS present`)
    const total = Number(scope!.total)
    if (!total && !scope!.present) throw new EnterpriseProfileError(404, 'not_found', 'Enterprise and profile history not found')
    const { rows } = await tx.execute<Omit<Audit, 'requestHash'>>(sql`SELECT ${auditFields} FROM enterprise_profile_audit
      WHERE enterprise_id = ${enterpriseId} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`)
    return boundedEnterpriseProfileHistory({
      total, page, pageSize, rows: rows.map(row => ({ ...row, id: Number(row.id), enterpriseId: Number(row.enterpriseId),
        retainedAliasId: row.retainedAliasId === null ? null : Number(row.retainedAliasId), aliasCreated: row.aliasCreated === '1' })),
    })
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
