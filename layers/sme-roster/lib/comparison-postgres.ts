import { inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { chunk } from 'es-toolkit'
import { normalizeUscc } from './domain'
import { readCuration, projectCuratedComparison } from './curation'
import { getPostgresComparison } from './comparison'
import type { ComparisonRowFilter } from './comparison-filter'
import { attachReconcile, readReconcile } from './reconcile'
import { filterCuratedComparison, projectComparisonSummary, selectComparisonSummaryPage, type SummaryDisposition } from './comparison-summary'
import * as schema from '../../../db/schema'
import { enterprise, enterpriseAlias } from '../../../db/postgresql/enterprise-tables'
import { postgresRosterRow } from './roster/postgres-rows'
import { projectPlatformComparisonEvidence, type ComparisonObservation } from './comparison-platform'
import { readPostgresFingerprintQueries, readPostgresRelationFingerprints } from '../server/utils/postgres-platform-fingerprint'
import { readPostgresObservationComparisonFacts } from '../server/utils/record-correspondence-target-postgres'
import { postgresDifferenceRow } from '../server/utils/decision-lifecycle-102/postgres-reads'
import { readPostgresQueryAssessments } from './roster/query-assessment-postgres'
import type { ComparisonSummaryOptions } from './comparison-summary-read'

type Reader = Pick<NodePgDatabase,'execute'>
type ComparisonReader = Pick<NodePgDatabase, 'execute' | 'select'>
type Subject = { id: number; nameNorm: string; uscc: string | null }
type Membership = { enterpriseId: number; queryId: number; collectionId: number; owned: boolean }
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`
// inArray binds each ID separately. Keep queries below PostgreSQL's 65,535-parameter limit.
const ownerBatchSize = 32_768

async function readMemberships(db: Reader, subjects: Subject[]) {
  if (!subjects.length) return []
  const rows = subjects.flatMap(row => {
    const uscc = normalizeUscc(row.uscc)
    return [`name:${row.nameNorm}`, ...(uscc ? [uscc] : [])].map(key => [row.id,key] as const)
  })
  return (await db.execute<Membership>(sql`
    WITH owned AS (
      SELECT DISTINCT a.enterprise_id,c.id AS collection_id,q.old_id AS query_id FROM platform_observation_assignment a
      JOIN platform_business_observation o ON o.id=a.observation_id
      JOIN platform_collection c ON c.id=o.collection_id JOIN platform_legacy_query_alias q ON q.collection_id=c.id
      WHERE a.enterprise_id=ANY(${ids(subjects.map(row => row.id))}) AND NOT EXISTS
        (SELECT 1 FROM platform_observation_assignment n WHERE n.observation_id=a.observation_id AND n.revision>a.revision)
    ), queried AS (
      SELECT x.enterprise_id,c.id AS collection_id,q.old_id AS query_id
      FROM unnest(${ids(rows.map(([owner]) => owner))},${sql.param(rows.map(([,key]) => key))}::text[]) AS x(enterprise_id,key)
      JOIN platform_collection c ON c.query_key=x.key JOIN platform_legacy_query_alias q ON q.collection_id=c.id
    ), membership AS (
      SELECT *,true AS owned FROM owned UNION ALL SELECT *,false AS owned FROM queried
    )
    SELECT enterprise_id::float8 AS "enterpriseId",query_id::float8 AS "queryId",collection_id::float8 AS "collectionId",bool_or(owned) AS owned
    FROM membership GROUP BY enterprise_id,query_id,collection_id`)).rows
}

async function readPostgresCuratedComparison(db: ComparisonReader, curatedPath: string) {
  const base = await getPostgresComparison(db)
  const ownerIds = [...new Set(base.rows.map(row => row.enterpriseId))]
  const enterprises: Subject[] = []
  for (const batch of chunk(ownerIds, ownerBatchSize)) {
    enterprises.push(...await db.select({
      id: enterprise.id,
      nameNorm: enterprise.nameNorm,
      uscc: enterprise.usccNorm,
    }).from(enterprise).where(inArray(enterprise.id, batch)))
  }
  const names = new Map(enterprises.map(row => [row.id, row.nameNorm]))
  return { curated: projectCuratedComparison(base, readCuration(curatedPath), names), enterprises }
}

async function readPostgresComparisonAliases(db: Pick<NodePgDatabase, 'select'>, owners: number[]) {
  const rows: Pick<typeof enterpriseAlias.$inferSelect, 'enterpriseId' | 'name' | 'verificationStatus'>[] = []
  for (const batch of chunk([...new Set(owners)], ownerBatchSize)) {
    const aliases = await db.select({
      enterpriseId: enterpriseAlias.enterpriseId,
      name: enterpriseAlias.name,
      verificationStatus: enterpriseAlias.verificationStatus,
    }).from(enterpriseAlias).where(inArray(enterpriseAlias.enterpriseId, batch))
    for (const alias of aliases) rows.push(alias)
  }
  return Map.groupBy(rows, row => row.enterpriseId)
}

export function readPostgresComparisonExport(db: NodePgDatabase, curatedPath: string, filter: ComparisonRowFilter) {
  return db.transaction(async tx => {
    const { curated, enterprises } = await readPostgresCuratedComparison(tx, curatedPath)
    const aliases = await readPostgresComparisonAliases(tx, enterprises.map(row => row.id))
    return filterCuratedComparison(curated, filter, aliases)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export function readPostgresWholeComparison(db: NodePgDatabase, input: ComparisonSummaryOptions, view: 'full' | 'summary') {
  return db.transaction(async tx => {
    const { curated, enterprises } = await readPostgresCuratedComparison(tx, input.curatedPath)
    const result = input.enterpriseId === undefined ? curated : { ...curated, rows: curated.rows.filter(row => row.enterpriseId === input.enterpriseId) }
    const scopedIds = [...new Set(result.rows.map(row => row.enterpriseId))]
    const selectedOwners = new Set(scopedIds)
    const aliases = await readPostgresComparisonAliases(tx, scopedIds)
    const { scoped, selected } = selectComparisonSummaryPage(result, input, input.page, input.pageSize, aliases)
    const members = await readMemberships(tx, enterprises.filter(row => selectedOwners.has(row.id)))
    const byOwner = new Map([...Map.groupBy(members, row => row.enterpriseId)].map(([id, rows]) => [id, rows.map(row => row.queryId)]))
    const { rows: dispositions } = await tx.execute<SummaryDisposition>(sql`
      SELECT DISTINCT ON (p.enterprise_id,p.title_code,p.direction) p.enterprise_id::float8 AS "enterpriseId",p.title_code AS "titleCode",p.direction,
        p.id::float8 AS "explanationId",p.status,p.reason_code AS "reasonCode",p.measure_code AS "measureCode",
        p.verification_status AS "verificationStatus",p.recorded_at AS "recordedAt",
        q.old_id::float8 AS "evidenceQueryId",r.old_id::float8 AS "evidenceRelationId"
      FROM difference_reason p LEFT JOIN platform_legacy_query_alias q ON q.collection_id=p.evidence_query_id
      LEFT JOIN platform_legacy_relation_alias r ON r.observation_id=p.evidence_relation_id
      WHERE p.enterprise_id=ANY(${ids(scopedIds)}) ORDER BY p.enterprise_id,p.title_code,p.direction,p.recorded_at DESC,p.id DESC`)
    const selectedQueryIds = [...new Set(selected.flatMap(row => byOwner.get(row.enterpriseId) ?? []))]
    const { rows: counts } = await tx.execute<{ queryId: number; count: number }>(sql`
      SELECT q.old_id::float8 AS "queryId",count(*)::float8 AS count FROM platform_legacy_query_alias q
      JOIN platform_business_observation o ON o.collection_id=q.collection_id WHERE q.old_id=ANY(${ids(selectedQueryIds)}) GROUP BY q.old_id`)
    const assessment = await readPostgresQueryAssessments(tx, selected)
    const assessments = assessment.map(row => ({ queryCoverage: { status: row.queryCoverage.status }, assessment: row.assessment,
      explanationValidity: { status: row.explanationValidity.status } }))
    const reconcile = readReconcile(input.reconcilePath)
    const summary = projectComparisonSummary(result, reconcile, scoped, selected, dispositions, byOwner, new Map(counts.map(row => [row.queryId,row.count])), assessments)
    if (view === 'summary') return summary
    const ownerIds = new Set(selected.map(row => row.enterpriseId))
    const { view: _view, rows: _summaries, ...countsOnly } = summary
    const rowKey = (row: { enterpriseId: number; titleCode: string; direction: string }) => [row.enterpriseId,row.titleCode,row.direction].join(':')
    const pageKeys = new Set(selected.map(rowKey))
    const rows = attachReconcile(result.rows.filter(row => pageKeys.has(rowKey(row))), reconcile)
    const platform = await readPostgresComparisonEvidence(tx, rows, enterprises.filter(row => ownerIds.has(row.id)),
      members.filter(row => ownerIds.has(row.enterpriseId)))
    return { ...countsOnly, rows: platform }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

async function readPostgresComparisonEvidence<T extends Parameters<typeof projectPlatformComparisonEvidence>[0][number]>(
  tx: Reader, rows: T[], subjects: Subject[], membership: Membership[],
) {
  if (!rows.length) return []
  const ownerIds = subjects.map(row => row.id)
  const aliases = (await tx.execute<{ alias: typeof schema.enterpriseAlias.$inferSelect }>(sql`
    SELECT ${postgresRosterRow(schema.enterpriseAlias,'a')} AS alias FROM enterprise_alias a
    WHERE enterprise_id=ANY(${ids(ownerIds)}) ORDER BY a.name_norm COLLATE "C", a.id`)).rows.map(row => row.alias)
  const dispositions = (await tx.execute<{ row: Parameters<typeof projectPlatformComparisonEvidence>[2][number] }>(sql`
    SELECT ${postgresDifferenceRow()} AS row FROM difference_reason p WHERE p.enterprise_id=ANY(${ids(ownerIds)})
    ORDER BY p.recorded_at DESC,p.id DESC`)).rows.map(row => row.row)
  const queries = [...(await readPostgresFingerprintQueries(tx, [...new Set(membership.map(row => row.queryId))], false)).values()]
    .map(row => row.query).sort((a,b) => a.id - b.id)
  const collections = new Set(membership.filter(row => row.owned).map(row => row.collectionId))
  const recognized = queries.filter(query => query.interface === 'recognized_list').map(query => query.id)
  const relationIds = (await tx.execute<{ id: number }>(sql`SELECT a.old_id::float8 AS id FROM platform_business_observation o
    JOIN platform_legacy_relation_alias a ON a.observation_id=o.id JOIN platform_legacy_query_alias q ON q.collection_id=o.collection_id
    WHERE o.collection_id=ANY(${ids([...collections])}) OR q.old_id=ANY(${ids(recognized)})`)).rows.map(row => row.id)
  const originals = await readPostgresRelationFingerprints(tx, { relationIds })
  const byQuery = new Map(queries.map(row => [row.id,row]))
  const archive = await readPostgresObservationComparisonFacts(tx, originals.map(row =>
    ({ observationId: row.observationId, interface: byQuery.get(row.relation.queryId)!.interface })), 'archive')
  const facts = new Map<number, ComparisonObservation>()
  for (const { relation, observationId } of originals) {
    const stored = archive.get(observationId)
    if (!stored) continue
    const { rawFields: _raw, normalizationConflicts, ...archiveProcessFacts } = stored
    facts.set(relation.id, { normalizationConflicts, archiveProcessFacts })
  }
  const queried = new Map<string,number[]>()
  for (const row of subjects) {
    const code = normalizeUscc(row.uscc)
    for (const key of ['name:' + row.nameNorm, ...(code ? [code] : [])]) {
      const owners = queried.get(key) ?? []
      owners.push(row.id)
      queried.set(key, owners)
    }
  }
  return projectPlatformComparisonEvidence(rows, aliases, dispositions, queried, queries, originals.map(row => row.relation)
    .sort((a,b) => a.queryId-b.queryId || a.sequenceNo-b.sequenceNo), facts)
}
