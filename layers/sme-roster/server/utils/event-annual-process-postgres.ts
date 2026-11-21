import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import type { AnnualProcessSourceRefs } from '../../lib/roster/annual-process'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { projectAnnualFinalQualification, validAnnualDecisionQuery, type AnnualWriteScope, type AnnualWriteStep } from './annual-correspondence'
import { ANNUAL_COMPARISON_RAW_LIMIT } from './annual-process-target-sources'
import { annualScopeRecordIds, projectAnnualWriteScope } from './annual-correspondence-read'
import { normalizedUscc } from './event-archive-discovery'
import {
  prepareAnnualObservations, projectAnnualProcess, scopeAnnualEvent,
  type AnnualEventScope, type AnnualObservationFacts, type AnnualSourceRows,
} from './event-annual-process-read'
import {
  readPostgresPlatformBusinessCorrespondences, readPostgresPlatformBusinessGroups, readPostgresPlatformBusinessMetadata,
} from './platform-business-record-read'
import { readPostgresCorrespondenceRefs } from './record-correspondence-postgres-refs'
import { readPostgresObservationComparisonFacts } from './record-correspondence-target-postgres'

type Reader = Pick<NodePgDatabase, 'execute'>
type Observation = Omit<AnnualSourceRows['rows'][number], keyof AnnualObservationFacts | 'rawFields'> & {
  observationId: number; interface: 'apply_list' | 'business_list'; titleCode: string | null
}
type Coverage = AnnualSourceRows['queries'][number] & { scopedTitle: string | null; named: boolean }
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`

async function readAnnualSources(db: Reader, scope: AnnualEventScope, comparison: boolean) {
  const { owner, identity, titleCode } = scope
  const uscc = normalizedUscc(sql`original.uscc_raw`)
  const queryTitle = sql`coalesce(c.title_code,CASE c.rdjb WHEN '1' THEN 'innovative_sme' WHEN '2' THEN 'specialized_sme' WHEN '3' THEN 'little_giant' END)`
  const keyRows = sql`SELECT value FROM unnest(${sql.param([identity, 'name:' + scope.joined.enterprise.nameNorm].filter(Boolean))}::text[]) AS k(value)
    UNION SELECT 'name:' || name_norm FROM enterprise_alias WHERE enterprise_id=${owner} AND verification_status='confirmed'`
  const { rows: collections } = await db.execute<Coverage>(sql`
    WITH keys AS (${keyRows}), original_identity AS (
      SELECT o.collection_id FROM platform_observation_assignment original JOIN platform_business_observation o ON o.id=original.observation_id
      WHERE original.revision=1 AND ${identity ? sql`${uscc}=${identity}` : sql`false`}
    ), assigned AS (
      SELECT o.collection_id FROM platform_observation_assignment a JOIN platform_business_observation o ON o.id=a.observation_id
      WHERE a.enterprise_id=${owner} AND NOT EXISTS (
        SELECT 1 FROM platform_observation_assignment newer WHERE newer.observation_id=a.observation_id AND newer.revision>a.revision
      )
    )
    SELECT q.old_id::float8 AS "queryId",c.interface,c.query_key AS "queryKey",c.rdjb,
      c.title_code AS "titleCode",c.queried_at AS "queriedAt",c.status,nullif(c.completeness,'unknown') AS completeness,
      c.full_range::int AS "fullRangeValue",${queryTitle} AS "scopedTitle",c.query_key IN (SELECT value FROM keys) AS named
    FROM platform_collection c JOIN platform_legacy_query_alias q ON q.collection_id=c.id
    WHERE c.interface IN ('apply_list','business_list')
      AND (c.query_key IN (SELECT value FROM keys) OR c.id IN (
        SELECT collection_id FROM original_identity UNION SELECT collection_id FROM assigned
      ))
    ORDER BY q.old_id`)
  if (!collections.length) return { queries: [], rows: [], titles: [], facts: new Map<number, AnnualObservationFacts>() }
  const { rows: matching } = await db.execute<Observation>(sql`
    WITH keys AS (${keyRows})
    SELECT ra.old_id::float8 AS id,q.old_id::float8 AS "queryId",o.sequence_no::float8 AS "sequenceNo",o.source_relation_key AS "relationKey",
      a.enterprise_id::float8 AS "enterpriseId",original.uscc_raw AS "usccRaw",original.name_raw AS "nameRaw",
      a.verification_status AS "verificationStatus",a.match_basis AS "matchBasis",o.id::float8 AS "observationId",
      c.interface,${queryTitle} AS "titleCode",p.page_no::float8 AS "sourcePage",p.rdjb AS "sourceRdjb",
      EXISTS(SELECT 1 FROM platform_observation_archive_ref r JOIN platform_archive_value v ON v.id=r.archive_id
        WHERE r.owner_id=o.id AND r.field='sourceText' AND position(convert_to('转写','UTF8') in v.bytes)>0
          AND (position(convert_to('名称','UTF8') in v.bytes)>0 OR encode(v.bytes,'escape') ILIKE '%qymc%')
          AND encode(v.bytes,'escape') ILIKE '%platform-verify-aclass%')::int AS "identityOnlySource"
    FROM platform_legacy_query_alias q JOIN platform_collection c ON c.id=q.collection_id
    JOIN platform_business_observation o ON o.collection_id=c.id
    JOIN platform_legacy_relation_alias ra ON ra.observation_id=o.id
    JOIN platform_observation_assignment original ON original.observation_id=o.id AND original.revision=1
    JOIN LATERAL (SELECT enterprise_id,verification_status,match_basis FROM platform_observation_assignment
      WHERE observation_id=o.id ORDER BY revision DESC LIMIT 1) a ON true
    LEFT JOIN LATERAL (SELECT page_no,rdjb FROM platform_collection_page
      WHERE collection_id=c.id AND status='success' AND o.sequence_no BETWEEN sequence_start AND sequence_end ORDER BY ordinal LIMIT 1) p ON true
    WHERE q.old_id=ANY(${ids(collections.map(row => row.queryId))}) AND (a.enterprise_id IS NULL OR a.enterprise_id=${owner})
      AND (${identity ? sql`${uscc}=${identity}` : sql`a.enterprise_id=${owner} AND a.verification_status='confirmed'`}
        OR nullif(${uscc},'') IS NULL AND (a.enterprise_id=${owner} OR c.query_key IN (SELECT value FROM keys)))
    ORDER BY q.old_id,o.sequence_no,ra.old_id`)
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
  const { rows: [header] } = await db.execute<Parameters<typeof scopeAnnualEvent>[0]>(sql`
    SELECT ${postgresRosterRow(schema.recordEvent,'v')} AS event,${postgresRosterRow(schema.record,'r')} AS record,
      json_build_object('nameNorm',e.name_norm,'usccNorm',e.uscc_norm) AS enterprise
    FROM record_event v JOIN record r ON r.id=v.record_id JOIN enterprise e ON e.id=r.enterprise_id WHERE v.id=${eventId}`)
  const scope = header && scopeAnnualEvent(header)
  if (!scope) return null
  const sources = await readAnnualSources(db, scope, comparison)
  const metadata = await readPostgresPlatformBusinessMetadata(db, [...sources.rows.map(r => r.id), ...sources.titles.map(t => t.relationId)])
  const prepared = prepareAnnualObservations(scope, sources.rows, sources.titles, sources.queries, metadata, sources.facts)
  const groups = await readPostgresPlatformBusinessGroups(db, prepared.observations, metadata)
  const { rows: evidence } = await db.execute<AnnualProcessSourceRefs['evidence'][number]>(sql`
    SELECT e.id::float8 AS id,e.source_file AS "sourceFile",e.attachment,e.list_no::float8 AS "listNo",e.page::float8 AS page,
      f.id::float8 AS "fileId",f.sha256,f.removed_at AS "removedAt"
    FROM record_evidence e LEFT JOIN stored_file f ON f.rel_path=e.source_file
    WHERE e.record_event_id=${eventId} ORDER BY e.id`)
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
  const history = recordIds.length ? (await db.execute<{ recordId: number; relationId: number }>(sql`
    SELECT o.record_id::float8 AS "recordId",a.old_id::float8 AS "relationId"
    FROM platform_business_observation o JOIN platform_legacy_relation_alias a ON a.observation_id=o.id
    WHERE o.record_id=ANY(${ids(recordIds)}) ORDER BY a.old_id`)).rows : []
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
  const contexts = priors.length ? (await db.execute<{ id: number; titleCode: string | null; rdjb: string; interface: string; status: string }>(sql`
    SELECT a.old_id::float8 AS id,c.title_code AS "titleCode",c.rdjb,c.interface,c.status
    FROM platform_legacy_relation_alias a JOIN platform_business_observation o ON o.id=a.observation_id
    JOIN platform_collection c ON c.id=o.collection_id WHERE a.old_id=ANY(${ids(relationIds)})`)).rows : []
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
