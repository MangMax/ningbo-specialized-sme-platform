import { sql } from 'drizzle-orm'
import * as schema from '../../../../db/schema'
import { projectLegacyComparisonCycles } from '../../lib/roster/current-qualification'
import { readPostgresLegacyQualification, type PostgresQualificationTransaction } from '../../lib/roster/current-qualification-postgres'
import { COMPARISON_VERSION, comparePlatformComparison, type CandidateComparisonInput } from '../../lib/roster/platform-comparison'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { projectQueryComparisonWitnesses } from '../../lib/roster/query-assessment'
import { readPostgresQueryCoverageInputs } from '../../lib/roster/query-coverage-postgres'
import type { CurrentTitle } from '../../lib/roster/current-titles'
import { projectAnnualFinalQualification } from './annual-correspondence'
import { projectAnnualWriteScope } from './annual-correspondence-read'
import { normalizedUscc } from './event-archive-discovery'
import { readPostgresAnnualDecisionRefs, readPostgresAnnualProcessEntry } from './event-annual-process-postgres'
import { admitAnnualComparison, type readAnnualComparisonBatch } from './event-annual-process-read'
import { readPostgresPlatformBusinessMetadata } from './platform-business-record-read'
import { projectPlatformComparisonProcesses } from './platform-comparison-input'

type Tx = PostgresQualificationTransaction
type AnnualInputs = Parameters<typeof admitAnnualComparison>[0]
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`

async function hasUnboundProcessCollection(tx: Tx, enterpriseId: number) {
  const { rows: [row] } = await tx.execute<{ found: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM platform_collection c CROSS JOIN enterprise e
      WHERE e.id=${enterpriseId} AND c.interface IN ('apply_list','business_list') AND (
        c.query_key IN (coalesce(e.uscc_norm,''), 'name:' || e.name_norm)
        OR c.query_key IN (SELECT 'name:' || name_norm FROM enterprise_alias
          WHERE enterprise_id=e.id AND verification_status='confirmed')
        OR EXISTS (SELECT 1 FROM platform_business_observation o
          JOIN platform_observation_assignment a ON a.observation_id=o.id
          JOIN platform_observation_assignment original ON original.observation_id=o.id AND original.revision=1
          WHERE o.collection_id=c.id AND (a.enterprise_id=e.id OR
            e.uscc_norm<>'' AND ${normalizedUscc(sql`original.uscc_raw`)}=e.uscc_norm))
      )
    ) AS found`)
  return row!.found
}

async function readAnnualComparisonProcesses(tx: Tx, request: Parameters<typeof readAnnualComparisonBatch>[2],
  hasUnboundCollection: () => Promise<boolean>,
) {
  const eventIds = [...new Set(request.eventIds)]
  if (eventIds.length > 40) throw new Error('input_resource_limit')
  const { rows: decisions } = await tx.execute<AnnualInputs['decisions'][number]>(sql`
    SELECT a.old_id::float8 AS "relationId", c.event_id::float8 AS "eventId",
      c.predecessor_event_id::float8 AS "predecessorEventId", c.enterprise_id::float8 AS "enterpriseId", c.title_code AS "titleCode"
    FROM record_correspondence c LEFT JOIN platform_legacy_relation_alias a ON a.observation_id=c.observation_id
    WHERE c.event_id=ANY(${ids(eventIds)}) OR c.predecessor_event_id=ANY(${ids(eventIds)})
      OR c.enterprise_id=${request.enterpriseId} AND c.title_code=${request.titleCode} LIMIT 129`)
  if (decisions.length > 128) throw new Error('input_resource_limit')
  if (!eventIds.length) {
    if (decisions.length || await hasUnboundCollection()) throw new Error('platform_comparison_scope_unavailable')
    return []
  }
  const entries: AnnualInputs['entries'] = []
  for (const eventId of eventIds) {
    const entry = await readPostgresAnnualProcessEntry(tx, eventId, true)
    const record = entry?.read.process.event.record
    if (!entry || record?.enterpriseId !== request.enterpriseId || record.titleCode !== request.titleCode) {
      throw new Error('platform_comparison_scope_unavailable')
    }
    entries.push(entry)
  }
  const refs = entries.flatMap(({ read }) => [...read.sourceRefs.observations, ...read.sourceRefs.titleScopeRefs])
  const recordIds = [...new Set(refs.flatMap(row => row.recordId === null ? [] : [row.recordId]))]
  const { rows: historicalQueries } = await tx.execute<AnnualInputs['historicalQueries'][number]>(sql`
    SELECT o.record_id::float8 AS "recordId", a.old_id::float8 AS "relationId", q.old_id::float8 AS "queryId"
    FROM platform_business_observation o JOIN platform_legacy_relation_alias a ON a.observation_id=o.id
    JOIN platform_legacy_query_alias q ON q.collection_id=o.collection_id
    WHERE o.record_id=ANY(${ids(recordIds)}) OR a.old_id=ANY(${ids(refs.map(row => row.relationId))}) ORDER BY a.old_id`)
  const history = new Map([...Map.groupBy(historicalQueries, row => row.recordId)].flatMap(([id, rows]) =>
    id === null ? [] : [[id, rows.map(row => row.relationId)] as const]))
  const queryIds = [...new Set([...entries.flatMap(({ read }) => read.sourceRefs.coverage.map(row => row.queryId)),
    ...refs.map(row => row.queryId), ...historicalQueries.map(row => row.queryId)])]
  const { rows: queryRows } = await tx.execute<AnnualInputs['queryRows'][number]>(sql`
    SELECT a.old_id::float8 AS id, ${postgresRosterRow(schema.platformCollection, 'c')} AS collection
    FROM platform_collection c JOIN platform_legacy_query_alias a ON a.collection_id=c.id
    WHERE a.old_id=ANY(${ids(queryIds)})`)
  const collectionIds = ids(queryRows.map(row => row.collection.id))
  const { rows: pages } = await tx.execute<AnnualInputs['pages'][number]>(sql`
    SELECT collection_id::float8 AS "collectionId", rdjb FROM platform_collection_page WHERE collection_id=ANY(${collectionIds})`)
  const { rows: titleScopes } = await tx.execute<AnnualInputs['titleScopes'][number]>(sql`
    SELECT collection_id::float8 AS "collectionId", rdjb FROM platform_query_title_scope WHERE collection_id=ANY(${collectionIds})`)
  const metadata = await readPostgresPlatformBusinessMetadata(tx, historicalQueries.map(row => row.relationId))
  const batch = admitAnnualComparison({ request, entries, history, decisions, historicalQueries, queryRows, pages, titleScopes,
    metadata, hasUnboundProcessCollection: () => false })
  const processes: Parameters<typeof projectPlatformComparisonProcesses>[0][number][] = []
  for (const { input, read } of batch.entries) {
    const scope = projectAnnualWriteScope(read, records => records.flatMap(id => history.get(id) ?? []))
    const currentDecisionRefs = await readPostgresAnnualDecisionRefs(tx, scope, {
      protectionRelationIds: scope.steps.flatMap(step => step.protectionRelationIds),
      currentRelationIds: scope.steps.flatMap(step => step.currentRelationIds),
    })
    const finalStep = scope.steps.find(step => step.stepId === scope.finalCandidateStepId)
    const finalIds = new Set([...(finalStep?.protectionRelationIds ?? []), ...(finalStep?.currentRelationIds ?? [])])
    const final = projectAnnualFinalQualification(scope, currentDecisionRefs.filter(ref => finalIds.has(ref.relationId)))
    const used = new Set(final.decisionRefs.map(ref => ref.id))
    processes.push({ input, sourceRefs: read.sourceRefs, sourceGeneration: read.sourceGeneration, currentDecisionRefs,
      finalQualification: { ...final, decisionRefs: currentDecisionRefs.filter(ref => used.has(ref.id)) } })
  }
  return projectPlatformComparisonProcesses(processes)
}

type Subject = Parameters<typeof readPostgresQueryCoverageInputs>[1][number]
export async function preparePostgresRefreshComparison(tx: Tx, subject: Subject, asOf: number, titles: readonly CurrentTitle[]) {
  const legacy = await readPostgresLegacyQualification(tx, subject.id, asOf)
  const coverage = new Map((await readPostgresQueryCoverageInputs(tx, [subject], titles, true)).map(({ titleCode, input }) =>
    [titleCode, projectQueryComparisonWitnesses(input, { titleCode })]))
  let unboundCollection: Promise<boolean> | undefined
  return async (titleCode: CurrentTitle) => {
    const assessment = legacy.titles.find(item => item.titleCode === titleCode)!
    const { group, officialQualification, subject: status, region, cycles, versions, evidence, sourceVersions, completeness, correspondence } = assessment
    const bindings = projectLegacyComparisonCycles(legacy, titleCode)
    const queries = coverage.get(titleCode)!
    const input: CandidateComparisonInput = { version: COMPARISON_VERSION, legacy, titleCode,
      formal: { assessment: { titleCode, group, officialQualification, subject: status, region, cycles,
        versions, evidence, sourceVersions, completeness, correspondence }, cycles: bindings }, queries, processes: [] }
    if (bindings.length > 40) return comparePlatformComparison(input)
    let processes: CandidateComparisonInput['processes']
    try {
      processes = await readAnnualComparisonProcesses(tx, { enterpriseId: subject.id, titleCode,
        eventIds: bindings.flatMap(binding => binding.eventIds), selectedQueryIds: queries.sources.map(query => query.source.queryId),
      }, () => unboundCollection ??= hasUnboundProcessCollection(tx, subject.id))
    } catch (error) {
      const pg = error as { code?: string; cause?: { code?: string } } | null
      if (pg?.code || pg?.cause?.code || (error instanceof Error && error.message === 'input_resource_limit')) throw error
      throw new Error('platform_comparison_scope_unavailable', { cause: error })
    }
    return comparePlatformComparison({ ...input, processes })
  }
}
