import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { platformTaskLinks } from './task-presentation'
import type { ReconcileReportCounts } from '../platform-reconcile'
import { and, count, eq, inArray, sql, sum } from 'drizzle-orm'
import { job as pgJob } from '../../../../../db/postgresql/job-tables'
import type { TaskSummary } from '../../../lib/sme-roster/task-summary'
import { schema } from '../../../../../db/client'
const j = schema.job
// Reconcile historical coverage is unknown unless every nested container and
// range is valid. CASE keeps SQL text/scalars from becoming JSON function input.
const reconcilePositions = sql`case when json_type(${j.result},'$.collection.positions') = 'array'
  then json_extract(${j.result},'$.collection.positions') else '[]' end`
const reconcileSlot = sql`case when p.type = 'object' then p.value else '{}' end`
const reconcileUnfinished = sql`case when json_type(${reconcileSlot},'$.unfinished') = 'array'
  then json_extract(${reconcileSlot},'$.unfinished') else '[]' end`
const reconcileRange = sql`case when u.type = 'object' then u.value else '{}' end`
const validReconcileRange = sql`case when u.type = 'object'
  and json_type(${reconcileRange},'$.source') = 'text'
  and json_type(${reconcileRange},'$.page') = 'integer'
  and json_extract(${reconcileRange},'$.page') between 1 and 9007199254740991
  and ((json_extract(${reconcileRange},'$.source') = 'businessList'
    and json_type(${reconcileRange},'$.rdjb') = 'text'
    and json_extract(${reconcileRange},'$.rdjb') in ('1','2','3'))
    or (json_extract(${reconcileRange},'$.source') = 'queryList'
      and json_type(${reconcileRange},'$.rdjb') = 'null')) then 1 else 0 end`
const validReconcileCoverage = sql`case when json_type(${j.result},'$.collection') = 'object'
  and json_type(${j.result},'$.collection.positions') = 'array'
  and ${sql.join(['complete', 'partial', 'failed', 'unknown'].map(key => sql`case
    when json_type(${j.result}, ${'$.collection.' + key}) = 'integer'
      and json_extract(${j.result}, ${'$.collection.' + key}) between 0 and 9007199254740991
    then 1 else 0 end = 1`), sql` and `)}
  and (json_extract(${j.result},'$.collection.complete') + json_extract(${j.result},'$.collection.partial')
    + json_extract(${j.result},'$.collection.failed') + json_extract(${j.result},'$.collection.unknown'))
    = json_array_length(${reconcilePositions})
  and not exists (select 1 from json_each(${reconcilePositions}) p where case
    when p.type = 'object' and json_type(${reconcileSlot},'$.unfinished') = 'array'
      and not exists (select 1 from json_each(${reconcileUnfinished}) u where ${validReconcileRange} = 0)
    then 0 else 1 end = 1)
  then 1 else 0 end`
export const reconcileProjection = {
  counts: sql<string>`case when ${j.kind} = 'reconcile' then json_object('queryFailed',json_extract(${j.result},'$.counts.queryFailed'),'notQueried',json_extract(${j.result},'$.counts.notQueried'),'total',json_extract(${j.result},'$.counts.total'),'needsReview',json_extract(${j.result},'$.counts.needsReview')) else '{}' end`,
  // Validate the entire collection before counting or taking a bounded preview.
  // Unknown shapes produce no coverage claims; raw/page payloads stay in SQLite.
  reconcileCollection: sql<string>`case when ${j.kind} = 'reconcile' then case when ${validReconcileCoverage} = 1 then json_object(
    'complete',json_extract(${j.result},'$.collection.complete'),
    'partial',json_extract(${j.result},'$.collection.partial'),
    'failed',json_extract(${j.result},'$.collection.failed'),
    'unknown',json_extract(${j.result},'$.collection.unknown'),
    'unfinished',(select coalesce(sum(json_array_length(${reconcileUnfinished})),0) from json_each(${reconcilePositions}) p),
    'positions',json((select json_group_array(json_object('source',source,'rdjb',rdjb,'page',page)) from
      (select json_extract(${reconcileRange},'$.source') as source,
        json_extract(${reconcileRange},'$.rdjb') as rdjb,json_extract(${reconcileRange},'$.page') as page
       from json_each(${reconcilePositions}) p, json_each(${reconcileUnfinished}) u limit 50)))
  ) else '{}' end else '{}' end`,
}

export function readReconcileSummary(row: { kind: string; counts: string; reconcileCollection: string }) {
  let reconcileCollection: TaskSummary['reconcileCollection']
  if (row.kind === 'reconcile') {
    const coverage = JSON.parse(row.reconcileCollection || '{}') as Record<string, unknown>
    const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    const known = ['complete', 'partial', 'failed', 'unknown', 'unfinished'].every(key => count(coverage[key]))
    const positions: NonNullable<TaskSummary['reconcileCollection']>['positions'] = []
    if (known && Array.isArray(coverage.positions)) {
      for (const candidate of coverage.positions as unknown[]) {
        if (!candidate || typeof candidate !== 'object') continue
        const position = candidate as Record<string, unknown>
        if (position && (position.source === 'businessList' || position.source === 'queryList')
          && (position.rdjb === null || (typeof position.rdjb === 'string' && ['1', '2', '3'].includes(position.rdjb)))
          && typeof position.page === 'number' && Number.isSafeInteger(position.page) && position.page > 0) {
          positions.push({ source: position.source, rdjb: position.rdjb, page: position.page })
        }
      }
    }
    reconcileCollection = {
      complete: known ? coverage.complete as number : null, partial: known ? coverage.partial as number : null,
      failed: known ? coverage.failed as number : null, unknown: known ? coverage.unknown as number : null,
      unfinished: known ? coverage.unfinished as number : null, positions,
      positionsTruncated: known && (coverage.unfinished as number) > positions.length,
    }
  }
  if (row.kind !== 'reconcile') return {}
  const counts = JSON.parse(row.counts || '{}') as Partial<Record<keyof ReconcileReportCounts, unknown>>
  const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
  const reconcile: NonNullable<TaskSummary['reconcile']> = { targets: count(counts.total), needsReview: count(counts.needsReview), queryFailed: count(counts.queryFailed), notQueried: count(counts.notQueried) }
  return { reconcile, reconcileCollection }
}

export async function summarizePostgresReconcileJobs(db: NodePgDatabase, ids: string[]) {
  // Drizzle 0.45.4 has no PostgreSQL JSON token, set-returning function or boolean aggregate builders.
  // Validate the full coverage on the server before preparing the bounded preview.
  const jobs = db.$with('reconcile_jobs').as(db.select({
    id: pgJob.id, kind: pgJob.kind, result: sql`business.job_params_for_query(${pgJob.result})`.as('result'),
  }).from(pgJob).where(and(eq(pgJob.kind, 'reconcile'), inArray(pgJob.id, ids))))
  const scopes = db.$with('reconcile_scopes').as(db.select({
    id: jobs.id, kind: jobs.kind, result: jobs.result,
    coverage: sql`${jobs.result}->'collection'`.as('coverage'),
    positions: sql`${jobs.result}->'collection'->'positions'`.as('positions'),
  }).from(jobs))
  const positions = scopes.positions
  const unfinished = sql`pos.value->'unfinished'`
  const ranges = db.select({
    count: count().as('range_count'),
    valid: sql<boolean>`coalesce(bool_and(coalesce(
      CASE WHEN (u.value->'page')::text ~ '^[0-9]+$' AND length((u.value->'page')::text) <= 16
        THEN (u.value->>'page')::numeric BETWEEN 1 AND 9007199254740991 ELSE false END
      AND ((u.value->>'source'='businessList' AND (u.value->'rdjb')::text IN ('"1"','"2"','"3"'))
        OR (u.value->>'source'='queryList' AND json_typeof(u.value->'rdjb')='null')),false)),true)`.as('range_valid'),
  }).from(sql`json_array_elements(CASE WHEN json_typeof(${unfinished})='array' THEN ${unfinished} END) u`).as('ranges')
  const stats = db.select({
    count: count().as('position_count'),
    unfinished: sql`coalesce(${sum(ranges.count)}, 0)`.as('unfinished'),
    valid: sql<boolean>`coalesce(bool_and(coalesce(json_typeof(${unfinished})='array',false) AND ${ranges.valid}),true)`.as('valid'),
  }).from(sql`json_array_elements(CASE WHEN json_typeof(${positions})='array' THEN ${positions} END) pos`)
    .crossJoinLateral(ranges).as('stats')
  const previewRows = db.select({ value: sql`u.value`.as('value') })
    .from(sql`json_array_elements(${positions}) pos`).crossJoinLateral(sql`json_array_elements(${unfinished}) u`)
    .limit(50).as('preview')
  const preview = db.select({ json: sql`json_agg(json_build_object('source', preview.value->'source',
    'rdjb', preview.value->'rdjb', 'page', preview.value->'page'))` }).from(previewRows)
  const coverage = scopes.coverage
  const total = db.select({ total: sum(sql`CASE WHEN (${coverage}->key)::text ~ '^[0-9]+$'
    AND length((${coverage}->key)::text) <= 16 THEN
    CASE WHEN (${coverage}->>key)::numeric <= 9007199254740991 THEN (${coverage}->>key)::numeric END
    END`) }).from(sql`unnest(ARRAY['complete','partial','failed','unknown']) keys(key)`)
  const rows = await db.with(jobs, scopes).select({
    id: scopes.id, kind: scopes.kind,
    counts: sql<string | null>`json_build_object(
      'total',${scopes.result}->'counts'->'total','needsReview',${scopes.result}->'counts'->'needsReview',
      'queryFailed',${scopes.result}->'counts'->'queryFailed','notQueried',${scopes.result}->'counts'->'notQueried'
    )::text`,
    reconcileCollection: sql<string | null>`CASE WHEN json_typeof(${positions}) = 'array'
      AND ${total} = ${stats.count} AND ${stats.valid} THEN json_build_object(
        'complete',${coverage}->'complete','partial',${coverage}->'partial','failed',${coverage}->'failed','unknown',${coverage}->'unknown',
        'unfinished',${stats.unfinished}, 'positions', ${preview}
      )::text END`,
  }).from(scopes).crossJoinLateral(stats)
  return new Map(rows.map(row => [row.id, {
    ...readReconcileSummary({ ...row, counts: row.counts ?? '{}', reconcileCollection: row.reconcileCollection ?? '{}' }),
    links: platformTaskLinks(),
  }]))
}
