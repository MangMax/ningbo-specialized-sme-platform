import type { useApplicationDb } from '../../../../../db/client'
import type { TaskSummary } from '../../../../core/lib/task-center'

/** Project scalars in SQLite: never hydrate archives, conditions or backup paths. */
export function readSnapshotSummary(db: ReturnType<typeof useApplicationDb>, id: string): NonNullable<TaskSummary['snapshot']> {
  const counts = db.$client.prepare(`select
    json_extract(result,'$.counts.enterprises') enterprises,
    json_extract(result,'$.counts.requests') requests,
    json_extract(result,'$.counts.rows') rows,
    json_extract(result,'$.counts.unfinished') unfinished
    from job where id=?`).get(id) as Record<string, unknown>
  const number = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
  const positions = db.$client.prepare(`select
    json_extract(i.value,'$.enterpriseId') enterpriseId,
    json_extract(i.value,'$.source') source,
    json_extract(i.value,'$.rdjb') rdjb,
    json_extract(i.value,'$.rows') rows,
    coalesce((select max(json_extract(p.value,'$.page')) from json_each(i.value,'$.segments') s,
      json_each(s.value,'$.pages') p where json_extract(p.value,'$.status')='success'),0)+1 page
    from job j, json_each(j.result,'$.items') i
    where j.id=? and json_extract(i.value,'$.complete') is not 1 limit 21`).all(id) as Record<string, unknown>[]
  return {
    sources: ['queryList','businessList','queryBusList'].map(source => {
      const c = db.$client.prepare(`select json_extract(result, ?) requests, json_extract(result, ?) rows,
        json_extract(result, ?) failed, json_extract(result, ?) unfinished from job where id=?`).get(
          `$.counts.bySource.${source}.requests`, `$.counts.bySource.${source}.rows`,
          `$.counts.bySource.${source}.failed`, `$.counts.bySource.${source}.unfinished`, id) as Record<string, unknown>
      return { source, requests: number(c.requests), rows: number(c.rows), failed: number(c.failed), unfinished: number(c.unfinished) }
    }),
    enterprises: number(counts.enterprises), requests: number(counts.requests), rows: number(counts.rows), unfinished: number(counts.unfinished),
    positions: positions.slice(0,20).map(p => ({ enterpriseId: number(p.enterpriseId),
      source: ['queryList','businessList','queryBusList'].includes(String(p.source)) ? String(p.source) : '未知接口',
      rdjb: ['1','2','3'].includes(String(p.rdjb)) ? String(p.rdjb) : null, rows: number(p.rows), page: number(p.page) })),
    truncated: positions.length > 20,
  }
}
