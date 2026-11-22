import { and, between, desc, eq, exists, gt, inArray, isNull, notExists, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { enterprise, enterpriseAlias } from '../../../../db/postgresql/enterprise-tables'
import { storedFile } from '../../../../db/postgresql/file-tables'
import { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import { platformArchiveValue, platformObservationArchiveRef } from '../../../../db/postgresql/platform-archive-tables'
import { platformBusinessObservation as observation, platformCollection as collection, platformCollectionPage as page,
  platformLegacyQueryAlias as queryAlias, platformLegacyRelationAlias as relationAlias,
  platformObservationAssignment as assignment } from '../../../../db/postgresql/platform-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { projectAnnualFinalQualification, validAnnualDecisionQuery, type AnnualWriteScope, type AnnualWriteStep } from './annual-correspondence-contract'
import { ANNUAL_COMPARISON_RAW_LIMIT } from './annual-process-limits'
import { annualScopeRecordIds, projectAnnualWriteScope } from './annual-correspondence-projection'
import { normalizedUscc } from './event-archive-discovery-model'
import { type AnnualSourceRows } from './event-annual-process-read'
import { prepareAnnualObservations, projectAnnualProcess, scopeAnnualEvent, type AnnualEventScope, type AnnualObservationFacts } from './event-annual-process-model'
import {
  readPostgresPlatformBusinessCorrespondences, readPostgresPlatformBusinessGroups, readPostgresPlatformBusinessMetadata,
} from './platform-business-record-postgres'
import { readPostgresCorrespondenceRefs } from './record-correspondence-postgres-refs'
import { readPostgresObservationComparisonFacts } from './record-correspondence-target-postgres'

type Reader = Pick<NodePgDatabase, 'execute' | 'select'>
type Observation = Omit<AnnualSourceRows['rows'][number], keyof AnnualObservationFacts | 'rawFields'> & {
  observationId: number; interface: 'apply_list' | 'business_list'; titleCode: string | null
}
type Coverage = AnnualSourceRows['queries'][number] & { scopedTitle: string | null; named: boolean }
async function readAnnualSources(db: Reader, scope: AnnualEventScope, comparison: boolean) {
  const { owner, identity, titleCode } = scope
  const original = alias(assignment, 'original')
  const newer = alias(assignment, 'newer')
  const uscc = normalizedUscc(original.usccRaw)
  const queryTitle = sql<string | null>`coalesce(${collection.titleCode},case ${collection.rdjb}
    when '1' then 'innovative_sme' when '2' then 'specialized_sme' when '3' then 'little_giant' end)`
  const names = db.select({ name: sql<string>`'name:' || ${enterpriseAlias.nameNorm}` }).from(enterpriseAlias)
    .where(and(eq(enterpriseAlias.enterpriseId, owner), eq(enterpriseAlias.verificationStatus, 'confirmed')))
  const named = or(inArray(collection.queryKey, [identity, 'name:' + scope.joined.enterprise.nameNorm].filter(Boolean)),
    inArray(collection.queryKey, names))!
  const originalIdentity = identity ? inArray(collection.id, db.select({ id: observation.collectionId }).from(original)
    .innerJoin(observation, eq(observation.id, original.observationId)).where(and(eq(original.revision, 1), eq(uscc, identity)))) : undefined
  const assigned = db.select({ id: observation.collectionId }).from(assignment)
    .innerJoin(observation, eq(observation.id, assignment.observationId))
    .where(and(eq(assignment.enterpriseId, owner), notExists(db.select({ id: newer.observationId }).from(newer)
      .where(and(eq(newer.observationId, assignment.observationId), gt(newer.revision, assignment.revision))))))
  const collections = await db.select({
    queryId: queryAlias.oldId, interface: collection.interface, queryKey: collection.queryKey, rdjb: collection.rdjb,
    titleCode: collection.titleCode, queriedAt: collection.queriedAt, status: collection.status,
    completeness: sql<string | null>`nullif(${collection.completeness},'unknown')`, fullRangeValue: collection.fullRange,
    scopedTitle: queryTitle, named,
  }).from(collection).innerJoin(queryAlias, eq(queryAlias.collectionId, collection.id))
    .where(and(inArray(collection.interface, ['apply_list', 'business_list']), or(named, originalIdentity, inArray(collection.id, assigned))))
    .orderBy(queryAlias.oldId) as Coverage[]
  if (!collections.length) return { queries: [], rows: [], titles: [], facts: new Map<number, AnnualObservationFacts>() }
  const latest = db.select({ enterpriseId: assignment.enterpriseId, verificationStatus: assignment.verificationStatus,
    matchBasis: assignment.matchBasis }).from(assignment).where(eq(assignment.observationId, observation.id))
    .orderBy(desc(assignment.revision)).limit(1).as('latest')
  const sourcePage = db.select({ pageNo: page.pageNo, rdjb: page.rdjb }).from(page)
    .where(and(eq(page.collectionId, collection.id), eq(page.status, 'success'),
      between(observation.sequenceNo, page.sequenceStart, page.sequenceEnd))).orderBy(page.ordinal).limit(1).as('source_page')
  const bytes = platformArchiveValue.bytes
  const identityOnly = exists(db.select({ id: platformArchiveValue.id }).from(platformObservationArchiveRef)
    .innerJoin(platformArchiveValue, eq(platformArchiveValue.id, platformObservationArchiveRef.archiveId))
    .where(and(eq(platformObservationArchiveRef.ownerId, observation.id), eq(platformObservationArchiveRef.field, 'sourceText'),
      sql`position(convert_to('转写','UTF8') in ${bytes})>0 and (position(convert_to('名称','UTF8') in ${bytes})>0
        or encode(${bytes},'escape') ilike '%qymc%') and encode(${bytes},'escape') ilike '%platform-verify-aclass%'`)))
  const matching = await db.select({ id: relationAlias.oldId, queryId: queryAlias.oldId, sequenceNo: observation.sequenceNo,
    relationKey: observation.sourceRelationKey, enterpriseId: latest.enterpriseId, usccRaw: original.usccRaw, nameRaw: original.nameRaw,
    verificationStatus: latest.verificationStatus, matchBasis: latest.matchBasis, observationId: observation.id,
    interface: collection.interface, titleCode: queryTitle, sourcePage: sourcePage.pageNo, sourceRdjb: sourcePage.rdjb,
    identityOnlySource: sql<number>`(${identityOnly})::int`,
  }).from(queryAlias).innerJoin(collection, eq(collection.id, queryAlias.collectionId))
    .innerJoin(observation, eq(observation.collectionId, collection.id))
    .innerJoin(relationAlias, eq(relationAlias.observationId, observation.id))
    .innerJoin(original, and(eq(original.observationId, observation.id), eq(original.revision, 1)))
    .crossJoinLateral(latest).leftJoinLateral(sourcePage, sql`true`)
    .where(and(sql`${queryAlias.oldId} = any(${sql.param(collections.map(row => row.queryId))}::bigint[])`, or(isNull(latest.enterpriseId), eq(latest.enterpriseId, owner)),
      or(identity ? eq(uscc, identity) : and(eq(latest.enterpriseId, owner), eq(latest.verificationStatus, 'confirmed')),
        and(eq(uscc, ''), or(eq(latest.enterpriseId, owner), named)))))
    .orderBy(queryAlias.oldId, observation.sequenceNo, relationAlias.oldId) as Observation[]
  const matchedQueries = new Set(matching.map(row => row.queryId))
  const queries = collections.filter(q => (q.named || matchedQueries.has(q.queryId)) &&
    (q.scopedTitle === titleCode || q.scopedTitle === null && (q.interface === 'apply_list' || comparison)))
    .map(({ scopedTitle: _title, named: _named, ...q }) => q)
  const included = new Set(queries.map(q => q.queryId))
  const observations = matching.filter(row => included.has(row.queryId))
  const typed = await readPostgresObservationComparisonFacts(db, observations, comparison ? 'archive' : 'version')
  const facts = new Map(observations.map(row => {
    const fact = typed.get(row.observationId)
    if (!fact) throw new Error('annual_observation_fact_missing')
    if (comparison && Buffer.byteLength(JSON.stringify([fact.province, fact.status, fact.batch, fact.declareKind,
      fact.appliedAt, fact.awardBatchLabel, fact.year])) > ANNUAL_COMPARISON_RAW_LIMIT) throw new Error('input_resource_limit')
    return [row.id, fact]
  }))
  const rows = observations.map(row => ({ ...row, ...facts.get(row.id)!, rawFields: null }))
  const titles = matching.filter(row => row.interface === 'business_list')
    .map(({ id, queryId, relationKey, usccRaw, titleCode }) => ({ relationId: id, queryId, relationKey, usccRaw, titleCode }))
    .sort((a, b) => a.relationId - b.relationId)
  return { queries, rows, titles, facts }
}

export async function readPostgresAnnualProcessEntry(db: Reader, eventId: number, comparison = false) {
  const [header] = await db.select({ event: recordEvent, record, enterprise: { nameNorm: enterprise.nameNorm, usccNorm: enterprise.usccNorm } })
    .from(recordEvent).innerJoin(record, eq(record.id, recordEvent.recordId)).innerJoin(enterprise, eq(enterprise.id, record.enterpriseId))
    .where(eq(recordEvent.id, eventId))
  const scope = header && scopeAnnualEvent(header)
  if (!scope) return null
  const sources = await readAnnualSources(db, scope, comparison)
  const metadata = await readPostgresPlatformBusinessMetadata(db, [...sources.rows.map(r => r.id), ...sources.titles.map(t => t.relationId)])
  const prepared = prepareAnnualObservations(scope, sources.rows, sources.titles, sources.queries, metadata, sources.facts)
  const groups = await readPostgresPlatformBusinessGroups(db, prepared.observations, metadata)
  const evidence = await db.select({ id: recordEvidence.id, sourceFile: recordEvidence.sourceFile, attachment: recordEvidence.attachment,
    listNo: recordEvidence.listNo, page: recordEvidence.page, fileId: storedFile.id, sha256: storedFile.sha256, removedAt: storedFile.removedAt })
    .from(recordEvidence).leftJoin(storedFile, eq(storedFile.relPath, recordEvidence.sourceFile))
    .where(eq(recordEvidence.recordEventId, eventId)).orderBy(recordEvidence.id)
  return projectAnnualProcess(prepared, groups, evidence)
}

async function readPostgresAnnualProcess(db: Reader, eventId: number) {
  return (await readPostgresAnnualProcessEntry(db, eventId))?.read ?? null
}

export async function readPostgresAnnualWriteScope(db: Reader, eventId: number) {
  const read = await readPostgresAnnualProcess(db, eventId)
  return read ? projectPostgresAnnualScope(db, read) : null
}

async function projectPostgresAnnualScope(db: Reader, read: NonNullable<Awaited<ReturnType<typeof readPostgresAnnualProcess>>>) {
  const recordIds = annualScopeRecordIds(read)
  const history = recordIds.length ? await db.select({ recordId: observation.recordId, relationId: relationAlias.oldId })
    .from(observation).innerJoin(relationAlias, eq(relationAlias.observationId, observation.id))
    .where(sql`${observation.recordId} = any(${sql.param(recordIds)}::bigint[])`).orderBy(relationAlias.oldId) : []
  const byRecord = Map.groupBy(history, row => row.recordId)
  return projectAnnualWriteScope(read, matching => matching.flatMap(id => (byRecord.get(id) ?? []).map(row => row.relationId)))
}

export async function readPostgresAnnualDecisionRefs(db: Reader, scope: AnnualWriteScope, step: Pick<AnnualWriteStep, 'protectionRelationIds' | 'currentRelationIds'>) {
  const relationIds = [...new Set([...step.protectionRelationIds, ...step.currentRelationIds])]
  const priors = (await readPostgresPlatformBusinessCorrespondences(db, relationIds)).filter(row => row.type === 'event_process'
    && row.eventId === scope.eventId && row.enterpriseId === scope.enterpriseId && row.titleCode === scope.titleCode
    && (row.role === 'context_only' || row.role === (scope.declareKind === 'apply' ? 'supports_award' : 'supports_review')))
  const valid = await readPostgresCorrespondenceRefs(db, { annualDecisionIds: priors.map(row => row.id) })
  const validity = new Map(valid.map(row => [row.id, row.requiresRevalidation]))
  const contexts = priors.length ? await db.select({ id: relationAlias.oldId, titleCode: collection.titleCode, rdjb: collection.rdjb,
    interface: collection.interface, status: collection.status }).from(relationAlias)
    .innerJoin(observation, eq(observation.id, relationAlias.observationId)).innerJoin(collection, eq(collection.id, observation.collectionId))
    .where(sql`${relationAlias.oldId} = any(${sql.param(relationIds)}::bigint[])`) : []
  const queries = new Map(contexts.map(row => [row.id, row]))
  return priors.flatMap(row => {
    if (row.relationId === null) return []
    const query = queries.get(row.relationId)
    return [{ ...row, relationId: row.relationId, requiresRevalidation: validity.get(row.id) !== false || !query
      || !validAnnualDecisionQuery(row.titleCode, query.titleCode, query.rdjb, query.interface, query.status) }]
  })
}

export async function readPostgresQualifiedAnnualProcess(db: Reader, eventId: number) {
  const read = await readPostgresAnnualProcess(db, eventId)
  if (!read) return null
  const scope = await projectPostgresAnnualScope(db, read)
  const step = scope.steps.find(row => row.stepId === scope.finalCandidateStepId)
  const decisions = step ? await readPostgresAnnualDecisionRefs(db, scope, step) : []
  const qualification = projectAnnualFinalQualification(scope, decisions)
  const selected = new Set(qualification.decisionRefs.map(row => row.id))
  return { ...read, process: { ...read.process, finalQualification: { ...qualification, decisionRefs: decisions.filter(row => selected.has(row.id)) } } }
}
