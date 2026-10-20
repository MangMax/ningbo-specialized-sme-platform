import type { ComparisonDirection } from './comparison'
import { COMPARISON_LABELS } from './labels'

/** The legacy list uses the same coordinate on first load and route restoration. */
export function parseComparisonRouteFilters(query: Record<string, unknown>) {
  const text = (key: string, fallback = '') => typeof query[key] === 'string' ? query[key] as string : fallback
  const page = (key: string, fallback: number) => Math.max(1, Math.trunc(Number(text(key))) || fallback)
  const direction = text('direction')
  return {
    title: text('title', 'specialized_sme'),
    direction: (Object.keys(COMPARISON_LABELS).includes(direction) ? direction : 'missing_in_miit') as ComparisonDirection,
    q: text('q'),
    district: text('district'),
    page: page('page', 1),
    pageSize: Math.min(200, page('pageSize', 25)),
    showCurated: text('showCurated') === 'true',
  }
}
