import { and, count, desc, eq, getTableColumns, sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { alias } from 'drizzle-orm/pg-core'
import { enterprise } from '../../../../../db/postgresql/enterprise-tables'
import { differenceReason } from '../../../../../db/postgresql/roster-selection-tables'
import { differencePublicColumns } from '../../../lib/platform/difference-reference-target'
import { DecisionError102, publicVersion102, type currentDecision102, type decisionHistory102 } from '../decision-lifecycle-102'

type Reader = Pick<NodePgDatabase,'select'>
type Scope = Parameters<typeof currentDecision102>[1]
type PublicRow = Parameters<typeof publicVersion102>[0]
const p = alias(differenceReason, 'p')
const decisionColumns = getTableColumns(p)
const jsonFields = new Set(['actor', 'currentQualification', 'factReferences'])
const aliasOf = {
  evidenceQueryId: sql`(SELECT old_id FROM platform_legacy_query_alias WHERE collection_id=p.evidence_query_id)`,
  evidenceRelationId: sql`(SELECT old_id FROM platform_legacy_relation_alias WHERE observation_id=p.evidence_relation_id)`,
}

export function postgresDifferenceRow(keys = Object.keys(differencePublicColumns({}))) {
  const fields = keys.map(key => {
    let value: SQL
    if (key === 'evidenceQueryId' || key === 'evidenceRelationId') value = aliasOf[key]
    else {
      const field = key as keyof typeof decisionColumns
      value = sql`${decisionColumns[field]}`
      if (jsonFields.has(field)) value = sql`(${value})::json`
    }
    return sql`${key}::text,${value}`
  })
  return sql`json_build_object(${sql.join(fields, sql`,`)})`
}

const inScope = (scope: Scope) => and(eq(p.enterpriseId, scope.enterpriseId), eq(p.titleCode, scope.titleCode), eq(p.direction, scope.direction))
const newestFirst = [desc(p.recordedAt), desc(p.id)] as const

export async function readPostgresDecisionHead102(db: Reader, scope: Scope) {
  const [row] = await db.select({ id: p.id, recordedAt: p.recordedAt, lifecycleAction: p.lifecycleAction, status: p.status })
    .from(p).where(inScope(scope)).orderBy(...newestFirst).limit(1)
  return row
}

export async function requirePostgresDecisionEnterprise(db: Reader, id: number) {
  const [owner] = await db.select({ id: enterprise.id, nameNorm: enterprise.nameNorm, usccNorm: enterprise.usccNorm })
    .from(enterprise).where(eq(enterprise.id, id))
  if (!owner) throw new DecisionError102(404, 'not_found', 'Enterprise not found')
  return owner
}

export async function currentPostgresDecisions102(db: Reader, scopes: readonly Scope[]) {
  if (!scopes.length) return []
  // WITH ORDINALITY preserves duplicate scopes and their original positions.
  const wanted = sql`unnest(${sql.param(scopes.map(scope => scope.enterpriseId))}::bigint[],
    ${sql.param(scopes.map(scope => scope.titleCode))}::text[], ${sql.param(scopes.map(scope => scope.direction))}::text[])
    WITH ORDINALITY AS s(enterprise_id,title_code,direction,ordinal)`
  const d = differenceReason
  const head = db.select().from(d).where(and(
    eq(d.enterpriseId, sql`s.enterprise_id`), eq(d.titleCode, sql`s.title_code`),
    eq(d.direction, sql`s.direction`),
  )).orderBy(desc(d.recordedAt), desc(d.id)).limit(1).as('p')
  const rows = await db.select({
    existing: sql<boolean>`${enterprise.id} IS NOT NULL`,
    headId: head.id,
    decision: sql<PublicRow | null>`CASE WHEN ${head.id} IS NOT NULL AND ${head.lifecycleAction} IS DISTINCT FROM 'withdraw'
      THEN ${postgresDifferenceRow()} END`,
  }).from(wanted)
    .leftJoin(enterprise, eq(enterprise.id, sql`s.enterprise_id`))
    .leftJoinLateral(head, sql`true`).orderBy(sql`s.ordinal`)
  return rows.map(({ existing, headId, decision }, index) => {
    if (!existing) throw new DecisionError102(404, 'not_found', 'Enterprise not found')
    return { ...scopes[index]!, versionId: headId, current: decision ? publicVersion102(decision, headId) : null }
  })
}

export async function readPostgresQualificationDecisionHeads(db: Reader, enterpriseId: number, titles: readonly string[]) {
  const d = differenceReason
  const head = db.select().from(d).where(and(eq(d.enterpriseId, enterpriseId),
    eq(d.titleCode, sql`t.title`), eq(d.direction, sql`s.direction`),
  )).orderBy(desc(d.recordedAt), desc(d.id)).limit(1).as('p')
  const rows = await db.select({ decision: sql<PublicRow>`${postgresDifferenceRow()}` })
    .from(sql`unnest(${sql.param(titles)}::text[]) WITH ORDINALITY AS t(title,ordinal)`)
    .crossJoin(sql`(VALUES ('missing_in_miit',1),('extra_in_miit',2)) AS s(direction,ordinal)`)
    .innerJoinLateral(head, sql`true`).orderBy(sql`t.ordinal`, sql`s.ordinal`)
  return rows.map(({ decision }) => decision)
}

export async function readPostgresDecision102(db: Reader, id: number) {
  const [stored] = await db.select({ row: sql<PublicRow>`${postgresDifferenceRow()}` }).from(p).where(eq(p.id, id))
  if (!stored) throw new DecisionError102(404, 'not_found', 'Decision version not found')
  return publicVersion102(stored.row, (await readPostgresDecisionHead102(db, stored.row))?.id ?? null)
}

const historyFields = ['id','enterpriseId','titleCode','direction','status','reasonCode','measureCode','verificationStatus','recordedAt',
  'lifecycleAction','previousId','actor','ruleVersion','effectiveAt','evidenceQueryId','evidenceRelationId'] as const

export async function historyPostgresDecision102(db: Reader, input: z.infer<typeof decisionHistory102>) {
  const scope = 'id' in input ? (await db.select({ enterpriseId: p.enterpriseId, titleCode: p.titleCode, direction: p.direction })
    .from(p).where(eq(p.id, input.id)))[0] : input
  if (!scope) throw new DecisionError102(404, 'not_found', 'Decision version not found')
  await requirePostgresDecisionEnterprise(db, scope.enterpriseId)
  const head = await readPostgresDecisionHead102(db, scope)
  const [totals] = await db.select({ total: count() }).from(p).where(inScope(scope))
  const rows = await db.select({ row: sql<Pick<PublicRow, typeof historyFields[number]>>`${postgresDifferenceRow([...historyFields])}` })
    .from(p).where(inScope(scope)).orderBy(...newestFirst).limit(input.pageSize).offset((input.page - 1) * input.pageSize)
  return { total: totals!.total, page: input.page, pageSize: input.pageSize, rows: rows.map(({ row }) => ({
    ...row, origin: row.lifecycleAction ? 'lifecycle' : 'legacy_import', isCurrent: row.id === head?.id, detailsAvailable: true,
  })) }
}
