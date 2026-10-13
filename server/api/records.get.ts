import { useDb } from '@db'
import { listRecords } from '~~/lib/query'

export default defineEventHandler((event) => {
  const q = getQuery(event)
  const num = (v: unknown, d: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : d
  }
  return listRecords(useDb(), {
    title: typeof q.title === 'string' && q.title ? q.title : undefined,
    source: typeof q.source === 'string' && q.source ? q.source : undefined,
    district: typeof q.district === 'string' && q.district ? q.district : undefined,
    eventType: typeof q.eventType === 'string' && q.eventType ? q.eventType : undefined,
    q: typeof q.q === 'string' && q.q ? q.q : undefined,
    page: num(q.page, 1),
    pageSize: num(q.pageSize, 25),
  })
})
