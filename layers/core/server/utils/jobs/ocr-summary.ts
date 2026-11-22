import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { TaskSummary } from '../../../lib/task-center'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { job } from '../../../../../db/postgresql/job-tables'
import { storedFile } from '../../../../../db/postgresql/file-tables'
export function readOcrLinks(row: { kind: string; files: string }): TaskSummary['links'] {
  const links: TaskSummary['links'] = []
  if (row.kind === 'ocr' || row.kind === 'render-pages') {
    for (const file of JSON.parse(row.files || '[]') as { id: number; path: string | null }[]) if (Number.isSafeInteger(file.id) && typeof file.path === 'string' && !file.path.startsWith('/') && !file.path.includes('..') && !file.path.includes('\\')) links.push({ label: `识别结果 #${file.id}`, to: `/ocr?file=${encodeURIComponent(file.path)}` })
    links.push({ label: '识别校对入口', to: '/ocr' }, { label: '文件管理 / 转图', to: '/files' })
  }
  return links
}


export async function summarizePostgresOcrJobs(db: NodePgDatabase, ids: string[]) {
  // The bounded, correlated set-returning JSON expansion keeps large task
  // payloads out of the summary and preserves the historical array projection.
  const items = db.select({ value: sql`value`.as('value') })
    .from(sql`json_array_elements(business.job_params_for_query(${job.result})->'files')`)
    .where(sql`(value->'ok')::text IN ('true','1')`).limit(50).as('items')
  const files = db.select({
    files: sql`json_agg(json_build_object('id',${items.value}->'fileId','path',${storedFile.relPath}))::text`,
  }).from(items).leftJoin(storedFile, eq(storedFile.id, sql`CASE WHEN (${items.value}->'fileId')::text ~ '^[0-9]{1,16}$'
      THEN (${items.value}->>'fileId')::bigint END`))
  const rows = await db.select({ id: job.id, kind: job.kind, files: sql<string | null>`(${files})` })
    .from(job).where(and(inArray(job.id, ids), eq(job.kind, 'ocr')))
  return new Map(rows.map(row => [row.id, { links: readOcrLinks({ ...row, files: row.files ?? '[]' }) }]))
}

export async function summarizePostgresRenderJobs(_db: NodePgDatabase, ids: string[]) {
  return new Map(ids.map(id => [id, { links: readOcrLinks({ kind: 'render-pages', files: '[]' }) }]))
}
