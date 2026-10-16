import { useDb } from '@db'
import { COMPARISON_DIRECTIONS, type ComparisonDirection } from '~~/lib/comparison'
import { attachPlatformEvidence } from '~~/lib/comparison-platform'
import { getCuratedComparison } from '~~/lib/curation'
import { TITLE_ORDER } from '~~/lib/labels'
import { MAX_PAGE_SIZE } from '~~/lib/query'
import { attachReconcile, readReconcile } from '~~/lib/reconcile'

/**
 * 两侧比对结果(已公布 vs 平台导出),带人工标注、平台解释与**库内平台证据**。
 *
 * `reconcile` 段是**增强**:平台解释缓存(`data/platform-reconcile.json`,票 16 的
 * pipeline CLI 产出)不存在时 `explanation` 全为 null,比对本身不受影响。
 *
 * `platform` 段(RL-03)是**另一条增强**:每个企业的已确认曾用名(`enterprise_alias`)、
 * 「当前」差异处置(`difference_reason`,原因 + 配对措施)与平台查询/关系条数
 * (`platform_query` / `platform_relation`)。没有证据的行 `platform` 为 `null`。
 */
defineRouteMeta({
  openAPI: {
    tags: ['比对'],
    summary: '查比对结果',
    description: '按称号 / 方向过滤,分页返回;含人工标注(`curated`)与平台解释。',
    parameters: [
      {
        name: 'title',
        in: 'query',
        schema: { type: 'string' },
        description: '称号代号,多值:`little_giant` / `specialized_sme` / `innovative_sme`。',
      },
      {
        name: 'direction',
        in: 'query',
        schema: { type: 'string', enum: ['missing_in_miit', 'extra_in_miit'] },
        description: '比对方向:公布文件有而平台导出无 / 反方向。',
      },
      {
        name: 'showCurated',
        in: 'query',
        schema: { type: 'string', enum: ['true', 'false'] },
        description: '`true` 时**也**返回已被人工标注排除的行(默认不返回)。',
      },
      { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 25 } },
    ],
    responses: {
      200: { description: '比对结果(`rows` / `total` / `counts` / `curatedCounts` / `reconcile`)。' },
      400: { description: 'title / direction / showCurated 取值非法。' },
    },
  },
})

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
  const db = useDb()
  const result = getCuratedComparison(db, config.curatedPath)
  const { counts, curatedCounts } = result
  const filtered = result.rows.filter(row =>
    (!title?.length || title.includes(row.titleCode)) &&
    (!direction || row.direction === direction) &&
    (q.showCurated === 'true' || !row.curated),
  )
  // 平台解释是**增强项**:缓存不存在时 explanation 全为 null,比对本身不受影响。
  const reconcile = readReconcile(config.reconcilePath)
  // 库内平台证据(RL-03)同样只是增强:没有证据的行 platform 为 null。
  const rows = attachPlatformEvidence(attachReconcile(filtered, reconcile), db)
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
    platform: {
      withEvidence: rows.filter((row) => row.platform).length,
    },
  }
})
