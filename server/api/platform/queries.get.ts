import { useDb } from '@db'
import { MAX_PAGE_SIZE } from '~~/lib/query'
import { PLATFORM_INTERFACE_VALUES, TITLE_ORDER } from '~~/lib/labels'
import { listPlatformQueries } from '~~/lib/platform/read'

/**
 * 平台查询证据(契约 §7.6):工信部三个来源取回的**原始关系**,逐条可查。
 *
 * 读接口**不鉴权**(与既有分法一致:读不鉴权,写/任务鉴权)。含 partial 的状态原样带出,
 * 由页面各自呈现 —— 读侧不把 `failed` 说成 `no_record`。
 */
defineRouteMeta({
  openAPI: {
    tags: ['比对'],
    summary: '查平台查询证据',
    description:
      '按接口 / 查询键 / 企业 / 状态过滤,分页返回;每个查询带它的**全部**关系(逐条保留)。',
    parameters: [
      {
        name: 'interface',
        in: 'query',
        schema: { type: 'string', enum: ['business_list', 'apply_list', 'recognized_list'] },
        description: '平台接口:`business_list`(businessList)/ `apply_list`(queryList)/ `recognized_list`(queryBusList)。',
      },
      { name: 'titleCode', in: 'query', schema: { type: 'string', enum: ['innovative_sme', 'specialized_sme', 'little_giant'] } },
      { name: 'uscc', in: 'query', schema: { type: 'string' } },
      { name: 'queryKey', in: 'query', schema: { type: 'string' }, description: '查询键(统一社会信用代码或 `name:<nameNorm>`)。' },
      { name: 'enterpriseId', in: 'query', schema: { type: 'integer' }, description: '只看有关系归到该企业的查询。' },
      {
        name: 'status',
        in: 'query',
        schema: { type: 'string', enum: ['success', 'failed', 'no_record', 'not_queried', 'partial'] },
        description: '平台查询状态。**失败 ≠ 无记录**,四态各自取值。',
      },
      { name: 'includeRawResponse', in: 'query', schema: { type: 'string', enum: ['true', 'false'] }, description: '`true` 时带出原始响应原文(默认不带,控制体量)。' },
      { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 25 } },
    ],
    responses: {
      200: { description: '分页查询与全部关系(rows[{query,relations}]/total/page/pageSize/counts)。query.collectionEvidence 为原采集结果（旧记录 null）；relations 含原 rawFields、sourceRdjb/sourcePage 及真实查询/关系 id。完整转存/读回契约见 docs/platform-recognized-evidence.md。' },
      400: { description: 'interface / status 取值非法。' },
    },
  },
})

/** 平台接口取值 —— 直接用唯一出处(`lib/labels.ts`),不在这里重列一遍。 */
const INTERFACES = PLATFORM_INTERFACE_VALUES
// ⚠️ 唯一**有意**的例外:上面 `defineRouteMeta` 里的 `enum` 必须保持**字面量** ——
// nitro 的 `handlers-meta` 按 AST 静态求值抽 spec,写标识符它求值不出来(见 `tests/setup.ts`)。
// 两处由 `tests/labels-enums.test.ts` 对齐钉死,所以不会各说各话。
const STATUSES = ['success', 'failed', 'no_record', 'not_queried', 'partial'] as const

export default defineEventHandler((event) => {
  const q = getQuery(event)
  const num = (v: unknown, d: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : d
  }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

  const iface = str(q.interface)
  if (iface != null && !INTERFACES.includes(iface as (typeof INTERFACES)[number])) {
    throw createError({ statusCode: 400, statusMessage: `Unknown interface; expected ${INTERFACES.join(', ')}` })
  }
  const status = str(q.status)
  if (status != null && !STATUSES.includes(status as (typeof STATUSES)[number])) {
    throw createError({ statusCode: 400, statusMessage: `Unknown status; expected ${STATUSES.join(', ')}` })
  }
  const titleCode = str(q.titleCode)
  if (titleCode && !(TITLE_ORDER as readonly string[]).includes(titleCode)) throw createError({ statusCode: 400, statusMessage: 'Unknown titleCode' })
  const enterpriseId = q.enterpriseId != null && q.enterpriseId !== '' ? Number(q.enterpriseId) : undefined
  if (enterpriseId != null && !Number.isFinite(enterpriseId)) {
    throw createError({ statusCode: 400, statusMessage: 'enterpriseId must be a number' })
  }

  return listPlatformQueries(useDb(), {
    interface: iface as (typeof INTERFACES)[number] | undefined,
    queryKey: str(q.queryKey),
    titleCode,
    uscc: str(q.uscc),
    enterpriseId,
    status: status as (typeof STATUSES)[number] | undefined,
    page: Math.max(1, Math.floor(num(q.page, 1))),
    pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(num(q.pageSize, 25)))),
    includeRawResponse: q.includeRawResponse === 'true',
  })
})
