import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { annualTaskReason, platformTaskLinks } from './task-presentation'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { job as pgJob } from '../../../../../db/postgresql/job-tables'
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
  return annualTaskSummary(row.annualTotal, row.annualDone, row.annualFailed, row.annualAttempt)
}

function annualTaskSummary(total: number | null, done: number, failed: number, attempt: number | null) {
  return { total, done, failed, unfinished: total === null ? null : total - done - failed, attempt }
}

export const annualTaskLinks = (id: string) => [
  { label: '年度任务详情与重试资格', to: `/api/roster/annual-correspondence-tasks/${id}` },
  ...platformTaskLinks(),
]

export async function summarizePostgresAnnualJobs(db: NodePgDatabase, ids: string[]) {
  const result = sql`${pgJob.result}::json`
  const events = sql`case when json_typeof(${result}->'events')='array' then ${result}->'events' end`
  const countWithStatus = (status: 'done' | 'failed') => db.$count(
    sql`json_array_elements(${events}) as event`, eq(sql`event->>'status'`, status))
  const rows = await db.select({ id: pgJob.id,
    attempt: sql<number | null>`case when (${result}->'attempt')::text ~ '^-?[0-9]+$' then (${result}->>'attempt')::float8 end`,
    total: sql<number | null>`json_array_length(${events})`, done: countWithStatus('done'), failed: countWithStatus('failed'),
  }).from(pgJob).where(and(inArray(pgJob.id, ids), eq(pgJob.kind, ANNUAL_CORRESPONDENCE_KIND)))
  return new Map(rows.map(({ id, total, done, failed, attempt }) => [
    id, {
      annual: annualTaskSummary(total, done, failed, attempt),
      links: annualTaskLinks(id),
      capabilities: { cancel: false, retry: false, retryItemIds: [], reason: annualTaskReason },
    },
  ]))
}
