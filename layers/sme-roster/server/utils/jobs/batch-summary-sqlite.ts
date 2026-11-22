import { sql } from 'drizzle-orm'
import { job as j } from '../../../../../db/schema'

export const batchProjection = {
  itemCount: sql<number>`json_array_length(${j.params}, '$.items')`,
  attempt: sql<number>`json_extract(${j.result}, '$.attempt')`,
  items: sql<string>`case when ${j.kind} = 'platform-query-batch' then (select json_group_array(json_object('id',json_extract(item.value,'$.itemId'),'status',json_extract(item.value,'$.status'),'completeness',json_extract(item.value,'$.completeness'),'unfinished',coalesce(json_array_length(json_extract(item.value,'$.unfinished')),0),'positions',json((select json_group_array(json_object('source',json_extract(pos.value,'$.source'),'rdjb',json_extract(pos.value,'$.rdjb'),'page',json_extract(pos.value,'$.page'))) from (select value from json_each(item.value,'$.unfinished') limit 50) pos)))) from (select value from json_each(${j.result}, '$.items') limit 50) item) else '[]' end`,
}
