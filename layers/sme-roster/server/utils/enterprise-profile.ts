import { applyEnterpriseProfileChange, EnterpriseKernelError as EnterpriseProfileError, enterpriseProfileState, enterpriseProfileVersion, type EnterpriseProfile } from '../../../core/server/public'
import { createHash } from 'node:crypto'
import { desc, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as s from '../../../../db/schema'
import { captureIdentityRevision113, identityMaterial113 } from './evidence-impact-113'
import { canonicalEnterpriseId } from '../../lib/roster/enterprise-identity'

type Db = BetterSQLite3Database<typeof s>
export { EnterpriseProfileError }
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/u.test(value) && value.isWellFormed(), 'Invalid text')
const fields = { name: text(300), city: text(100).nullable(), district: text(100).nullable() }
// Preconditions are exact source values, including legacy leading/trailing spaces.
const oldValue = z.string().max(1000).refine(value => value.isWellFormed(), 'Invalid old value')
export const enterpriseProfilePatchSchema = z.strictObject({
  idempotencyKey: text(200),
  expectedVersion: z.string().regex(/^[0-9a-f]{64}$/),
  expectedValues: z.strictObject({ name: oldValue.optional(), city: oldValue.nullable().optional(), district: oldValue.nullable().optional() }).optional(),
  changes: z.strictObject({ name: fields.name.optional(), city: fields.city.optional(), district: fields.district.optional() }).refine(v => Object.keys(v).length > 0, 'At least one profile field required'),
  previousName: z.strictObject({ name: oldValue.min(1), sameSubject: z.literal(true) }).optional(),
  actor: z.strictObject({ type: z.enum(['user', 'agent']), id: text(200) }),
  basis: text(2000),
})
export function parseEnterpriseProfileHistoryQuery(query: Record<string, unknown>) {
  const parsed = z.strictObject({ page: z.coerce.number().int().min(1).max(10000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).safeParse(query)
  if (!parsed.success) throw new EnterpriseProfileError(400, 'invalid_request', 'Expected page 1..10000 and pageSize 1..100; no other selectors')
  return parsed.data
}
export function boundedEnterpriseProfileHistory<T>(history: T): T {
  if (Buffer.byteLength(JSON.stringify(history)) > 256 * 1024) throw new EnterpriseProfileError(413, 'response_too_large', 'History page exceeds 256 KiB; request a smaller pageSize')
  return history
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function getEnterpriseProfile(db: Db, enterpriseId: number) {
  return db.transaction(tx => {
    const current = enterpriseProfileState(tx, canonicalEnterpriseId(tx, enterpriseId) ?? enterpriseId)
    return { profile: current.profile, version: enterpriseProfileVersion(current) }
  })
}
function receipt(row: typeof s.enterpriseProfileAudit.$inferSelect) {
  return { auditId: row.id, profile: row.after, version: row.afterVersion, retainedAlias: row.retainedAliasId == null ? null : { id: row.retainedAliasId, name: row.before.name, created: row.aliasCreated }, committedAt: row.createdAt }
}
export function patchEnterpriseProfile(db: Db, enterpriseId: number, body: unknown) {
  enterpriseId = canonicalEnterpriseId(db, enterpriseId) ?? enterpriseId
  const parsed = enterpriseProfilePatchSchema.safeParse(body)
  if (!parsed.success) throw new EnterpriseProfileError(400, 'invalid_request', z.prettifyError(parsed.error))
  const input = parsed.data, requestHash = digest({ enterpriseId, ...input })
  return db.transaction(tx => {
    const prior = tx.select().from(s.enterpriseProfileAudit).where(eq(s.enterpriseProfileAudit.idempotencyKey, input.idempotencyKey)).get()
    if (prior) {
      if (prior.requestHash !== requestHash) throw new EnterpriseProfileError(409, 'idempotency_conflict', 'Key already used for a different profile request')
      return receipt(prior)
    }
    const current = enterpriseProfileState(tx, canonicalEnterpriseId(tx, enterpriseId) ?? enterpriseId)
    const beforeVersion = enterpriseProfileVersion(current)
    if (input.expectedVersion !== beforeVersion) throw new EnterpriseProfileError(409, 'version_conflict', 'Enterprise profile changed; read it again')
    for (const [key, value] of Object.entries(input.expectedValues ?? {})) {
      if (current.profile[key as keyof EnterpriseProfile] !== value) throw new EnterpriseProfileError(409, 'old_value_conflict', `Unexpected old ${key}`)
    }
    const owner = current.profile.enterpriseId
    const renamed = input.changes.name !== undefined && input.changes.name !== current.profile.name
    const identityBefore = renamed ? identityMaterial113(tx, owner) : null
    const audit = applyEnterpriseProfileChange(tx, current, input.changes, {
      idempotencyKey: input.idempotencyKey, requestHash, actor: input.actor, basis: input.basis, previousName: input.previousName?.name,
    })
    if (identityBefore !== null) captureIdentityRevision113(tx, { enterpriseId: owner, sourceKey: `enterprise:${owner}`, sourceVersion: `profile:${audit.id}`, before: identityBefore, after: identityMaterial113(tx, owner) })
    return receipt(audit)
  }, { behavior: 'immediate' })
}
export function getEnterpriseProfileHistory(db: Db, enterpriseId: number, query: Record<string, unknown>) {
  const { page, pageSize } = parseEnterpriseProfileHistoryQuery(query)
  return db.transaction(tx => {
    const scope = eq(s.enterpriseProfileAudit.enterpriseId, enterpriseId)
    const total = tx.select({ count: sql<number>`count(*)` }).from(s.enterpriseProfileAudit).where(scope).get()!.count
    if (total === 0 && !tx.select({ id: s.enterprise.id }).from(s.enterprise).where(eq(s.enterprise.id, enterpriseId)).get()) throw new EnterpriseProfileError(404, 'not_found', 'Enterprise and profile history not found')
    const rows = tx.select({ id: s.enterpriseProfileAudit.id, enterpriseId: s.enterpriseProfileAudit.enterpriseId, before: s.enterpriseProfileAudit.before, after: s.enterpriseProfileAudit.after, beforeVersion: s.enterpriseProfileAudit.beforeVersion, afterVersion: s.enterpriseProfileAudit.afterVersion, actor: s.enterpriseProfileAudit.actor, basis: s.enterpriseProfileAudit.basis, retainedAliasId: s.enterpriseProfileAudit.retainedAliasId, aliasCreated: s.enterpriseProfileAudit.aliasCreated, createdAt: s.enterpriseProfileAudit.createdAt }).from(s.enterpriseProfileAudit).where(scope).orderBy(desc(s.enterpriseProfileAudit.id)).limit(pageSize).offset((page - 1) * pageSize).all()
    return boundedEnterpriseProfileHistory({ rows, total, page, pageSize })
  })
}
