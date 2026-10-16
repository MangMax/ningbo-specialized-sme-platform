import { useDb } from '@db'
import {
  backfillFromDisk,
  CATEGORY_STATES,
  listStoredFiles,
  PARSE_STATES,
  type BackfillReport,
} from '../../utils/stored-files'
import { backfillFileParts } from '../../utils/file-parts'
import type { CategoryState, FileSource, ParseState } from '~~/lib/stored-file'
import { SOURCE_ORDER } from '~~/lib/labels'

/**
 * 文件库列表。`GET /api/files?source=&categoryState=&parseState=&q=&page=&pageSize=`
 *
 * **首次请求懒回填**,两趟:
 *  1. 扫 `files/` 反推分类写 `stored_file`(票 09)—— 要算 22 个文件的 SHA-256
 *     (**入库范围之外**的文件不进表,在 `backfill.excluded` 里带原因列出 —— RL-16);
 *  2. 从 `record_evidence` 聚合出**段**写 `stored_file_part`(票 17,必须先有第 1 趟,
 *     段要挂到 `stored_file.id` 上)。
 * 之后每请求只查表。`?rescan=1` 强制两趟都重跑(验收与排查用;**幂等**)。
 */
let backfilled = false

/**
 * 文件库列表。
 *
 * **首次请求会懒回填**(要算 22 个文件的 SHA-256),所以第一次可能比之后慢 ——
 * 这一点写进 spec,免得代理以为接口不稳定。`rescan=1` 强制重跑(幂等)。
 */
defineRouteMeta({
  openAPI: {
    tags: ['文件库'],
    summary: '列出文件库',
    description:
      '首次请求会做一次惰性回填(扫盘 + 算哈希),可能偏慢;`rescan=1` 强制重跑(幂等)。多值参数用逗号分隔。',
    parameters: [
      {
        name: 'source',
        in: 'query',
        schema: { type: 'string' },
        description: '来源,多值:`jxj` / `miit`。',
      },
      {
        name: 'categoryState',
        in: 'query',
        schema: { type: 'string' },
        description: '分类状态,多值:`set`(已定)/ `inferred`(程序推的)/ `unset`(未定)。',
      },
      {
        name: 'parseState',
        in: 'query',
        schema: { type: 'string' },
        description: '解析状态,多值:`unparsed` / `parsed` / `failed`。',
      },
      { name: 'q', in: 'query', schema: { type: 'string' }, description: '文件名关键词(子串)。' },
      { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
      {
        name: 'rescan',
        in: 'query',
        schema: { type: 'string', enum: ['1', 'true'] },
        description: '强制重跑回填(幂等;验收与排查用)。',
      },
    ],
    responses: { 200: { description: '分页的文件列表(含段与引用数);跑过回填时带 `backfill`。' } },
  },
})

export default defineEventHandler(async (event) => {
  const db = useDb()
  const q = getQuery(event)

  const force = q.rescan === '1' || q.rescan === 'true'
  let backfill: BackfillReport | undefined
  if (!backfilled || force) {
    const files = await backfillFromDisk(db, useRuntimeConfig().filesDir)
    backfill = { ...files, parts: backfillFileParts(db) }
    backfilled = true
  }

  const csv = (v: unknown): string[] | undefined => {
    if (v == null) return undefined
    const raw = Array.isArray(v) ? v.flatMap((x) => String(x).split(',')) : String(v).split(',')
    const list = raw.map((s) => s.trim()).filter(Boolean)
    return list.length ? list : undefined
  }
  const num = (v: unknown, d: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : d
  }

  const result = listStoredFiles(db, {
    source: csv(q.source)?.filter((s) => SOURCE_ORDER.includes(s)) as FileSource[] | undefined,
    categoryState: csv(q.categoryState)?.filter((s) =>
      CATEGORY_STATES.includes(s as CategoryState),
    ) as CategoryState[] | undefined,
    parseState: csv(q.parseState)?.filter((s) =>
      PARSE_STATES.includes(s as ParseState),
    ) as ParseState[] | undefined,
    q: typeof q.q === 'string' && q.q ? q.q : undefined,
    page: num(q.page, 1),
    pageSize: num(q.pageSize, 50),
  })

  return {
    rows: result.rows,
    total: result.total,
    /** 回填统计只在真的跑过回填时出现,便于验收时核对「22 个」。 */
    ...(backfill ? { backfill } : {}),
  }
})
