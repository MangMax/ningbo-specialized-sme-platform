import { platformTaskLinks } from './task-presentation'
import type { TaskSummaryAccess } from '../../../../core/server/utils/job-runner-postgres'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { job } from '../../../../../db/postgresql/job-tables'
import type { useApplicationDb } from '../../../../../db/client'
import type { TaskSummary } from '../../../lib/sme-roster/task-summary'

/** Project scalars in SQLite: never hydrate archives, conditions or backup paths. */
export function readSnapshotSummary(db: ReturnType<typeof useApplicationDb>, id: string): NonNullable<TaskSummary['snapshot']> {
  const counts = db.$client.prepare(`select
    json_extract(result,'$.counts.enterprises') enterprises,
    json_extract(result,'$.counts.requests') requests,
    json_extract(result,'$.counts.rows') rows,
    json_extract(result,'$.counts.unfinished') unfinished
    from job where id=?`).get(id) as Record<string, unknown>
  const positions = db.$client.prepare(`select
    json_extract(i.value,'$.enterpriseId') enterpriseId,
    json_extract(i.value,'$.source') source,
    json_extract(i.value,'$.rdjb') rdjb,
    json_extract(i.value,'$.rows') rows,
    coalesce((select max(json_extract(p.value,'$.page')) from json_each(i.value,'$.segments') s,
      json_each(s.value,'$.pages') p where json_extract(p.value,'$.status')='success'),0)+1 page
    from job j, json_each(j.result,'$.items') i
    where j.id=? and json_extract(i.value,'$.complete') is not 1 limit 21`).all(id) as Record<string, unknown>[]
  const sources = Object.fromEntries(['queryList','businessList','queryBusList'].map(source => {
      const c = db.$client.prepare(`select json_extract(result, ?) requests, json_extract(result, ?) rows,
        json_extract(result, ?) failed, json_extract(result, ?) unfinished from job where id=?`).get(
          `$.counts.bySource.${source}.requests`, `$.counts.bySource.${source}.rows`,
          `$.counts.bySource.${source}.failed`, `$.counts.bySource.${source}.unfinished`, id) as Record<string, unknown>
      return [source,c]
    }))
  return formatSnapshotSummary(counts,sources,positions)
}

function formatSnapshotSummary(counts: Record<string,unknown>, sources: Record<string,Record<string,unknown>>, positions: Record<string,unknown>[]): NonNullable<TaskSummary['snapshot']> {
  const number = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
  return {
    sources: ['queryList','businessList','queryBusList'].map(source=>{
      const c = sources[source] ?? {}
      return { source,requests:number(c.requests),rows:number(c.rows),failed:number(c.failed),unfinished:number(c.unfinished) }
    }),
    enterprises: number(counts.enterprises), requests: number(counts.requests), rows: number(counts.rows), unfinished: number(counts.unfinished),
    positions: positions.slice(0,20).map(p => ({ enterpriseId: number(p.enterpriseId),
      source: ['queryList','businessList','queryBusList'].includes(String(p.source)) ? String(p.source) : '未知接口',
      rdjb: ['1','2','3'].includes(String(p.rdjb)) ? String(p.rdjb) : null, rows: number(p.rows), page: number(p.page) })),
    truncated: positions.length > 20,
  }
}

export const snapshotTaskLinks = (id: string) => [
  { label:'快照范围、计数与未完成位置',to:`/tasks?tab=sme-roster&group=platform&job=${id}#snapshot-result` },
  ...platformTaskLinks(),
]

export async function summarizePostgresSnapshots(db: NodePgDatabase, ids: string[], detail: boolean, { authorized }: TaskSummaryAccess) {
  if (!detail || !authorized) return new Map(ids.map(id => [id, {
    links: snapshotTaskLinks(id),
  }]))
  const result = sql`${job.result}::json`
  type Counts = Record<string, unknown> & { bySource?: Record<string, Record<string, unknown>> }
  // PostgreSQL JSON table functions and ordered, limited scalar projection keep
  // raw archives and unbounded position data in the database.
  const positions = sql<Record<string, unknown>[] | null>`(SELECT json_agg(json_build_object(
    'enterpriseId', i.value->'enterpriseId', 'source', i.value->'source',
    'rdjb', i.value->'rdjb', 'rows', i.value->'rows', 'page', coalesce((
      SELECT max((p.value->>'page')::integer)
      FROM json_array_elements(i.value->'segments') s(value), json_array_elements(s.value->'pages') p(value)
      WHERE p.value->>'status' = 'success'), 0) + 1))
    FROM (SELECT value FROM json_array_elements(${result}->'items') i(value)
      WHERE coalesce((i.value->'complete')::text, '') NOT IN ('true', '1') LIMIT 21) i)`
  const rows = await db.select({
    id: job.id,
    counts: sql<Counts | null>`${result}->'counts'`,
    positions,
  }).from(job).where(and(inArray(job.id, ids), eq(job.kind, 'difference-snapshot')))
  return new Map(rows.map(row=>[row.id,{ links: snapshotTaskLinks(row.id),
    snapshot:formatSnapshotSummary(row.counts ?? {},row.counts?.bySource ?? {},row.positions ?? []),
  }]))
}
