import { platformTaskLinks } from './task-presentation'
import type { TaskSummaryAccess } from '../../../../core/server/utils/job-runner-postgres'
import { and, eq, inArray, max, notInArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { job } from '../../../../../db/postgresql/job-tables'
import type { TaskSummary } from '../../../lib/sme-roster/task-summary'

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
  // Drizzle 0.45 has no typed JSON table function, JSON field operator or
  // ordered JSON aggregate. Keep the result capped before aggregating it.
  const item = sql`item.value`
  const itemOrder = sql`item.ordinal`
  const unfinished = db.select({ value: item.as('value'), ordinal: itemOrder.as('ordinal') })
    .from(sql`json_array_elements(${result}->'items') WITH ORDINALITY item(value, ordinal)`)
    .where(notInArray(sql<string>`coalesce((${item}->'complete')::text, '')`, ['true', '1']))
    .orderBy(itemOrder).limit(21).as('unfinished')
  const value = sql`unfinished.value`
  const latestPage = db.select({ page: max(sql`(p.value->>'page')::integer`) })
    .from(sql`json_array_elements(${value}->'segments') s(value)`)
    .crossJoin(sql`json_array_elements(s.value->'pages') p(value)`)
    .where(eq(sql<string>`p.value->>'status'`, 'success'))
  const positions = db.select({
    value: sql<Record<string, unknown>[] | null>`json_agg(json_build_object(
      'enterpriseId', ${value}->'enterpriseId', 'source', ${value}->'source',
      'rdjb', ${value}->'rdjb', 'rows', ${value}->'rows',
      'page', coalesce(${latestPage}, 0) + 1) ORDER BY unfinished.ordinal)`,
  }).from(unfinished)
  const rows = await db.select({
    id: job.id,
    counts: sql<Counts | null>`${result}->'counts'`,
    positions: sql<Record<string, unknown>[] | null>`${positions}`,
  }).from(job).where(and(inArray(job.id, ids), eq(job.kind, 'difference-snapshot')))
  return new Map(rows.map(row=>[row.id,{ links: snapshotTaskLinks(row.id),
    snapshot:formatSnapshotSummary(row.counts ?? {},row.counts?.bySource ?? {},row.positions ?? []),
  }]))
}
