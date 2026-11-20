import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { enterpriseAlias } from '../../../../db/schema'
import { normalizeEnterpriseName } from '../../lib/enterprise-name'

type Transaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type AliasSourceKind = typeof enterpriseAlias.$inferInsert.sourceKind

const aliasPair = sql`(a.name_norm,a.source_kind,a.source_ref_id)=(b.name_norm,b.source_kind,b.source_ref_id)`

export async function findPostgresEnterpriseMergeAliasConflict(tx: Transaction, from: number, into: number) {
  const { rows: [clash] } = await tx.execute<{ sourceId: string; survivorId: string; statusConflict: boolean }>(sql`
    SELECT a.id AS "sourceId",b.id AS "survivorId",checks.status_conflict AS "statusConflict"
    FROM enterprise_alias a JOIN enterprise_alias b ON b.enterprise_id=${into} AND ${aliasPair}
    CROSS JOIN LATERAL (SELECT a.verification_status<>b.verification_status AND (
      'withdrawn' IN (a.verification_status,b.verification_status)
      OR EXISTS(SELECT 1 FROM enterprise_alias_audit WHERE alias_id IN (a.id,b.id))
    ) AS status_conflict) checks
    WHERE a.enterprise_id=${from} AND (checks.status_conflict OR EXISTS(
      SELECT 1 FROM enterprise_alias_audit x JOIN enterprise_alias_audit y ON y.alias_id=b.id AND y.idempotency_key=x.idempotency_key
      WHERE x.alias_id=a.id))
    ORDER BY a.id LIMIT 1`)
  if (!clash) return null
  const pair = `${clash.sourceId}/${clash.survivorId}`
  return clash.statusConflict
    ? { code: 'merge_alias_lifecycle_conflict', message: `别名 ${pair} 核验状态不同，须显式处理后再归并` }
    : { code: 'merge_alias_audit_key_conflict', message: `别名 ${pair} 存在同幂等键审计，不能丢弃任何一条历史` }
}

async function moveAliases(tx: Transaction, from: number, into: number) {
  // Only the audit lookup ID changes on collision. The original owner and payload stay intact.
  await tx.execute(sql`
    UPDATE enterprise_alias_audit audit SET alias_id=b.id FROM enterprise_alias a
    JOIN enterprise_alias b ON b.enterprise_id=${into} AND ${aliasPair}
    WHERE a.enterprise_id=${from} AND audit.alias_id=a.id`)
  await tx.execute(sql`
    DELETE FROM enterprise_alias a USING enterprise_alias b
    WHERE a.enterprise_id=${from} AND b.enterprise_id=${into} AND ${aliasPair}`)
  const { rowCount } = await tx.execute(sql`UPDATE enterprise_alias SET enterprise_id=${into} WHERE enterprise_id=${from}`)
  return rowCount ?? 0
}

async function ensureMergeAlias(tx: Transaction, enterpriseId: number, name: string, sourceKind: AliasSourceKind, sourceRefId: number, note: string) {
  const nameNorm = normalizeEnterpriseName(name)
  const { rows: [existing] } = await tx.execute<{ id: number }>(sql`
    SELECT id::float8 AS id FROM enterprise_alias WHERE enterprise_id=${enterpriseId} AND name_norm=${nameNorm}
      AND (verification_status='confirmed' OR (source_kind=${sourceKind} AND source_ref_id=${sourceRefId}))
    ORDER BY (verification_status='confirmed') DESC,id LIMIT 1`)
  if (existing) return { id: existing.id, created: false }
  const { rows: [created] } = await tx.execute<{ id: number }>(sql`
    INSERT INTO enterprise_alias (enterprise_id,name,name_norm,source_kind,source_ref_id,verification_status,note,created_at)
    VALUES (${enterpriseId},${name},${nameNorm},${sourceKind},${sourceRefId},'confirmed',${note},${new Date().toISOString()})
    RETURNING id::float8 AS id`)
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

/** Apply the identity changes after the caller locks and checks both subjects.
 * The caller owns rollback, including conflicts found after creating new aliases.
 */
export async function applyPostgresEnterpriseMerge(tx: Transaction, input: EnterpriseMergeInput) {
  const { fromEnterpriseId: from, intoEnterpriseId: into, rename, sourceAlias, sourceKind, sourceRefId, basis } = input
  let renameAlias: { id: number | null; created: boolean } = { id: null, created: false }
  if (rename !== null) {
    await tx.execute(sql`UPDATE enterprise SET name=${rename.to},name_norm=${normalizeEnterpriseName(rename.to)} WHERE id=${into}`)
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
  await tx.execute(sql`INSERT INTO enterprise_merge (from_enterprise_id,into_enterprise_id,basis,recorded_at)
    VALUES (${from},${into},${basis},${recordedAt})`)
  return { ok: true as const, alias, renameAlias, aliasesMoved, recordedAt }
}
