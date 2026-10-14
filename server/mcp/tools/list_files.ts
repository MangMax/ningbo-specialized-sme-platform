import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { openFileStore } from '../../utils/mcp-files'
import { listStoredFiles } from '../../utils/stored-files'

/**
 * `list_files` —— 文件库列表(票 18,只读)。
 *
 * 与 `GET /api/files` **同一个查询层**(`listStoredFiles`):同一个筛选语义、同一个排序
 * (来源 → 公布年份倒序 → 公布批次倒序 → 文件名)、同一个「被记录引用数」。所以代理看到的
 * 就是 `/files` 页上那一份列表,不另立一套口径。
 *
 * 首次调用会顺带做一次**懒回填**(扫 `files/` 补 `stored_file`、按需补段),返回里的
 * `backfill` 就是这次的统计 —— 冷启动时用它核对「23 个文件」。
 */
export default defineMcpTool({
  name: 'list_files',
  title: '文件库列表',
  annotations: { readOnlyHint: true, openWorldHint: false },
  description: [
    '列出文件库里的文件(元数据 + 处理状态 + 该文件含哪些段)。',
    '筛选:来源 / 分类状态 / 解析状态 / 文件名关键词;分页 page(从 1 起)、pageSize(默认 50,上限 200)。',
    '**没有**类别(announcement / export)筛选 —— 查询层(`listStoredFiles`)没有这一维,`/api/files` 也没有;',
    '需要按类别收窄时,用 `source` 筛(经信局公布文件与工信部导出表的类别是固定的)或自己按 `kind` 过滤返回的 `rows`。',
    '`year` `batch` 是**公布**年份/批次(单值,目录给的);文件**内容**里的年份/批次看 `parts`。',
    '想拿某个文件本身用 `get_file`,只看段用 `list_file_parts`。',
  ].join('\n'),
  inputSchema: {
    source: z.enum(['jxj', 'miit']).optional().describe('来源:jxj 经信局 / miit 工信部'),
    categoryState: z
      .enum(['set', 'inferred', 'unset'])
      .optional()
      .describe('分类状态:set 已定 / inferred 程序推的 / unset 未定(票 12 待回写的就是 unset)'),
    parseState: z.enum(['unparsed', 'parsed', 'failed']).optional().describe('解析状态'),
    q: z.string().optional().describe('文件名关键词(子串,ASCII 大小写不敏感)'),
    page: z.number().int().min(1).optional().describe('页码,从 1 起(默认 1)'),
    pageSize: z.number().int().min(1).max(200).optional().describe('每页条数(默认 50,上限 200)'),
    includeRemoved: z.boolean().optional().describe('是否含已移出库的文件(removed_at 非空),默认不含'),
  },
  handler: async (input) => {
    const { db, backfill } = await openFileStore()
    const { rows, total } = listStoredFiles(db, {
      source: input.source ? [input.source] : undefined,
      categoryState: input.categoryState ? [input.categoryState] : undefined,
      parseState: input.parseState ? [input.parseState] : undefined,
      q: input.q?.trim() || undefined,
      includeRemoved: input.includeRemoved,
      page: input.page ?? 1,
      pageSize: input.pageSize ?? 50,
    })
    return {
      total,
      page: input.page ?? 1,
      pageSize: input.pageSize ?? 50,
      // 摊平成对象字面量再返回:`StoredFileRow` 是 interface(无隐式索引签名),
      // 直接放进 `Record<string, unknown>` 过不了类型检查。
      rows: rows.map((row) => ({ ...row })),
      // 只在真的跑过回填时出现(与 `/api/files` 同形),便于验收核对。
      ...(backfill ? { backfill } : {}),
    }
  },
})
