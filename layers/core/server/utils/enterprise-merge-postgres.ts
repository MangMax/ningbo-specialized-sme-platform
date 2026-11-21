import { and, asc, desc, eq, exists, inArray, ne, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise, enterpriseAlias, enterpriseAliasAudit, enterpriseMerge } from '../../../../db/postgresql/enterprise-tables'
import { normalizeEnterpriseName } from '../../lib/enterprise-name'

type Transaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type AliasSourceKind = typeof enterpriseAlias.$inferInsert.sourceKind

const sourceAlias = alias(enterpriseAlias, 'source_alias')
const survivorAlias = alias(enterpriseAlias, 'survivor_alias')
const pairedAliases = and(
  eq(sourceAlias.nameNorm, survivorAlias.nameNorm),
  eq(sourceAlias.sourceKind, survivorAlias.sourceKind),
  eq(sourceAlias.sourceRefId, survivorAlias.sourceRefId),
)
const sourceAudit = alias(enterpriseAliasAudit, 'source_audit')
const survivorAudit = alias(enterpriseAliasAudit, 'survivor_audit')

export async function findPostgresEnterpriseMergeAliasConflict(tx: Transaction, from: number, into: number) {
  const audited = exists(tx.select({ id: enterpriseAliasAudit.id }).from(enterpriseAliasAudit).where(or(
    eq(enterpriseAliasAudit.aliasId, sourceAlias.id), eq(enterpriseAliasAudit.aliasId, survivorAlias.id),
  )))
  const statusConflict = and(ne(sourceAlias.verificationStatus, survivorAlias.verificationStatus), or(
    eq(sourceAlias.verificationStatus, 'withdrawn'), eq(survivorAlias.verificationStatus, 'withdrawn'), audited,
  ))!.mapWith(Boolean)
  const keyConflict = exists(tx.select({ id: sourceAudit.id }).from(sourceAudit).innerJoin(survivorAudit, and(
    eq(survivorAudit.aliasId, survivorAlias.id), eq(survivorAudit.idempotencyKey, sourceAudit.idempotencyKey),
  )).where(eq(sourceAudit.aliasId, sourceAlias.id)))
  const [clash] = await tx.select({ sourceId: sourceAlias.id, survivorId: survivorAlias.id, statusConflict })
    .from(sourceAlias).innerJoin(survivorAlias, and(eq(survivorAlias.enterpriseId, into), pairedAliases))
    .where(and(eq(sourceAlias.enterpriseId, from), or(statusConflict, keyConflict)))
    .orderBy(asc(sourceAlias.id)).limit(1)
  if (!clash) return null
  const pair = `${clash.sourceId}/${clash.survivorId}`
  return clash.statusConflict
    ? { code: 'merge_alias_lifecycle_conflict', message: `别名 ${pair} 核验状态不同，须显式处理后再归并` }
    : { code: 'merge_alias_audit_key_conflict', message: `别名 ${pair} 存在同幂等键审计，不能丢弃任何一条历史` }
}

async function moveAliases(tx: Transaction, from: number, into: number) {
  const survivor = and(eq(survivorAlias.enterpriseId, into), pairedAliases)
  const source = eq(sourceAlias.enterpriseId, from)
  await tx.update(enterpriseAliasAudit).set({ aliasId: survivorAlias.id })
    .from(sourceAlias).innerJoin(survivorAlias, survivor)
    .where(and(source, eq(enterpriseAliasAudit.aliasId, sourceAlias.id)))
  // A typed IN subquery expresses the original DELETE USING join.
  await tx.delete(enterpriseAlias).where(inArray(enterpriseAlias.id,
    tx.select({ id: sourceAlias.id }).from(sourceAlias).innerJoin(survivorAlias, survivor).where(source),
  ))
  const { rowCount } = await tx.update(enterpriseAlias).set({ enterpriseId: into }).where(eq(enterpriseAlias.enterpriseId, from))
  return rowCount ?? 0
}

async function ensureMergeAlias(tx: Transaction, enterpriseId: number, name: string, sourceKind: AliasSourceKind, sourceRefId: number, note: string) {
  const nameNorm = normalizeEnterpriseName(name)
  const [existing] = await tx.select({ id: enterpriseAlias.id }).from(enterpriseAlias).where(and(
    eq(enterpriseAlias.enterpriseId, enterpriseId), eq(enterpriseAlias.nameNorm, nameNorm), or(
      eq(enterpriseAlias.verificationStatus, 'confirmed'),
      and(eq(enterpriseAlias.sourceKind, sourceKind), eq(enterpriseAlias.sourceRefId, sourceRefId)),
    ),
  )).orderBy(desc(eq(enterpriseAlias.verificationStatus, 'confirmed')), asc(enterpriseAlias.id)).limit(1)
  if (existing) return { id: existing.id, created: false }
  const [created] = await tx.insert(enterpriseAlias).values({
    enterpriseId, name, nameNorm, sourceKind, sourceRefId, verificationStatus: 'confirmed', note,
    createdAt: new Date().toISOString(),
  }).returning({ id: enterpriseAlias.id })
  return { id: created!.id, created: true }
}

interface EnterpriseMergeInput {
  fromEnterpriseId: number
  intoEnterpriseId: number
  rename: { from: string; to: string; note: string } | null
  sourceAlias: { name: string; note: string } | null
  sourceKind: AliasSourceKind
  sourceRefId: number
  basis: string
}

export async function applyPostgresEnterpriseMerge(tx: Transaction, input: EnterpriseMergeInput) {
  const { fromEnterpriseId: from, intoEnterpriseId: into, rename, sourceAlias, sourceKind, sourceRefId, basis } = input
  let renameAlias: { id: number | null; created: boolean } = { id: null, created: false }
  if (rename !== null) {
    await tx.update(enterprise).set({ name: rename.to, nameNorm: normalizeEnterpriseName(rename.to) }).where(eq(enterprise.id, into))
    renameAlias = await ensureMergeAlias(tx, into, rename.from, sourceKind, sourceRefId, rename.note)
  }
  const alias = sourceAlias === null ? { id: null, created: false }
    : await ensureMergeAlias(tx, into, sourceAlias.name, sourceKind, sourceRefId, sourceAlias.note)
  if (alias.created || renameAlias.created) {
    const generatedAliasConflict = await findPostgresEnterpriseMergeAliasConflict(tx, from, into)
    if (generatedAliasConflict) return { ok: false as const, error: generatedAliasConflict }
  }
  const aliasesMoved = await moveAliases(tx, from, into)

  const recordedAt = new Date().toISOString()
  await tx.insert(enterpriseMerge).values({ fromEnterpriseId: from, intoEnterpriseId: into, basis, recordedAt })
  return { ok: true as const, alias, renameAlias, aliasesMoved, recordedAt }
}
