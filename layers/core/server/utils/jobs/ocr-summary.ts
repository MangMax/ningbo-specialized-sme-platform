import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { TaskSummary } from '../../../lib/task-center'
import { sql } from 'drizzle-orm'
import { schema } from '../../../../../db/client'
const j = schema.job
export const ocrProjection = {
  files: sql<string>`case when ${j.kind} = 'ocr' then (select json_group_array(json_object('id',json_extract(value,'$.fileId'),'path',(select rel_path from stored_file where id = json_extract(value,'$.fileId')))) from (select value from json_each(${j.result}, '$.files') where json_extract(value,'$.ok') = 1 limit 50)) else '[]' end`,
}

export function readOcrLinks(row: { kind: string; files: string }): TaskSummary['links'] {
  const links: TaskSummary['links'] = []
  if (row.kind === 'ocr' || row.kind === 'render-pages') {
    for (const file of JSON.parse(row.files || '[]') as { id: number; path: string | null }[]) if (Number.isSafeInteger(file.id) && typeof file.path === 'string' && !file.path.startsWith('/') && !file.path.includes('..') && !file.path.includes('\\')) links.push({ label: `识别结果 #${file.id}`, to: `/ocr?file=${encodeURIComponent(file.path)}` })
    links.push({ label: '识别校对入口', to: '/ocr' }, { label: '文件管理 / 转图', to: '/files' })
  }
  return links
}


export async function summarizePostgresOcrJobs(db: NodePgDatabase, ids: string[]) {
  const { rows } = await db.execute<{ id: string; kind: string; files: string | null }>(sql`
    SELECT j.id,j.kind,(
      SELECT json_agg(json_build_object('id',i.value->'fileId','path',f.rel_path))::text
      FROM (
        SELECT value FROM json_array_elements(business.job_params_for_query(j.result)->'files')
        WHERE (value->'ok')::text IN ('true','1') LIMIT 50
      ) i
      LEFT JOIN business.stored_file f ON f.id=CASE WHEN (i.value->'fileId')::text ~ '^[0-9]{1,16}$'
        THEN (i.value->>'fileId')::bigint END
    ) AS files
    FROM business.job j WHERE j.id=ANY(${sql.param(ids)}::text[]) AND j.kind='ocr'`)
  return new Map(rows.map(row => [row.id, { links: readOcrLinks({ ...row, files: row.files ?? '[]' }) }]))
}

export async function summarizePostgresRenderJobs(_db: NodePgDatabase, ids: string[]) {
  return new Map(ids.map(id => [id, { links: readOcrLinks({ kind: 'render-pages', files: '[]' }) }]))
}
