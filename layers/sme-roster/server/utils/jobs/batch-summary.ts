import { platformTaskLinks, rosterTaskError, taskRetryReason } from './task-presentation'
import { isJobId } from '../../../../core/lib/job'
import { MAX_BATCH_ATTEMPTS, type PlatformBatchItem } from '../../../lib/platform/batch-query'
import type { TaskSummary } from '../../../lib/sme-roster/task-summary'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { JobState } from '../../../../core/lib/job'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { job as pgJob } from '../../../../../db/postgresql/job-tables'
import { schema } from '../../../../../db/client'
interface BatchItemRead extends Pick<PlatformBatchItem, 'status' | 'completeness'> {
  id: unknown; unfinished: number; positions: PlatformBatchItem['unfinished']
}
const j = schema.job
export const batchProjection = {
  itemCount: sql<number>`json_array_length(${j.params}, '$.items')`,
  attempt: sql<number>`json_extract(${j.result}, '$.attempt')`,
  items: sql<string>`case when ${j.kind} = 'platform-query-batch' then (select json_group_array(json_object('id',json_extract(item.value,'$.itemId'),'status',json_extract(item.value,'$.status'),'completeness',json_extract(item.value,'$.completeness'),'unfinished',coalesce(json_array_length(json_extract(item.value,'$.unfinished')),0),'positions',json((select json_group_array(json_object('source',json_extract(pos.value,'$.source'),'rdjb',json_extract(pos.value,'$.rdjb'),'page',json_extract(pos.value,'$.page'))) from (select value from json_each(item.value,'$.unfinished') limit 50) pos)))) from (select value from json_each(${j.result}, '$.items') limit 50) item) else '[]' end`,
}

export function readBatchSummary(row: { kind: string; state: JobState; items: string; itemCount: number; attempt: number }, detail: boolean) {
  const active = row.state === 'queued' || row.state === 'running'
  const items = JSON.parse(row.items || '[]') as BatchItemRead[]
  const retryItemIds = items.filter(i => i.completeness !== 'complete' && isJobId(i.id)).map(i => i.id as string)
  const outcome = row.kind === 'platform-query-batch' ? {
    complete: items.filter(i => i.completeness === 'complete').length,
    partial: items.filter(i => i.completeness === 'partial').length,
    failed: items.filter(i => ['failed', 'auth_failed'].includes(i.status)).length,
    notQueried: items.length ? items.filter(i => i.status === 'not_queried').length : row.itemCount ?? 0,
    unfinished: items.reduce((n, i) => n + i.unfinished, 0), attempt: row.attempt || 0,
  } : null
  const retry = row.kind === 'platform-query-batch' && !active && row.attempt < MAX_BATCH_ATTEMPTS && retryItemIds.length > 0
  const safeItems: NonNullable<TaskSummary['items']> = items.map(i => ({ id: isJobId(i.id) ? i.id : '', status: ['success', 'no_record', 'auth_failed', 'failed', 'partial', 'not_queried'].includes(i.status) ? i.status : 'unknown', completeness: ['complete', 'partial', 'not_queried'].includes(i.completeness) ? i.completeness : 'unknown', positions: (i.positions ?? []).filter(p => ['queryList','businessList','queryBusList'].includes(p.source) && (p.rdjb === null || ['1','2','3'].includes(p.rdjb)) && Number.isSafeInteger(p.page) && p.page > 0) }))
  return { items: detail ? safeItems : [], retryItemIds, outcome, retry }
}

export async function summarizePostgresBatches(db: NodePgDatabase, ids: string[], detail: boolean) {
  // Drizzle 0.45.4 has no PostgreSQL JSON operators or aggregate builders.
  const jobs = db.$with('batch_jobs').as(db.select({
    id: pgJob.id, kind: pgJob.kind, state: pgJob.state,
    hasError: isNotNull(pgJob.error).mapWith(Boolean).as('has_error'),
    restarted: sql<boolean>`coalesce(position('服务重启' in ${pgJob.error}),0)>0`.as('restarted'),
    itemCount: sql<number>`json_array_length(${pgJob.params}::json -> 'items')`.as('item_count'),
    result: sql`regexp_replace(${pgJob.result}, ${String.raw`\\u(?:0000|d[89a-f][0-9a-f]{2})`},
      ${String.raw`\\uFFFD`}, 'gi')::json`.as('result'),
  }).from(pgJob).where(and(eq(pgJob.kind, 'platform-query-batch'), inArray(pgJob.id, ids))))
  const itemRows = db.select({ value: sql`value`.as('value') })
    .from(sql`json_array_elements(${jobs.result} -> 'items')`).limit(50).as('item')
  const unfinished = sql`item.value -> 'unfinished'`
  const positionRows = db.select({ value: sql`value`.as('value') })
    .from(sql`json_array_elements(${unfinished})`).limit(50).as('position')
  const positions = db.select({ json: sql`json_agg(json_build_object('source', position.value ->> 'source',
    'rdjb', position.value -> 'rdjb', 'page', position.value -> 'page'))` }).from(positionRows)
  const items = db.select({ json: sql`json_agg(json_build_object(
    'id', item.value ->> 'itemId', 'status', item.value ->> 'status',
    'completeness', item.value ->> 'completeness',
    'unfinished', coalesce(json_array_length(${unfinished}), 0),
    'positions', CASE WHEN ${detail} THEN ${positions} END
  ))::text` }).from(itemRows)
  const rows = await db.with(jobs).select({
    id: jobs.id, kind: jobs.kind, state: jobs.state, hasError: jobs.hasError, restarted: jobs.restarted,
    itemCount: jobs.itemCount, attempt: sql<number>`(${jobs.result} ->> 'attempt')::integer`,
    items: sql<string>`${items}`,
  }).from(jobs)
  return new Map(rows.map(row => {
    const { items, retryItemIds, outcome, retry } = readBatchSummary(row, detail)
    return [row.id, {
      outcome, ...(detail ? { items } : {}),
      error: rosterTaskError(row),
      ...(retry ? { capabilities: { cancel: false, retry, retryItemIds, reason: taskRetryReason } } : {}),
      links: platformTaskLinks(),
    }]
  }))
}
