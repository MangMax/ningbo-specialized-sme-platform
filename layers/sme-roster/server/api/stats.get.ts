import { useDb } from '@db'
import { readRosterStatistics } from '#sme-roster/public'
import { getFirstRecognitionYearBuckets } from '#sme-roster/lib/roster/recognitions'

/** 统计聚合,可按标题 / 区县 / 来源过滤(与 SPEC 契约一致)。 */
defineRouteMeta({
  openAPI: {
    tags: ['台账'],
    summary: '统计聚合',
    description:
      '按称号 / 区县 / 来源过滤计数聚合(统计页用)。`byYear` 是事件年份；`byFirstRecognitionYear` 是首次正式认定年份(企业 × 称号)，按 `decidedYear ?? year` 计算，供首次认定年份筛选使用。',
    parameters: [
      { name: 'title', in: 'query', schema: { type: 'string' }, description: '称号代号。' },
      { name: 'district', in: 'query', schema: { type: 'string' }, description: '区县。' },
      { name: 'source', in: 'query', schema: { type: 'string' }, description: '来源:`jxj` / `miit`。' },
    ],
    responses: { 200: { description: '聚合结果，含事件年份 `byYear` 与首次认定年份 `byFirstRecognitionYear`。' } },
  },
})

export default defineEventHandler((event) => {
  const q = getQuery(event)
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const filter = {
    title: str(q.title),
    district: str(q.district),
    source: str(q.source),
  }
  const db = useDb()
  return {
    ...readRosterStatistics(db, filter),
    byFirstRecognitionYear: getFirstRecognitionYearBuckets(db, filter),
  }
})
