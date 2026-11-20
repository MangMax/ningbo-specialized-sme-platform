import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { TaskSummary } from '../../../lib/sme-roster/task-summary'
import { sql } from 'drizzle-orm'
import { schema } from '../../../../../db/client'
import { ANNUAL_CORRESPONDENCE_KIND } from '../../../lib/roster/annual-correspondence'
import type { ProjectedTask } from './task-summary'

const j = schema.job
export const annualProjection = {
  annualTotal: sql<number | null>`case when ${j.kind} = ${ANNUAL_CORRESPONDENCE_KIND} and json_type(${j.result}, '$.events') = 'array' then json_array_length(${j.result}, '$.events') end`,
  annualAttempt: sql<number | null>`case when ${j.kind} = ${ANNUAL_CORRESPONDENCE_KIND} and json_type(${j.result}, '$.attempt') = 'integer' then json_extract(${j.result}, '$.attempt') end`,
  annualDone: sql<number>`(select count(*) from json_each(case when ${j.kind} = ${ANNUAL_CORRESPONDENCE_KIND} then ${j.result} else '{}' end, '$.events') where json_extract(value, '$.status') = 'done')`,
  annualFailed: sql<number>`(select count(*) from json_each(case when ${j.kind} = ${ANNUAL_CORRESPONDENCE_KIND} then ${j.result} else '{}' end, '$.events') where json_extract(value, '$.status') = 'failed')`,
}
export function readAnnualSummary(row: ProjectedTask) {
  if (row.kind !== ANNUAL_CORRESPONDENCE_KIND) return undefined
  return { total: row.annualTotal, done: row.annualDone, failed: row.annualFailed,
    unfinished: row.annualTotal === null ? null : row.annualTotal - row.annualDone - row.annualFailed,
    attempt: row.annualAttempt }
}

export async function summarizePostgresAnnualJobs(db: NodePgDatabase, ids: string[]) {
  const { rows } = await db.execute<{ id: string; attempt: number | null; total: number | null; done: number; failed: number }>(sql`
    SELECT id,(result::json->>'attempt')::float8 AS attempt,json_array_length(result::json->'events') AS total,
      (SELECT count(*)::float8 FROM json_array_elements(result::json->'events') AS event WHERE event->>'status'='done') AS done,
      (SELECT count(*)::float8 FROM json_array_elements(result::json->'events') AS event WHERE event->>'status'='failed') AS failed
    FROM business.job WHERE id=ANY(${sql.param(ids)}::text[]) AND kind=${ANNUAL_CORRESPONDENCE_KIND}`)
  return new Map<string, Partial<Pick<TaskSummary, 'annual' | 'links' | 'capabilities'>>>(rows.map(({ id, total, done, failed, attempt }) => [
    id, { annual: { total, done, failed, unfinished: total === null ? null : total - done - failed, attempt },
      links: [{ label: '年度任务详情与重试资格', to: `/api/roster/annual-correspondence-tasks/${id}` }],
      capabilities: { cancel: false, retry: false, retryItemIds: [], reason: '请通过年度专属接口核对当前来源代次与重试资格。' } },
  ]))
}
