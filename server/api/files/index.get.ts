import { useDb } from '@db'
import {
  CATEGORY_STATES,
  listStoredFiles,
  PARSE_STATES,
} from '../../utils/stored-files'
import type { CategoryState, FileSource, ParseState } from '~~/lib/stored-file'
import { SOURCE_ORDER } from '~~/lib/labels'

defineRouteMeta({
  openAPI: {
    tags: ['文件库'],
    summary: '列出文件库',
    description:
      '只读列表，不扫盘或回填；rescan兼容参数不再执行维护。registeredSummary={count,declarations}仅来自已登记声明；declarations按displaySequence升序；part.year/batch各自可空。parts仍为旧兼容读模型，不是登记摘要。多值参数用逗号分隔。',
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
      {
        name: 'q',
        in: 'query',
        schema: { type: 'string' },
        description: '用户可见名称或磁盘文件名关键词(子串)。',
      },
      { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
      {
        name: 'rescan',
        in: 'query',
        schema: { type: 'string', enum: ['1', 'true'] },
        description: '兼容保留；不再触发扫盘或回填。',
      },
    ],
    responses: {
      200: {
        description: '分页只读文件列表，含registeredSummary、兼容parts与引用数。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['rows', 'total'],
              properties: {
                rows: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: true,
                    required: ['displayName', 'filename'],
                    properties: {
                      displayName: {
                        type: 'string',
                        description: '用户可见名称；未设置时等于磁盘文件名 filename。',
                      },
                      filename: {
                        type: 'string',
                        description: '磁盘上的原始文件名；修改 displayName 不会改动它。',
                      },
                    },
                  },
                },
                total: { type: 'integer', description: '符合筛选条件的文件总数。' },
                backfill: {
                  type: 'object',
                  description: '历史兼容字段；只读列表不再返回回填统计。',
                },
              },
            },
          },
        },
      },
    },
  },
})

export default defineEventHandler(async (event) => {
  const db = useDb()
  const q = getQuery(event)

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
  }
})
