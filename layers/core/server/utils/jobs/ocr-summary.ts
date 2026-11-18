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
