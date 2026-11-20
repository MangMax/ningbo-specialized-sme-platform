import { getTableColumns, sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import * as schema from '../../../../../db/schema'
import { differencePublicColumns } from '../../../lib/platform/difference-reference-target'
import { DecisionError102, publicVersion102, type currentDecision102, type decisionHistory102 } from '../decision-lifecycle-102'

type Reader = Pick<NodePgDatabase,'execute'>
type Scope = Parameters<typeof currentDecision102>[1]
type PublicRow = Parameters<typeof publicVersion102>[0]
const decisionColumns = getTableColumns(schema.differenceReason)
const aliasOf = {
  evidenceQueryId: sql`(SELECT old_id FROM platform_legacy_query_alias WHERE collection_id=p.evidence_query_id)`,
  evidenceRelationId: sql`(SELECT old_id FROM platform_legacy_relation_alias WHERE observation_id=p.evidence_relation_id)`,
}

export function postgresDifferenceRow(keys = Object.keys(differencePublicColumns({}))) {
  const fields = keys.map(key => {
    let value: SQL
    if (key === 'evidenceQueryId' || key === 'evidenceRelationId') value = aliasOf[key]
    else {
      const column = decisionColumns[key as keyof typeof decisionColumns]
      value = sql`p.${sql.identifier(column.name)}`
      if (column.dataType === 'json') value = sql`(${value})::json`
    }
    return sql`${key}::text,${value}`
  })
  return sql`json_build_object(${sql.join(fields, sql`,`)})`
}

const inScope = (scope: Scope) => sql`p.enterprise_id=${scope.enterpriseId} AND p.title_code=${scope.titleCode} AND p.direction=${scope.direction}`

export async function readPostgresDecisionHead102(db: Reader, scope: Scope) {
  const { rows: [row] } = await db.execute<Pick<PublicRow,'id'|'recordedAt'|'lifecycleAction'|'status'>>(sql`
    SELECT p.id::float8 AS id,p.recorded_at AS "recordedAt",p.lifecycle_action AS "lifecycleAction",p.status
    FROM difference_reason p WHERE ${inScope(scope)} ORDER BY p.recorded_at DESC,p.id DESC LIMIT 1`)
  return row
}

export async function requirePostgresDecisionEnterprise(db: Reader, id: number) {
  const { rows: [enterprise] } = await db.execute<{ id: number; nameNorm: string; usccNorm: string | null }>(sql`
    SELECT id::float8 AS id,name_norm AS "nameNorm",uscc_norm AS "usccNorm" FROM enterprise WHERE id=${id}`)
  if (!enterprise) throw new DecisionError102(404, 'not_found', 'Enterprise not found')
  return enterprise
}

export async function currentPostgresDecisions102(db: Reader, scopes: readonly Scope[]) {
  if (!scopes.length) return []
  const { rows } = await db.execute<{ existing: boolean; headId: number | null; decision: PublicRow | null }>(sql`
    SELECT e.id IS NOT NULL AS existing,p.id::float8 AS "headId",
      CASE WHEN p.id IS NOT NULL AND p.lifecycle_action IS DISTINCT FROM 'withdraw' THEN ${postgresDifferenceRow()} END AS decision
    FROM unnest(${sql.param(scopes.map(scope => scope.enterpriseId))}::bigint[],
      ${sql.param(scopes.map(scope => scope.titleCode))}::text[],${sql.param(scopes.map(scope => scope.direction))}::text[])
      WITH ORDINALITY AS s(enterprise_id,title_code,direction,ordinal)
    LEFT JOIN enterprise e ON e.id=s.enterprise_id
    LEFT JOIN LATERAL (SELECT * FROM difference_reason d WHERE d.enterprise_id=s.enterprise_id AND d.title_code=s.title_code
      AND d.direction=s.direction ORDER BY d.recorded_at DESC,d.id DESC LIMIT 1) p ON true
    ORDER BY s.ordinal`)
  return rows.map(({ existing, headId, decision }, index) => {
    if (!existing) throw new DecisionError102(404, 'not_found', 'Enterprise not found')
    return { ...scopes[index]!, versionId: headId, current: decision ? publicVersion102(decision, headId) : null }
  })
}

export async function readPostgresQualificationDecisionHeads(db: Reader, enterpriseId: number, titles: readonly string[]) {
  const { rows } = await db.execute<{ decision: PublicRow }>(sql`
    SELECT ${postgresDifferenceRow()} AS decision
    FROM unnest(${sql.param(titles)}::text[]) AS t(title)
    CROSS JOIN (VALUES ('missing_in_miit'),('extra_in_miit')) AS s(direction)
    JOIN LATERAL (SELECT * FROM difference_reason d WHERE d.enterprise_id=${enterpriseId} AND d.title_code=t.title
      AND d.direction=s.direction ORDER BY d.recorded_at DESC,d.id DESC LIMIT 1) p ON true`)
  return rows.map(({ decision }) => decision)
}

export async function readPostgresDecision102(db: Reader, id: number) {
  const { rows: [stored] } = await db.execute<{ row: PublicRow }>(sql`
    SELECT ${postgresDifferenceRow()} AS row FROM difference_reason p WHERE id=${id}`)
  if (!stored) throw new DecisionError102(404, 'not_found', 'Decision version not found')
  return publicVersion102(stored.row, (await readPostgresDecisionHead102(db, stored.row))?.id ?? null)
}

const historyFields = ['id','enterpriseId','titleCode','direction','status','reasonCode','measureCode','verificationStatus','recordedAt',
  'lifecycleAction','previousId','actor','ruleVersion','effectiveAt','evidenceQueryId','evidenceRelationId'] as const

export async function historyPostgresDecision102(db: Reader, input: z.infer<typeof decisionHistory102>) {
  const scope = 'id' in input ? (await db.execute<Scope>(sql`SELECT enterprise_id::float8 AS "enterpriseId",
      title_code AS "titleCode",direction FROM difference_reason WHERE id=${input.id}`)).rows[0] : input
  if (!scope) throw new DecisionError102(404, 'not_found', 'Decision version not found')
  await requirePostgresDecisionEnterprise(db, scope.enterpriseId)
  const head = await readPostgresDecisionHead102(db, scope)
  const { rows: [count] } = await db.execute<{ total: number }>(sql`SELECT count(*)::float8 AS total FROM difference_reason p WHERE ${inScope(scope)}`)
  const { rows } = await db.execute<{ row: Pick<PublicRow,typeof historyFields[number]> }>(sql`
    SELECT ${postgresDifferenceRow([...historyFields])} AS row FROM difference_reason p WHERE ${inScope(scope)}
    ORDER BY p.recorded_at DESC,p.id DESC LIMIT ${input.pageSize} OFFSET ${(input.page-1)*input.pageSize}`)
  return { total: count!.total, page: input.page, pageSize: input.pageSize, rows: rows.map(({ row }) => ({
    ...row, origin: row.lifecycleAction ? 'lifecycle' : 'legacy_import', isCurrent: row.id === head?.id, detailsAvailable: true,
  })) }
}
