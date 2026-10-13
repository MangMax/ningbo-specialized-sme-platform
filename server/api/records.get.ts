import { useDb } from '@db'
import { listRecords, type EventType } from '~~/lib/query'

const EVENT_TYPES: EventType[] = ['award', 'review', 'maintain', 'nurture']

export default defineEventHandler((event) => {
  const q = getQuery(event)
  const num = (v: unknown, d: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : d
  }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const eventType = str(q.eventType)
  const yearNum = Number(q.year)
  return listRecords(useDb(), {
    title: str(q.title),
    source: str(q.source),
    district: str(q.district),
    eventType: eventType && EVENT_TYPES.includes(eventType as EventType) ? (eventType as EventType) : undefined,
    year: Number.isInteger(yearNum) && yearNum > 0 ? yearNum : undefined,
    q: str(q.q),
    page: num(q.page, 1),
    pageSize: num(q.pageSize, 25),
  })
})
