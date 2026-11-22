import { sql } from 'drizzle-orm'
import { job as j } from '../../../../../db/schema'

export const ocrProjection = {
  files: sql<string>`case when ${j.kind} = 'ocr' then (select json_group_array(json_object('id',json_extract(value,'$.fileId'),'path',(select rel_path from stored_file where id = json_extract(value,'$.fileId')))) from (select value from json_each(${j.result}, '$.files') where json_extract(value,'$.ok') = 1 limit 50)) else '[]' end`,
}
