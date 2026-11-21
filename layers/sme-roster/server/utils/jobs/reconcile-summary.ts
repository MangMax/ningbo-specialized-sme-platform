import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { platformTaskLinks } from './task-presentation'
import type { ReconcileReportCounts } from '../platform-reconcile'
import { and, eq, sql } from 'drizzle-orm'
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
  // Drizzle 0.45.4 has no JSON set-returning functions, token validation or JSON aggregate builders.
  // Validate the full coverage on the server before preparing the bounded preview.
  const rows = await db.select({
    id: pgJob.id, kind: pgJob.kind,
    counts: sql<string | null>`json_build_object(
      'total',r.result->'counts'->'total','needsReview',r.result->'counts'->'needsReview',
      'queryFailed',r.result->'counts'->'queryFailed','notQueried',r.result->'counts'->'notQueried'
    )::text`,
    reconcileCollection: sql<string | null>`CASE WHEN json_typeof(c.positions) = 'array'
      AND (SELECT sum(CASE WHEN (c.coverage->key)::text ~ '^[0-9]+$'
        AND length((c.coverage->key)::text) <= 16 THEN
        CASE WHEN (c.coverage->>key)::numeric <= 9007199254740991 THEN (c.coverage->>key)::numeric END
      END) FROM unnest(ARRAY['complete','partial','failed','unknown']) keys(key)) = p.count
      AND p.valid THEN json_build_object(
        'complete',c.coverage->'complete','partial',c.coverage->'partial','failed',c.coverage->'failed','unknown',c.coverage->'unknown',
        'unfinished',p.unfinished,
        'positions',(
          SELECT json_agg(json_build_object('source',u.value->'source','rdjb',u.value->'rdjb','page',u.value->'page'))
          FROM (
            SELECT u.value FROM json_array_elements(c.positions) pos
            CROSS JOIN LATERAL json_array_elements(pos.value->'unfinished') u LIMIT 50
          ) u
        )
      )::text END`,
  }).from(pgJob)
    .crossJoinLateral(sql`(SELECT business.job_params_for_query(${pgJob.result}) AS result) r`)
    .crossJoinLateral(sql`(SELECT r.result->'collection' AS coverage,r.result->'collection'->'positions' AS positions) c`)
    .crossJoinLateral(sql`(
      SELECT count(*) AS count,coalesce(sum(s.count),0) AS unfinished,
        coalesce(bool_and(coalesce(json_typeof(pos.value->'unfinished')='array',false) AND s.valid),true) AS valid
      FROM json_array_elements(CASE WHEN json_typeof(c.positions)='array' THEN c.positions END) pos
      CROSS JOIN LATERAL (
        SELECT count(*) AS count,coalesce(bool_and(coalesce(
          CASE WHEN (u.value->'page')::text ~ '^[0-9]+$' AND length((u.value->'page')::text) <= 16
            THEN (u.value->>'page')::numeric BETWEEN 1 AND 9007199254740991 ELSE false END
          AND ((u.value->>'source'='businessList' AND (u.value->'rdjb')::text IN ('"1"','"2"','"3"'))
            OR (u.value->>'source'='queryList' AND json_typeof(u.value->'rdjb')='null')),false)),true) AS valid
        FROM json_array_elements(CASE WHEN json_typeof(pos.value->'unfinished')='array' THEN pos.value->'unfinished' END) u
      ) s
    ) p`)
    .where(and(eq(pgJob.kind, 'reconcile'), sql`${pgJob.id} = any(${sql.param(ids)}::text[])`))
  return new Map(rows.map(row => [row.id, {
    ...readReconcileSummary({ ...row, counts: row.counts ?? '{}', reconcileCollection: row.reconcileCollection ?? '{}' }),
    links: platformTaskLinks(),
  }]))
}
