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

  /**
   * 多值参数:以逗号分隔承载(如 `title=a,b`),也兼容重复参数(`title=a&title=b`),
   * 空白项剔除;无值返回 undefined。
   */
  const csv = (v: unknown): string[] | undefined => {
    if (v == null) return undefined
    const raw = Array.isArray(v) ? v.flatMap((x) => String(x).split(',')) : String(v).split(',')
    const list = raw.map((s) => s.trim()).filter(Boolean)
    return list.length ? list : undefined
  }
  const csvEventTypes = (v: unknown): EventType[] | undefined => {
    const list = csv(v)?.filter((x): x is EventType => EVENT_TYPES.includes(x as EventType))
    return list?.length ? list : undefined
  }
  const csvYears = (v: unknown): number[] | undefined => {
    const list = csv(v)
      ?.map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0)
    return list?.length ? list : undefined
  }

  return listRecords(useDb(), {
    title: csv(q.title),
    source: csv(q.source),
    district: str(q.district),
    eventType: csvEventTypes(q.eventType),
    year: csvYears(q.year),
    q: str(q.q),
    flags: str(q.flags),
    page: num(q.page, 1),
    pageSize: num(q.pageSize, 25),
  })
})
