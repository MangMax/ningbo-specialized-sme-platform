import { useDb } from '@db'
import { getQuality } from '#sme-roster/lib/query'

/** 质量清单;`?kind=` 按质量项过滤(不传返回全部)。 */
defineRouteMeta({
  openAPI: {
    tags: ['台账'],
    summary: '质量清单',
    description: '数据质量问题清单(如缺统一社会信用代码);`kind` 传质量标记代号可只取一组。',
    parameters: [
      {
        name: 'kind',
        in: 'query',
        schema: { type: 'string' },
        description: '质量标记代号(如 `uscc_missing`);不传返回全部。',
      },
    ],
    responses: { 200: { description: '按质量项分组的清单。' } },
  },
})

export default defineEventHandler((event) => {
  const kind = getQuery(event).kind
  const groups = getQuality(useDb())
  return typeof kind === 'string' && kind ? groups.filter((g) => g.kind === kind) : groups
})
