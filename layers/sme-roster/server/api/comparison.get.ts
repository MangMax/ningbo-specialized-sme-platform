import { requestLogContext } from '../../../core/lib/logging'
import { readSummary } from '../utils/comparison-summary-read'
import { withEnterpriseReadSignal } from '../../../core/server/utils/enterprise-read-signal'
import { useDb } from '@db'
import { COMPARISON_DIRECTIONS, type ComparisonDirection } from '#sme-roster/lib/comparison'
import { readWholeComparisonFull } from '#sme-roster/lib/comparison-full'
import { TITLE_ORDER } from '#sme-roster/lib/labels'
import { MAX_PAGE_SIZE } from '#sme-roster/lib/query'

import { readPostgresWholeComparison } from '#sme-roster/lib/comparison-postgres'
import { usePostgresRosterDb } from '../utils/postgres-roster-db'

/**
 * 两侧比对结果(已公布 vs 平台导出),带人工标注、**库内平台原因与证据**、旧解释缓存对照。
 *
 * `platform` 段(RL-03,RL-15 收口)是**主源**:每个企业的已确认曾用名(`enterprise_alias`)、
 * 「当前」差异处置(`difference_reason`:状态 + 原因 + 配对措施)与平台查询
 * (`platform_query` / `platform_relation`,含逐条原始关系)。
 * **每一行都有 `platform`** —— 没有解释记录时状态即状态机的默认态 `not_queried`
 * (「还没查过」,不是「没有」),由 `disposition.explanationId === null` 说清。
 *
 * `reconcile` 段是**对照**(票 16 的旧路径):解释缓存(`data/platform-reconcile.json`)
 * 不存在时 `explanation` 全为 null —— 旧缓存缺失**不再**让页面变成「无数据」,
 * 因为原因与证据已由 `platform` 段从库里带出。
 */
defineRouteMeta({
  openAPI: {
    tags: ['比对'],
    summary: '查比对结果',
    description:
      '按称号 / 方向过滤,分页返回。默认/full 保留人工标注、platform 全部关系与旧 explanation 原文；view=summary 显式返回标量列表，不加载平台原档，summary 行 evidenceIncluded:false，detailUrl 为精确企业×称号×方向完整读取；平台原档可用 /api/platform/queries/{queryId}/evidence 分段读取。summary 的 sourceRelationCount 是所含查询全部来源行数，不代表确认归属。已认定查询原始行 enterpriseId 可为 null。',
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
      {
        name: 'q',
        in: 'query',
        schema: { type: 'string' },
        description:
          '企业名称 / **已确认**曾用名 / 统一社会信用代码关键词(RL-20)。口径与 `/api/roster/enterprises` 的 `q` 同一处:名称按 `normalizeName` 归一后子串匹配,统代按大写子串,别名只认 `confirmed`。',
      },
      {
        name: 'district',
        in: 'query',
        schema: { type: 'string' },
        description: '区县(精确,等于该行记录上的属地)。RL-20 增量。',
      },
      { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 25 } },
      { name: 'view', in: 'query', schema: { type: 'string', enum: ['full', 'summary'], default: 'full' }, description: '显式 opt-in。summary 不含 notes / aliases / queries / relations / collectionEvidence / 旧缓存原文，不以空数组冒充完整证据。默认完整响应不变。' },
      { name: 'enterpriseId', in: 'query', schema: { type: 'integer', minimum: 1 }, description: '精确企业过滤；与 title/direction 取交集。无匹配时 rows=[]，不回退全范围；counts/curatedCounts 仍为全局。' },
    ],
    responses: {
      200: {
        description:
          '比对结果(`rows` / `total` / `counts` / `curatedCounts` / `platform` / `reconcile`)。summary 额外 view:"summary"；行 platform 含 aliasCount/confirmedAliasCount/queryCount/sourceRelationCount/disposition，explanation 为 {code} 或 null。assessment 含 queryCoverage.status、assessment、explanationValidity.status，独立保留查询覆盖、决定撤回及解释有效性。全局 counts/curatedCounts 不随过滤和分页变化；platform/reconcile 为分页前同过滤范围计数。summary 不推断处置状态。',
      },
      400: { description: 'title / direction / showCurated / view / enterpriseId 取值非法。' },
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
  if (q.view != null && q.view !== 'full' && q.view !== 'summary') {
    throw createError({ statusCode: 400, statusMessage: 'view must be full or summary' })
  }
  const enterpriseId = q.enterpriseId == null ? undefined : Number(q.enterpriseId)
  if (enterpriseId != null && (typeof q.enterpriseId !== 'string' || !Number.isSafeInteger(enterpriseId) || enterpriseId < 1)) {
    throw createError({ statusCode: 400, statusMessage: 'enterpriseId must be a positive integer' })
  }
  const config = useRuntimeConfig(event)
  const options = {
    curatedPath: config.curatedPath, reconcilePath: config.reconcilePath, enterpriseId,
    title, direction: direction as ComparisonDirection | undefined,
    district: typeof q.district === 'string' ? q.district : undefined,
    q: typeof q.q === 'string' ? q.q : undefined, showCurated: q.showCurated === 'true',
    page: Math.max(1, Math.floor(num(q.page, 1))),
    pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(num(q.pageSize, 25)))),
  }
  const postgres = usePostgresRosterDb()
  if (postgres) return readPostgresWholeComparison(postgres, options, q.view === 'summary' ? 'summary' : 'full')
  const db = useDb()
  if (q.view === 'summary') {
    return withEnterpriseReadSignal(event, async signal => {
      const result = await readSummary(db, options, signal, undefined, requestLogContext(event))
      if (Buffer.isBuffer(result)) setHeader(event, 'content-type', 'application/json')
      return result
    })
  }
  return readWholeComparisonFull(db, options)
})
