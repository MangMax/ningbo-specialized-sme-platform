import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import { enterprise, enterpriseAlias } from '../../../../db/postgresql/enterprise-tables'
import { record } from '../../../../db/postgresql/ledger-tables'
import { platformBusinessObservation, platformCollection } from '../../../../db/postgresql/platform-tables'
import { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import { getPostgresComparison } from '../comparison-heads-postgres'
import { normalizeName } from '../domain'
import { postgresDifferenceRow } from '../../server/utils/decision-lifecycle-102/postgres-reads'
import { projectDifferences } from './current-difference'
import { readPostgresDifferenceQualifications } from './current-qualification-postgres'
import { projectRosterDifferenceList, selectRosterDifferencePage } from './difference-list-projection'
import type { RosterDifferenceFilter, RosterDifferencesResult } from './enterprise-roster-projection'
import { readPostgresQueryAssessments } from './query-assessment-postgres'

type Reader = Pick<NodePgDatabase, 'execute' | 'select' | 'selectDistinctOn' | '$with' | 'with'>
type MapValue<T> = T extends Map<unknown,infer Value> ? Value : never
type Explanation = MapValue<Parameters<typeof projectRosterDifferenceList>[2]>
type Query = MapValue<Parameters<typeof projectRosterDifferenceList>[4]>
const reason = differenceReason
const reasonProjection = alias(reason, 'p')

const collection = platformCollection
const observation = platformBusinessObservation


async function selectPage(db: Reader, filter: RosterDifferenceFilter) {
  const heads = await db.selectDistinctOn([reason.enterpriseId, reason.titleCode, reason.direction], {
    id: reason.id, enterpriseId: reason.enterpriseId, titleCode: reason.titleCode,
    direction: reason.direction, status: reason.status, reasonCode: reason.reasonCode,
  }).from(reason).orderBy(reason.enterpriseId, reason.titleCode, reason.direction, desc(reason.recordedAt), desc(reason.id))
  const { rows: derived } = await getPostgresComparison(db)
  const selectedOwners = [...new Set([...heads.map(row => row.enterpriseId), ...derived.map(row => row.enterpriseId)])]
  const ownerIds = sql`ANY(${sql.param(selectedOwners)}::bigint[])`
  const enterprises = await db.select({ id: enterprise.id, name: enterprise.name, uscc: enterprise.usccNorm })
    .from(enterprise).where(eq(enterprise.id, ownerIds))
  const aliases = new Map<number, string[]>()
  if (filter.q?.trim()) {
    const rows = await db.select({ enterpriseId: enterpriseAlias.enterpriseId, name: enterpriseAlias.name })
      .from(enterpriseAlias).where(and(eq(enterpriseAlias.verificationStatus, 'confirmed'), eq(enterpriseAlias.enterpriseId, ownerIds)))
    for (const [owner, names] of Map.groupBy(rows, row => row.enterpriseId)) aliases.set(owner, names.map(row => normalizeName(row.name)))
  }
  return selectRosterDifferencePage(filter, derived, heads, new Map(enterprises.map(row => [row.id,row])), aliases)
}

export async function listPostgresRosterDifferences(db: NodePgDatabase, filter: RosterDifferenceFilter): Promise<RosterDifferencesResult> {
  return db.transaction(async tx => {
    const asOf = Date.now()
    const page = await selectPage(tx, filter)
    if (!page.rows.length) return { ...page, rows: [] }
    const enterpriseIds = [...new Set(page.rows.map(row => row.enterpriseId))]
    const qualification = await readPostgresDifferenceQualifications(tx, enterpriseIds, asOf)
    const selected = projectDifferences(page.rows, qualification.assessed, qualification.facts, asOf)
    const selectedIds = selected.flatMap(row => row.explanationId === null ? [] : [row.explanationId])
    const stored = await tx.select({ row: sql<Explanation>`${postgresDifferenceRow()}` })
      .from(reasonProjection).where(inArray(reasonProjection.id, selectedIds))
    const ledgerDistrict = tx.select({ district: record.district }).from(record).where(and(
      eq(record.enterpriseId, enterprise.id), isNotNull(record.district), ne(record.district, ''),
    )).orderBy(record.id).limit(1)
    const districts = await tx.select({ id: enterprise.id, district: sql<string | null>`coalesce(${enterprise.district}, (${ledgerDistrict}))` })
      .from(enterprise).where(inArray(enterprise.id, enterpriseIds))
    const queryIds = [...new Set(stored.flatMap(({ row }) => row.evidenceQueryId === null ? [] : [row.evidenceQueryId]))]
    const queries = queryIds.length ? await tx.select({
      id: collection.publicId, queriedAt: collection.queriedAt, interface: collection.interface,
      status: collection.status, failureReason: collection.failureReason,
    }).from(collection)
      .where(inArray(collection.publicId, queryIds)) as Query[] : []
    const observations = queryIds.length ? await tx.select({ queryId: collection.publicId, id: observation.publicId })
      .from(collection).innerJoin(observation, eq(observation.collectionId, collection.id))
      .where(inArray(collection.publicId, queryIds)).orderBy(observation.id) : []
    const relations = new Map([...Map.groupBy(observations, row => row.queryId)].map(([id, rows]) => [id, rows.map(row => row.id)]))
    // Qualification follows enterprise merges. Stored difference coordinates
    // may still refer to an original owner and need coverage for that owner.
    const covered = selected.every(row => qualification.coverage.get(row.enterpriseId)?.has(row.titleCode))
    const assessments = await readPostgresQueryAssessments(tx, selected, covered ? qualification.coverage : undefined)
    return projectRosterDifferenceList(page, selected, new Map(stored.map(({ row }) => [row.id,row])),
      new Map(districts.map(row => [row.id,row.district])), new Map(queries.map(row => [row.id,row])), relations, assessments)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
