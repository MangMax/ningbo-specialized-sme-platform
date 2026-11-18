import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as s from '../../../../db/schema'
import { captureIdentityRevision113, identityMaterial113 } from './evidence-impact-113'
import { normalizeName } from '../../lib/domain'
import { canonicalEnterpriseId, currentEnterpriseIdentity } from '../../lib/roster/enterprise-identity'

type Db = BetterSQLite3Database<typeof s>
type Executor = Pick<Db, 'select' | 'insert' | 'update'>
export interface EnterpriseProfile { enterpriseId: number; name: string; city: string | null; district: string | null }
export class EnterpriseProfileError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message) }
}
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
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function state(db: Executor, enterpriseId: number) {
  enterpriseId = canonicalEnterpriseId(db, enterpriseId) ?? enterpriseId
  const row = db.select({ id: s.enterprise.id, name: s.enterprise.name, nameNorm: s.enterprise.nameNorm, city: s.enterprise.city, district: s.enterprise.district, usccNorm: s.enterprise.usccNorm }).from(s.enterprise).where(eq(s.enterprise.id, enterpriseId)).get()
  if (!row) throw new EnterpriseProfileError(404, 'not_found', 'Enterprise not found')
  const last = db.select({ key: s.enterpriseProfileAudit.idempotencyKey }).from(s.enterpriseProfileAudit).where(eq(s.enterpriseProfileAudit.enterpriseId, enterpriseId)).orderBy(desc(s.enterpriseProfileAudit.id)).limit(1).get()
  const profile: EnterpriseProfile = { enterpriseId, name: row.name, city: row.city, district: row.district }
  return { profile, row, key: last?.key ?? null }
}
function version(value: ReturnType<typeof state>) { return digest({ profile: value.profile, uscc: value.row.usccNorm, nameNorm: value.row.nameNorm, lastWrite: value.key }) }
export function getEnterpriseProfile(db: Db, enterpriseId: number) {
  return db.transaction(tx => { const current = state(tx, enterpriseId); return { profile: current.profile, version: version(current) } })
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
    const identityBefore = identityMaterial113(tx, enterpriseId)
    const current = state(tx, enterpriseId), beforeVersion = version(current)
    if (input.expectedVersion !== beforeVersion) throw new EnterpriseProfileError(409, 'version_conflict', 'Enterprise profile changed; read it again')
    for (const [key, value] of Object.entries(input.expectedValues ?? {})) {
      if (current.profile[key as keyof EnterpriseProfile] !== value) throw new EnterpriseProfileError(409, 'old_value_conflict', `Unexpected old ${key}`)
    }
    const after = { ...current.profile, ...input.changes }, renamed = after.name !== current.profile.name
    let retainedAliasId: number | null = null, aliasCreated = false
    if (renamed) {
      if (input.previousName?.name !== current.profile.name) throw new EnterpriseProfileError(422, 'previous_name_confirmation_required', 'Confirm the exact previous name belongs to this enterprise')
      const nameNorm = normalizeName(after.name), oldNorm = normalizeName(current.profile.name)
      if (!nameNorm || !oldNorm) throw new EnterpriseProfileError(422, 'invalid_name', 'Normalized enterprise name must not be empty')
      const nameOwner = tx.select({ id: s.enterprise.id }).from(s.enterprise).where(and(currentEnterpriseIdentity(tx), inArray(s.enterprise.nameNorm, [nameNorm, oldNorm]), ne(s.enterprise.id, enterpriseId))).limit(1).get()
      const aliasOwner = tx.select({ id: s.enterpriseAlias.id }).from(s.enterpriseAlias).where(and(inArray(s.enterpriseAlias.nameNorm, [nameNorm, oldNorm]), eq(s.enterpriseAlias.verificationStatus, 'confirmed'), ne(s.enterpriseAlias.enterpriseId, enterpriseId))).limit(1).get()
      if (nameOwner || aliasOwner) throw new EnterpriseProfileError(409, 'identity_conflict', 'Name belongs to another enterprise; use the identity operation')
      const existing = tx.select({ id: s.enterpriseAlias.id }).from(s.enterpriseAlias).where(and(eq(s.enterpriseAlias.enterpriseId, enterpriseId), eq(s.enterpriseAlias.nameNorm, oldNorm), eq(s.enterpriseAlias.verificationStatus, 'confirmed'))).orderBy(asc(s.enterpriseAlias.id)).limit(1).get()
      if (existing) retainedAliasId = existing.id
      else {
        const sameKey = tx.select({ id: s.enterpriseAlias.id }).from(s.enterpriseAlias).where(and(eq(s.enterpriseAlias.enterpriseId, enterpriseId), eq(s.enterpriseAlias.nameNorm, oldNorm), eq(s.enterpriseAlias.sourceKind, 'manual'), eq(s.enterpriseAlias.sourceRefId, 0))).limit(1).get()
        if (sameKey) throw new EnterpriseProfileError(409, 'alias_lifecycle_required', 'Previous-name record is not confirmed; confirm or restore it through alias lifecycle first')
        retainedAliasId = tx.insert(s.enterpriseAlias).values({ enterpriseId, name: current.profile.name, nameNorm: oldNorm, sourceKind: 'manual', sourceRefId: 0, verificationStatus: 'confirmed', note: `Enterprise profile rename: ${input.idempotencyKey}` }).returning({ id: s.enterpriseAlias.id }).get().id
        aliasCreated = true
      }
    } else if (input.previousName) throw new EnterpriseProfileError(422, 'unexpected_previous_name', 'Previous-name confirmation is only valid for a name change')
    tx.update(s.enterprise).set({ ...input.changes, ...(renamed ? { nameNorm: normalizeName(after.name) } : {}) }).where(eq(s.enterprise.id, enterpriseId)).run()
    const afterVersion = version({ ...current, profile: after, row: { ...current.row, nameNorm: renamed ? normalizeName(after.name) : current.row.nameNorm }, key: input.idempotencyKey })
    const audit = tx.insert(s.enterpriseProfileAudit).values({ enterpriseId, idempotencyKey: input.idempotencyKey, requestHash, beforeVersion, afterVersion, before: current.profile, after, actor: input.actor, basis: input.basis, retainedAliasId, aliasCreated }).returning().get()
    if (renamed) captureIdentityRevision113(tx, { enterpriseId, sourceKey: `enterprise:${enterpriseId}`, sourceVersion: `profile:${audit.id}`, before: identityBefore, after: identityMaterial113(tx, enterpriseId) })
    return receipt(audit)
  }, { behavior: 'immediate' })
}
export function getEnterpriseProfileHistory(db: Db, enterpriseId: number, query: Record<string, unknown>) {
  const parsed = z.strictObject({ page: z.coerce.number().int().min(1).max(10000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).safeParse(query)
  if (!parsed.success) throw new EnterpriseProfileError(400, 'invalid_request', 'Expected page 1..10000 and pageSize 1..100; no other selectors')
  return db.transaction(tx => {
    const { page, pageSize } = parsed.data, scope = eq(s.enterpriseProfileAudit.enterpriseId, enterpriseId)
    const total = tx.select({ count: sql<number>`count(*)` }).from(s.enterpriseProfileAudit).where(scope).get()!.count
    if (total === 0 && !tx.select({ id: s.enterprise.id }).from(s.enterprise).where(eq(s.enterprise.id, enterpriseId)).get()) throw new EnterpriseProfileError(404, 'not_found', 'Enterprise and profile history not found')
    const rows = tx.select({ id: s.enterpriseProfileAudit.id, enterpriseId: s.enterpriseProfileAudit.enterpriseId, before: s.enterpriseProfileAudit.before, after: s.enterpriseProfileAudit.after, beforeVersion: s.enterpriseProfileAudit.beforeVersion, afterVersion: s.enterpriseProfileAudit.afterVersion, actor: s.enterpriseProfileAudit.actor, basis: s.enterpriseProfileAudit.basis, retainedAliasId: s.enterpriseProfileAudit.retainedAliasId, aliasCreated: s.enterpriseProfileAudit.aliasCreated, createdAt: s.enterpriseProfileAudit.createdAt }).from(s.enterpriseProfileAudit).where(scope).orderBy(desc(s.enterpriseProfileAudit.id)).limit(pageSize).offset((page - 1) * pageSize).all()
    const result = { rows, total, page, pageSize }
    if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new EnterpriseProfileError(413, 'response_too_large', 'History page exceeds 256 KiB; request a smaller pageSize')
    return result
  })
}
