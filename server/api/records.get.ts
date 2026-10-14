import { useDb } from '@db'
import { listRecords, type EventType } from '~~/lib/query'

const EVENT_TYPES: EventType[] = ['award', 'review', 'maintain', 'nurture']

/**
 * 台账记录(最小粒度 = 企业 × 称号 × 来源)。
 *
 * query 参数**手写** —— Nitro 的 spec 生成只自动推断**路径参数**,query / header
 * 没有运行时 schema 可推(见票 19)。这里写的形状与下面 `listRecords` 的入参一一对应。
 */
defineRouteMeta({
  openAPI: {
    tags: ['台账'],
    summary: '查台账记录',
    description: '多值参数用逗号分隔也可重复传(`title=a,b` 或 `title=a&title=b`)。分页返回。',
    parameters: [
      {
        name: 'title',
        in: 'query',
        schema: { type: 'string' },
        description: '称号代号,多值:`little_giant` / `specialized_sme` / `innovative_sme`。',
      },
      { name: 'source', in: 'query', schema: { type: 'string' }, description: '来源:`jxj` / `miit`。' },
      { name: 'district', in: 'query', schema: { type: 'string' }, description: '区县(精确)。' },
      {
        name: 'eventType',
        in: 'query',
        schema: { type: 'string' },
        description: '事件类型:`award`(认定)/ `review`(复核)/ `maintain`(维护)/ `nurture`(入库培育)。',
      },
      { name: 'year', in: 'query', schema: { type: 'string' }, description: '事件年份,多值。' },
      { name: 'q', in: 'query', schema: { type: 'string' }, description: '企业名称关键词。' },
      { name: 'flags', in: 'query', schema: { type: 'string' }, description: '质量标记(如 `uscc_missing`)。' },
      { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 25 } },
    ],
    responses: { 200: { description: '分页的记录列表。' } },
  },
})

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
