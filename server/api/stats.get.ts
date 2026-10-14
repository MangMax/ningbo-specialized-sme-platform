import { useDb } from '@db'
import { getStats } from '~~/lib/query'

/** 统计聚合,可按标题 / 区县 / 来源过滤(与 SPEC 契约一致)。 */
defineRouteMeta({
  openAPI: {
    tags: ['台账'],
    summary: '统计聚合',
    description: '按称号 / 区县 / 来源过滤后的计数聚合(统计页用)。',
    parameters: [
      { name: 'title', in: 'query', schema: { type: 'string' }, description: '称号代号。' },
      { name: 'district', in: 'query', schema: { type: 'string' }, description: '区县。' },
      { name: 'source', in: 'query', schema: { type: 'string' }, description: '来源:`jxj` / `miit`。' },
    ],
    responses: { 200: { description: '聚合结果。' } },
  },
})

export default defineEventHandler((event) => {
  const q = getQuery(event)
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  return getStats(useDb(), {
    title: str(q.title),
    district: str(q.district),
    source: str(q.source),
  })
})
