import { isJobId } from '../../../layers/core/lib/job'
import { MAX_BATCH_ATTEMPTS, type PlatformBatchItem } from '../../../lib/platform/batch-query'
import type { TaskSummary } from '../../../layers/core/lib/task-center'
import type { ProjectedTask } from './task-summary'
import { sql } from 'drizzle-orm'
import { schema } from '../../../db/client'
interface BatchItemRead extends Pick<PlatformBatchItem, 'status' | 'completeness'> {
  id: unknown; unfinished: number; positions: PlatformBatchItem['unfinished']
}
const j = schema.job
export const batchProjection = {
  itemCount: sql<number>`json_array_length(${j.params}, '$.items')`,
  attempt: sql<number>`json_extract(${j.result}, '$.attempt')`,
  items: sql<string>`case when ${j.kind} = 'platform-query-batch' then (select json_group_array(json_object('id',json_extract(item.value,'$.itemId'),'status',json_extract(item.value,'$.status'),'completeness',json_extract(item.value,'$.completeness'),'unfinished',coalesce(json_array_length(json_extract(item.value,'$.unfinished')),0),'positions',json((select json_group_array(json_object('source',json_extract(pos.value,'$.source'),'rdjb',json_extract(pos.value,'$.rdjb'),'page',json_extract(pos.value,'$.page'))) from (select value from json_each(item.value,'$.unfinished') limit 50) pos)))) from (select value from json_each(${j.result}, '$.items') limit 50) item) else '[]' end`,
}

export function readBatchSummary(row: ProjectedTask, detail: boolean) {
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
