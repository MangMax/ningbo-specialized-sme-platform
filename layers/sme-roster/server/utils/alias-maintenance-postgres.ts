import { isCurrentPlatformObservation } from '../../lib/platform/current-observation-postgres'
import { createHash } from 'node:crypto'
import { and, count, desc, eq, ne, notExists } from 'drizzle-orm'
import { alias as pgAlias } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise as enterpriseTable, enterpriseAlias as aliases, enterpriseAliasAudit as audit, enterpriseMerge } from '../../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { sourceDocument } from '../../../../db/postgresql/official-evidence-tables'
import { platformBusinessObservation as observation, platformCollection as collection,
  platformObservationAssignment as assignment } from '../../../../db/postgresql/platform-tables'
import { z } from 'zod'
import { lockReviewedEnterpriseBatch, canonicalEnterpriseId } from '../../../core/server/public'
import { normalizeUscc } from '../../lib/domain'
import { failAlias, parse as parseAliasInput, positiveId as positiveAliasId } from './alias-maintenance-model'
import { aliasDecisionSchema, aliasListInput, aliasPageInput, boundedAliasPage, decideEnterpriseAlias } from './alias-maintenance-model'

type Db = NodePgDatabase
type Alias = Parameters<typeof decideEnterpriseAlias>[0]
function aliasView(row: typeof aliases.$inferSelect): Alias {
  const { id, enterpriseId, version, originalName, originalSourceKind, originalSourceRefId,
    name, nameNorm, sourceKind, sourceRefId, validFrom, validTo, verificationStatus, note, createdAt } = row
  return { id, enterpriseId, version, originalName: originalName ?? name,
    originalSourceKind: originalSourceKind ?? sourceKind, originalSourceRefId: originalSourceRefId ?? sourceRefId,
    name, nameNorm, sourceKind, sourceRefId, validFrom, validTo, verificationStatus, note, createdAt }
}
const snapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const

async function enterprise(db: Db, rawId: unknown) {
  const requested = parseAliasInput(positiveAliasId, rawId)
  const id = await canonicalEnterpriseId(db, requested)
  if (id === null) return failAlias(404, 'enterprise_not_found', '企业不存在')
  return { id, requested }
}

async function readAlias(db: Db, enterpriseId: number, aliasId: unknown) {
  const id = parseAliasInput(positiveAliasId, aliasId)
  const [row] = await db.select().from(aliases).where(and(eq(aliases.id, id), eq(aliases.enterpriseId, enterpriseId)))
  return row ? aliasView(row) : failAlias(404, 'alias_not_found', '该企业没有此别名')
}

export function getPostgresEnterpriseAlias(db: Db, enterpriseId: unknown, aliasId: unknown) {
  return db.transaction(async tx => readAlias(tx, (await enterprise(tx, enterpriseId)).id, aliasId), snapshot)
}

export function listPostgresEnterpriseAliases(db: Db, enterpriseId: unknown, input: unknown) {
  return db.transaction(async tx => {
    const { id } = await enterprise(tx, enterpriseId)
    const { page, pageSize, status } = parseAliasInput(z.strictObject(aliasListInput), input)
    const scope = and(eq(aliases.enterpriseId, id), status === 'all' ? undefined : eq(aliases.verificationStatus, status))
    const [counted] = await tx.select({ total: count() }).from(aliases).where(scope)
    const total = counted!.total
    const rows = await tx.select().from(aliases).where(scope).orderBy(aliases.id).limit(pageSize).offset((page - 1) * pageSize)
    return boundedAliasPage({ page, pageSize, total, rows: rows.map(aliasView) })
  }, snapshot)
}

export function getPostgresEnterpriseAliasHistory(db: Db, enterpriseId: unknown, aliasId: unknown, input: unknown) {
  return db.transaction(async tx => {
    const alias = await readAlias(tx, (await enterprise(tx, enterpriseId)).id, aliasId)
    const { page, pageSize } = parseAliasInput(z.strictObject(aliasPageInput), input)
    const scope = eq(audit.aliasId, alias.id)
    const [counted] = await tx.select({ total: count() }).from(audit).where(scope)
    const total = counted!.total
    const rows = await tx.select().from(audit).where(scope).orderBy(audit.id).limit(pageSize).offset((page - 1) * pageSize)
    return boundedAliasPage({ page, pageSize, total,
      rows: rows.map(row => ({ ...row, before: JSON.parse(row.before), after: JSON.parse(row.after) })) })
  }, snapshot)
}

async function checkSource(db: Db, alias: Alias) {
  const { sourceKind, sourceRefId, enterpriseId, name } = alias
  if (sourceKind === 'manual') {
    if (sourceRefId !== 0) failAlias(400, 'alias_source_evidence_mismatch', '人工依据使用basis，不接受来源行ID')
    return
  }
  if (sourceKind === 'announcement') {
    const rows = await db.select({ id: sourceDocument.id }).from(recordEvidence)
      .innerJoin(recordEvent, eq(recordEvent.id, recordEvidence.recordEventId))
      .innerJoin(record, eq(record.id, recordEvent.recordId))
      .innerJoin(sourceDocument, eq(sourceDocument.path, recordEvidence.sourceFile))
      .where(and(eq(sourceDocument.id, sourceRefId), eq(sourceDocument.source, 'jxj'), eq(record.enterpriseId, enterpriseId),
        eq(record.nameRaw, name))).limit(1)
    if (!rows.length) failAlias(400, 'alias_source_evidence_mismatch', '公布名单原件的 ID 必须由该企业同原名称的记录出处支持')
    return
  }
  const original = pgAlias(assignment, 'original')
  const latest = db.select({ enterpriseId: assignment.enterpriseId, observationId: assignment.observationId }).from(assignment)
    .where(eq(assignment.observationId, observation.id)).orderBy(desc(assignment.revision)).limit(1).as('latest')
  const [source] = await db.select({ interface: collection.interface, enterpriseId: latest.enterpriseId,
    uscc: enterpriseTable.usccNorm, originalUscc: original.usccRaw, originalName: original.nameRaw }).from(observation)
    .innerJoin(collection, eq(collection.id, observation.collectionId))
    .innerJoin(enterpriseTable, eq(enterpriseTable.id, enterpriseId))
    .innerJoin(original, and(eq(original.observationId, observation.id), eq(original.revision, 1)))
    .innerJoinLateral(latest, eq(latest.observationId, observation.id))
    .where(and(eq(observation.publicId, sourceRefId), isCurrentPlatformObservation(db)))
  if (!source) return failAlias(400, 'alias_source_evidence_required', '平台别名必须引用真实平台关系')
  const expectedInterface = sourceKind === 'platform_business' ? 'business_list' : 'apply_list'
  if (source.interface !== expectedInterface || !source.uscc || normalizeUscc(source.originalUscc) !== source.uscc || source.originalName !== name) {
    failAlias(400, 'alias_source_evidence_mismatch', '平台关系的接口、统一社会信用代码或 qymc 与该别名不一致')
  }
  if (source.enterpriseId !== null && await canonicalEnterpriseId(db, Number(source.enterpriseId)) !== enterpriseId) {
    failAlias(400, 'alias_source_evidence_mismatch', '平台关系已归属的企业与该别名归属企业不一致')
  }
}

async function checkConflict(db: Db, alias: Alias) {
  const { nameNorm, enterpriseId, sourceKind, sourceRefId, id } = alias
  if (alias.verificationStatus === 'confirmed') {
    const otherName = db.select({ id: enterpriseTable.id }).from(enterpriseTable)
      .where(and(ne(enterpriseTable.id, enterpriseId), eq(enterpriseTable.nameNorm, nameNorm),
        notExists(db.select({ id: enterpriseMerge.fromEnterpriseId }).from(enterpriseMerge)
          .where(eq(enterpriseMerge.fromEnterpriseId, enterpriseTable.id)))))
    const otherAlias = db.select({ id: aliases.id }).from(aliases)
      .where(and(ne(aliases.enterpriseId, enterpriseId), eq(aliases.nameNorm, nameNorm), eq(aliases.verificationStatus, 'confirmed')))
    if ((await otherName.unionAll(otherAlias).limit(1)).length) {
      failAlias(409, 'alias_subject_conflict', '该名称已由其他企业使用，不能自动确认归属')
    }
  }
  const rows = await db.select({ id: aliases.id }).from(aliases)
    .where(and(ne(aliases.id, id), eq(aliases.enterpriseId, enterpriseId), eq(aliases.nameNorm, nameNorm),
      eq(aliases.sourceKind, sourceKind), eq(aliases.sourceRefId, sourceRefId))).limit(1)
  if (rows.length) failAlias(409, 'alias_identity_conflict', '更正后的自然键已有别名，请维护其稳定ID')
}

export function maintainPostgresEnterpriseAlias(db: Db, enterpriseId: unknown, aliasId: unknown, input: unknown) {
  if (process.env.NUXT_DB_READONLY === '1') failAlias(503, 'write_unavailable', 'PostgreSQL 企业别名处于只读模式')
  const request = parseAliasInput(aliasDecisionSchema, input)
  const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
  return db.transaction(async tx => {
    const { id: owner, requested } = await enterprise(tx, enterpriseId)
    await tx.select({ id: enterpriseTable.id }).from(enterpriseTable).where(eq(enterpriseTable.id, owner)).for('update')
    if (owner !== await canonicalEnterpriseId(tx, requested)) failAlias(409, 'alias_version_conflict', '别名版本已改变，请重新读取')
    const before = await readAlias(tx, owner, aliasId)
    const [prior] = await tx.select({ hash: audit.requestHash, after: audit.after }).from(audit)
      .where(and(eq(audit.aliasId, before.id), eq(audit.idempotencyKey, request.idempotencyKey)))
    if (prior) {
      if (prior.hash !== requestHash) failAlias(409, 'alias_idempotency_conflict', '同一幂等键载荷不同')
      return { alias: JSON.parse(prior.after) as Alias, replayed: true }
    }
    const next = decideEnterpriseAlias(before, request)
    if (request.action !== 'withdraw') {
      await lockReviewedEnterpriseBatch(tx, [owner], [{ name: before.name }, { name: next.name }])
      await checkSource(tx, next)
      await checkConflict(tx, next)
    }
    const [updated] = await tx.update(aliases).set({
      name: next.name, nameNorm: next.nameNorm, sourceKind: next.sourceKind, sourceRefId: next.sourceRefId,
      validFrom: next.validFrom, validTo: next.validTo, note: next.note, verificationStatus: next.verificationStatus,
      version: before.version + 1, originalName: before.originalName, originalSourceKind: before.originalSourceKind,
      originalSourceRefId: before.originalSourceRefId,
    }).where(and(eq(aliases.id, before.id), eq(aliases.version, request.expectedVersion))).returning()
    if (!updated) return failAlias(409, 'alias_version_conflict', '别名版本已改变')
    const alias = aliasView(updated)
    await tx.insert(audit).values({
      aliasId: before.id, enterpriseId: owner, action: request.action, actor: request.actor, basis: request.basis,
      idempotencyKey: request.idempotencyKey, requestHash, before: JSON.stringify(before), after: JSON.stringify(alias),
      createdAt: new Date().toISOString(),
    })
    return { alias, replayed: false }
  })
}
