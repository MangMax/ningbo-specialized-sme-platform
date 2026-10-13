import { useDb } from '@db'
import { getQuality } from '~~/lib/query'

/** 质量清单;`?kind=` 按质量项过滤(不传返回全部)。 */
export default defineEventHandler((event) => {
  const kind = getQuery(event).kind
  const groups = getQuality(useDb())
  return typeof kind === 'string' && kind ? groups.filter((g) => g.kind === kind) : groups
})
