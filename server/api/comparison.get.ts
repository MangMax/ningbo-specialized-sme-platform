import { useDb } from '@db'
import { COMPARISON_DIRECTIONS, getComparison, type ComparisonDirection } from '~~/lib/comparison'
import { TITLE_ORDER } from '~~/lib/labels'
import { MAX_PAGE_SIZE } from '~~/lib/query'

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

  const { rows, counts } = getComparison(useDb(), { title, direction: direction as ComparisonDirection | undefined })
  const page = Math.max(1, Math.floor(num(q.page, 1)))
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(num(q.pageSize, 25))))
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, counts }
})
