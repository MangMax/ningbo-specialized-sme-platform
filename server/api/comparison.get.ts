import { useDb } from '@db'
import { COMPARISON_DIRECTIONS, type ComparisonDirection } from '~~/lib/comparison'
import { getCuratedComparison } from '~~/lib/curation'
import { TITLE_ORDER } from '~~/lib/labels'
import { MAX_PAGE_SIZE } from '~~/lib/query'
import { attachReconcile, readReconcile } from '~~/lib/reconcile'

export default defineEventHandler((event) => {
  const q = getQuery(event)
  const num = (v: unknown, d: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : d
  }
  const csv = (v: unknown): string[] | undefined => {
    if (v == null) return undefined
    const raw = Array.isArray(v) ? v.flatMap((x) => String(x).split(',')) : String(v).split(',')
    const list = raw.map((s) => s.trim()).filter(Boolean)
    return list.length ? list : undefined
  }

  const title = csv(q.title)
  if (title?.some((code) => !TITLE_ORDER.includes(code))) {
    throw createError({ statusCode: 400, statusMessage: `Unknown title; expected ${TITLE_ORDER.join(', ')}` })
  }
  const direction = q.direction === '' ? undefined : q.direction
  if (direction != null && !COMPARISON_DIRECTIONS.includes(direction as ComparisonDirection)) {
    throw createError({ statusCode: 400, statusMessage: `Unknown direction; expected ${COMPARISON_DIRECTIONS.join(', ')}` })
  }

  if (q.showCurated != null && !['true', 'false', ''].includes(String(q.showCurated))) {
    throw createError({ statusCode: 400, statusMessage: 'showCurated must be true or false' })
  }
  const config = useRuntimeConfig(event)
  const result = getCuratedComparison(useDb(), config.curatedPath)
  const { counts, curatedCounts } = result
  const filtered = result.rows.filter(row =>
    (!title?.length || title.includes(row.titleCode)) &&
    (!direction || row.direction === direction) &&
    (q.showCurated === 'true' || !row.curated),
  )
  // 平台解释是**增强项**:缓存不存在时 explanation 全为 null,比对本身不受影响。
  const reconcile = readReconcile(config.reconcilePath)
  const rows = attachReconcile(filtered, reconcile)
  const page = Math.max(1, Math.floor(num(q.page, 1)))
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(num(q.pageSize, 25))))
  return {
    rows: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    counts,
    curatedCounts,
    reconcile: {
      generatedAt: reconcile.generatedAt,
      matched: rows.filter((row) => row.explanation).length,
    },
  }
})
