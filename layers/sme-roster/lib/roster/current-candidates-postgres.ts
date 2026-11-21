import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { record } from '../../../../db/postgresql/ledger-tables'
import {
  platformApplyProjection, platformBusinessObservation, platformBusinessProjection, platformObservationAssignment,
  platformRecognizedProjection,
} from '../../../../db/postgresql/platform-tables'
import { recordCorrespondence } from '../../../../db/postgresql/qualification-tables'
import { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import { normalizeUscc } from '../domain'
import { TITLE_RDJB_CODES } from '../platform/recognized-evidence'
import { CURRENT_TITLES, type CurrentTitle } from './current-titles'
import { qualificationUsccCandidate } from './platform-qualification-postgres'

type Reader = Pick<NodePgDatabase, 'select' | '$with' | 'with'>
type Sort = 'id_asc' | 'name_asc' | 'name_desc'

export async function readPostgresCurrentCandidateIds(db: Reader, title: CurrentTitle, sort: Sort = 'id_asc') {
  const titles = CURRENT_TITLES.slice(0, CURRENT_TITLES.indexOf(title) + 1)
  const returnedTitles = titles.map(code => TITLE_RDJB_CODES[code]!)
  const returned = (table: typeof platformRecognizedProjection | typeof platformBusinessProjection | typeof platformApplyProjection) =>
    db.select({ versionId: table.versionId, observationId: table.observationId }).from(table)
      .where(inArray(table.titleRaw, returnedTitles))

  // PostgreSQL materializes a CTE referenced more than once by default.
  const typedReturn = db.$with('typed_return').as(returned(platformRecognizedProjection)
    .union(returned(platformBusinessProjection)).union(returned(platformApplyProjection)))
  const observations = db.$with('observations').as(db.select({
    id: sql<number | null>`${platformBusinessObservation.id}`.as('id'),
  }).from(typedReturn)
    .innerJoin(platformBusinessObservation, eq(platformBusinessObservation.versionId, typedReturn.versionId))
    .union(db.select({ id: typedReturn.observationId }).from(typedReturn).where(isNotNull(typedReturn.observationId))))
  const assignment = db.select({ enterpriseId: platformObservationAssignment.enterpriseId, uscc: platformObservationAssignment.usccRaw })
    .from(platformObservationAssignment).where(eq(platformObservationAssignment.observationId, observations.id))
    .orderBy(desc(platformObservationAssignment.revision)).limit(1).as('assignment')

  // Drizzle has no typed SQL NULL literal or CASE expression builder.
  const noUscc = sql<string | null>`NULL::text`
  // Drizzle puts WITH inside the first UNION branch when both are added to the
  // same query builder. Place the UNION in a final CTE to share observations.
  const candidates = db.$with('candidates').as(db.select({
    id: sql`${record.enterpriseId}`.mapWith((value: string | null) => value === null ? null : Number(value)).as('id'),
    uscc: noUscc.as('uscc'),
  })
    .from(record).where(inArray(record.titleCode, titles))
    .union(db.select({ id: differenceReason.enterpriseId, uscc: noUscc }).from(differenceReason).where(inArray(differenceReason.titleCode, titles)))
    .union(db.select({ id: recordCorrespondence.enterpriseId, uscc: noUscc }).from(recordCorrespondence)
      .where(and(inArray(recordCorrespondence.titleCode, titles), isNotNull(recordCorrespondence.enterpriseId))))
    .union(db.select({
      id: assignment.enterpriseId,
      uscc: sql<string | null>`CASE WHEN ${assignment.enterpriseId} IS NULL THEN ${assignment.uscc} END`,
    }).from(observations).crossJoinLateral(assignment)))
  const rows = await db.with(typedReturn, observations, candidates).select().from(candidates)

  const ids = new Set(rows.flatMap(row => row.id === null ? [] : [row.id]))
  const keys = new Set(rows.flatMap(row => row.id === null && row.uscc !== null ? [normalizeUscc(row.uscc)] : []))
  if (keys.size) {
    const owners = await db.select({ id: enterprise.id, uscc: enterprise.usccNorm }).from(enterprise)
      .where(qualificationUsccCandidate(sql`${enterprise.usccNorm}`, [...keys]))
    for (const { id, uscc } of owners) if (uscc !== null && keys.has(normalizeUscc(uscc))) ids.add(id)
  }
  if (sort === 'id_asc') return [...ids].sort((a, b) => a - b)
  // Drizzle has no scalar = ANY with one array bind or a collated lower expression.
  // Keep the global DB sort and avoid the protocol's parameter limit on large rosters.
  const sortName = sql`lower(${enterprise.name} COLLATE "C")`
  const named = await db.select({ id: enterprise.id }).from(enterprise)
    .where(sql`${enterprise.id} = ANY(${sql.param([...ids])}::bigint[])`)
    .orderBy(sort === 'name_desc' ? desc(sortName) : asc(sortName), enterprise.id)
  return named.map(row => row.id)
}
