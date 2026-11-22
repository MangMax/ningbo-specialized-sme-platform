import { and, eq, exists, inArray, ne, or, sql, type SQLWrapper } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { enterprise, enterpriseAlias } from '../../../../db/postgresql/enterprise-tables'
import { recordCorrespondence as correspondence } from '../../../../db/postgresql/qualification-tables'
import { platformQueryTitleScope as titleScope } from '../../../../db/postgresql/platform-archive-tables'
import { platformBusinessObservation as observation, platformCollection as collection, platformCollectionPage as page,
  platformLegacyQueryAlias as queryAlias, platformLegacyRelationAlias as relationAlias,
  platformObservationAssignment as assignment } from '../../../../db/postgresql/platform-tables'
import { projectLegacyComparisonCycles } from '../../lib/roster/current-qualification-model'
import { readPostgresLegacyQualification, type PostgresQualificationTransaction } from '../../lib/roster/current-qualification-postgres'
import { COMPARISON_VERSION, comparePlatformComparison, type CandidateComparisonInput } from '../../lib/roster/platform-comparison'
import { projectQueryComparisonWitnesses } from '../../lib/roster/query-assessment-projection'
import { readPostgresQueryCoverageInputs } from '../../lib/roster/query-coverage-postgres'
import type { CurrentTitle } from '../../lib/roster/current-titles'
import { projectAnnualFinalQualification } from './annual-correspondence-contract'
import { projectAnnualWriteScope } from './annual-correspondence-projection'
import { normalizedUscc } from './event-archive-discovery-model'
import { readPostgresAnnualDecisionRefs, readPostgresAnnualProcessEntry } from './event-annual-process-postgres'
import { type readAnnualComparisonBatch } from './event-annual-process-read'
import { admitAnnualComparison } from './event-annual-process-model'
import { readPostgresPlatformBusinessMetadata } from './platform-business-record-postgres'
import { projectPlatformComparisonProcesses } from './platform-comparison-input-model'

type Tx = PostgresQualificationTransaction
type AnnualInputs = Parameters<typeof admitAnnualComparison>[0]
// Keep historical scopes in bound arrays instead of expanding a parameter per ID.
const matchesIds = (column: SQLWrapper, ids: readonly number[]) => sql`${column} = any(${sql.param(ids)}::bigint[])`

async function hasUnboundProcessCollection(tx: Tx, enterpriseId: number) {
  const original = alias(assignment, 'original')
  const aliases = tx.select({
    // Drizzle 0.45.4 has no expression builders for coalesce or text concatenation.
    key: sql<string>`'name:' || ${enterpriseAlias.nameNorm}`,
  }).from(enterpriseAlias).where(and(eq(enterpriseAlias.enterpriseId, enterprise.id), eq(enterpriseAlias.verificationStatus, 'confirmed')))
  const assignments = tx.select({ id: observation.id }).from(observation)
    .innerJoin(assignment, eq(assignment.observationId, observation.id))
    .innerJoin(original, and(eq(original.observationId, observation.id), eq(original.revision, 1)))
    .where(and(eq(observation.collectionId, collection.id), or(
      eq(assignment.enterpriseId, enterprise.id),
      and(ne(enterprise.usccNorm, ''), eq(normalizedUscc(original.usccRaw), enterprise.usccNorm)),
    )))
  const rows = await tx.select({ id: collection.id }).from(collection).crossJoin(enterprise)
    .where(and(eq(enterprise.id, enterpriseId), inArray(collection.interface, ['apply_list', 'business_list']), or(
      eq(collection.queryKey, sql`coalesce(${enterprise.usccNorm}, '')`),
      eq(collection.queryKey, sql`'name:' || ${enterprise.nameNorm}`),
      inArray(collection.queryKey, aliases),
      exists(assignments),
    ))).limit(1)
  return rows.length > 0
}

async function readAnnualComparisonProcesses(tx: Tx, request: Parameters<typeof readAnnualComparisonBatch>[2],
  hasUnboundCollection: () => Promise<boolean>,
) {
  const eventIds = [...new Set(request.eventIds)]
  if (eventIds.length > 40) throw new Error('input_resource_limit')
  const decisions = await tx.select({
    relationId: relationAlias.oldId, eventId: correspondence.eventId,
    predecessorEventId: correspondence.predecessorEventId, enterpriseId: correspondence.enterpriseId, titleCode: correspondence.titleCode,
  }).from(correspondence).leftJoin(relationAlias, eq(relationAlias.observationId, correspondence.observationId))
    .where(or(
      inArray(correspondence.eventId, eventIds), inArray(correspondence.predecessorEventId, eventIds),
      and(eq(correspondence.enterpriseId, request.enterpriseId), eq(correspondence.titleCode, request.titleCode)),
    )).limit(129)
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
  const historicalQueries = await tx.select({ recordId: observation.recordId, relationId: relationAlias.oldId, queryId: queryAlias.oldId })
    .from(observation).innerJoin(relationAlias, eq(relationAlias.observationId, observation.id))
    .innerJoin(queryAlias, eq(queryAlias.collectionId, observation.collectionId))
    .where(or(matchesIds(observation.recordId, recordIds), matchesIds(relationAlias.oldId, refs.map(row => row.relationId))))
    .orderBy(relationAlias.oldId)
  const history = new Map([...Map.groupBy(historicalQueries, row => row.recordId)].flatMap(([id, rows]) =>
    id === null ? [] : [[id, rows.map(row => row.relationId)] as const]))
  const queryIds = [...new Set([...entries.flatMap(({ read }) => read.sourceRefs.coverage.map(row => row.queryId)),
    ...refs.map(row => row.queryId), ...historicalQueries.map(row => row.queryId)])]
  const queryRows = await tx.select({ id: queryAlias.oldId, collection }).from(collection)
    .innerJoin(queryAlias, eq(queryAlias.collectionId, collection.id)).where(matchesIds(queryAlias.oldId, queryIds)) as AnnualInputs['queryRows']
  const collectionIds = queryRows.map(row => row.collection.id)
  const pages = await tx.select({ collectionId: page.collectionId, rdjb: page.rdjb }).from(page)
    .where(matchesIds(page.collectionId, collectionIds))
  const titleScopes = await tx.select({ collectionId: titleScope.collectionId, rdjb: titleScope.rdjb })
    .from(titleScope).where(matchesIds(titleScope.collectionId, collectionIds))
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
