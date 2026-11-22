import { sql } from 'drizzle-orm'
import { job as j } from '../../../../../db/schema'

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
