import { and, eq, inArray, isNull, min, ne, notExists, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { record } from '../../../db/postgresql/ledger-tables'
import { TITLE_ORDER } from './labels'
import { projectComparisonSources, type ComparisonQuery } from './difference-coordinate-model'

export async function readPostgresDifferenceCoordinates(db: Pick<NodePgDatabase, 'select' | '$with' | 'with'>, opts: ComparisonQuery = {}) {
  const opposite = alias(record, 'opposite')
  const other = alias(enterprise, 'other')
  const localSide = eq(record.source, 'jxj')
  const opposingTitleAndSide = and(eq(opposite.titleCode, record.titleCode), or(
    and(localSide, ne(opposite.source, 'jxj')),
    and(ne(record.source, 'jxj'), eq(opposite.source, 'jxj')),
  ))

  const sameEnterprise = db.select({ id: opposite.id }).from(opposite)
    .where(and(eq(opposite.enterpriseId, record.enterpriseId), opposingTitleAndSide))
  const sameUscc = db.select({ id: opposite.id }).from(other)
    .innerJoin(opposite, eq(opposite.enterpriseId, other.id))
    .where(and(
      ne(other.id, record.enterpriseId),
      // Drizzle 0.45 has no COLLATE expression builder. Use bytewise USCC equality.
      eq(other.usccNorm, sql`${enterprise.usccNorm} COLLATE "C"`),
      opposingTitleAndSide,
    ))
  const differences = db.$with('differences').as(db.select({ recordId: min(record.id).as('record_id') })
    .from(record)
    .innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))
    .where(and(inArray(record.titleCode, TITLE_ORDER), or(isNull(enterprise.usccNorm),
      and(notExists(sameEnterprise), notExists(sameUscc)))))
    .groupBy(record.enterpriseId, record.titleCode, localSide))

  const rows = await db.with(differences).select({
    enterpriseId: enterprise.id,
    name: enterprise.name,
    uscc: enterprise.usccNorm,
    district: record.district,
    titleCode: record.titleCode,
    source: record.source,
    currentCity: enterprise.city,
    regStatus: enterprise.regStatus,
  }).from(differences)
    .innerJoin(record, eq(record.id, differences.recordId))
    .innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))

  return projectComparisonSources(rows, opts)
}
