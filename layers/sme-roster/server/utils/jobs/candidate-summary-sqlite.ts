import { sql } from 'drizzle-orm'
import { job as j } from '../../../../../db/schema'

const candidateCounts = sql`case when json_type(${j.result}, '$.counts') = 'object' then json_object(
  ${sql.join(['succeeded', 'needsReview', 'failed', 'created', 'existing'].map(key => sql`${key}, case
    when json_type(${j.result}, ${'$.counts.' + key}) = 'integer'
    then json_extract(${j.result}, ${'$.counts.' + key}) end`), sql`, `)}
) end`
export const candidateProjection = {
  discoveryMeta: sql<string>`case when ${j.kind} = 'event-archive-candidates' then json_object('ruleVersion', substr(json_extract(${j.result},'$.ruleVersion'),1,80), 'attempt', json_extract(${j.result},'$.attempt'), 'titleCode',substr(json_extract(${j.params},'$.titleCode'),1,40),'queryId',json_extract(${j.params},'$.queryId'),'eventCount',json_array_length(${j.params},'$.eventIds'),'counts',json(${candidateCounts}),'throughEventId',json_extract(${j.result},'$.throughEventId'),'nextAfterEventId',json_extract(${j.result},'$.nextAfterEventId'),'continuationJobId',substr(json_extract(${j.result},'$.continuationJobId'),1,26),'items',json((select json_group_array(json_object('eventId',json_extract(value,'$.eventId'),'enterpriseId',json_extract(value,'$.enterpriseId'),'status',substr(json_extract(value,'$.status'),1,20),'created',json_extract(value,'$.created'),'existing',json_extract(value,'$.existing'),'errorCode',substr(json_extract(value,'$.errorCode'),1,50))) from (select value from json_each(${j.result},'$.items') limit 200)))) else '{}' end`,
}
