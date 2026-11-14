import { createHash } from 'node:crypto'
import { and, asc, count, eq, ne } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { createError } from 'h3'
import { z } from 'zod'
import { normalizeName } from '../../lib/domain'
import * as schema from '../../db/schema'
import { captureIdentityRevision113, identityMaterial113 } from './evidence-impact-113'
import { findPlatformAliasRelationEvidence, platformAliasEvidenceMismatch } from './roster-import'
import { canonicalEnterpriseId, currentEnterpriseIdentity } from '../../lib/roster/enterprise-identity'

type Db = BetterSQLite3Database<typeof schema>
const positiveId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
function fail(statusCode: number, code: string, message: string): never { throw createError({ statusCode, message, data: { code } }) }
function parse<T>(shape: z.ZodType<T>, value: unknown): T {
  const result = shape.safeParse(value)
  if (!result.success) fail(400, 'alias_input_invalid', result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
  return result.data
}
export const aliasPageInput = {
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}
export const aliasDecisionInput = {
  action: z.enum(['confirm', 'correct', 'withdraw']),
  changes: z.object({
    name: z.string().trim().min(1).max(1000).optional(),
    sourceKind: z.enum(['platform_business', 'platform_apply', 'announcement', 'manual']).optional(),
    sourceRefId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    validFrom: z.string().trim().min(1).max(100).nullable().optional(),
    validTo: z.string().trim().min(1).max(100).nullable().optional(),
    note: z.string().max(4000).nullable().optional(),
  }).strict().optional(),
  expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
  actor: z.string().trim().min(1).max(200),
  basis: z.string().trim().min(1).max(4000),
  idempotencyKey: z.string().trim().min(1).max(200),
}
export const aliasListInput = { ...aliasPageInput, status: z.enum(['all', 'pending', 'confirmed', 'withdrawn']).default('all') }
function enterprise(db: Db, value: unknown) {
  const selectedId = parse(positiveId, value)
  const id = canonicalEnterpriseId(db, selectedId) ?? selectedId
  const found = db.select({ id: schema.enterprise.id, usccNorm: schema.enterprise.usccNorm }).from(schema.enterprise).where(eq(schema.enterprise.id, id)).get()
  if (!found) fail(404, 'enterprise_not_found', '企业不存在')
  return found
}
const view = (row: typeof schema.enterpriseAlias.$inferSelect) => ({ ...row, originalName: row.originalName ?? row.name, originalSourceKind: row.originalSourceKind ?? row.sourceKind, originalSourceRefId: row.originalSourceRefId ?? row.sourceRefId })
export function getEnterpriseAlias(db: Db, enterpriseId: unknown, aliasId: unknown) {
  const owner = enterprise(db, enterpriseId)
  const id = parse(positiveId, aliasId)
  const row = db.select().from(schema.enterpriseAlias).where(and(eq(schema.enterpriseAlias.id, id), eq(schema.enterpriseAlias.enterpriseId, owner.id))).get()
  if (!row) fail(404, 'alias_not_found', '该企业没有此别名')
  return view(row)
}
/** A page never silently truncates persisted notes or history snapshots. */
function boundedPage<T>(result: T): T {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 256 * 1024) fail(413, 'alias_page_response_too_large', '别名页面超过256KiB，请减小pageSize后完整分页读取')
  return result
}
export function listEnterpriseAliases(db: Db, enterpriseId: unknown, input: unknown) {
  const owner = enterprise(db, enterpriseId)
  const { page, pageSize, status } = parse(z.object(aliasListInput).strict(), input)
  const where = and(eq(schema.enterpriseAlias.enterpriseId, owner.id), status === 'all' ? undefined : eq(schema.enterpriseAlias.verificationStatus, status))
  return boundedPage(db.transaction(tx => ({ page, pageSize, total: tx.select({ n: count() }).from(schema.enterpriseAlias).where(where).get()!.n,
    rows: tx.select().from(schema.enterpriseAlias).where(where).orderBy(asc(schema.enterpriseAlias.id)).limit(pageSize).offset((page - 1) * pageSize).all().map(view),
  })))
}
export function getEnterpriseAliasHistory(db: Db, enterpriseId: unknown, aliasId: unknown, input: unknown) {
  const alias = getEnterpriseAlias(db, enterpriseId, aliasId)
  const { page, pageSize } = parse(z.object(aliasPageInput).strict(), input)
  const where = eq(schema.enterpriseAliasAudit.aliasId, alias.id)
  return boundedPage(db.transaction(tx => ({ page, pageSize, total: tx.select({ n: count() }).from(schema.enterpriseAliasAudit).where(where).get()!.n,
    rows: tx.select().from(schema.enterpriseAliasAudit).where(where).orderBy(asc(schema.enterpriseAliasAudit.id)).limit(pageSize).offset((page - 1) * pageSize).all(),
  })))
}
export function maintainEnterpriseAlias(db: Db, enterpriseId: unknown, aliasId: unknown, input: unknown) {
  const request = parse(z.object(aliasDecisionInput).strict(), input)
  const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
  return db.transaction(tx => {
    const before = getEnterpriseAlias(tx, enterpriseId, aliasId)
    const previous = tx.select().from(schema.enterpriseAliasAudit).where(and(eq(schema.enterpriseAliasAudit.aliasId, before.id), eq(schema.enterpriseAliasAudit.idempotencyKey, request.idempotencyKey))).get()
    if (previous) {
      if (previous.requestHash !== requestHash) fail(409, 'alias_idempotency_conflict', '同一幂等键载荷不同')
      return { alias: previous.after, replayed: true }
    }
    if (before.version !== request.expectedVersion) fail(409, 'alias_version_conflict', '别名版本已改变，请重新读取')
    if (request.action !== 'correct' && request.changes != null) fail(400, 'alias_input_invalid', '仅更正操作接收changes')
    if (request.action === 'confirm' && before.verificationStatus === 'confirmed') fail(409, 'alias_transition_invalid', '该别名已经确认')
    if (request.action === 'withdraw' && before.verificationStatus === 'withdrawn') fail(409, 'alias_transition_invalid', '该别名已经撤回')
    const changes = request.changes ?? {}
    if (request.action === 'correct' && !Object.entries(changes).some(([key, value]) => before[key as keyof typeof before] !== value)) fail(400, 'alias_correction_empty', '更正必须明确改变字段')
    const next = { ...before, ...changes, nameNorm: changes.name == null ? before.nameNorm : normalizeName(changes.name),
      verificationStatus: request.action === 'confirm' ? 'confirmed' as const : request.action === 'withdraw' ? 'withdrawn' as const : before.verificationStatus }
    if (!next.nameNorm) fail(400, 'alias_input_invalid', '归一化名称不能为空')
    const target = enterprise(tx, enterpriseId)
    if (request.action !== 'withdraw') {
      if (next.sourceKind === 'platform_business' || next.sourceKind === 'platform_apply') {
        const evidence = findPlatformAliasRelationEvidence(tx, next.sourceRefId)
        if (!evidence) fail(400, 'alias_source_evidence_required', '平台别名必须引用真实平台关系')
        const mismatch = platformAliasEvidenceMismatch(tx, next.sourceKind, next.name, target.usccNorm, target.id, evidence)
        if (mismatch) fail(400, 'alias_source_evidence_mismatch', mismatch)
      } else if (next.sourceKind === 'manual') {
        if (next.sourceRefId !== 0) fail(400, 'alias_source_evidence_mismatch', '人工依据使用basis，不接受来源行ID')
      } else {
        const evidence = tx.select({ id: schema.recordEvidence.id }).from(schema.recordEvidence)
          .innerJoin(schema.recordEvent, eq(schema.recordEvent.id, schema.recordEvidence.recordEventId))
          .innerJoin(schema.record, eq(schema.record.id, schema.recordEvent.recordId))
          .innerJoin(schema.sourceDocument, eq(schema.sourceDocument.path, schema.recordEvidence.sourceFile))
          .where(and(eq(schema.sourceDocument.id, next.sourceRefId), eq(schema.sourceDocument.source, 'jxj'), eq(schema.record.enterpriseId, target.id), eq(schema.record.nameRaw, next.name))).limit(1).get()
        if (!evidence) fail(400, 'alias_source_evidence_mismatch', '公布文件ID必须由该企业同原名称的记录出处支持')
      }
      if (next.verificationStatus === 'confirmed') {
        const other = tx.select({ id: schema.enterprise.id }).from(schema.enterprise).where(and(currentEnterpriseIdentity(tx), ne(schema.enterprise.id, target.id), eq(schema.enterprise.nameNorm, next.nameNorm))).limit(1).get()
        const otherAlias = tx.select({ id: schema.enterpriseAlias.id }).from(schema.enterpriseAlias).where(and(ne(schema.enterpriseAlias.enterpriseId, target.id), eq(schema.enterpriseAlias.nameNorm, next.nameNorm), eq(schema.enterpriseAlias.verificationStatus, 'confirmed'))).limit(1).get()
        if (other || otherAlias) fail(409, 'alias_subject_conflict', '该名称已由其他企业使用，不能自动确认归属')
      }
      const clash = tx.select({ id: schema.enterpriseAlias.id }).from(schema.enterpriseAlias).where(and(ne(schema.enterpriseAlias.id, before.id), eq(schema.enterpriseAlias.enterpriseId, before.enterpriseId), eq(schema.enterpriseAlias.nameNorm, next.nameNorm), eq(schema.enterpriseAlias.sourceKind, next.sourceKind), eq(schema.enterpriseAlias.sourceRefId, next.sourceRefId))).limit(1).get()
      if (clash) fail(409, 'alias_identity_conflict', '更正后的自然键已有别名，请维护其稳定ID')
    }
    const identityBefore = identityMaterial113(tx, before.enterpriseId)
    const after = tx.update(schema.enterpriseAlias).set({ ...changes, nameNorm: next.nameNorm, verificationStatus: next.verificationStatus, version: before.version + 1,
      originalName: before.originalName, originalSourceKind: before.originalSourceKind, originalSourceRefId: before.originalSourceRefId,
    }).where(and(eq(schema.enterpriseAlias.id, before.id), eq(schema.enterpriseAlias.version, request.expectedVersion))).returning().get()
    if (!after) fail(409, 'alias_version_conflict', '别名版本已改变')
    const result = view(after)
    tx.insert(schema.enterpriseAliasAudit).values({ aliasId: before.id, enterpriseId: before.enterpriseId, action: request.action,
      actor: request.actor, basis: request.basis, idempotencyKey: request.idempotencyKey, requestHash,
      before, after: result, createdAt: new Date().toISOString(),
    }).run()
    captureIdentityRevision113(tx, { enterpriseId: before.enterpriseId, sourceKey: `enterprise:${before.enterpriseId}`, sourceVersion: `alias:${before.id}:${after.version}`, before: identityBefore, after: identityMaterial113(tx, before.enterpriseId) })
    return { alias: result, replayed: false }
  }, { behavior: 'immediate' })
}
