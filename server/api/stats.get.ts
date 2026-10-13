import { useDb } from '@db'
import { getStats } from '~~/lib/query'

/** 统计聚合,可按标题 / 区县 / 来源过滤(与 SPEC 契约一致)。 */
export default defineEventHandler((event) => {
  const q = getQuery(event)
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  return getStats(useDb(), {
    title: str(q.title),
    district: str(q.district),
    source: str(q.source),
  })
})
