import { sql } from 'drizzle-orm'
import { job as j } from '../../../../../db/schema'
import { ANNUAL_CORRESPONDENCE_KIND } from '../../../lib/roster/annual-correspondence'

export const annualProjection = {
  annualTotal: sql<number | null>`case when ${j.kind} = ${ANNUAL_CORRESPONDENCE_KIND} and json_type(${j.result}, '$.events') = 'array' then json_array_length(${j.result}, '$.events') end`,
  annualAttempt: sql<number | null>`case when ${j.kind} = ${ANNUAL_CORRESPONDENCE_KIND} and json_type(${j.result}, '$.attempt') = 'integer' then json_extract(${j.result}, '$.attempt') end`,
  annualDone: sql<number>`(select count(*) from json_each(case when ${j.kind} = ${ANNUAL_CORRESPONDENCE_KIND} then ${j.result} else '{}' end, '$.events') where json_extract(value, '$.status') = 'done')`,
  annualFailed: sql<number>`(select count(*) from json_each(case when ${j.kind} = ${ANNUAL_CORRESPONDENCE_KIND} then ${j.result} else '{}' end, '$.events') where json_extract(value, '$.status') = 'failed')`,
}
